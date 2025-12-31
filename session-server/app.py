import json
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse


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
    client_info = ClientInfo(client_id=client_id, name=payload.get("name"), ws=ws, room_id=room_id)
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

    client_info = ClientInfo(client_id=client_id, name=payload.get("name"), ws=ws, room_id=room_id)
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
