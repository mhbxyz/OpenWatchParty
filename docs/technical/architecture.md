---
title: Architecture
parent: Technical
nav_order: 1
---

# Architecture

## System Overview

OpenWatchParty consists of three main components that work together to provide synchronized media playback.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Jellyfin Server                                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    OpenWatchParty Plugin (C#)                    │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐   │    │
│  │  │  ClientScript   │  │  Configuration  │  │   JWT Token    │   │    │
│  │  │    Endpoint     │  │      Page       │  │    Endpoint    │   │    │
│  │  └─────────────────┘  └─────────────────┘  └────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP (loads JS)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Browser (Jellyfin Web)                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    Web Client (JavaScript)                       │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │    │
│  │  │  State  │ │   UI    │ │Playback │ │   WS    │ │  Utils  │   │    │
│  │  │ Module  │ │ Module  │ │ Module  │ │ Module  │ │ Module  │   │    │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Session Server (Rust)                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────────┐       │
│  │  Room Manager   │  │  Client Handler │  │  Message Router    │       │
│  └─────────────────┘  └─────────────────┘  └────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Jellyfin Plugin (C#)

The plugin integrates with Jellyfin's plugin system.

**Responsibilities:**
- Serve client JavaScript bundle via `/OpenWatchParty/ClientScript`
- Provide configuration UI for JWT settings
- Generate JWT tokens for authenticated users
- Handle HTTP caching with ETag support

**Files:**
- `Plugin.cs` - Plugin entry point, configuration loading
- `OpenWatchPartyController.cs` - REST API endpoints
- `PluginConfiguration.cs` - Configuration model
- `Web/configPage.html` - Admin configuration page
- `Web/plugin.js` - Bundled client JavaScript

### 2. Session Server (Rust)

A lightweight WebSocket server that manages rooms and relays messages.

**Responsibilities:**
- Accept WebSocket connections
- Manage room lifecycle (create, join, leave, close)
- Relay playback events between clients
- Validate host permissions
- Filter state updates (anti-jitter, rate limiting)
- Schedule synchronized actions

**Modules:**
- `main.rs` - Server setup, Warp configuration
- `types.rs` - Data structures (Client, Room, Message)
- `routes.rs` - Warp route filters
- `tasks.rs` - Background tasks (zombie cleanup, shutdown)
- `messaging.rs` - Message sending utilities
- `auth.rs` - JWT validation (optional)
- `utils.rs` - Utilities (timestamp)
- `ws/` - WebSocket handling (connection, dispatch, constants, validation, pending_play, handlers/)
- `room/` - Room lifecycle (leave, close)

### 3. Web Client (JavaScript)

Modular JavaScript injected into Jellyfin's web interface.

**Responsibilities:**
- Inject UI elements (button, panel, home section)
- Manage WebSocket connection to session server
- Intercept video playback events
- Apply synchronized playback commands
- Correct drift with playback rate adjustment
- Synchronize clocks with server

**Modules:**
- `plugin.js` - Loader, script initialization
- `state.js` - Global state and constants
- `utils/` - Utility functions (log, media, misc, time, video)
- `ui/` - User interface (cards, home, indicators, render, styles, toasts)
- `playback/` - Video binding and sync (bind, play, sync)
- `chat/` - Text chat (input, messages)
- `ws/` - WebSocket communication (auth, connection, send, handlers/)
- `app/` - Initialization and cleanup (cleanup, lifecycle)

## Data Flow

### Joining a Room

```
Browser                          Server                      Host Browser
   │                                │                              │
   ├── WebSocket connect ──────────►│                              │
   │◄─── client_hello ──────────────┤                              │
   │◄─── room_list ─────────────────┤                              │
   │                                │                              │
   ├── join_room ──────────────────►│                              │
   │◄─── room_state ────────────────┤                              │
   │                                ├── participants_update ──────►│
   │                                │                              │
   ├── ready ──────────────────────►│                              │
   │                                │                              │
```

### Synchronized Playback

```
Host Browser                     Server                   Client Browser
     │                              │                            │
     ├── player_event (play) ──────►│                            │
     │                              │                            │
     │                         [Validate host]                   │
     │                         [Calculate target_ts]             │
     │                              │                            │
     │◄─── player_event ────────────┼─── player_event ──────────►│
     │     target_ts = T+1000       │    target_ts = T+1000      │
     │                              │                            │
     │         [Wait for T]         │            [Wait for T]    │
     │                              │                            │
     │      video.play()            │              video.play()  │
     │                              │                            │
```

### Leaving a Room (Explicit Leave)

```
Participant                      Server                       Host
     │                              │                           │
     ├── leave_room ───────────────►│                           │
     │                              │                           │
     │                         [Remove from room]               │
     │                         [Update room state]              │
     │                              │                           │
     │                              ├── participants_update ───►│
     │                              │   (count decreased)       │
     │                              │                           │
     │◄─── room_list ───────────────┤                           │
     │                              │                           │
  [Back to lobby]                   │                           │
```

### Host Disconnect (Recovery or Transfer)

```
Host                            Server                    Participants
  │                                │                            │
  X (transport lost)               │                            │
  │                                │                            │
                              [Detect disconnect]               │
                              [Hold eligible host for 10s]      │
                                   │                            │
                              [Recovery or grace expires]       │
                                   │                            │
                                   ├── host_changed ───────────►│
                                   │   (reclaimed/transferred)   │
                                   │                            │
                                   │                    [Update host controls]
```

The grace period requires a JWT-authenticated host with a non-empty user ID
and `host_transfer` support. A new authenticated connection for that user can
reclaim the host role by joining the same room before the expiry task runs.
Otherwise, the first remaining participant in join order that supports host
transfer is promoted; the room closes if none is eligible. Hosts without grace
eligibility follow the transfer-or-close path immediately.

An explicit `leave_room` does not start this grace period. An explicit
`close_room` closes the room for everyone. See [Room lifecycle](server.md#module-room).

## Technology Stack

| Component | Technology |
|-----------|------------|
| Plugin | C# (.NET SDK 10.0.401), ASP.NET Core |
| Session Server | Rust, Warp, Tokio |
| Web Client | JavaScript (IIFE pattern) |
| Communication | WebSocket, JSON |
| Authentication | JWT (optional) |
| Containerization | Docker, Docker Compose |

## State Management

### Server State

```
SharedState = Arc<RwLock<ServerState>>
ServerState {
  clients: HashMap<ClientId, Client>
  rooms: HashMap<RoomId, Room>
}

Client {
  sender: Sender<Message>       // bounded channel
  room_id: Option<RoomId>
  user_id: String
  user_name: String
  authenticated: bool
  message_count: u32
  last_reset: Instant
  last_seen: Instant
}

Room {
  room_id: String
  name: String
  host_id: ClientId
  clients: Vec<ClientId>
  ready_clients: HashSet<ClientId>
  pending_play: Option<PendingPlay>
  state: PlaybackState
  pending_host_reconnect: Option<PendingHostReconnect>
  state_server_ts: u64
  last_state_at: Option<Instant>
  command_cooldown_until: Option<Instant>
}
```

This is an abbreviated view; `types.rs` defines the complete structs. Client
membership and room membership are changed under the same write guard. Socket
writes are handled by each client's bounded sender and writer task.

### Client State

```javascript
OWP.state = {
  ws: WebSocket,
  roomId: string,
  clientId: string,
  isHost: boolean,
  serverOffsetMs: number,
  lastSyncPosition: number,
  lastSyncServerTs: number,
  isSyncing: boolean,
  isBuffering: boolean,
  // ... and more
}
```

## Security Model

- **Authentication**: Optional JWT tokens validated by session server
- **Authorization**: Only hosts can seek or publish state updates. Guests can
  play/pause the room when shared playback control is negotiated for the room.
- **Transport**: WebSocket (ws://) or secure WebSocket (wss://)
- **Rate limiting**: the plugin issues at most 30 tokens per user in a fixed
  one-minute window (`MaxTokensPerMinute`); the session server accepts at most
  30 messages per connection in a fixed window that restarts once more than
  one second has passed (`RATE_LIMIT_MESSAGES`, `RATE_LIMIT_WINDOW_MS`)
- **Message size**: 64KB maximum

See [Security Guide](../operations/security.md) for detailed security configuration.

## Operational Limits

### Resource Constraints

| Resource | Limit | Configurable |
|----------|-------|--------------|
| Clients per room | 20 | Server constant `MAX_CLIENTS_PER_ROOM` |
| Messages per second | 30 | Server constant `RATE_LIMIT_MESSAGES` |
| Message size | 64 KB | Server constant |
| Token requests | 30/min per user | Plugin constant |

### Performance Characteristics

| Metric | Typical Value | Notes |
|--------|---------------|-------|
| Sync accuracy | ±50ms | Under normal network conditions |
| Clock sync precision | ±20ms | After EMA smoothing stabilizes |
| Drift correction range | 0.90x - 1.15x | Playback rate adjustment |
| State update interval | 1000ms | From host to server |
| Sync loop interval | 500ms | Client-side drift check |

## Edge Cases and Behavior

### Multiple Clients Joining Rapidly

When several clients join a room in quick succession:

1. **Server handling**: Membership changes use the shared `ServerState` write lock.
2. **Participant updates**: Joining sends the room state and updated participant
   lists/statuses; these joins are not batched behind a 100ms timer.
3. **Ready mechanism**: A play command waits up to `MAX_READY_WAIT_MS` (2s) for
   every current room member to be ready.
4. **Scheduling**: Once ready, or when the wait expires, play is scheduled
   `PLAY_SCHEDULE_MS` (1s) ahead. Each client applies the server timestamp using
   its clock offset.

### Host Network Disconnect

When the host loses connection:

```
Host disconnects
       │
       ▼
Server detects WebSocket close or stale connection
       │
       ▼
Eligible authenticated host: hold role for 10 seconds
       │
       ▼
Same user rejoins: reclaim host with new connection ID
Otherwise: transfer to first eligible remaining participant
       │
       ▼
No eligible participant: close room and notify members
```

**Notes**:
- Each WebSocket receives a separate client ID, even for the same Jellyfin user.
- The server sends WebSocket control-frame heartbeats every 20s. Browsers answer
  these independently of JavaScript timers in background tabs.
- Zombie cleanup checks every 30s for connections inactive for more than 60s;
  these are detection intervals, not the host recovery window.
- An eligible host's 10s grace begins when the server handles its disconnect.
- Explicit leave transfers immediately; Close room closes for everyone.

### Clock Skew Tolerance

The system tolerates significant clock differences between clients:

| Skew Level | Behavior |
|------------|----------|
| < 100ms | Ideal - no noticeable drift |
| 100ms - 500ms | Good - corrected by playback rate adjustment |
| 500ms - 2000ms | Acceptable - noticeable catch-up but functional |
| > 2000ms | Poor - may trigger hard seek, visible jumps |

**Clock sync mechanism**:
- Application ping/pong every 2s initially, then every 30s after five valid
  clock samples; an offset change greater than 50ms returns to the fast cadence
- Minimum-RTT selection from the last eight samples, followed by EMA smoothing
- EMA smoothing (α=0.4) prevents sudden jumps
- Initial sync uses first measurement directly
- Offset stored in `serverOffsetMs` state

### Buffering and HLS Edge Cases

HLS streaming introduces unique challenges:

| Scenario | Behavior |
|----------|----------|
| Segment loading | `isBuffering=true`, sync paused |
| Seek during buffer | Queued until ready |
| False pause (HLS artifact) | Filtered by buffering check |
| Backward position jump | Ignored if < 2s (HLS noise) |

**Protection mechanisms**:
- `isSyncing` lock (2s) prevents feedback loops
- `readyState >= 3` required before sending updates
- Server-side cooldown (2s) after commands

### Room Capacity and Scaling

**Design limits**:
- 20 clients per room (comfortable for watch parties)
- All state in-memory (rooms are ephemeral by design)
- Single server instance (sufficient for typical use)

**At capacity**:
```
Client attempts join
       │
       ▼
Server checks room.clients.len() >= 20
       │
       ▼
Returns error: "Room is full"
Client shows error message
```

**Performance at scale**:

| Rooms | Clients/Room | Total Clients | Expected Behavior |
|-------|--------------|---------------|-------------------|
| 10 | 5 | 50 | Excellent |
| 50 | 10 | 500 | Good |
| 100 | 15 | 1500 | Acceptable (monitor memory) |
| 200+ | 20 | 4000+ | May need resource limits |

**Bottlenecks**:
1. Memory: ~2KB per client, ~5KB per room
2. CPU: Minimal (message relay, no heavy computation)
3. Network: Proportional to message rate × clients

### Reconnection Behavior

When a client disconnects and reconnects:

| Scenario | Behavior |
|----------|----------|
| Eligible authenticated host rejoins during 10s grace | Reclaims host role with a new client ID |
| Host grace expires | Transfers to first eligible remaining participant, or closes room |
| Participant reconnects | Rejoins with a new client ID and re-syncs if the room still exists |
| Older server without host transfer | Host disconnect closes the room; client does not try to recover it |
| Server restart | All rooms lost, clients reconnect to empty server |

**Auto-reconnect**:
- Transport reconnect uses capped exponential backoff: 1s, 2s, 4s, 8s, 16s,
  then 30s; opening a socket resets the attempt counter
- Maintains `autoReconnect=true` state
- Remembers `desiredRoomId` across an unexpected close, then reauthenticates and
  rejoins; each authentication/rejoin wait has a 5s timeout
- Explicit room leave cancels automatic room rejoin; client cleanup disables
  transport reconnection and cancels pending work
- Blocked authentication uses a separate retry policy; see
  [Client connection lifecycle](client.md#connection-and-room-lifecycle)
