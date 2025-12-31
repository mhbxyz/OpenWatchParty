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
