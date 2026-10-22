---
title: "Session Server (Rust)"
---

<span id="session-server-rust" class="legacy-anchor"></span>

## Overview

The OpenWatchParty 0.7.0 session server is an asynchronous Rust application using Warp for WebSocket handling and Tokio as the async runtime. The pinned Rust toolchain/MSRV is 1.88.0. It manages rooms, clients, playback synchronization, participant status and media queues in memory.

## Module Structure

```
src/
├── main.rs           # Entry point, Warp configuration
├── types.rs          # Data structures
├── routes.rs         # Warp route filters
├── tasks.rs          # Background tasks (zombie cleanup, shutdown)
├── messaging.rs      # Message sending functions
├── auth.rs           # JWT and invite-ticket validation
├── trust.rs          # Versioned public-key trust store
├── metrics.rs        # Prometheus counters and readiness state
├── utils.rs          # Utilities (timestamp)
├── ws/
│   ├── mod.rs
│   ├── connection.rs     # WebSocket connection lifecycle
│   ├── dispatch.rs       # Message dispatching and error sending
│   ├── constants.rs      # Protocol constants and limits
│   ├── validation.rs     # Message validation
│   ├── pending_play.rs   # Pending play logic
│   └── handlers/
│       ├── mod.rs
│       ├── auth.rs       # Authentication handler
│       ├── chat.rs       # Chat message handler
│       ├── create.rs     # Room creation
│       ├── join.rs       # Room joining
│       ├── misc.rs       # Ping, list_rooms, etc.
│       ├── playback.rs   # player_event, state_update, ready
│       ├── status.rs     # participant_status
│       └── queue.rs      # Room queue messages and the up-next countdown
└── room/
    ├── mod.rs
    ├── leave.rs          # Client leave / disconnect and host recovery
    ├── close.rs          # Room closure
    ├── participants.rs   # Participant list/status and room capabilities
    └── queue.rs          # Room queue list operations
```

## Module: `main.rs`

### Description
Application entry point. Configures the Warp server and routes.

### Shared State Initialization

```rust
let state: SharedState = Arc::new(RwLock::new(ServerState::default()));
let app_tasks = tasks::AppTasks::new();
```

`main.rs` passes this state, JWT configuration, origin/ingress configuration and
the task tracker to `routes::build_routes`. It starts heartbeat and zombie
cleanup tasks and coordinates their cancellation with graceful server shutdown.
`HOST` and `PORT` default to `0.0.0.0` and `3000`. `rust-toolchain.toml` pins
Rust 1.88.0.

### Global State

| Variable | Type | Description |
|----------|------|-------------|
| `state` | `SharedState` | One lock protecting both connected clients and active rooms |
| `app_tasks` | `AppTasks` | Tracks application tasks and provides shutdown cancellation |

## Module: `types.rs`

### Description
Defines the data structures used by the server.

### Type Aliases

```rust
pub type SharedState = Arc<RwLock<ServerState>>;

pub struct ServerState {
    pub clients: HashMap<String, Client>,
    pub rooms: HashMap<String, Room>,
}
```

### Struct `Client`

Represents a connected WebSocket client.

| Field | Type | Description |
|-------|------|-------------|
| `sender` | `mpsc::Sender<...>` | Bounded channel for sending messages to client |
| `room_id` | `Option<String>` | Current room ID (if in a room) |
| `user_id` | `String` | Jellyfin user ID (empty until identity is established) |
| `user_name` | `String` | Display name |
| `authenticated` | `bool` | Whether the client has authenticated |
| `session_expires_at` | `Option<u64>` | JWT expiration in Unix seconds; absent in insecure mode |
| `authentication_version` | `u64` | Identifies the current authentication generation |
| `supports_host_transfer` | `bool` | Negotiated host-transfer capability |
| `supports_shared_playback_control` | `bool` | Negotiated shared-control capability |
| `supports_media_queue` | `bool` | Negotiated room-queue capability: the client gets `queue_state` |
| `message_count` | `u32` | Messages sent in current rate-limit window |
| `last_reset` | `Instant` | Monotonic time of last rate-limit window reset |
| `last_seen` | `Instant` | Monotonic time of last activity (for zombie detection) |

### Struct `Room`

Represents a watch party room.

| Field | Type | Serialized | Description |
|-------|------|------------|-------------|
| `room_id` | `String` | Yes | Unique identifier (UUID) |
| `name` | `String` | Yes | Display name |
| `host_id` | `String` | Yes | Host client ID |
| `media_id` | `Option<String>` | Yes | Jellyfin media ID |
| `clients` | `Vec<String>` | Yes | Participant client IDs |
| `ready_clients` | `HashSet<String>` | Yes | Clients ready to receive play |
| `pending_play` | `Option<PendingPlay>` | Yes | Pending play action |
| `state` | `PlaybackState` | Yes | Current playback state |
| `pending_host_reconnect` | `Option<PendingHostReconnect>` | No | Authenticated user ID and generation for host recovery |
| `state_server_ts` | `u64` | No | Wall-clock timestamp of the canonical playback state |
| `target_server_ts` | `Option<u64>` | No | Wall-clock timestamp of a scheduled action |
| `target_at` | `Option<Instant>` | No | Monotonic deadline for the scheduled action |
| `last_state_at` | `Option<Instant>` | No | Monotonic time of the last accepted update |
| `command_cooldown_until` | `Option<Instant>` | No | Deadline suppressing stale state updates after commands |
| `statuses` | `HashMap<String, &'static str>` | No | Last participant status by client ID |
| `status_broadcast` | `StatusBroadcast` | No | Participant-status broadcast scheduling |
| `guest_command_until` | `Option<Instant>` | No | Deadline protecting a guest command from stale host state |
| `queue` | `MediaQueue` | No | Queued items, the up-next countdown and the generation of the pending play the last advance armed; the current item is `media_id` |

### Struct `PlaybackState`

Room playback state.

| Field | Type | Description |
|-------|------|-------------|
| `position` | `f64` | Position in seconds |
| `play_state` | `PlayState` | `"playing"` or `"paused"` |

### Struct `PendingPlay`

Pending play action waiting for all clients to be ready.

| Field | Type | Description |
|-------|------|-------------|
| `position` | `f64` | Position to start at |
| `initiator_id` | `String` | Client that requested play; not serialized |
| `generation` | `u64` | Identifies the pending action; not serialized |
| `position_ts` | `u64` | Timestamp associated with the pending position |

### Struct `WsMessage`

WebSocket message format.

| Field | Type | JSON Key | Description |
|-------|------|----------|-------------|
| `msg_type` | `ServerMessageType` | `"type"` | Message type |
| `room` | `Option<String>` | `"room"` | Room ID |
| `client` | `Option<String>` | `"client"` | Sender client ID |
| `payload` | `Option<Value>` | `"payload"` | Message data |
| `ts` | `u64` | `"ts"` | Client timestamp |
| `server_ts` | `Option<u64>` | `"server_ts"` | Server timestamp |

### Outgoing wire types

`WsMessage` uses `ServerMessageType` for the 17 current server message kinds.
Serde preserves their existing snake_case names; `as_str` supplies the same labels
for metrics and logging. `IncomingMessage` remains separate and retains its
unknown-client-type handling.

`PlaybackState` shares the two-case `PlayState` with validated playback payloads.
Scheduled controls use `ScheduledPlayerEventPayload` with position, canonical
play state, action, and target timestamp; the room list uses `RoomListEntry` and
keeps `media_id: null` for rooms without media. Other payloads remain contextual
JSON in this stage. Optional envelope fields keep their omission rules, and
protocol version 1 and feature negotiation remain unchanged.

## Module: `ws/`

### Description
Handles WebSocket connections and main business logic. Split into sub-modules: `connection.rs` (lifecycle), `dispatch.rs` (message routing), `constants.rs` (protocol constants), `validation.rs` (message validation), `pending_play.rs` (play scheduling), and `handlers/` (per-message-type logic).

### Constants (`ws/constants.rs`)

| Constant | Value | Description |
|----------|-------|-------------|
| `PLAY_SCHEDULE_MS` | 1000 | Delay before play execution (ms) |
| `CONTROL_SCHEDULE_MS` | 300 | Delay before pause/seek execution (ms) |
| `MAX_READY_WAIT_MS` | 2000 | Max wait time for ready clients (ms) |
| `MIN_STATE_UPDATE_INTERVAL_MS` | 500 | Min interval between state updates (ms) |
| `POSITION_JITTER_THRESHOLD` | 0.5 | Position noise threshold (seconds) |
| `COMMAND_COOLDOWN_MS` | 2000 | Cooldown after player_event (ms) |
| `MAX_MESSAGE_SIZE` | 65536 | Maximum message size (64 KB) |

### Function `client_connection`

Manages a WebSocket using `SharedState`, JWT configuration and `AppTasks`:

1. Split the socket and create bounded message/control channels through
   `ClientSender::channel(CLIENT_CHANNEL_BUFFER)`.
2. Register a UUID for this connection, independently of its Jellyfin user ID.
3. Start the supervised writer and send `client_hello` and the room list.
4. Process incoming messages, control-frame activity, session expiration,
   writer termination and server cancellation.
5. On termination, remove this client through `handle_disconnect`, then shut
   down the writer with a bounded wait.

### Function `all_ready`

Checks if all clients in a room are ready.

```rust
fn all_ready(room: &Room) -> bool {
    room.clients
        .iter()
        .all(|client_id| room.ready_clients.contains(client_id))
}
```

### Function `prepare_scheduled_play`

Updates the room's canonical state and scheduling deadlines, consumes its
pending play and returns the sender list and `player_event` message. The event
retains the initiating guest's client ID when shared control is enabled.
Callers enqueue the message through `send_to_senders`.

`schedule_pending_play` waits up to `MAX_READY_WAIT_MS` and checks the pending
generation before applying it. Obsolete or cancelled tasks do not start a
replacement action.

### Message Processing

The `client_msg` function handles incoming messages based on type:

#### `list_rooms`
Sends room list to the client.

#### `create_room`
Creates a new room with the sender as host.

#### `join_room`
Adds client to an existing room.

#### `ready`
Marks client as ready; triggers pending play if all ready.

#### `leave_room`
Removes the client. A host's explicit leave transfers immediately to the first
eligible remaining participant, or closes the room if transfer is unavailable.

#### `close_room`
Closes the room for everyone; only its host may request this.

#### `player_event`
Validates permissions, applies the action and broadcasts canonical results.
Seek is host-only; guest play/pause requires negotiated room shared control.

#### `state_update`
Applies filtering (cooldown, rate limit, jitter), broadcasts if accepted.

#### `ping`
Responds with `pong` for latency measurement and clock offset. This handler is
available before authentication: clients can initialize their clock while JWT
authentication is still pending. The response copies only a valid unsigned
64-bit `payload.client_ts`; it omits `payload` when the timestamp is missing or
malformed and never reflects request `room`, `client` or other payload fields.
The server timestamp is carried in the pong envelope.

#### `queue_add`, `queue_remove`, `queue_move`, `queue_advance`, `queue_countdown`
Host only. Change the server-authoritative room queue and send `queue_state`
only to members that negotiated `media_queue`. Protocol version stays 1 because
the capability and queue message are additive. The queue holds at most 20 items
by count; this is not a byte-size or process-memory bound. An advance, including
one triggered when a countdown ends, moves the room to the item at position 0,
clears readiness as appropriate, arms a pending play and announces the move
with `room_state`. `last_added` persists after its item is removed so episode
filling does not restore an item removed by the host. The pending-play generation
keeps old host events from changing the new item's initial state while members
load it. Countdown generations prevent a canceled or replaced timer from
advancing the room. See [Room queue](/technical/protocol/#room-queue).

## Module: `room/`

### Description
Manages room lifecycle and client disconnection. Split into `leave.rs` (client leave/disconnect) and `close.rs` (room closure).

### Function `handle_disconnect`

Called when a connection terminates. It takes a shared-state write guard and
removes that connection's membership and client registration together.

A JWT-authenticated host with a non-empty user ID and host-transfer support
gets a 10-second recovery window. The room records the user ID and a generation,
removes the old connection from membership, cancels pending play and notifies
remaining members. A new authenticated connection for the same user can reclaim
the host role through `join_room` while that generation is pending. It receives
a new client ID; the old ID is not reused.

The tracked expiry task promotes the first remaining client in join order
that supports host transfer, or closes the room if none exists. Hosts that do
not qualify for recovery follow the leave/transfer path immediately. A stale
expiry generation cannot change an already recovered room.

### Function `handle_leave`

Explicit leave removes membership, readiness and participant status, without
starting host recovery. Guest leave preserves the existing host. Host leave
cancels pending play and promotes an eligible remaining client, or closes the
room. Empty rooms close unless they are holding a pending host recovery.

`handle_leave_without_transfer` is used when switching rooms: it does not leave
the previous room to a replacement host. `close_room` is the separate
host-authorized operation that closes the room for all members.

## Module: `messaging.rs`

### Description
Message sending utility functions.

### Functions

- `send_room_list(client_id, state)` - Send room list to a specific client
- `broadcast_room_list(state)` - Send room list to all clients
- `send_to_client(client_id, state, msg)` - Send a message to a specific client
- `collect_room_senders(room, clients, exclude)` - Snapshot room senders under a state guard
- `send_to_senders(senders, msg, context)` - Enqueue a message for those senders
- `send_error(client_id, state, code, message)` in `ws/dispatch.rs` - Send a protocol error

## Module: `auth.rs`

### Description
Optional JWT authentication.

### Validation

`JwtConfig` validates HS256 or RS256 tokens according to the configured auth
mode, keys/trust store, issuer and audience. Expiration is enforced at the exact
Unix second with no clock leeway. The connection also tracks session expiration
after authentication, so an idle socket does not retain access after its token
expires. JSON `ping` is handled before auth; other room operations require an
authenticated or explicitly insecure-mode connection.

## Concurrency Model

```
┌──────────────────────────────────────────────────────────────────┐
│                        Tokio Runtime                             │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐     │
│  │  Task: Client1 │  │  Task: Client2 │  │  Task: Client3 │     │
│  │  WebSocket     │  │  WebSocket     │  │  WebSocket     │     │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘     │
│          │                   │                   │               │
│          └───────────────────┼───────────────────┘               │
│                              │                                   │
│                              ▼                                   │
│                 Arc<RwLock<ServerState>>                         │
│                 clients + rooms under one lock                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Design Considerations

1. **RwLock**: Read-heavy workload; multiple readers, exclusive writer
2. **Atomic membership**: A write guard covers both client and room maps;
   callers pass mutable map references to helpers instead of acquiring another
   room lock
3. **Socket isolation**: Handlers enqueue through bounded `ClientSender`
   channels; each connection's writer performs the socket writes
4. **Task lifetime**: `AppTasks` tracks heartbeat, cleanup, pending actions and
   recovery deadlines with cancellation and bounded graceful shutdown
