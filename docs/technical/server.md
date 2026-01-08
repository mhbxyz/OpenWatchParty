# Session Server (Rust)

## Overview

The OpenWatchParty session server is an asynchronous Rust application using Warp for WebSocket handling and Tokio as the async runtime. It manages rooms, clients, and playback synchronization in memory.

## Module Structure

```
src/
├── main.rs       # Entry point, Warp configuration
├── types.rs      # Data structures
├── ws.rs         # WebSocket handler and business logic
├── room.rs       # Room lifecycle management
├── messaging.rs  # Message sending functions
├── auth.rs       # JWT authentication (optional)
└── utils.rs      # Utilities (timestamp)
```

## Module: `main.rs`

### Description
Application entry point. Configures the Warp server and routes.

### Main Function

```rust
#[tokio::main]
async fn main() {
    // Thread-safe shared state
    let clients: Clients = Arc::new(Mutex::new(HashMap::new()));
    let rooms: Rooms = Arc::new(Mutex::new(HashMap::new()));

    // WebSocket route: GET /ws
    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(clients_filter)
        .and(rooms_filter)
        .map(|ws, clients, rooms| {
            ws.on_upgrade(|socket| client_connection(socket, clients, rooms))
        });

    // Listen on 0.0.0.0:3000
    warp::serve(ws_route).run(([0, 0, 0, 0], 3000)).await;
}
```

### Global State

| Variable | Type | Description |
|----------|------|-------------|
| `clients` | `Clients` | HashMap of connected clients |
| `rooms` | `Rooms` | HashMap of active rooms |

## Module: `types.rs`

### Description
Defines the data structures used by the server.

### Type Aliases

```rust
pub type Clients = Arc<Mutex<HashMap<String, Client>>>;
pub type Rooms = Arc<Mutex<HashMap<String, Room>>>;
```

### Struct `Client`

Represents a connected WebSocket client.

| Field | Type | Description |
|-------|------|-------------|
| `sender` | `mpsc::UnboundedSender<...>` | Channel for sending messages to client |
| `room_id` | `Option<String>` | Current room ID (if in a room) |

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
| `last_state_ts` | `u64` | No | Last accepted state_update timestamp |
| `last_command_ts` | `u64` | No | Last player_event timestamp (cooldown) |

### Struct `PlaybackState`

Room playback state.

| Field | Type | Description |
|-------|------|-------------|
| `position` | `f64` | Position in seconds |
| `play_state` | `String` | `"playing"` or `"paused"` |

### Struct `PendingPlay`

Pending play action waiting for all clients to be ready.

| Field | Type | Description |
|-------|------|-------------|
| `position` | `f64` | Position to start at |
| `created_at` | `u64` | Creation timestamp |

### Struct `WsMessage`

WebSocket message format.

| Field | Type | JSON Key | Description |
|-------|------|----------|-------------|
| `msg_type` | `String` | `"type"` | Message type |
| `room` | `Option<String>` | `"room"` | Room ID |
| `client` | `Option<String>` | `"client"` | Sender client ID |
| `payload` | `Option<Value>` | `"payload"` | Message data |
| `ts` | `u64` | `"ts"` | Client timestamp |
| `server_ts` | `Option<u64>` | `"server_ts"` | Server timestamp |

## Module: `ws.rs`

### Description
Handles WebSocket connections and main business logic.

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `PLAY_SCHEDULE_MS` | 1500 | Delay before play execution (ms) |
| `CONTROL_SCHEDULE_MS` | 300 | Delay before pause/seek execution (ms) |
| `MAX_READY_WAIT_MS` | 2000 | Max wait time for ready clients (ms) |
| `MIN_STATE_UPDATE_INTERVAL_MS` | 500 | Min interval between state updates (ms) |
| `POSITION_JITTER_THRESHOLD` | 0.5 | Position noise threshold (seconds) |
| `COMMAND_COOLDOWN_MS` | 2000 | Cooldown after player_event (ms) |
| `MAX_MESSAGE_SIZE` | 65536 | Maximum message size (64 KB) |

### Function `client_connection`

Manages a client connection lifecycle.

```rust
pub async fn client_connection(ws: WebSocket, clients: Clients, rooms: Rooms) {
    // 1. Split WebSocket into sender/receiver
    let (client_ws_sender, mut client_ws_rcv) = ws.split();

    // 2. Create mpsc channel for async sending
    let (client_sender, client_rcv) = mpsc::unbounded_channel();

    // 3. Task to forward messages to WebSocket
    tokio::spawn(async move {
        client_rcv.forward(client_ws_sender).await;
    });

    // 4. Generate UUID for client
    let client_id = Uuid::new_v4().to_string();

    // 5. Register client
    clients.lock().unwrap().insert(client_id, Client { sender, room_id: None });

    // 6. Send client_hello with ID
    send_to_client(&client_id, &WsMessage {
        msg_type: "client_hello",
        payload: { "client_id": client_id }
    });

    // 7. Send room list
    send_room_list(&client_id, &clients, &rooms);

    // 8. Message receive loop
    while let Some(msg) = client_ws_rcv.next().await {
        client_msg(&client_id, msg, &clients, &rooms).await;
    }

    // 9. Cleanup on disconnect
    handle_disconnect(&client_id, &clients, &rooms);
}
```

### Function `all_ready`

Checks if all clients in a room are ready.

```rust
fn all_ready(room: &Room) -> bool {
    room.ready_clients.len() >= room.clients.len()
}
```

### Function `broadcast_scheduled_play`

Broadcasts a scheduled play event to all participants.

```rust
fn broadcast_scheduled_play(room: &mut Room, clients: &Clients, position: f64, target_server_ts: u64) {
    // 1. Update room state
    room.state.position = position;
    room.state.play_state = "playing";

    // 2. Create message with target_server_ts
    let msg = WsMessage {
        msg_type: "player_event",
        payload: { "action": "play", "position": position, "target_server_ts": target_server_ts },
        server_ts: target_server_ts
    };

    // 3. Broadcast to all room clients
    broadcast_to_room(room, &clients, &msg, None);
}
```

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
Removes client from room; closes room if host leaves.

#### `player_event`
Validates host permissions, applies action, broadcasts to room.

#### `state_update`
Applies filtering (cooldown, rate limit, jitter), broadcasts if accepted.

#### `ping`
Responds with `pong` for latency measurement.

## Module: `room.rs`

### Description
Manages room lifecycle and client disconnection.

### Function `handle_disconnect`

Called when a client disconnects.

```rust
pub fn handle_disconnect(client_id: &str, clients: &Clients, rooms: &Rooms) {
    // 1. Remove client from their room
    handle_leave(client_id, &mut clients, &mut rooms);

    // 2. Remove client from the list
    clients.remove(client_id);

    // 3. Update room list for all
    broadcast_room_list(clients, rooms);
}
```

### Function `handle_leave`

Removes a client from a room.

```rust
pub fn handle_leave(client_id: &str, clients: &mut HashMap, rooms: &mut HashMap) {
    if let Some(room_id) = client.room_id.take() {
        if let Some(room) = rooms.get_mut(&room_id) {
            // Remove client
            room.clients.retain(|id| id != client_id);
            room.ready_clients.remove(client_id);

            // If host, cancel pending_play
            if room.host_id == client_id {
                room.pending_play = None;
            }

            // Close room if empty or host leaves
            if room.clients.is_empty() || room.host_id == client_id {
                for cid in &room.clients {
                    send_to_client(cid, { "type": "room_closed" });
                }
                rooms.remove(&room_id);
            } else {
                broadcast_to_room(room, { "type": "client_left", "client": client_id });
            }
        }
    }
}
```

## Module: `messaging.rs`

### Description
Message sending utility functions.

### Functions

- `send_room_list(client_id, clients, rooms)` - Send room list to specific client
- `broadcast_room_list(clients, rooms)` - Send room list to all clients
- `send_to_client(client_id, clients, msg)` - Send message to specific client
- `broadcast_to_room(room, clients, msg, exclude)` - Broadcast to room members
- `send_error(client_id, clients, message)` - Send error message

## Module: `auth.rs`

### Description
Optional JWT authentication.

### Validation

```rust
pub fn validate_token(token: &str, secret: &str) -> Result<Claims, Error> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;  // Enforce expiration
    validation.leeway = 60;  // 60 seconds tolerance

    decode::<Claims>(token, &DecodingKey::from_secret(secret.as_ref()), &validation)
}
```

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
│                   Arc<Mutex<Clients>>                            │
│                   Arc<Mutex<Rooms>>                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Design Considerations

1. **Mutex blocking**: Operations on `clients` and `rooms` are short and synchronous
2. **No deadlock**: Only one lock acquired at a time per handler
3. **Message cloning**: `warp_msg.clone()` for efficient broadcasting
4. **Unbounded channels**: No backpressure, suitable for low message volume
