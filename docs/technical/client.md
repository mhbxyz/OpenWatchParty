# JavaScript Client

## Overview

The OpenWatchParty client is a set of JavaScript modules (IIFE pattern) injected into Jellyfin's web interface. These modules handle playback synchronization between multiple users via WebSocket.

## Module Architecture

```
plugin.js              # Loader - loads modules in order
    ├── state.js      # Global state and constants
    ├── utils.js      # Utility functions
    ├── ui.js         # User interface
    ├── playback.js   # Video playback management
    ├── ws.js         # WebSocket communication
    └── app.js        # Initialization and main loops
```

## Module: `state.js`

### Description
Defines global shared state and configuration constants.

### Constants (`OSP.constants`)

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `PANEL_ID` | string | `'osp-panel'` | Panel element ID |
| `BTN_ID` | string | `'osp-osd-btn'` | OSD button ID |
| `STYLE_ID` | string | `'osp-style'` | Style tag ID |
| `HOME_SECTION_ID` | string | `'osp-home-section'` | Home section ID |
| `DEFAULT_WS_URL` | string | `ws(s)://host:3000/ws` | WebSocket server URL |
| `SUPPRESS_MS` | number | `2000` | Event suppression duration (ms) |
| `SEEK_THRESHOLD` | number | `2.5` | Difference threshold for seek (seconds) |
| `STATE_UPDATE_MS` | number | `1000` | State update send interval (ms) |
| `SYNC_LEAD_MS` | number | `120` | Sync advance to compensate latency (ms) |
| `DRIFT_DEADZONE_SEC` | number | `0.04` | Dead zone for no correction (seconds) |
| `DRIFT_SOFT_MAX_SEC` | number | `2.5` | Threshold for forced seek (seconds) |
| `PLAYBACK_RATE_MIN` | number | `0.95` | Minimum playback speed for catchup |
| `PLAYBACK_RATE_MAX` | number | `1.05` | Maximum playback speed for catchup |
| `DRIFT_GAIN` | number | `0.5` | Proportional gain for speed adjustment |

### State (`OSP.state`)

| Property | Type | Description |
|----------|------|-------------|
| `ws` | WebSocket\|null | WebSocket connection instance |
| `roomId` | string | Current room ID |
| `clientId` | string | Unique client ID (assigned by server) |
| `name` | string | User display name |
| `isHost` | boolean | `true` if this client is the room host |
| `followHost` | boolean | `true` if client follows host commands |
| `suppressUntil` | number | Timestamp until which events are ignored |
| `rooms` | Array | List of available rooms |
| `inRoom` | boolean | `true` if client is in a room |
| `bound` | boolean | `true` if video events are bound |
| `autoReconnect` | boolean | `true` for automatic reconnection |
| `serverOffsetMs` | number | Client/server clock offset (ms) |
| `lastSeekSentAt` | number | Timestamp of last seek sent |
| `lastStateSentAt` | number | Timestamp of last state update sent |
| `lastSentPosition` | number | Last sent position (seconds) |
| `hasTimeSync` | boolean | `true` if clock sync is established |
| `pendingActionTimer` | number\|null | Timer for scheduled actions |
| `homeRoomCache` | Map | Cover image cache |
| `lastParticipantCount` | number | Last known participant count |
| `joiningItemId` | string | Media ID being loaded |
| `roomName` | string | Current room name |
| `participantCount` | number | Room participant count |
| `lastSyncServerTs` | number | Server timestamp of last sync |
| `lastSyncPosition` | number | Position of last sync (seconds) |
| `lastSyncPlayState` | string | Play state of last sync |
| `readyRoomId` | string | Room ID for which "ready" was sent |
| `isBuffering` | boolean | `true` if video is buffering (HLS) |
| `wantsToPlay` | boolean | `true` if user wants to play |
| `isSyncing` | boolean | Anti-feedback lock during sync |

## Module: `utils.js`

### Description
Shared utility functions.

### Functions

#### `nowMs() -> number`
Returns current timestamp in milliseconds.

#### `shouldSend() -> boolean`
Returns `true` if client can send events (outside suppression period).

#### `suppress(ms?: number) -> void`
Activates event suppression for `ms` milliseconds (default: `SUPPRESS_MS`).

#### `getVideo() -> HTMLVideoElement|null`
Returns the page's `<video>` element or `null`.

#### `isVideoReady() -> boolean`
Returns `true` if video has `readyState >= 3` (can play without interruption).

#### `isBuffering() -> boolean`
Returns `true` if video is currently buffering.
- **Logic**: `readyState < 3` OR (`networkState === 2` AND `readyState < 4`)

#### `isSeeking() -> boolean`
Returns `true` if video is seeking (`video.seeking === true`).

#### `startSyncing() -> void`
Activates `isSyncing` lock for `SUPPRESS_MS` milliseconds.
- **Usage**: Called when receiving server commands to prevent feedback loops.

#### `getPlaybackManager() -> PlaybackManager|null`
Returns the Jellyfin playback manager.

#### `getCurrentItem() -> object|null`
Returns the currently playing media item.

#### `getCurrentItemId() -> string|null`
Returns the current media item ID.

#### `getItemImageUrl(itemId: string) -> string`
Returns the cover image URL for an item.

#### `isHomeView() -> boolean`
Returns `true` if user is on the home page.

#### `getServerNow() -> number`
Returns current timestamp adjusted to server clock.
```javascript
return nowMs() + (state.serverOffsetMs || 0);
```

#### `adjustedPosition(position: number, serverTs: number) -> number`
Calculates adjusted position accounting for elapsed time and latency.
```javascript
const elapsed = Math.max(0, serverNow - serverTs) + SYNC_LEAD_MS;
return position + (elapsed / 1000);
```

#### `scheduleAt(serverTs: number, fn: Function) -> void`
Schedules function execution at a given server timestamp.

## Module: `playback.js`

### Description
Manages HTML5 video element interaction and playback synchronization.

### Functions

#### `playItem(item: object) -> boolean`
Starts playback of a media item via Jellyfin API.

#### `ensurePlayback(itemId: string, attempt?: number) -> void`
Ensures the specified media is playing.
- **Usage**: Called when participant joins to load the same media as host.
- **Retry**: Up to 5 attempts, 500ms apart.

#### `notifyReady() -> void`
Sends `ready` message to server indicating client is ready to play.

#### `watchReady() -> void`
Waits for video to be ready (`readyState >= 2`) then calls `notifyReady()`.

#### `bindVideo() -> void`
Binds video events to synchronization handlers.

**Events listened:**
- `waiting`: Sets `isBuffering = true`
- `canplay`: Sets `isBuffering = false`
- `playing`: Sets `isBuffering = false`
- `play`: Sends `player_event` if host
- `pause`: Sends `player_event` if host (ignored if buffering)
- `seeked`: Sends `player_event` if host

**Send logic (`sendStateUpdate`):**
```
If NOT host → ignore
If isSyncing → ignore (anti-feedback lock)
If isSeeking → ignore (HLS lies during seek)
If isBuffering OR readyState < 3 → ignore
If < 1000ms since last send → ignore
Otherwise → send state_update
```

**Event logic (`onEvent`):**
```
If NOT host → ignore
If isSyncing → ignore
If readyState < 3 → ignore
If pause AND (isBuffering OR isSeeking) → ignore (not user-initiated)
If play AND isSeeking → ignore
If seek AND < 500ms since last OR diff < SEEK_THRESHOLD → ignore
Otherwise → send player_event
```

#### `syncLoop() -> void`
Synchronization loop called every second (non-hosts only).

**Drift correction algorithm:**
```
1. If host or not in room → reset playbackRate to 1
2. If no sync or state !== 'playing' → reset playbackRate to 1
3. If isBuffering or readyState < 3 → do nothing (let it load)
4. If video paused → reset playbackRate to 1
5. Calculate expected position:
   expected = lastSyncPosition + (serverNow - lastSyncServerTs) / 1000
6. Calculate drift:
   drift = expected - video.currentTime
7. If |drift| < DRIFT_DEADZONE (0.04s) → playbackRate = 1
8. If |drift| >= DRIFT_SOFT_MAX (2.5s) → forced seek to expected
9. Otherwise → adjust playbackRate:
   rate = clamp(1 + drift * DRIFT_GAIN, 0.95, 1.05)
```

## Module: `ws.js`

### Description
Manages WebSocket communication with the session server.

### Functions

#### `send(type: string, payload?: object, roomOverride?: string) -> void`
Sends a message to the WebSocket server.
```javascript
{
  type: type,
  room: roomOverride || state.roomId,
  payload: payload,
  ts: nowMs(),
  client: state.clientId
}
```

#### `createRoom() -> void`
Creates a new room with the name from the input field.

#### `joinRoom(id: string) -> void`
Joins an existing room.

#### `leaveRoom() -> void`
Leaves the current room.

#### `connect() -> void`
Establishes WebSocket connection.
- **Auto-reconnect**: If `autoReconnect === true`, reconnects after 3 seconds.

### Message Handler (`handleMessage`)

#### `room_list`
Updates available rooms list and refreshes UI.

#### `client_hello`
Receives client ID assigned by server.

#### `room_state`
Response to `create_room` or `join_room`:
1. Updates local state (roomId, roomName, isHost, etc.)
2. Synchronizes clock on first connection
3. Applies initial playback state (seek + play/pause)
4. Loads media if non-host

#### `participants_update`
Updates participant counter and shows toast for new participant.

#### `room_closed`
Resets state when room is closed (host disconnected).

#### `player_event`
Playback command received from host:
1. Activates `startSyncing()` (2s lock)
2. Seeks if difference > SEEK_THRESHOLD
3. Updates local sync state
4. Actions based on `action`:
   - `play`: Schedule play at `target_server_ts` or immediate with compensation
   - `pause`: Schedule pause
   - `seek`: Schedule seek

#### `state_update`
Periodic update from host:
1. Seek if difference > SEEK_THRESHOLD
2. Sync play/pause state
3. Update sync timestamps

#### `pong`
Response to ping for RTT calculation:
```javascript
rtt = now - payload.client_ts;
// EMA adjustment of server offset
sampleOffset = server_ts + (rtt / 2) - now;
serverOffsetMs = hasTimeSync ? (0.6 * old + 0.4 * sample) : sample;
```

## Module: `ui.js`

### Description
Manages the plugin user interface.

### Functions

#### `injectStyles() -> void`
Injects CSS styles into `<head>`.

#### `updateStatusIndicator() -> void`
Updates connection status indicator (Online/Offline).

#### `updateRoomListUI() -> void`
Updates room list in the panel.

#### `renderHomeWatchParties() -> void`
Displays watch parties on Jellyfin homepage.

#### `render() -> void`
Main panel render:
- **Lobby**: Room list + creation form
- **In-room**: Room name, participants, RTT, leave button

#### `injectOsdButton() -> void`
Injects "Watch Party" button into video player OSD controls.

#### `showToast(message: string) -> void`
Shows a toast notification.

## Module: `app.js`

### Description
Main entry point and initialization loops.

### Function `init()`

1. Log loading message
2. Inject CSS styles
3. Create UI panel (hidden by default)
4. Connect WebSocket
5. Start intervals:

| Interval | Frequency | Action |
|----------|-----------|--------|
| UI injection | 1000ms | Inject OSD button if missing |
| Video binding | 1000ms | Bind video events if video present |
| Ping | 3000ms | Send ping for RTT measurement |
| Home render | 2000ms | Refresh watch parties on home page |
| Sync loop | 1000ms | Execute synchronization loop |

## Synchronization Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          HOST                                    │
├─────────────────────────────────────────────────────────────────┤
│  [User clicks Play]                                              │
│        │                                                         │
│        ▼                                                         │
│  onEvent('play')                                                 │
│        │                                                         │
│        ├── Checks: isHost? shouldSend? !isSyncing? isVideoReady?│
│        │                                                         │
│        ▼                                                         │
│  send('player_event', {action:'play', position})                │
│        │                                                         │
└────────┼────────────────────────────────────────────────────────┘
         │
         ▼ WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                        SERVER                                    │
├─────────────────────────────────────────────────────────────────┤
│  Receives player_event                                          │
│        │                                                         │
│        ├── Validates: is host?                                  │
│        ├── Updates room.state                                   │
│        ├── Sets last_command_ts (cooldown)                      │
│        │                                                         │
│        ▼                                                         │
│  Broadcasts with target_server_ts = now + PLAY_SCHEDULE_MS      │
│        │                                                         │
└────────┼────────────────────────────────────────────────────────┘
         │
         ▼ WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                       NON-HOST CLIENT                            │
├─────────────────────────────────────────────────────────────────┤
│  handleMessage('player_event')                                  │
│        │                                                         │
│        ├── startSyncing() → isSyncing = true for 2s             │
│        ├── Update lastSyncServerTs, lastSyncPosition            │
│        │                                                         │
│        ▼                                                         │
│  scheduleAt(target_server_ts, () => video.play())               │
│        │                                                         │
│        ▼                                                         │
│  [Video plays at synchronized time]                             │
│        │                                                         │
│        ├── syncLoop() adjusts playbackRate for drift            │
│        │                                                         │
└─────────────────────────────────────────────────────────────────┘
```
