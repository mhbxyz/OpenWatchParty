# Architecture

OpenSyncParty is split into a lightweight session server, client adapters, and
optional Jellyfin integration.

## Components

- Session Server: WebSocket coordinator handling rooms, state, and resync logic.
- Clients: Web overlay, MPV script, and optional VLC adapter.
- Jellyfin Plugin: Auth token issuance and UI entry point for watch parties.
- Infra: Redis and optional persistence, exposed via reverse proxy or tunnel.

## High-level Flow

1. Jellyfin provides a media URL and auth token (optional).
2. Host creates a room on the session server via WebSocket.
3. Clients join the room and subscribe to state updates.
4. Host player events are broadcast and applied with latency compensation.

## Sync Strategy

- MVP uses a host-authoritative model with resync thresholds.
- Clients report RTT to estimate latency and adjust playback.
