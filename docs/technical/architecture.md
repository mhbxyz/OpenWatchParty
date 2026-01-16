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
- `main.rs` - Server setup, Warp routes
- `types.rs` - Data structures (Client, Room, Message)
- `ws.rs` - WebSocket handler, message processing
- `room.rs` - Room lifecycle management
- `messaging.rs` - Message sending utilities
- `auth.rs` - JWT validation (optional)

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
- `utils.js` - Utility functions
- `ui.js` - User interface rendering
- `playback.js` - Video binding and sync
- `ws.js` - WebSocket communication
- `app.js` - Application initialization

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
     │     target_ts = T+1500       │    target_ts = T+1500      │
     │                              │                            │
     │         [Wait for T]         │            [Wait for T]    │
     │                              │                            │
     │      video.play()            │              video.play()  │
     │                              │                            │
```

### Leaving a Room (Normal Disconnect)

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

### Host Disconnect (Room Closure)

```
Host                            Server                    Participants
  │                                │                            │
  X (disconnect/leave)             │                            │
  │                                │                            │
                              [Detect disconnect]               │
                              [Close room]                      │
                                   │                            │
                                   ├── room_closed ────────────►│
                                   │                            │
                                   ├── room_list ──────────────►│
                                   │   (room removed)           │
                                   │                            │
                                   │                    [Show notification]
                                   │                    [Return to lobby]
```

## Technology Stack

| Component | Technology |
|-----------|------------|
| Plugin | C# (.NET 9.0), ASP.NET Core |
| Session Server | Rust, Warp, Tokio |
| Web Client | JavaScript (IIFE pattern) |
| Communication | WebSocket, JSON |
| Authentication | JWT (optional) |
| Containerization | Docker, Docker Compose |

## State Management

### Server State

```
Clients: HashMap<ClientId, Client>
Rooms: HashMap<RoomId, Room>

Client {
  sender: UnboundedSender<Message>
  room_id: Option<RoomId>
}

Room {
  room_id: String
  name: String
  host_id: ClientId
  clients: Vec<ClientId>
  ready_clients: HashSet<ClientId>
  pending_play: Option<PendingPlay>
  state: PlaybackState
  last_state_ts: u64
  last_command_ts: u64
}
```

### Client State

```javascript
OSP.state = {
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
- **Authorization**: Only hosts can send playback commands
- **Transport**: WebSocket (ws://) or secure WebSocket (wss://)
- **Rate limiting**: 10 tokens per minute per user
- **Message size**: 64KB maximum

See [Security Guide](../operations/security.md) for detailed security configuration.

## Operational Limits

### Resource Constraints

| Resource | Limit | Configurable |
|----------|-------|--------------|
| Clients per room | 20 | Server constant `MAX_CLIENTS_PER_ROOM` |
| Rooms per user | 3 | Server constant `MAX_ROOMS_PER_USER` |
| Messages per second | 30 | Server constant `RATE_LIMIT_MESSAGES` |
| Message size | 64 KB | Server constant |
| Token requests | 10/min per user | Plugin constant |

### Performance Characteristics

| Metric | Typical Value | Notes |
|--------|---------------|-------|
| Sync accuracy | ±50ms | Under normal network conditions |
| Clock sync precision | ±20ms | After EMA smoothing stabilizes |
| Drift correction range | 0.85x - 2.0x | Playback rate adjustment |
| State update interval | 1000ms | From host to server |
| Sync loop interval | 500ms | Client-side drift check |

## Edge Cases and Behavior

### Multiple Clients Joining Rapidly

When several clients join a room in quick succession:

1. **Server handling**: Each join is processed sequentially with room lock
2. **Participant updates**: Batched within 100ms to avoid message flood
3. **Ready mechanism**: Host's play command waits up to 2s for all clients to be ready
4. **Mitigation**: If clients aren't ready within timeout, play proceeds anyway

**Recommendation**: Allow 2-3 seconds between mass joins for optimal sync.

### Host Network Disconnect

When the host loses connection:

```
Host disconnects
       │
       ▼
Server detects (60s timeout or WebSocket close)
       │
       ▼
Room is closed immediately
       │
       ▼
All participants receive "room_closed" message
       │
       ▼
Clients show "Room closed" notification
Playback continues locally (not synced)
```

**Notes**:
- Rooms cannot survive host disconnect (by design - host owns the room)
- Participants can create a new room to continue
- No automatic host transfer (planned feature)

### Clock Skew Tolerance

The system tolerates significant clock differences between clients:

| Skew Level | Behavior |
|------------|----------|
| < 100ms | Ideal - no noticeable drift |
| 100ms - 500ms | Good - corrected by playback rate adjustment |
| 500ms - 2000ms | Acceptable - noticeable catch-up but functional |
| > 2000ms | Poor - may trigger hard seek, visible jumps |

**Clock sync mechanism**:
- NTP-like ping/pong every 10 seconds
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

**Current limits**:
- 20 clients per room (comfortable for watch parties)
- All state in-memory (lost on server restart)
- Single server instance (no clustering)

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
| Brief disconnect (< 60s) | Can rejoin same room |
| Host reconnects | Must create new room (old room closed) |
| Participant reconnects | Joins as new participant, re-syncs |
| Server restart | All rooms lost, clients reconnect to empty server |

**Auto-reconnect**:
- Client retries every 3 seconds
- Maintains `autoReconnect=true` state
- Shows "Reconnecting..." in UI
