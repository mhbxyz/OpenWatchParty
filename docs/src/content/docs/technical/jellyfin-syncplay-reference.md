---
title: "Jellyfin SyncPlay Reference"
---

<span id="jellyfin-syncplay-reference" class="legacy-anchor"></span>

:::note[Historical reference]
This document preserves a historical reference snapshot of Jellyfin's native SyncPlay material checked in January 2026; it is not a statement about later Jellyfin releases. The OpenWatchParty comparison rows reflect product 0.7.0 and protocol 1 as of October 2026.
:::

## Overview

Jellyfin SyncPlay is the built-in synchronized playback feature that allows multiple users to watch content together. Understanding its architecture helps inform design decisions for OpenWatchParty.

**Key differences from OpenWatchParty:**

| Aspect | Jellyfin SyncPlay | OpenWatchParty |
|--------|-------------------|----------------|
| Architecture | Integrated into Jellyfin | Standalone plugin + server |
| Transport | REST API + Jellyfin messages | Dedicated WebSocket |
| Time sync | Min-delay selection | Lowest-RTT of eight samples, then EMA smoothing |
| Server | C# (same as Jellyfin) | Rust |
| Client support | All official clients | Web only (currently) |

## Source Code Locations

### Server (C#)

Repository: [jellyfin/jellyfin](https://github.com/jellyfin/jellyfin)

```
Emby.Server.Implementations/SyncPlay/
├── SyncPlayManager.cs      # Main orchestrator
└── Group.cs                # Group/room management

MediaBrowser.Controller/SyncPlay/
├── ISyncPlayManager.cs     # Main interface
├── IGroupState.cs          # State machine interface
├── IGroupStateContext.cs   # State context
├── IGroupPlaybackRequest.cs
├── ISyncPlayRequest.cs
├── GroupMember.cs          # Participant model
├── GroupStates/            # State implementations
├── PlaybackRequests/       # Command handlers
├── Queue/                  # Queue management
└── Requests/               # Request types
```

### Client (JavaScript/TypeScript)

Repository: [jellyfin/jellyfin-web](https://github.com/jellyfin/jellyfin-web)

```
src/plugins/syncPlay/
├── plugin.ts               # Plugin entry point
├── ui/                     # UI components
└── core/
    ├── Manager.js          # Main orchestrator
    ├── Controller.js       # Control flow
    ├── PlaybackCore.js     # Playback synchronization
    ├── QueueCore.js        # Queue management
    ├── Helper.js           # Utilities
    ├── Settings.js         # Configuration
    ├── index.js            # Module exports
    ├── players/            # Player-specific implementations
    └── timeSync/
        ├── TimeSync.js         # Base sync algorithm
        ├── TimeSyncCore.js     # Facade/conversions
        └── TimeSyncServer.js   # Server ping implementation
```

## Time Synchronization Algorithm

### Overview

SyncPlay uses an **NTP-like algorithm** with **min-delay selection** (not averaging).

### Four Timestamps

Each ping collects four timestamps:

| Timestamp | Source | Description |
|-----------|--------|-------------|
| `requestSent` | Client | Before API call |
| `requestReceived` | Server | When request arrives |
| `responseSent` | Server | When response leaves |
| `responseReceived` | Client | After response arrives |

### Offset Calculation

```javascript
// NTP-like formula
offset = ((requestReceived - requestSent) + (responseSent - responseReceived)) / 2
```

This assumes symmetric network latency and accounts for server processing time.

### Round-Trip Delay

```javascript
delay = (responseReceived - requestSent) - (responseSent - requestReceived)
//       └── total round trip ──────────┘   └── server processing time ──┘
```

### Min-Delay Selection Strategy

Instead of averaging or EMA smoothing, SyncPlay:

1. Maintains a **sliding window of 8 measurements**
2. Sorts measurements by round-trip delay (lowest first)
3. Selects the measurement with **minimum delay** as the best estimate

**Rationale:** Measurements with minimal latency are assumed to be most accurate, as network jitter typically adds delay rather than reducing it.

### Polling Intervals

| Phase | Interval | Trigger |
|-------|----------|---------|
| Greedy | 1000ms | Initial sync |
| Low-profile | 60000ms | After 3 successful pings |

```javascript
const NumberOfTrackedMeasurements = 8;
const PollingIntervalGreedy = 1000;      // 1 second
const PollingIntervalLowProfile = 60000; // 60 seconds
const GreedyPingCount = 3;
```

### Time Conversion

```javascript
// TimeSyncCore.js
// Server time → Local time
localTime = serverTime - extraTimeOffset;

// Local time → Server time
serverTime = localTime + extraTimeOffset;

// Total offset includes user-configurable adjustment
totalOffset = timeSyncServer.getTimeOffset() + extraTimeOffset;
```

## Playback Synchronization

### PlaybackCore.js

Manages synchronized playback with two correction strategies:

#### 1. SpeedToSync

Adjusts playback rate to catch up gradually:

```javascript
// Activates when drift is within thresholds
if (drift >= minDelaySpeedToSync && drift <= maxDelaySpeedToSync) {
    // Adjust playback rate between 0.2x and 2.0x
    // Corrects within configurable duration
}
```

**Characteristics:**
- Smooth, imperceptible correction
- Works when player supports `playbackRate`
- Limited correction range

#### 2. SkipToSync

Direct seek to correct position:

```javascript
// Activates when drift exceeds threshold
if (drift > minDelaySkipToSync) {
    player.seek(estimatedServerPosition);
}
```

**Characteristics:**
- Immediate correction
- Visible jump in playback
- Used for large drifts

### Local Control Methods

```javascript
localUnpause()  // Resume playback
localPause()    // Pause playback
localSeek(ticks) // Seek to position (in ticks)
localStop()     // Stop playback
```

### Drift Calculation

```javascript
// Expected position based on server sync
const expected = lastSyncPosition + (now - lastSyncTime);

// Actual player position
const actual = player.currentTime;

// Drift to correct
const drift = expected - actual;
```

## Manager Coordination

### Initialization Flow

```
1. SyncPlay enabled
2. timeSyncCore.forceUpdate()
3. Wait for 'time-sync-server-update' event
4. syncPlayReady = true
5. Process queued commands
```

### Event Categories

#### 1. Group Updates (`processGroupUpdate`)

Handles:
- User join/leave notifications
- Queue changes
- Group state transitions ("GroupJoined", "UserLeft", "PlayQueue")

#### 2. Playback Commands (`processCommand`)

Command structure:
```javascript
{
    Command: "Play" | "Pause" | "Seek",
    When: serverTimestamp,      // Execution time
    PositionTicks: number,      // Position in ticks
    PlaylistItemId: string      // Queue item ID
}
```

Processing:
1. Validate command isn't stale (`When > syncPlayEnabledAt`)
2. Verify playlist alignment
3. Queue if not ready, otherwise execute
4. Delegate to `playbackCore.applyCommand()`

#### 3. State Changes (`processStateChange`)

Handles group state modifications and emits events to observers.

### Command Flow

```
Server API Call
     ↓
Manager.processCommand()
     ↓
Validate timing & playlist
     ↓
playbackCore.applyCommand()
     ↓
Schedule execution at 'When' timestamp
     ↓
Player executes action
```

## Communication Protocol

### Transport

SyncPlay uses Jellyfin's existing infrastructure:
- **REST API** for time sync (`apiClient.getServerTime()`)
- **Jellyfin message system** for commands (WebSocket-based but shared with other features)

### API Endpoints

```
GET /SyncPlay/Time          # Get server time (for sync)
POST /SyncPlay/New          # Create group
POST /SyncPlay/Join         # Join group
POST /SyncPlay/Leave        # Leave group
POST /SyncPlay/Play         # Send play command
POST /SyncPlay/Pause        # Send pause command
POST /SyncPlay/Seek         # Send seek command
POST /SyncPlay/SetPlaylist  # Set queue
```

### Server Time Response

```json
{
    "RequestReceptionTime": "2024-01-15T10:30:00.123Z",
    "ResponseTransmissionTime": "2024-01-15T10:30:00.125Z"
}
```

## Server Architecture

### SyncPlayManager.cs

Main orchestrator responsibilities:
- Create/destroy groups
- Route messages to appropriate groups
- Manage user sessions
- Handle authentication/authorization

### Group.cs

Group (room) management:
- Track members
- Maintain playback state
- Process commands from host
- Broadcast state updates

### State Machine

Groups use a state machine pattern:

```
States: Idle, Waiting, Paused, Playing

Transitions:
  Idle → Waiting (play requested, waiting for ready)
  Waiting → Playing (all ready)
  Playing → Paused (pause requested)
  Paused → Playing (unpause requested)
  Any → Idle (stop/leave)
```

## Settings and Configuration

### Client Settings (Settings.js)

```javascript
{
    // Sync correction
    enableSyncCorrection: true,

    // SpeedToSync
    useSpeedToSync: true,
    minDelaySpeedToSync: 50,      // ms
    maxDelaySpeedToSync: 3000,    // ms
    speedToSyncDuration: 1000,    // ms

    // SkipToSync
    useSkipToSync: true,
    minDelaySkipToSync: 400,      // ms

    // Extra offset (user adjustable)
    extraTimeOffset: 0            // ms
}
```

### Server Configuration

Configured via Jellyfin's standard configuration system:
- Group size limits
- Timeout values
- Feature toggles

## Known Limitations

Based on GitHub issues:

1. **Transcoding delay**: Users requiring transcoding tend to be ~2 seconds behind
2. **Sync correction issues**: Can cause problems when precise sync isn't needed
3. **Pause/resume desync**: Occasional further desync after pause/resume cycles

## Comparison with OpenWatchParty

### Time Sync Approach

| Aspect | Jellyfin SyncPlay | OpenWatchParty |
|--------|-------------------|----------------|
| Algorithm | Min-delay selection | Lowest-RTT of recent eight samples, then EMA (α=0.4) |
| Samples | 8 (sliding window) | 8-sample window |
| Selection | Best (lowest RTT) | Lowest RTT sample, then EMA smoothing |
| Initial sync | 3 fast pings | First measurement direct |
| Maintenance | 60s polling | 2s until five valid samples, then 30s; a clock-offset change over 50ms restarts the fast cadence |

**Trade-offs:**
- Min-delay is more resistant to outliers
- EMA provides smoother transitions
- Min-delay requires more samples for accuracy

### Drift Correction

| Aspect | Jellyfin SyncPlay | OpenWatchParty |
|--------|-------------------|----------------|
| Strategy | SpeedToSync + SkipToSync | Continuous rate adjustment |
| Rate range | 0.2x - 2.0x | 0.90x - 1.15x |
| Deadzone | Configurable thresholds | 40ms |
| Hard seek | Above threshold | Above 2s drift |

### Architecture

| Aspect | Jellyfin SyncPlay | OpenWatchParty |
|--------|-------------------|----------------|
| Deployment | Integrated | Plugin + external server |
| Dependencies | None | Rust server required |
| Client support | All Jellyfin clients | Web only |
| Maintenance | Jellyfin team | Independent |

## References

### GitHub Repositories
- [jellyfin/jellyfin](https://github.com/jellyfin/jellyfin) - Server
- [jellyfin/jellyfin-web](https://github.com/jellyfin/jellyfin-web) - Web client

### Key Pull Requests
- [PR #1011](https://github.com/jellyfin/jellyfin-web/pull/1011) - Original SyncPlay implementation
- [PR #1945](https://github.com/jellyfin/jellyfin-web/pull/1945) - TV series support, code refactor
- [PR #1990](https://github.com/jellyfin/jellyfin-web/pull/1990) - WebRTC time syncing proposal
- [PR #2204](https://github.com/jellyfin/jellyfin-web/pull/2204) - SyncPlay settings UI
- [PR #3976](https://github.com/jellyfin/jellyfin-web/pull/3976) - Move to plugin architecture

### Issues
- [#4972](https://github.com/jellyfin/jellyfin-web/issues/4972) - Disable sync correction by default
- [#6210](https://github.com/jellyfin/jellyfin-web/issues/6210) - Desync when transcoding
