import argparse
import asyncio
import json
import time
from typing import Optional

import websockets


def now_ms() -> int:
    return int(time.time() * 1000)


class MpvIpc:
    def __init__(self, socket_path: str):
        self.socket_path = socket_path
        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.request_id = 0

    async def connect(self) -> None:
        self.reader, self.writer = await asyncio.open_unix_connection(self.socket_path)

    async def send(self, command) -> int:
        self.request_id += 1
        payload = {"command": command, "request_id": self.request_id}
        self.writer.write((json.dumps(payload) + "\n").encode("utf-8"))
        await self.writer.drain()
        return self.request_id

    async def recv(self) -> dict:
        line = await self.reader.readline()
        if not line:
            raise ConnectionError("mpv IPC closed")
        return json.loads(line.decode("utf-8"))

    async def set_property(self, name: str, value):
        await self.send(["set_property", name, value])


class SyncClient:
    def __init__(self, args):
        self.args = args
        self.client_id = args.client_id or f"mpv-{int(time.time())}"
        self.ws = None
        self.mpv = MpvIpc(args.mpv_socket)
        self.suppress_until = 0
        self.last_ping_at = 0.0
        self.last_time_pos = None

    def should_send(self) -> bool:
        return time.time() * 1000 > self.suppress_until

    def suppress(self, ms: int = 400) -> None:
        self.suppress_until = time.time() * 1000 + ms

    async def connect(self) -> None:
        await self.mpv.connect()
        await self.mpv.send(["observe_property", 1, "pause"])
        await self.mpv.send(["observe_property", 2, "time-pos"])
        self.ws = await websockets.connect(self.args.ws)

    async def send_ws(self, event_type: str, payload: dict) -> None:
        message = {
            "type": event_type,
            "room": self.args.room,
            "client": self.client_id,
            "payload": payload,
            "ts": now_ms(),
        }
        await self.ws.send(json.dumps(message))

    async def create_room(self) -> None:
        media_url = self.args.media_url
        await self.send_ws(
            "create_room",
            {
                "media_url": media_url,
                "start_pos": self.last_time_pos or 0,
                "name": self.args.name,
                "auth_token": self.args.auth_token,
                "options": {"free_play": False},
            },
        )

    async def join_room(self) -> None:
        await self.send_ws(
            "join_room",
            {
                "name": self.args.name,
                "auth_token": self.args.auth_token,
                "invite_token": self.args.invite_token,
            },
        )

    async def apply_player_event(self, payload: dict) -> None:
        action = payload.get("action")
        position = payload.get("position")
        self.suppress()
        if action == "play":
            await self.mpv.set_property("pause", False)
        elif action == "pause":
            await self.mpv.set_property("pause", True)
        elif action == "seek" and position is not None:
            await self.mpv.set_property("time-pos", float(position))

    async def handle_ws_message(self, msg: dict) -> None:
        if msg.get("room") != self.args.room:
            return
        payload = msg.get("payload") or {}
        if msg.get("type") == "pong":
            if payload.get("client_ts"):
                rtt = now_ms() - int(payload["client_ts"])
                print(f"[OpenSyncParty] RTT {rtt} ms")
            return
        if msg.get("type") == "room_state":
            state = payload.get("state") or {}
            if "position" in state:
                self.suppress()
                await self.mpv.set_property("time-pos", float(state["position"]))
            if state.get("play_state") == "playing":
                self.suppress()
                await self.mpv.set_property("pause", False)
            if state.get("play_state") == "paused":
                self.suppress()
                await self.mpv.set_property("pause", True)
            return
        if msg.get("type") == "player_event":
            await self.apply_player_event(payload)
        if msg.get("type") == "state_update":
            if "position" in payload:
                self.suppress()
                await self.mpv.set_property("time-pos", float(payload["position"]))

    async def ws_loop(self) -> None:
        async for raw in self.ws:
            msg = json.loads(raw)
            await self.handle_ws_message(msg)

    async def ping_loop(self) -> None:
        while True:
            await asyncio.sleep(3)
            client_ts = now_ms()
            self.last_ping_at = client_ts
            await self.send_ws("ping", {"client_ts": client_ts})

    async def mpv_loop(self) -> None:
        while True:
            msg = await self.mpv.recv()
            if msg.get("event") == "property-change":
                name = msg.get("name")
                data = msg.get("data")
                if name == "pause" and self.args.host and self.should_send():
                    action = "pause" if data else "play"
                    position = self.last_time_pos or 0
                    await self.send_ws("player_event", {"action": action, "position": position})
                if name == "time-pos":
                    if data is None:
                        continue
                    if self.last_time_pos is not None and self.args.host and self.should_send():
                        if abs(float(data) - float(self.last_time_pos)) > 1.0:
                            await self.send_ws("player_event", {"action": "seek", "position": float(data)})
                    self.last_time_pos = float(data)
            if msg.get("event") == "seek" and self.args.host and self.should_send():
                if self.last_time_pos is not None:
                    await self.send_ws("player_event", {"action": "seek", "position": self.last_time_pos})


async def main() -> None:
    parser = argparse.ArgumentParser(description="OpenSyncParty MPV adapter")
    parser.add_argument("--ws", default="ws://localhost:8999/ws", help="WebSocket URL")
    parser.add_argument("--room", required=True, help="Room ID")
    parser.add_argument("--name", default="MPV", help="Display name")
    parser.add_argument("--client-id", default=None, help="Client ID override")
    parser.add_argument("--mpv-socket", default="/tmp/mpv-socket", help="MPV JSON IPC socket path")
    parser.add_argument("--host", action="store_true", help="Create room and act as host")
    parser.add_argument("--media-url", default=None, help="Override media URL")
    parser.add_argument("--auth-token", default=None, help="JWT auth token")
    parser.add_argument("--invite-token", default=None, help="Invite token for join")
    args = parser.parse_args()

    client = SyncClient(args)
    await client.connect()
    if args.host:
        await client.create_room()
    else:
        await client.join_room()

    await asyncio.gather(client.ws_loop(), client.mpv_loop(), client.ping_loop())


if __name__ == "__main__":
    asyncio.run(main())
