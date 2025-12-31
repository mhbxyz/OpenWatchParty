# Session Server

WebSocket coordination service for rooms, state, and sync events.

## Responsibilities

- Room lifecycle (create, join, leave)
- Broadcast of player events
- Latency measurement and resync policies
- Auth and permissions

## Endpoints (planned)

- `GET /health` basic health check
- `GET /metrics` Prometheus metrics
- `WS /ws` WebSocket message channel

## Notes

Implementation target (MVP): FastAPI + websockets + Redis.
