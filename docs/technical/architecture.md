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
