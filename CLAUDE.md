# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenWatchParty is a Jellyfin plugin that enables synchronized watch parties. It consists of three components:

1. **Jellyfin Plugin (C#)** - `plugins/jellyfin/OpenWatchParty/`
   - Serves client JS, generates JWT tokens, provides configuration UI
   - Target: .NET 9.0, Jellyfin 10.11.x

2. **Session Server (Rust)** - `server/`
   - WebSocket server managing rooms and sync state
   - Uses warp, tokio, handles JWT validation

3. **Web Client (JavaScript)** - `clients/web-plugin/`
   - Modular IIFE structure: `state.js` → `utils.js` → `ui.js`/`playback.js` → `ws.js` → `app.js`
   - Injected into Jellyfin via `plugin.js` loader
   - Global namespace: `window.OpenWatchParty` (alias: `OWP`)

## Common Commands

```bash
# Development
make up              # Build plugin and start stack (Jellyfin + session server)
make dev             # Start stack and follow logs
make restart-jellyfin # Restart Jellyfin after JS changes
make watch           # Auto-restart on JS file changes

# Build
make build           # Build Jellyfin plugin only
make build-server    # Build Rust server locally
make sync-refs       # Sync Jellyfin DLLs from container (required before plugin build)

# Testing & Quality
make test            # Run Rust tests
make lint            # Run clippy + eslint
make fmt             # Format Rust code
make check           # Fast cargo check

# Observability
make logs            # Follow all logs
make status          # Service status + health checks
make stats           # Container CPU/memory usage
```

## Architecture

### Sync Flow
1. Host sends `player_event` (play/pause/seek) → Server broadcasts with `target_server_ts`
2. Clients use `scheduleAt()` to execute action at synchronized time
3. `syncLoop()` continuously adjusts `playbackRate` to correct drift (non-hosts only)

### Key Mechanisms
- **Clock sync**: NTP-like ping/pong with EMA smoothing for `serverOffsetMs`
- **HLS protection**: `isSyncing` lock prevents feedback loops during buffering
- **Ready system**: Play waits for all clients to be ready (2s timeout)
- **Rate limiting**: 30 msg/sec per client, room limits (3 per user, 20 clients per room)

### WebSocket Messages
- Client → Server: `create_room`, `join_room`, `leave_room`, `ready`, `player_event`, `state_update`, `ping`
- Server → Client: `client_hello`, `room_list`, `room_state`, `player_event`, `state_update`, `pong`, `room_closed`

## Environment Variables

```bash
JELLYFIN_PORT=8096        # Jellyfin web UI port
SESSION_SERVER_PORT=3000  # WebSocket server port
MEDIA_DIR=~/Videos/Movies # Media directory for Jellyfin
JWT_SECRET=               # Enable auth (empty = disabled)
```

## File Naming Conventions

- CSS/HTML IDs: `owp-` prefix (e.g., `#owp-panel`, `.owp-header`)
- JS modules: `state.js`, `utils.js`, `ui.js`, `playback.js`, `ws.js`, `app.js`
- Rust modules: `auth.rs`, `ws.rs`, `room.rs`, `messaging.rs`, `types.rs`, `utils.rs`

## Commit Rules

- **No AI signatures**: Do not add `Co-Authored-By: Claude` or similar AI attribution lines in commits
- **Update documentation**: After making code changes, update relevant documentation in `docs/` if the changes affect user-facing behavior, configuration options, APIs, or architecture
