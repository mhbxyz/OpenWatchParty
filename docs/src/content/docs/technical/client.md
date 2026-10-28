---
title: "JavaScript Client"
---

<span id="javascript-client" class="legacy-anchor"></span>

## Overview

The OpenWatchParty client is a set of JavaScript modules (IIFE pattern) injected into Jellyfin's web interface. These modules handle playback synchronization between multiple users via WebSocket.

See [Client State Lifecycle](/technical/client-state/) for field ownership, domain
factories, reset boundaries and cancellation rules.

## Module Architecture

```
plugin.js                    # Loader - loads modules in parallel waves
    ├── state.js             # Global state and constants
    ├── utils/               # Utility functions
    │   ├── i18n.js, log.js, media.js, misc.js, time.js, url.js, video.js
    ├── ui/                  # User interface
    │   ├── cards.js, guest-controls.js, header.js, home.js, indicators.js
    │   ├── panel-elements.js, lobby.js, participants.js, leave-confirm.js, room.js
    │   ├── queue.js, render.js, styles.js, toasts.js
    ├── playback/            # Video playback management
    │   ├── bind.js, play.js, sync.js
    ├── chat/                # Text chat
    │   ├── input.js, messages.js
    ├── ws/                  # WebSocket communication
    │   ├── send.js, auth.js, connection.js
    │   ├── validation.js
    │   └── handlers/
    │       ├── clock.js, playback.js, room.js, sync.js
    └── app/                 # Initialization and cleanup
        ├── cleanup.js, invite.js, lifecycle.js, queue.js
```

The 40 modules are loaded in dependency waves, parallelizing where possible:
`state.js` → utility waves → UI waves → playback and chat → `ws/send` →
`ws/auth` → `ws/validation` → WebSocket handlers → `ws/connection` → `app/*`.

### Panel views

`render.js` coordinates redraws. Shared controls and
focus helpers live in `panel-elements.js`; lobby and help in `lobby.js`;
participant presentation in `participants.js`; leave confirmation in
`leave-confirm.js`; room sections and chat input setup in `room.js`; the room
queue's section and up-next strip in `queue.js`, whose host logic (filling the
queue, starting the countdown at the credits) is `app/queue.js`. `app/start.js`
reports this client's readiness and follows `start_state`; `room.js` shows it in
the room bar.

The loader initializes shared elements first, then lobby, participants and leave
confirmation in parallel, then room controls, and finally the renderer. The
private `OWP.ui._panelViews` namespace connects these modules. Public `OWP.ui`
entry points remain unchanged. Redraws preserve chat nodes, draft, scroll and
focus, and labels still use the localization catalog.

## Module: `state.js`

### Description
Defines global shared state and configuration constants.

### Constants (`OWP.constants`)

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `PANEL_ID` | string | `'owp-panel'` | Panel element ID |
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
| `PAUSED_SEEK_THRESHOLD` | number | `0.04` | Difference threshold for aligning a pause (seconds) |
| `STATE_UPDATE_MS` | number | `1000` | State update send interval (ms) |
| `SYNC_LEAD_MS` | number | `300` | Sync advance to compensate latency (ms) |
| `DRIFT_DEADZONE_SEC` | number | `0.04` | Dead zone for no correction (seconds) |
| `DRIFT_SOFT_MAX_SEC` | number | `2.0` | Threshold for forced seek (seconds) |
| `PLAYBACK_RATE_MIN` | number | `0.90` | Minimum playback speed for catchup |
| `PLAYBACK_RATE_MAX` | number | `1.15` | Maximum playback speed for catchup |
| `DRIFT_GAIN` | number | `0.15` | Proportional gain for speed adjustment (sqrt curve) |
| `UI_CHECK_MS` | number | `2000` | UI injection check interval (ms) |
| `PING_INIT_MS` | number | `2000` | Initial application ping interval (ms) |
| `PING_STABLE_MS` | number | `30000` | Application ping interval after clock convergence (ms) |
| `PING_STABLE_AFTER` | number | `5` | Valid clock samples before the stable interval |
| `RECONNECT_BASE_MS` | number | `1000` | Initial transport reconnect delay (ms) |
| `RECONNECT_MAX_MS` | number | `30000` | Maximum transport reconnect delay (ms) |
| `ROOM_REJOIN_TIMEOUT_MS` | number | `5000` | Authentication/rejoin wait timeout (ms) |
| `HOME_REFRESH_MS` | number | `5000` | Home watch parties refresh (ms) |
| `SYNC_LOOP_MS` | number | `500` | Sync loop interval (ms) |

### State (`OWP.state`)

This is a representative list of fields used across modules, not the complete
state inventory; see [Client State Lifecycle](/technical/client-state/).

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
| `desiredRoomId` | string | Room to recover after an unexpected transport close |
| `rejoinPending` | boolean | Waiting to authenticate or receive the recovered room state |
| `connectionAttempt` | number | Generation that invalidates obsolete connection work |
| `authRequestAttempt` | number | Generation that invalidates obsolete token requests |
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
| `roomBarSection` | string | Drop-down open under the room bar: `'people'`, `'chat'`, `'sync'`, `'queue'`, `'leave'` or `''` |
| `roomMediaId` | string | The room's item from `room_state`; a change in the same room is a move to another queue item |
| `queueItems` | array | `{ id, title }` entries from `queue_state` |
| `queueCurrent` | number\|null | Index of the room's item in `queueItems` |
| `queueCountdownUntil` | number | Server time (ms) at which the room moves to the next item; 0 without a countdown |
| `queueLastAdded` | string\|null | `last_added` from `queue_state`: the item the room's queue was filled up to |
| `queueReceived` | boolean | `true` once `queue_state` came for this room since joining or reconnecting; the host waits for it before filling the queue |
| `lastSyncServerTs` | number | Server timestamp of last sync |
| `lastSyncPosition` | number | Position of last sync (seconds) |
| `lastSyncPlayState` | string | Play state of last sync |
| `roomWaiting` | boolean | `true` while a guest is waiting for the host after buffering |
| `roomHostId` | string | Client id of the room's host, to tell a guest's play or pause from the host's |
| `sharedPlaybackControl` | boolean | Enabled only after server and current-room capability negotiation; false on connection or room reset |
| `ownCommandUntil` | number | Until when a guest's own play or pause holds against room updates already on their way |
| `ownCommandPlayState` | string | Play state of that command |
| `guestPaused` | boolean | `true` while a guest has paused local playback; on promotion, retained until playback matches the room so the private pause cannot become authoritative |
| `readyRoomId` | string | Room ID for which "ready" was sent |
| `mediaSwitchUntil` | number | Until this time (ms), a closed player is OWP opening the room media, not the user leaving |
| `isBuffering` | boolean | `true` if video is buffering (HLS) |
| `wantsToPlay` | boolean | `true` if user wants to play |
| `isSyncing` | boolean | Anti-feedback lock during sync |

### Connection and Room Lifecycle

`OWP.state` is currently a flat shared object, defined in `state.js`. The
following describes its existing owners and cleanup boundaries; these are not
separate nested state objects.

| Boundary | Owner | Behavior |
|----------|-------|----------|
| Token acquisition/refresh | `ws/auth.js` | Updates credentials/configuration; invalidates obsolete responses through request generations |
| WebSocket transport | `ws/connection.js` | Owns socket callbacks, reconnect and rejoin timers, ping cadence and connection generations |
| Room state reset | `ws/send.js` (`resetRoomState`) | Clears room/media timers, pending playback, membership, statuses and chat; invalidates outstanding media/playback work |
| Room messages | `ws/handlers/room.js` | Applies membership, host and capability messages for the current room |
| Video binding | `playback/bind.js` | Attaches/detaches listeners for the current video element |
| Full client cleanup | `app/cleanup.js` | Stops the client, clears deferred work, detaches video/panel listeners and removes header buttons |

On an unexpected socket close, the client remembers the room in
`desiredRoomId`, normalizes playback rate and clears active membership. It
reconnects with capped exponential backoff (1s, 2s, 4s, 8s, 16s, then 30s),
resetting the counter once the connection authenticates, so a rejected token
keeps backing off. After authentication, it rejoins the remembered room;
authentication/rejoin waits time out after 5s. A failed rejoin
resets room state and rejects late room-state replies. An older server without
host transfer closes the room on host disconnect, so the host does not attempt
room recovery in that case.

The server decides whether a reconnecting host reclaims its role during the
10s authenticated recovery window or returns as a guest after transfer.
Explicit leave cancels automatic rejoin. `disconnect()` disables reconnect,
invalidates pending connection/authentication work and resets room state;
full cleanup also cancels the remaining deferred operations.

On socket open the client sends a JSON `ping` immediately, before JWT
authentication completes, then starts an adaptive interval: every 2s until five
valid pong samples, then every 30s. An offset change greater than 50ms restores
the fast cadence. These JSON pings measure clock offset and latency; the server's
separate WebSocket control-frame heartbeat maintains transport liveness even
when JavaScript timers are throttled. The server also supplies an initial clock
sample in `client_hello` before authentication.

When adding a state field, identify its owner, whether it survives transport
loss, and which room reset or full-cleanup path clears it. Preserve user
preferences and valid credentials across a room reset.

## Module: `utils/`

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

## Module: `playback/`

### Description
Manages HTML5 video element interaction and playback synchronization.

### Functions

#### `playItem(item: object) -> boolean`
Starts playback of a media item via Jellyfin API. Without a PlaybackManager, it opens the item's details page and selects the play button of that visible page (never one of a hidden, earlier details page). Leaving the player for that page sets `mediaSwitchUntil` (`MEDIA_SWITCH_GRACE_MS`, 20 s), so the periodic UI check does not take the closed player for the user leaving the room.

#### `ensurePlayback(itemId: string, attempt?: number) -> void`
Ensures the specified media is playing.
- **Usage**: Called when participant joins to load the same media as host.
- **Already playing**: Skipped only when `getPlayingItemId()` reports the same item.
- **Retry**: Up to 5 attempts, 500ms apart.

Private `schedulePlaybackRetry` in `playback/play.js` schedules missing-identity,
item lookup, and playback failure retries: at most five retries at 500 ms, each
carrying the original request generation and force flag. `ensurePlayback` checks
validity before work and after asynchronous operations; only the current
generation may clear `joiningItemId` in its finalizer.

#### `notifyReady() -> void`
Sends `ready` message to server indicating client is ready to play.

#### `watchReady() -> void`
Waits for the room media to play (`getPlayingItemId()`, which ignores the hidden pages Jellyfin keeps) and its video to be ready (`readyState >= 2`), then applies the room state and calls `notifyReady()`. A new video is required only when a different item was playing. Once ready, it ends the `mediaSwitchUntil` grace.

#### `bindVideo() -> void`
Binds video events to synchronization handlers.

**Events listened:**
- `waiting`: Sets `isBuffering = true`; the host reports `buffering` when appropriate
- `canplay`: Sets `isBuffering = false`
- `playing`: Sets `isBuffering = false`; a host may report the end of a stream reload
- `play`: A host reports it; a guest reports it only with negotiated `sharedPlaybackControl`
- `pause`: A host reports it (ignored if buffering); a guest reports it only with negotiated shared control
- `seeked`: The host reports it; guests cannot seek the room

**Send logic (`sendStateUpdate`):**
```
If NOT host → ignore (periodic state updates are host-only)
If guestPaused, isSyncing, a room action/media load is pending, or a stream is reloading → ignore
If isSeeking, isBuffering, or readyState < 3 → ignore
If less than STATE_UPDATE_MS (1000ms) since the previous send → ignore
Otherwise → send state_update
```

**Event logic:**
```
Host → send permitted play, pause, seek and buffering events
Guest → send only a play/pause that reverses the current room state and only when shared playback control is negotiated
All senders → suppress room echoes and stale events during room/media work
Host-only → seek and buffering; a guest's pause can remain private when shared control is unavailable
```

#### `syncLoop() -> void`
Synchronization loop called every 500 ms (`SYNC_LOOP_MS`, non-hosts only).

**Drift correction algorithm:**
```
1. If host or not in room → reset playbackRate to 1
2. If no sync or state !== 'playing' → reset playbackRate to 1
   If the room is paused and the video plays without the room taking it (while it
   waits for the host) → pause it, unless a room command is being applied or a
   host play is scheduled
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

## Module: `ws/`

When `host_changed` promotes a privately paused guest, `syncPromotedGuest()`
applies the tracked room position and play state before host events or periodic
state updates can be sent. Pending room playback and buffering keep the send
gate closed. Blocked autoplay keeps it closed until the user presses Play;
an asynchronous completion from a previous room cannot release the gate.
Participant status reports a private pause as `paused`, regardless of the
previous drift-correction status.

### Description
Manages WebSocket communication with the session server.

Every new connection resets `serverFeatures` and shared-control availability and advertises `features: ["host_transfer", "participant_status", "shared_playback_control", "media_queue"]` in `auth`, for both JWT and insecure identity modes. An optional `auth_success.features` array records the supported subset. If an older server omits it, the host's Close room action falls back to `leave_room` because that server closes a room when its host leaves.

`room_capabilities` enables shared play/pause only while the current host supports it. Otherwise guests retain their private pause and cannot play a paused room. Canonical playback acknowledgements clear the optimistic command hold and apply in server order, with event suppression to prevent echoes. The host keeps the play and pause it sent (`hostControlAcks`) until their canonical events return, and retires them without applying them again; a newer opposite control supersedes a pending command, and a guest command that changes neither the play state nor the position does not start the syncing lock. Host-side commands retry a temporarily missing video until `VIDEO_ACTION_MAX_WAIT_MS`, preserving the room, role and playback-attempt guards. Pending retries gate authoritative heartbeats; a stream reload still defers the latest command until it completes.

After an unexpected close, the client buffers a `WS_CLOSE` diagnostic containing the
WebSocket close code, clean flag, and truncated reason. On the next connection it
sends `auth` first, then flushes that diagnostic through `client_log`. A host that
rejoins during the server's 10-second grace period regains the host role under its
new connection ID.

### Token request lifecycle

`fetchAuthToken` owns request generation, ApiClient waiting, the abort deadline,
HTTP/JSON errors, and timeout cleanup. Private `applyTokenResponse` validates the
endpoint URL and applies the explicit authentication mode, identity, settings,
and refresh schedule. The coordinator checks its generation after fetch and JSON
decoding, before applying a response; obsolete failures cannot block a newer login.

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
- **Auto-reconnect**: If `autoReconnect === true`, retries with exponential backoff starting at 1 second and capped at 30 seconds.

### Connection setup responsibilities

`connect` coordinates socket replacement, token acquisition, endpoint validation,
and callback installation. Private `blockConnection` records authentication or
endpoint failures with the same login watchdog bookkeeping and toast suppression.
Private `onWsMessage` checks socket identity before reading data, validates
JSON/schema, and filters room messages before dispatch. Retry backoff and protocol
payloads remain owned by the existing connection lifecycle.

### Message Handler (`handleMessage`)

#### `room_list`
Updates available rooms list and refreshes UI.

#### `client_hello`
Receives client ID assigned by server.

#### `room_state`
Response to `create_room` or `join_room`:
1. Updates local state (roomId, roomName, isHost, etc.)
2. Initializes the clock from `server_ts` only if `client_hello` or a valid pong has not already done so
3. Applies initial playback state (seek + play/pause)
4. Loads media if non-host

#### `participants_update`
Updates participant counter and shows toast for new participant.

#### `participant_list`
Stores the participants' names for the current room and shows them instead of the count, one row per name with a separate **Host** badge. Lists for another room are ignored, and joining another room clears the previous names. The statuses are cleared until `participant_statuses` follows.

#### `participant_statuses`
Stores each participant's status, when the list has the same length as the participants, and shows it under the name. It also marks the server as accepting `participant_status`, so `playback.reportStatus()` (run on every sync tick in a room) sends this client's status, from `playback.ownStatus()`, once it has held for `PARTICIPANT_STATUS_HOLD_MS`. The same sends go to a server that declared `participant_status` in its `auth_success` features; a server that does neither receives nothing.

#### `queue_state` and media queue
The client advertises `media_queue` and receives queue snapshots only from a server that acknowledges that capability. The host's `app/queue.js` adds and removes Jellyfin items, fills upcoming episodes, moves to another item and starts/cancels the server countdown; guests receive authoritative `queue_state` and follow the room's `room_state` media. The queue holds at most 20 items by count. `last_added` is a persistent fill cursor, so an item the host removed is not re-added after reload or host transfer. The server owns the 10-second countdown and invalidates cancelled or replaced countdown tasks by generation. This count limit is not a byte or process-memory bound.

#### `start_state` and readiness
With a server that acknowledges `start_when_ready`, `app/start.js` sends `readiness` when this client's reason changes, from `start.ownReason()`: `loading` until the room's media shows (`transcoding` when it comes through the server's HLS, a `blob:` or `.m3u8` source), `autoplay_blocked` after the browser stopped a play, and `buffering` while the video stalls (`waiting`) or seeks. A paused video that has its frame (`readyState` 2) is ready: browsers stop loading a paused video. It runs on every sync tick and on the video's own events. While the room waits (`start_state` `waiting`) or counts down (`starting` with `countdown`), the client pauses its video at the play's position as OWP's own action (nothing is sent) and holds its room work (`pendingPlayUntil`). A play pressed meanwhile sends `start_now` while the room waits and only keeps waiting during the countdown; OWP's own play at the start time goes through. `ui.updateStartLabel()` puts "Waiting for Ana" (two names, or a count) or "Starting in 3" in place of the room's name, centred in the name's place with as much space after it as the fixed-width latency leaves before it, and as wide as the name at least so the bar keeps its size; with the panel closed it shows on its own where the bar would be (`#owp-start-float`). Selecting it sends `start_now` for the host, or a guest sharing the controls; its tooltip names each member's reason. SERVER lines in the chat (`chat.system()`) say who the room waits for and why, who got ready (a moment later, and not for a member whose `client_left` came meanwhile), who it started without, and a cancelled start. Only the last kind, an error, counts as unread and shows a toast.

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
A valid pong echoes only `payload.client_ts`; its `server_ts` is the server
clock sample. The client computes RTT from the echo and estimates offset from
`server_ts + RTT / 2 - clientNow`. It keeps the lowest-RTT sample among the
latest eight, then smooths the selected offset with EMA alpha 0.4; the first
valid sample initializes the offset directly. If a ping has a missing or
non-unsigned-64-bit timestamp, the server omits the pong payload. That fails the
client schema check, produces an `Invalid WebSocket message schema` warning,
and is ignored for clock sync; malformed values are not reflected back.

## Module: `ui/`

### Description
Manages the plugin user interface.

### Functions

#### `injectStyles() -> void`
Injects CSS styles into `<head>`. The sizes of the panel, the room bar, its drop-downs, the up-next strip and the toasts are written for 12 px text and multiplied by `--owp-scale`, and their surfaces use `--owp-surface-alpha` with a 12 px backdrop blur; both variables are set on `#owp-panel`, `.owp-queue-next` (the up-next strip, which floats outside the panel while the panel is closed), `.owp-toast-container` and `.owp-toast-system`, with the defaults of 14 px and 55 %. `prefers-reduced-transparency: reduce` makes the surfaces opaque.

#### `updateStatusIndicator() -> void`
Updates connection status indicator (Online/Offline).

#### `updateRoomListUI() -> void`
Updates room list in the panel.

#### `renderHomeWatchParties() -> void`
Displays watch parties on Jellyfin homepage.

#### `render() -> void`
Main panel render:
- **Lobby**: Room list + creation form
- **In-room**: Compact bar with the sync dot, latency, room name (or who the room waits for, or its countdown), participants, chat and leave buttons, plus their drop-downs

#### `injectHeaderButtons() -> void`
Puts a "Watch Party" button first in each Jellyfin 12 header: the legacy `.skinHeader .headerRight` and the MUI box holding SyncPlay and Cast, in the app bar (with Search) or in the player's own header. A `MutationObserver` coalesced per animation frame puts it back when Jellyfin rebuilds a header and keeps a panel opened from the header placed below it (falling back to the default placement while no header button is shown, as in the player). Unless such a panel is open, only changes inside a header or a newly added header trigger the lookup, so busy pages (the player, chat, library grids) don't; the periodic UI check catches anything else.

Over the player the panel follows Jellyfin's controls: while the header has `osdHeader` and `osdHeader-hidden`, the panel gets `owp-controls-hidden` (faded out, without pointer events), even under a resting pointer as the controls do, unless one of its text fields has focus or it holds the queue's up-next strip (`ui/queue.js` asks again with `applyPlayerControls()` whenever the strip comes or goes). A primary press outside the open panel closes it like its X, except on the header buttons and the toasts. On the player's picture (`#videoOsdPage` outside `.videoOsdBottom`, `.upNextContainer` and its buttons and fields) the press stops there, so the player does not take it as play/pause. The next mouse press on the picture then waits for its `mousedown`, whose click count follows the system's double-click time: the second click of a double click stops there too, with its `click` and `dblclick`, so a double click neither pauses nor goes full screen; a new click is dispatched again to its target as a `pointerdown`, for the player. By touch or pen the next presses go through, and only the clicks and double click of the gesture stop, until the next single tap. `closePanelOnPress(event)` closes the panel for such a press without stopping it; guest controls call it for the presses they stop, which the panel's listener never sees.

#### `removeHeaderButtons() -> void`
Removes the header buttons and stops their observers and listeners.

#### `resetPanelPlacement(panel) -> void`
Restores the default panel placement, away from the header.

#### `updateCreateRoomButton() -> void`
Enables "Create Room" only while something is playing; otherwise shows a hint.

#### `updateParticipantList() -> void`
Shows the participants' names (`state.participants`) in the room view, or the count when no names were received, for example from an older session server, and updates the count on the bar's participants button.

#### Room bar
In a room, `render()` draws a single bar (sync dot, latency, room name, then the participants, chat, leave and close buttons) and a drop-down below it. Participants, chat and the leave confirmation open one at a time (`state.roomBarSection`). Guests get Cancel and Leave. A host gets Cancel and Close room when alone or when `host_transfer` was not negotiated; otherwise the host gets Cancel, Leave and Close for everyone, plus the name of the first non-host participant who will take over. Participant lists and host changes update these controls in place. The chat counts as read only while its drop-down is open (`chat.isChatVisible()`). Keyboard: Escape closes the open drop-down and returns focus to its button; if an in-place update removes the focused choice, focus moves to Cancel. The panel is a non-modal `role="dialog"`, and every button that opens it (header and player) carries `aria-controls` and `aria-expanded`. Opened from the keyboard (a `click` with `detail` 0), the panel takes focus on its first control other than the close button; a mouse click leaves focus alone, so the player's shortcuts keep working. A full redraw with focus inside the panel (Create Room or Join changing the view, say) puts focus back on the same control or on the first one (a room list update does the same for the focused room's Join button), and `ui.hidePanel()` (the close button, leaving the room, closing the player) moves focus out of the hidden panel, to the button that opened it when that button is shown.

#### `applyNativeSyncPlayVisibility() -> void`
Adds or removes the stylesheet that hides Jellyfin's SyncPlay button, following `state.hideNativeSyncPlayButton` (from `hide_native_syncplay_button` in the token response).

#### `applyAppearance() -> void`
Sets `--owp-scale` (text size / 12) and `--owp-surface-alpha` from `state.appearanceTextSize` and `state.appearanceOpacity` (from `appearance_text_size` and `appearance_opacity` in the token response), in its own stylesheet. A missing or out-of-range value falls back to the default.

#### `showToast(message: string) -> void`
Shows a toast notification.

## Localization

`utils/i18n.js` reads the active Jellyfin display language from `document.documentElement.lang` at each lookup, then falls back to `navigator.language` and English. Locale matching tries the exact lower-case tag, its base language and finally `en`; the shipped catalogs are English (`en`), Spanish (`es`), French (`fr`) and German (`de`).

The session server names every room `<host>'s room`; `localizeRoomName()` shows that default in the viewer's language (for example `Sala de <host>`) and leaves any other name as it is.

The session server writes its errors and room-closed reasons in English. `localizeServerError()` shows the known ones in the viewer's language, by message first (several invite errors share an authentication code) and then by error code; `localizeRoomClosedReason()` does the same for the reasons. Anything else is shown as the server wrote it. The English catalog keeps the server's meaning, sometimes in shorter or clearer words.

The configuration page (`configPage.html`) has its own `configMessages` catalog with the same languages and lookup. The plugin reports its diagnostic checks in English: the page shows the known check names and fixed summaries in the page language, and any other detail (an error message, for example) as the plugin wrote it. A test fails if one of those summaries is no longer reported by the plugin.

To add a locale, copy the complete `en` catalog in `utils/i18n.js` (and in `configPage.html`), translate each value without changing its `{placeholders}`, and register the locale in `catalogs`. The localization tests enforce matching keys and placeholders in every shipped catalog. Plurals use `_one` and `_other` keys, which covers the shipped languages; a language with more plural forms (`few`, `many`) needs those keys added to `en` first.

The literal guard scans all client scripts together, preserving their IIFE scopes and original file/line locations. It follows local bindings and statically named `OWP` helper exports (including namespace aliases) across files to DOM text, attributes, HTML-writing methods and toast/confirmation sinks. Unknown `OWP.ui` helpers conservatively reject literal string arguments; use catalog lookups for their labels. Dynamic property names and runtime-generated text are outside this static guard's analysis. HTML-writing sinks reject uncatalogued literal text, including short labels and markup; this does not make translated HTML safe or change the client's createElement-based rendering.

## Module: `app/` lifecycle and cleanup

`app/lifecycle.js` initializes the panel, captures invite links, starts the
WebSocket connection and owns the UI, home and sync intervals. `app/cleanup.js`
performs full teardown. The `plugin.js` loader itself is the script entry point.

### Function `init()`

1. Log loading message
2. Inject CSS styles
3. Create UI panel (hidden by default)
4. Inject the header buttons
5. Connect WebSocket
6. Start intervals:

| Interval | Frequency | Action |
|----------|-----------|--------|
| UI check | 2000ms | Inject header buttons, update "Create Room", bind video, detect video player exit |
| Ping | Connection-owned | Immediate ping on socket open, then every 2s until five valid samples and every 30s afterward; an offset change over 50ms restarts the fast cadence |
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
│        ├── Sets command_cooldown_until                          │
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
