# Session Server

WebSocket coordination service for rooms, state, and sync events.

## Responsibilities

- Room lifecycle (create, join, leave)
- Broadcast of player events
- Latency measurement and resync policies
- Auth and permissions
- Participant list updates (count + display names)

## Endpoints (planned)

- `GET /health` basic health check
- `GET /metrics` Prometheus metrics
- `WS /ws` WebSocket message channel

## Run (PoC)

```bash
uv sync --group server
.venv/bin/python app.py
```

Ou via Makefile:

```bash
make server
```

The server listens on `ws://localhost:8999/ws` with a health check at
`http://localhost:8999/health`.

## Run with Docker Compose

```bash
docker compose up --build session-server
```

## Notes

MVP implementation uses FastAPI with in-memory room state (no Redis yet).

## JWT Auth (M2)

If `JWT_SECRET` is set, clients must provide `auth_token` for `create_room`. For
`join_room`, either `auth_token` or `invite_token` is required.

Hosts can request an invite token via the `create_invite` message.

Environment variables:

- `JWT_SECRET` (required to enable auth/invites)
- `JWT_AUDIENCE` (optional)
- `JWT_ISSUER` (optional)
- `INVITE_TTL_SECONDS` (default 3600)
- `HOST_ROLES` (comma-separated roles allowed to create rooms)
- `INVITE_ROLES` (comma-separated roles allowed to create invites)

## REST Invite

If you need an HTTP flow, POST `/invite` with a bearer JWT and payload:

```json
{ "room": "room_id", "expires_in": 3600 }
```
