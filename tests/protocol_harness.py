import argparse
import asyncio
import json
import os
import sys
import time

import websockets
import jwt


def now_ms() -> int:
    return int(time.time() * 1000)


async def recv_json(ws, timeout=3):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def expect_type(ws, expected_type, timeout=3):
    msg = await recv_json(ws, timeout=timeout)
    if msg.get("type") != expected_type:
        raise AssertionError(f"expected {expected_type}, got {msg.get('type')}: {msg}")
    return msg


async def run_harness(args) -> int:
    room_id = args.room
    host_id = "host-1"
    join_id = "client-2"
    jwt_secret = os.getenv("JWT_SECRET", "").strip()
    host_roles = [r.strip() for r in os.getenv("HOST_ROLES", "").split(",") if r.strip()]
    auth_token = None
    if jwt_secret:
        role_claim = host_roles[0] if host_roles else None
        host_claims = {"user_id": "u1", "username": "Host", "exp": int(time.time()) + 3600}
        if role_claim:
            host_claims["role"] = role_claim
        auth_token = jwt.encode(
            host_claims,
            jwt_secret,
            algorithm="HS256",
        )
        join_token = jwt.encode(
            {"user_id": "u2", "username": "Joiner", "exp": int(time.time()) + 3600},
            jwt_secret,
            algorithm="HS256",
        )
    else:
        join_token = None

    async with websockets.connect(args.ws) as host_ws:
        await host_ws.send(
            json.dumps(
                {
                    "type": "create_room",
                    "room": room_id,
                    "client": host_id,
                    "payload": {
                        "media_url": "demo",
                        "start_pos": 0,
                        "name": "Host",
                        "auth_token": auth_token,
                    },
                    "ts": now_ms(),
                }
            )
        )
        msg = await expect_type(host_ws, "room_state")
        payload = msg.get("payload", {})
        if payload.get("participant_count") != 1:
            raise AssertionError(f"expected 1 participant, got {payload.get('participant_count')}")

        async with websockets.connect(args.ws) as join_ws:
            await join_ws.send(
                json.dumps(
                    {
                        "type": "join_room",
                        "room": room_id,
                        "client": join_id,
                        "payload": {"name": "Joiner", "auth_token": join_token},
                        "ts": now_ms(),
                    }
                )
            )

            join_state = await expect_type(join_ws, "room_state")
            if join_state.get("payload", {}).get("participant_count") != 2:
                raise AssertionError("joiner did not receive updated participant_count")

            seen_participants = False
            for _ in range(3):
                msg = await recv_json(host_ws, timeout=3)
                if msg.get("type") == "participants_update":
                    count = msg.get("payload", {}).get("participant_count")
                    if count != 2:
                        raise AssertionError("host did not see 2 participants")
                    seen_participants = True
                    break
            if not seen_participants:
                raise AssertionError("host did not receive participants_update")

            await host_ws.send(
                json.dumps(
                    {
                        "type": "player_event",
                        "room": room_id,
                        "client": host_id,
                        "payload": {"action": "play", "position": 1.5},
                        "ts": now_ms(),
                    }
                )
            )
            player_msg = await expect_type(join_ws, "player_event")
            if player_msg.get("payload", {}).get("action") != "play":
                raise AssertionError("joiner did not receive play event")

            ping_ts = now_ms()
            await join_ws.send(
                json.dumps(
                    {
                        "type": "ping",
                        "room": room_id,
                        "client": join_id,
                        "payload": {"client_ts": ping_ts},
                        "ts": now_ms(),
                    }
                )
            )
            pong = await expect_type(join_ws, "pong")
            if pong.get("payload", {}).get("client_ts") != ping_ts:
                raise AssertionError("pong client_ts mismatch")

    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenSyncParty protocol harness")
    parser.add_argument("--ws", default="ws://localhost:8999/ws", help="WebSocket URL")
    parser.add_argument("--room", default="test-room", help="Room ID")
    args = parser.parse_args()

    try:
        rc = asyncio.run(run_harness(args))
    except Exception as exc:
        print(f"[harness] failed: {exc}")
        sys.exit(1)
    print("[harness] ok")
    sys.exit(rc)


if __name__ == "__main__":
    main()
