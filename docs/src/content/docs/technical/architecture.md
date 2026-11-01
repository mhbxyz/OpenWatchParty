---
title: "Architecture"
---

<span id="architecture" class="legacy-anchor"></span>

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

The plugin integrates with Jellyfin's plugin system. It serves a JavaScript loader at `/OpenWatchParty/ClientScript` and allow-listed modules under `/OpenWatchParty/Client/{path}`, provides the administrator configuration page and diagnostics, and issues session tokens. The loader fetches 39 client modules in dependency waves; the module files are not concatenated into the loader response.

**Files:**
- `Plugin.cs` - Plugin entry point and configuration page registration
- `Controllers/` - Client assets, token, diagnostics and signing-key endpoints
- `Configuration/PluginConfiguration.cs` - Administrator settings
- `OpenWatchPartyDiagnosticsService.cs` - Redacted status and session health checks
- `Web/configPage.html` - Administrator configuration page
- `src/clients/jellyfin-web/plugin.js` - Client loader

### 2. Session Server (Rust)

A lightweight WebSocket server that manages rooms and relays messages.

**Responsibilities:**
- Accept WebSocket connections
- Manage room lifecycle (create, join, leave, close)
- Relay playback events between clients
- Validate host permissions
- Filter state updates (anti-jitter and per-connection message limits)
- Schedule synchronized actions and pending plays
- Negotiate optional host transfer, participant status, shared guest controls and media queue capabilities
- Maintain a count-bounded room queue and server-side up-next countdown

**Modules:**
- `main.rs` - Server setup, Warp configuration
- `types.rs` - Data structures (Client, Room, Message)
- `routes.rs` - Warp route filters
- `tasks.rs` - Background tasks (zombie cleanup, shutdown)
- `messaging.rs` - Message sending utilities
- `auth.rs` - JWT validation and invite-ticket validation
- `utils.rs` - Timestamp and shared utilities
- `ws/` - WebSocket connection, dispatch, validation, pending play and handlers
- `room/` - Membership, room closure and media queue state

### 3. Web Client (JavaScript)

The Jellyfin Web client consists of the `plugin.js` loader and 39 allow-listed JavaScript modules, injected by the plugin.

**Responsibilities:**
- Inject UI elements (button, panel, home section)
- Manage WebSocket connection to session server
- Intercept video playback events
- Apply synchronized playback commands
- Correct drift with playback rate adjustment
- Synchronize clocks with the server
- Negotiate optional protocol capabilities and report participant status
- Support a host-controlled media queue and a local guest sync adjustment

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
   ├── auth (JWT by default) ──────►│                              │
   ├── ping (clock sample) ────────►│                              │
   │◄─── auth_success ──────────────┤                              │
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
`close_room` closes the room for everyone. See [Room lifecycle](/technical/server/#module-room).

## Technology Stack

| Component | Technology |
|-----------|------------|
| Plugin | C# (`net10.0`), Jellyfin 12 packages, target ABI `12.0.0.0`, ASP.NET Core |
| Session Server | Rust, Warp, Tokio |
| Web Client | JavaScript (IIFE pattern) |
| Communication | WebSocket, JSON |
| Authentication | JWT required by default; insecure no-auth mode requires explicit server configuration |
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
  statuses: HashMap<ClientId, ParticipantStatus>
  queue: MediaQueue  // includes up-next countdown and last_added cursor
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

- **Authentication**: JWT authentication is required unless the server is explicitly configured for insecure development mode.
- **Authorization**: Only hosts can seek, publish `state_update`, close the room or mutate its queue. Guest play/pause is available only when both the guest and current host negotiated `shared_playback_control`.
- **Transport**: WebSocket (ws://) or secure WebSocket (wss://)
- **Rate limiting**: JWT issuance is limited to 30 requests per user per fixed
  one-minute window; the insecure no-token response bypasses that limiter. The
  session server accepts at most 30 messages per connection in a one-second
  window (`RATE_LIMIT_MESSAGES`, `RATE_LIMIT_WINDOW_MS`).
- **Message size**: WebSocket messages are limited to 64 KiB.

See [Security Guide](/operations/security/) for detailed security configuration.

## Operational Limits

### Resource Constraints

| Resource | Bound | Notes |
|----------|-------|-------|
| Participants per room | 20 | `MAX_CLIENTS_PER_ROOM` |
| Queued media items per room | 20 | `MAX_QUEUE_ITEMS`; count bound only, not a byte or process-memory budget |
| WebSocket message | 64 KiB | `MAX_MESSAGE_SIZE` |
| Client messages | 30 per one-second window | Per connection; `RATE_LIMIT_MESSAGES` and `RATE_LIMIT_WINDOW_MS` |
| JWT requests | 30 per user per fixed minute | Plugin token issuance only; insecure no-token responses do not consume this limit |

The queue item cap bounds item count only; it is not a bound on serialized queue bytes or total process RSS. Message-size and participant limits are separate controls.

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
- Explicit leave immediately transfers the host role to an eligible participant, or closes the room if none is eligible; Close room closes for everyone.

### Clock Offset and Playback Drift

Client wall clocks can differ substantially. `client_hello` and pre-auth JSON
ping/pong estimate each client's offset from server time; absolute wall-clock
skew alone does not determine playback drift. The client keeps the lowest-RTT
sample among its latest eight and applies EMA smoothing (α=0.4). It pings every
2 seconds until five valid samples, then every 30 seconds; an offset change
above 50 ms restarts the fast cadence.

Playback correction uses the room's expected position, not a clock-skew band:

| Playback drift | Behavior |
|----------------|----------|
| Below 0.04 s | Reset playback rate to 1.0 |
| 0.04 s to below 2 s | Adjust playback rate, clamped to 0.90–1.15 |
| 2 s or more | Seek to expected position after the initial-sync cooldown; during that cooldown, only drift above 10 s forces the seek |
| Buffering or video not ready | Defer playback correction |

### Buffering and HLS Edge Cases

The client gates host state reports while buffering or while video readiness is
below `readyState` 3. The server filters unchanged-state position updates when
they are backward by 0.5–2 seconds or forward by less than 0.5 seconds, and
applies a 500 ms minimum state-update interval. After a playback command, a
monotonic 2 second cooldown filters unchanged-state updates; play-state changes
are accepted unless they conflict with the hold for an accepted guest command.
These intervals are separate from the client's 8 second join sync cooldown and
10 second initial-sync drift threshold.

### Room Capacity and Scaling

**Design limits**:
- 20 clients per room
- 20 queued media items per room
- All state is in memory; rooms are ephemeral and a server restart removes them
- This design is a single server process; no distributed room state is described here

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
  then 30s; an authenticated connection resets the attempt counter (a socket
  that opens but fails authentication does not)
- Maintains `autoReconnect=true` state
- Remembers `desiredRoomId` across an unexpected close, then reauthenticates and
  rejoins; each authentication/rejoin wait has a 5s timeout
- Explicit room leave cancels automatic room rejoin; client cleanup disables
  transport reconnection and cancels pending work
- Blocked authentication uses a separate retry policy; see
  [Client connection lifecycle](/technical/client/#connection-and-room-lifecycle)
