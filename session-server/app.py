import json
import os
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

import jwt
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class ClientInfo:
    client_id: str
    name: Optional[str]
    ws: WebSocket
    room_id: Optional[str] = None


@dataclass
class Room:
    room_id: str
    host_id: str
    media_url: Optional[str]
    options: dict = field(default_factory=dict)
    clients: Dict[str, ClientInfo] = field(default_factory=dict)
    state: dict = field(default_factory=lambda: {"position": 0.0, "play_state": "paused"})


app = FastAPI()
rooms: Dict[str, Room] = {}
clients_by_ws: Dict[WebSocket, ClientInfo] = {}
JWT_SECRET = os.getenv("JWT_SECRET", "").strip()
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "").strip()
JWT_ISSUER = os.getenv("JWT_ISSUER", "").strip()
INVITE_TTL_SECONDS = int(os.getenv("INVITE_TTL_SECONDS", "3600"))
HOST_ROLES = [role.strip().lower() for role in os.getenv("HOST_ROLES", "").split(",") if role.strip()]
INVITE_ROLES = [role.strip().lower() for role in os.getenv("INVITE_ROLES", "").split(",") if role.strip()]


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "rooms": len(rooms)})


def make_message(event_type: str, room: Optional[str], client: Optional[str], payload: dict) -> dict:
    return {
        "type": event_type,
        "room": room,
        "client": client,
        "payload": payload,
        "ts": now_ms(),
        "server_ts": now_ms(),
    }


def stamp_server_ts(message: dict) -> dict:
    stamped = dict(message)
    stamped["server_ts"] = now_ms()
    return stamped


def verify_jwt(token: str) -> Tuple[bool, Optional[dict], Optional[str]]:
    if not JWT_SECRET:
        return True, {}, None
    try:
        options = {"require": ["exp"]}
        kwargs = {"algorithms": ["HS256"], "options": options}
        if JWT_AUDIENCE:
            kwargs["audience"] = JWT_AUDIENCE
        if JWT_ISSUER:
            kwargs["issuer"] = JWT_ISSUER
        payload = jwt.decode(token, JWT_SECRET, **kwargs)
        return True, payload, None
    except jwt.ExpiredSignatureError:
        return False, None, "token_expired"
    except jwt.InvalidTokenError:
        return False, None, "token_invalid"


def extract_roles(claims: dict) -> set:
    roles = []
    role_claim = claims.get("role")
    if isinstance(role_claim, list):
        roles.extend(role_claim)
    elif isinstance(role_claim, str):
        roles.extend([part.strip() for part in role_claim.split(",")])
    roles_claim = claims.get("roles")
    if isinstance(roles_claim, list):
        roles.extend(roles_claim)
    elif isinstance(roles_claim, str):
        roles.extend([part.strip() for part in roles_claim.split(",")])
    return {str(role).lower() for role in roles if role}


def require_roles(claims: dict, required: list) -> bool:
    if not required:
        return True
    roles = extract_roles(claims)
    return any(role in roles for role in required)


def require_auth(payload: dict) -> Tuple[bool, Optional[dict], Optional[str]]:
    if not JWT_SECRET:
        return True, {}, None
    token = payload.get("auth_token")
    if not token:
        return False, None, "auth_required"
    return verify_jwt(token)


def verify_invite(payload: dict, room_id: str) -> Tuple[bool, Optional[dict], Optional[str]]:
    if not JWT_SECRET:
        return True, {}, None
    invite_token = payload.get("invite_token")
    if not invite_token:
        return False, None, "invite_required"
    ok, claims, err = verify_jwt(invite_token)
    if not ok or not claims:
        return False, None, err
    if claims.get("type") != "invite":
        return False, None, "invite_invalid"
    if claims.get("room") != room_id:
        return False, None, "invite_room_mismatch"
    return True, claims, None


def issue_invite(room_id: str, ttl_seconds: Optional[int] = None) -> dict:
    if not JWT_SECRET:
        raise ValueError("JWT_SECRET required for invites")
    exp = int(time.time()) + int(ttl_seconds or INVITE_TTL_SECONDS)
    payload = {
        "type": "invite",
        "room": room_id,
        "exp": exp,
    }
    if JWT_AUDIENCE:
        payload["aud"] = JWT_AUDIENCE
    if JWT_ISSUER:
        payload["iss"] = JWT_ISSUER
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"invite_token": token, "expires_at": exp}


class InviteRequest(BaseModel):
    room: str
    expires_in: Optional[int] = None


@app.post("/invite")
async def create_invite_http(request: InviteRequest, authorization: Optional[str] = Header(default=None)) -> JSONResponse:
    if not JWT_SECRET:
        raise HTTPException(status_code=400, detail="JWT_SECRET required")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    ok, claims, err = verify_jwt(token)
    if not ok or not claims:
        raise HTTPException(status_code=401, detail=err or "Invalid token")
    if not require_roles(claims, INVITE_ROLES or HOST_ROLES):
        raise HTTPException(status_code=403, detail="Insufficient role")
    if request.room not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    invite = issue_invite(request.room, request.expires_in)
    return JSONResponse(invite)


async def send_error(ws: WebSocket, code: str, message: str, room: Optional[str], client: Optional[str]) -> None:
    await ws.send_json(make_message("error", room, client, {"code": code, "message": message}))


async def broadcast(room: Room, message: dict, exclude_client: Optional[str] = None) -> None:
    dead = []
    for client_id, client_info in room.clients.items():
        if client_id == exclude_client:
            continue
        try:
            await client_info.ws.send_json(message)
        except Exception:
            dead.append(client_id)
    for client_id in dead:
        room.clients.pop(client_id, None)


def room_state_payload(room: Room) -> dict:
    return {
        "room": room.room_id,
        "host_id": room.host_id,
        "media_url": room.media_url,
        "options": room.options,
        "state": room.state,
        "participants": [
            {
                "client_id": client.client_id,
                "name": client.name,
                "is_host": client.client_id == room.host_id,
            }
            for client in room.clients.values()
        ],
        "participant_count": len(room.clients),
    }


def participants_payload(room: Room) -> dict:
    return {
        "participants": [
            {
                "client_id": client.client_id,
                "name": client.name,
                "is_host": client.client_id == room.host_id,
            }
            for client in room.clients.values()
        ],
        "participant_count": len(room.clients),
    }


async def handle_create_room(msg: dict, ws: WebSocket) -> None:
    room_id = msg.get("room")
    client_id = msg.get("client")
    payload = msg.get("payload") or {}
    if not room_id or not client_id:
        await send_error(ws, "bad_request", "room and client are required", room_id, client_id)
        return
    ok, claims, err = require_auth(payload)
    if not ok:
        await send_error(ws, err or "auth_failed", "auth required", room_id, client_id)
        return
    if claims and not require_roles(claims, HOST_ROLES):
        await send_error(ws, "forbidden", "insufficient role", room_id, client_id)
        return
    if room_id in rooms:
        await send_error(ws, "room_exists", "room already exists", room_id, client_id)
        return

    room = Room(
        room_id=room_id,
        host_id=client_id,
        media_url=payload.get("media_url"),
        options=payload.get("options", {}),
    )
    room.state = {
        "position": float(payload.get("start_pos", 0.0)),
        "play_state": "paused",
    }
    client_name = payload.get("name") or (claims or {}).get("username")
    client_info = ClientInfo(client_id=client_id, name=client_name, ws=ws, room_id=room_id)
    room.clients[client_id] = client_info
    rooms[room_id] = room
    clients_by_ws[ws] = client_info
    await ws.send_json(make_message("room_state", room_id, client_id, room_state_payload(room)))
    await broadcast(
        room,
        make_message("participants_update", room_id, client_id, participants_payload(room)),
        exclude_client=None,
    )


async def handle_join_room(msg: dict, ws: WebSocket) -> None:
    room_id = msg.get("room")
    client_id = msg.get("client")
    payload = msg.get("payload") or {}
    if not room_id or not client_id:
        await send_error(ws, "bad_request", "room and client are required", room_id, client_id)
        return
    room = rooms.get(room_id)
    if not room:
        await send_error(ws, "room_missing", "room not found", room_id, client_id)
        return

    ok, claims, err = require_auth(payload)
    if not ok:
        ok_invite, invite_claims, invite_err = verify_invite(payload, room_id)
        if not ok_invite:
            await send_error(ws, invite_err or err or "auth_failed", "auth or invite required", room_id, client_id)
            return
        claims = invite_claims

    client_name = payload.get("name") or (claims or {}).get("username")
    client_info = ClientInfo(client_id=client_id, name=client_name, ws=ws, room_id=room_id)
    room.clients[client_id] = client_info
    clients_by_ws[ws] = client_info

    await ws.send_json(make_message("room_state", room_id, client_id, room_state_payload(room)))
    await broadcast(
        room,
        make_message("client_joined", room_id, client_id, {"name": payload.get("name")}),
        exclude_client=client_id,
    )
    await broadcast(
        room,
        make_message("participants_update", room_id, client_id, participants_payload(room)),
        exclude_client=None,
    )


async def handle_player_event(msg: dict, ws: WebSocket) -> None:
    room_id = msg.get("room")
    client_id = msg.get("client")
    payload = msg.get("payload") or {}
    if not room_id or not client_id:
        await send_error(ws, "bad_request", "room and client are required", room_id, client_id)
        return
    room = rooms.get(room_id)
    if not room:
        await send_error(ws, "room_missing", "room not found", room_id, client_id)
        return
    if client_id != room.host_id and not room.options.get("free_play"):
        await send_error(ws, "not_host", "only host can send player events", room_id, client_id)
        return

    action = payload.get("action")
    position = payload.get("position")
    if action in {"play", "pause"}:
        room.state["play_state"] = "playing" if action == "play" else "paused"
    if position is not None:
        room.state["position"] = float(position)

    await broadcast(room, stamp_server_ts(msg), exclude_client=None)


async def handle_state_update(msg: dict, ws: WebSocket) -> None:
    room_id = msg.get("room")
    client_id = msg.get("client")
    payload = msg.get("payload") or {}
    if not room_id or not client_id:
        await send_error(ws, "bad_request", "room and client are required", room_id, client_id)
        return
    room = rooms.get(room_id)
    if not room:
        await send_error(ws, "room_missing", "room not found", room_id, client_id)
        return
    if client_id == room.host_id:
        if "position" in payload:
            room.state["position"] = float(payload["position"])
        if "play_state" in payload:
            room.state["play_state"] = payload["play_state"]

    await broadcast(room, stamp_server_ts(msg), exclude_client=None)


async def handle_force_resync(msg: dict, ws: WebSocket) -> None:
    room_id = msg.get("room")
    client_id = msg.get("client")
    if not room_id or not client_id:
        await send_error(ws, "bad_request", "room and client are required", room_id, client_id)
        return
    room = rooms.get(room_id)
    if not room:
        await send_error(ws, "room_missing", "room not found", room_id, client_id)
        return
    if client_id != room.host_id:
        await send_error(ws, "not_host", "only host can resync", room_id, client_id)
        return
    await broadcast(room, stamp_server_ts(msg), exclude_client=None)


async def handle_create_invite(msg: dict, ws: WebSocket) -> None:
    room_id = msg.get("room")
    client_id = msg.get("client")
    payload = msg.get("payload") or {}
    if not room_id or not client_id:
        await send_error(ws, "bad_request", "room and client are required", room_id, client_id)
        return
    room = rooms.get(room_id)
    if not room:
        await send_error(ws, "room_missing", "room not found", room_id, client_id)
        return
    if client_id != room.host_id:
        await send_error(ws, "not_host", "only host can create invite", room_id, client_id)
        return
    if not JWT_SECRET:
        await send_error(ws, "invite_disabled", "JWT_SECRET required", room_id, client_id)
        return
    ok, claims, err = require_auth(payload)
    if not ok:
        await send_error(ws, err or "auth_failed", "auth required", room_id, client_id)
        return
    if claims and not require_roles(claims, INVITE_ROLES or HOST_ROLES):
        await send_error(ws, "forbidden", "insufficient role", room_id, client_id)
        return
    ttl_seconds = payload.get("expires_in")
    invite = issue_invite(room_id, ttl_seconds)
    await ws.send_json(make_message("invite_created", room_id, client_id, invite))


async def handle_ping(msg: dict, ws: WebSocket) -> None:
    payload = msg.get("payload") or {}
    await ws.send_json(
        make_message("pong", msg.get("room"), msg.get("client"), {"client_ts": payload.get("client_ts")})
    )


async def handle_message(msg: dict, ws: WebSocket) -> None:
    msg_type = msg.get("type")
    if msg_type == "create_room":
        await handle_create_room(msg, ws)
    elif msg_type == "join_room":
        await handle_join_room(msg, ws)
    elif msg_type == "player_event":
        await handle_player_event(msg, ws)
    elif msg_type == "state_update":
        await handle_state_update(msg, ws)
    elif msg_type == "force_resync":
        await handle_force_resync(msg, ws)
    elif msg_type == "create_invite":
        await handle_create_invite(msg, ws)
    elif msg_type == "ping":
        await handle_ping(msg, ws)
    else:
        await send_error(ws, "unknown_type", f"unknown message type: {msg_type}", msg.get("room"), msg.get("client"))


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await send_error(ws, "bad_json", "invalid JSON", None, None)
                continue
            await handle_message(msg, ws)
    except WebSocketDisconnect:
        client_info = clients_by_ws.pop(ws, None)
        if not client_info:
            return
        room = rooms.get(client_info.room_id)
        if not room:
            return
        room.clients.pop(client_info.client_id, None)
        if room.host_id == client_info.client_id:
            remaining = list(room.clients.values())
            if remaining:
                room.host_id = remaining[0].client_id
                await broadcast(
                    room,
                    make_message("host_change", room.room_id, room.host_id, {"host_id": room.host_id}),
                    exclude_client=None,
                )
                await broadcast(
                    room,
                    make_message("participants_update", room.room_id, room.host_id, participants_payload(room)),
                    exclude_client=None,
                )
            else:
                rooms.pop(room.room_id, None)
        else:
            await broadcast(
                room,
                make_message("client_left", room.room_id, client_info.client_id, {}),
                exclude_client=None,
            )
            await broadcast(
                room,
                make_message("participants_update", room.room_id, client_info.client_id, participants_payload(room)),
                exclude_client=None,
            )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8999, reload=False)
