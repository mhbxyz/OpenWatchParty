---
title: Client
parent: Technical
nav_order: 4
---

# JavaScript Client

## Overview

The OpenWatchParty client is a set of JavaScript modules (IIFE pattern) injected into Jellyfin's web interface. These modules handle playback synchronization between multiple users via WebSocket.

## Module Architecture

```
plugin.js                    # Loader - loads modules in parallel waves
    ├── state.js             # Global state and constants
    ├── utils/               # Utility functions
    │   ├── log.js, media.js, misc.js, time.js, video.js
    ├── ui/                  # User interface
    │   ├── cards.js, header.js, home.js, indicators.js
    │   ├── render.js, styles.js, toasts.js
    ├── playback/            # Video playback management
    │   ├── bind.js, play.js, sync.js
    ├── chat/                # Text chat
    │   ├── input.js, messages.js
    ├── ws/                  # WebSocket communication
    │   ├── send.js, auth.js, connection.js
    │   └── handlers/
    │       ├── clock.js, playback.js, room.js, sync.js
    └── app/                 # Initialization and cleanup
        ├── cleanup.js, lifecycle.js
```

Modules are loaded in dependency waves, parallelizing where possible:
`state.js` → `utils/*` → `ui/*` → `playback/*` → `chat/*` → `ws/send` → `ws/auth` → `ws/handlers/*` → `ws/connection` → `app/*`

## Module: `state.js`

### Description
Defines global shared state and configuration constants.

### Constants (`OWP.constants`)

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `PANEL_ID` | string | `'owp-panel'` | Panel element ID |
| `BTN_ID` | string | `'owp-osd-btn'` | OSD button ID |
| `HEADER_BTN_CLASS` | string | `'owp-header-btn'` | Class of the header buttons |
| `LEGACY_HEADER_BTN_ID` | string | `'owp-header-btn-legacy'` | Header button ID (legacy `.headerRight`) |
| `MODERN_HEADER_BTN_ID` | string | `'owp-header-btn-modern'` | Header button ID (MUI app bar) |
| `PANEL_HEADER_CLASS` | string | `'owp-panel-header'` | Panel class while placed below the header |
| `ROOM_MODE_CLASS` | string | `'owp-room-mode'` | Panel class while in a room (room bar layout) |
| `STYLE_ID` | string | `'owp-style'` | Style tag ID |
| `SYNCPLAY_HIDE_STYLE_ID` | string | `'owp-hide-native-syncplay'` | Style tag that hides the native SyncPlay button |
| `HOME_SECTION_ID` | string | `'owp-home-section'` | Home section ID |
| `PROTOCOL_VERSION` | number | `1` | WebSocket protocol version declared in the `auth` message |
| `DEFAULT_WS_URL` | string | `ws(s)://host:3000/ws` | WebSocket server URL |
| `SUPPRESS_MS` | number | `2000` | Event suppression duration (ms) |
| `SEEK_THRESHOLD` | number | `1.0` | Difference threshold for seek (seconds) |
| `STATE_UPDATE_MS` | number | `1000` | State update send interval (ms) |
| `SYNC_LEAD_MS` | number | `300` | Sync advance to compensate latency (ms) |
| `DRIFT_DEADZONE_SEC` | number | `0.04` | Dead zone for no correction (seconds) |
| `DRIFT_SOFT_MAX_SEC` | number | `2.0` | Threshold for forced seek (seconds) |
| `PLAYBACK_RATE_MIN` | number | `0.90` | Minimum playback speed for catchup |
| `PLAYBACK_RATE_MAX` | number | `1.15` | Maximum playback speed for catchup |
| `DRIFT_GAIN` | number | `0.15` | Proportional gain for speed adjustment (sqrt curve) |
| `UI_CHECK_MS` | number | `2000` | UI injection check interval (ms) |
| `PING_MS` | number | `10000` | Ping interval for RTT (ms) |
| `HOME_REFRESH_MS` | number | `5000` | Home watch parties refresh (ms) |
| `SYNC_LOOP_MS` | number | `500` | Sync loop interval (ms) |

### State (`OWP.state`)

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
| `serverFeatures` | string[] | Features confirmed by `auth_success`; reset for every WebSocket connection |
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
| `participants` | array | `{ name, isHost, status }` entries from `participant_list` and `participant_statuses`; empty until the server sends one |
| `roomBarSection` | string | Drop-down open under the room bar: `'people'`, `'chat'`, `'leave'` or `''` |
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
Returns the current media item ID, falling back to the item of the page being browsed (route item, URL).

#### `getPlayingItemId() -> string|null`
Returns the item the player is actually playing, or `null`. It requires a video and never falls back to the page being browsed or to the hidden player page Jellyfin keeps (`.page.hide`) with the previous item's OSD.

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
Starts playback of a media item via Jellyfin API. Without a PlaybackManager, it opens the item's details page and selects the play button of that visible page (never one of a hidden, earlier details page).

#### `ensurePlayback(itemId: string, attempt?: number) -> void`
Ensures the specified media is playing.
- **Usage**: Called when participant joins to load the same media as host.
- **Already playing**: Skipped only when `getPlayingItemId()` reports the same item.
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
Synchronization loop called every 500 ms (`SYNC_LOOP_MS`, non-hosts only).

**Drift correction algorithm:**
```
1. If host or not in room → reset playbackRate to 1
2. If no sync or state !== 'playing' → reset playbackRate to 1
   If the room is paused and the video plays (a guest pressed play) → pause it,
   unless a room command is being applied or a host play is scheduled
3. If isBuffering or readyState < 3 → do nothing (let it load)
4. If video paused → reset playbackRate to 1
5. Calculate expected position:
   expected = lastSyncPosition + (serverNow - lastSyncServerTs) / 1000
6. Calculate drift:
   drift = expected - video.currentTime
7. If |drift| < DRIFT_DEADZONE (0.04s) → playbackRate = 1
8. If |drift| >= DRIFT_SOFT_MAX (2.0s) → forced seek to expected
9. Otherwise → adjust playbackRate using sqrt curve:
   rate = clamp(1 + sign(drift) * sqrt(|drift|) * DRIFT_GAIN, 0.90, 1.15)
```

## Module: `ws.js`

### Description
Manages WebSocket communication with the session server.

Every new connection resets `serverFeatures` and advertises `features: ["host_transfer"]` in `auth`, for both JWT and insecure identity modes. An optional `auth_success.features` array records the supported subset. If an older server omits it, the host's Close room action falls back to `leave_room` because that server closes a room when its host leaves.

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
Creates a new room for the item that is playing (`getPlayingItemId()`); refuses, with a toast, when nothing plays.

#### `joinRoom(id: string) -> void`
Joins an existing room.

#### `leaveRoom() -> void`
Leaves the current room. With negotiated host transfer, the host's room-bar confirmation offers this separately from closing the room and names the first non-host participant in join order who will take over.

#### `closeRoom() -> void`
Closes the room when invoked by the host. It sends `close_room` when the server confirmed `host_transfer`; with an older server it sends `leave_room`, which preserves the previous close-on-host-leave behavior. Exiting the player always calls `leaveRoom()`.

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

#### `participant_list`
Stores the participants' names for the current room and shows them instead of the count, one row per name with a separate **Host** badge. Lists for another room are ignored, and joining another room clears the previous names. The statuses are cleared until `participant_statuses` follows.

#### `participant_statuses`
Stores each participant's status, when the list has the same length as the participants, and shows it under the name. It also marks the server as accepting `participant_status`, so `playback.reportStatus()` (run on every sync tick in a room) sends this client's status, from `playback.ownStatus()`, once it has held for `PARTICIPANT_STATUS_HOLD_MS`. The same sends go to a server that declared `participant_status` in its `auth_success` features; a server that does neither receives nothing.

#### `host_changed`
Updates `isHost` for the current room and shows the new-host toast. When this client becomes host it only resets drift correction (playback rate, *catching up*); a room command or media load it accepted as a guest still completes, and it sends no host events or state heartbeat until then: until the scheduled time, or at most as long as a guest waits for the room's media. The existing room bar is updated in place so Invite and the current leave choices change without replacing chat or keyboard focus. All playback broadcasts, the host state heartbeat, and the invite button read `state.isHost` at use time.

#### `room_closed`
Resets state when the room is explicitly closed or host transfer is unavailable.

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
- **In-room**: Compact bar with the sync dot, latency, room name, participants, chat and leave buttons, plus their drop-downs

#### `injectOsdButton() -> void`
Injects "Watch Party" button into video player OSD controls.

#### `injectHeaderButtons() -> void`
Puts a "Watch Party" button first in each Jellyfin 12 header: the legacy `.skinHeader .headerRight` and the MUI app bar box holding SyncPlay, Cast and Search. A `MutationObserver` coalesced per animation frame puts it back when Jellyfin rebuilds a header and keeps a panel opened from the header placed below it (falling back to the default placement while no header button is shown, as in the player). Unless such a panel is open, only changes inside a header or a newly added header trigger the lookup, so busy pages (the player, chat, library grids) don't; the periodic UI check catches anything else.

#### `removeHeaderButtons() -> void`
Removes the header buttons and stops their observers and listeners.

#### `resetPanelPlacement(panel) -> void`
Restores the default panel placement used by the player button.

#### `updateCreateRoomButton() -> void`
Enables "Create Room" only while something is playing; otherwise shows a hint.

#### `updateParticipantList() -> void`
Shows the participants' names (`state.participants`) in the room view, or the count when no names were received, for example from an older session server, and updates the count on the bar's participants button.

#### Room bar
In a room, `render()` draws a single bar (sync dot, latency, room name, then the participants, chat, leave and close buttons) and a drop-down below it. Participants, chat and the leave confirmation open one at a time (`state.roomBarSection`). Guests get Cancel and Leave. A host gets Cancel and Close room when alone or when `host_transfer` was not negotiated; otherwise the host gets Cancel, Leave and Close for everyone, plus the name of the first non-host participant who will take over. Participant lists and host changes update these controls in place. The chat counts as read only while its drop-down is open (`chat.isChatVisible()`). Keyboard: Escape closes the open drop-down and returns focus to its button; if an in-place update removes the focused choice, focus moves to Cancel. The panel is a non-modal `role="dialog"`, and every button that opens it (header and player) carries `aria-controls` and `aria-expanded`. Opened from the keyboard (a `click` with `detail` 0), the panel takes focus on its first control other than the close button; a mouse click leaves focus alone, so the player's shortcuts keep working. A full redraw with focus inside the panel (Create Room or Join changing the view, say) puts focus back on the same control or on the first one (a room list update does the same for the focused room's Join button), and `ui.hidePanel()` (the close button, leaving the room, closing the player) moves focus out of the hidden panel, to the button that opened it when that button is shown.

#### `applyNativeSyncPlayVisibility() -> void`
Adds or removes the stylesheet that hides Jellyfin's SyncPlay button, following `state.hideNativeSyncPlayButton` (from `hide_native_syncplay_button` in the token response).

#### `showToast(message: string) -> void`
Shows a toast notification.

## Localization

`utils/i18n.js` reads the active Jellyfin display language from `document.documentElement.lang` at each lookup, then falls back to `navigator.language` and English. Locale matching tries the exact lower-case tag, its base language and finally `en`; the shipped catalogs are English (`en`), Spanish (`es`), French (`fr`) and German (`de`).

The session server names every room `<host>'s room`; `localizeRoomName()` shows that default in the viewer's language (for example `Sala de <host>`) and leaves any other name as it is.

The session server writes its errors and room-closed reasons in English. `localizeServerError()` shows the known ones in the viewer's language, by message first (several invite errors share an authentication code) and then by error code; `localizeRoomClosedReason()` does the same for the reasons. Anything else is shown as the server wrote it. The English catalog keeps the server's meaning, sometimes in shorter or clearer words.

The configuration page (`configPage.html`) has its own `configMessages` catalog with the same languages and lookup. The plugin reports its diagnostic checks in English: the page shows the known check names and fixed summaries in the page language, and any other detail (an error message, for example) as the plugin wrote it. A test fails if one of those summaries is no longer reported by the plugin.

To add a locale, copy the complete `en` catalog in `utils/i18n.js` (and in `configPage.html`), translate each value without changing its `{placeholders}`, and register the locale in `catalogs`. The localization tests enforce matching keys and placeholders in every shipped catalog. Plurals use `_one` and `_other` keys, which covers the shipped languages; a language with more plural forms (`few`, `many`) needs those keys added to `en` first.

## Module: `app.js`

### Description
Main entry point, initialization loops, and cleanup management.

### Function `init()`

1. Log loading message
2. Inject CSS styles
3. Create UI panel (hidden by default)
4. Inject the header buttons
5. Connect WebSocket
6. Start intervals:

| Interval | Frequency | Action |
|----------|-----------|--------|
| UI check | 2000ms | Inject header and OSD buttons, update "Create Room", bind video, detect video player exit |
| Ping | 10000ms | Send ping for RTT measurement |
| Home render | 5000ms | Refresh watch parties on home page |
| Sync loop | 500ms | Execute synchronization loop (non-hosts only) |

### Auto-Cleanup on Video Player Exit

The UI interval monitors the video element presence. When the user leaves the video player:

1. **Detection**: `hadVideoElement` flag tracks if a video was present
2. **Trigger**: When video element disappears from DOM, `onVideoPlayerExit()` is called
3. **Actions**:
   - Hide the OWP panel
   - Leave the room if in one (`leaveRoom()`)
   - Clean up video event listeners
   - Reset `bound` state

```javascript
// In UI interval
if (hadVideoElement && !video) {
    hadVideoElement = false;
    onVideoPlayerExit();
    return;
}
```

### Function `cleanup()`

Full cleanup for plugin unload:
- Clear all intervals
- Clear pending action timers
- Close WebSocket connection
- Remove panel event listeners
- Remove video event listeners

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
