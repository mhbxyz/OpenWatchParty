---
title: Client State Lifecycle
parent: Technical
nav_order: 10
---

# Client State Lifecycle

`state.js` defines 110 initial fields, grouped by domain factories. The live
`OWP.state` keeps its existing flat shape and identity: modules retain references
to it. There are no forwarding aliases or duplicate copies of a field. Defaults
are declared once and each factory returns fresh arrays, timer handles and cache
containers. `createState()` is for initialization, not for resetting a live app.
On a loader retry, missing factory/disposal helpers can be installed while the
existing state, constants and timer registry keep their identity and work.

## Ownership inventory

| Domain | Fields | Writers and readers | Reset boundary |
|---|---|---|---|
| Room membership and snapshot | `roomId`, `isHost`, `inRoom`, `roomName`, `participantCount`, `participants`, `lastParticipantCount`, `statusesRoomId`, `statusCandidate`, `statusCandidateSince`, `statusSentKey`, `lastSyncServerTs`, `lastSyncPosition`, `lastSyncPlayState`, `roomWaiting`, `roomHostId`, `roomMediaId`, `sharedPlaybackControl`, `readyRoomId` | `ws/send.js`, room/sync handlers and playback status reporting write; playback and UI read | `resetRoomMembership()` uses `createRoomState()` |
| Playback work within a room | `suppressUntil`, `pendingActionTimer`, `playbackBlocked`, `playbackFailureNotified`, `joiningItemId`, `pendingMediaId`, `mediaSwitchUntil`, `pendingMediaUntil`, `pendingJoinRoomId`, `guestPaused`, `ownCommandUntil`, `ownCommandPlayState`, `hostAppliedPlayState`, `hostPendingPlayState`, `hostControlAcks`, `isBuffering`, `wantsToPlay`, `streamReloadUntil`, `lastPlayedPosition`, `lastPlayedPlaying`, `streamReloadResume`, `reloadGuestCommand`, `isSyncing`, `syncCooldownUntil`, `isInitialSync`, `initialSyncUntil`, `initialSyncTargetPos`, `syncStatus`, `currentDrift`, `outOfSyncSince`, `driftCheckedAt`, `pendingPlayUntil` | Playback modules, sync/playback handlers, invite/card flows and `utils/misc.js`; indicators read | `resetRoomPlayback()` uses `createRoomPlaybackState()` after cancellation |
| Playback binding and generation fences | `bound`, `lastSeekSentAt`, `lastStateSentAt`, `lastSentPosition`, `playbackActionAttempt`, `playbackRequestAttempt`, `autoJoinAttempt`, `cardPollAttempt`, `mediaSyncAttempt`, `mediaReadyCleanup`, `videoListeners`, `currentVideoElement` | Playback, media, card and lifecycle modules | Room reset advances attempt counters; it preserves the active video binding. Player disposal uses `releaseVideoBinding()` |
| Connection session metadata | `clientId`, `isConnecting`, `connectionPhase`, `successfulPings`, `timeSyncSamples`, `lastRttMs` | `ws/connection.js`, room/clock handlers; UI, send and synchronization read | `resetConnectionSession()` uses `createConnectionSessionState()` on close/disconnect |
| Connection and recovery intent | `ws`, `autoReconnect`, `wsUrl`, `reconnectAttempts`, `reconnectTimer`, `connectionAttempt`, `serverFeatures`, `desiredRoomId`, `rejoinPending`, `rejectedRejoinRoomIds`, `roomRejoinTimer`, `serverOffsetMs`, `hasTimeSync` | Connection, auth/send and clock handlers; lifecycle and UI read | Connection owns timer cancellation, socket detachment, explicit rejoin cancellation and negotiation |
| Authentication | `authToken`, `authEnabled`, `authBlocked`, `authError`, `authRequestAttempt`, `authFailedToken`, `authRetryAttempts`, `authRetryAt`, `lastAuthToastMessage`, `lastAuthToastAt`, `userId`, `userName`, `tokenExpiresAt`, `tokenRefreshTimer` | `ws/auth.js` and connection; invite/UI read | Preserved across room resets. Disconnect advances request generation; full cleanup cancels the refresh timer |
| Room queue | `queueItems`, `queueCurrent`, `queueCountdownUntil`, `queueLastAdded`, `queueReceived` | `ws/handlers/room.js` writes from `queue_state`; `app/queue.js` and `ui/queue.js` read | Part of `createRoomState()`; entering another room or losing the connection uses `createQueueState()` |
| Room UI | `roomBarSection` | Room UI and connection | `resetRoomUI()` uses `createRoomUIState()` |
| Application/UI registries | `name`, `rooms`, `initialized`, `logBuffer`, `logBufferMax`, `homeRoomCache`, `lobbyHelpOpen`, `intervals` | UI, diagnostics, room-list handler and lifecycle modules | Room reset preserves these; full cleanup releases tracked work and sets `initialized` false |
| Invite work | `pendingInviteTicket`, `inviteJoinPending` | `app/invite.js`, send and room handlers | Room reset uses `createInviteWorkState()` |
| Preferences | `followHost`, `hideNativeSyncPlayButton`, `showSyncNudge`, `appearanceOpacity`, `appearanceTextSize`, `inviteTtlSeconds` | UI, auth configuration and invite code | Preserved across room reset, reconnect and cleanup |

## Transition rules

- **Leave, Close, room closed, or failed rejoin:** `resetRoomState()` coordinates
  playback cancellation, membership, room UI and invite-work resets. It then
  refreshes guest controls and clears chat. Credentials, preferences, lobby
  data and the bound video survive. The caller separately cancels rejoin intent.
- **Transport loss:** session metadata is reset, but recovery intent, credentials,
  the active video and generation counters are retained. The existing partial
  membership transition hides room controls while reauthentication/rejoin runs.
  Do not substitute a full room or authentication reset here: host recovery
  requires the same identity and target room.
- **Explicit disconnect:** connection/rejoin timers are cancelled, generations
  advance, room state is cleared, ping is stopped, then the socket is detached
  before closing it. A late socket close cannot restart this connection.
- **Player replacement/exit:** `releaseVideoBinding()` removes every registered
  video event, including `emptied` and `timeupdate`, stops video-scoped work and
  clears handles/binding flags. Replacement can bind the new element once.
- **Application cleanup:** all tracked work is stopped, disconnect runs, panel
  and header handlers are removed, the common video disposer runs and
  initialization becomes retryable. The disposer is idempotent. It does not
  replace the live state object or discard valid credentials/preferences.

## Cancellation before reset

The `room`, `media`, `video`, `connection`, `auth`, `ui` and `lifecycle` timer
scopes describe lifetime rather than the object holding a timer handle.
`resetRoomPlayback()` calls `mediaReadyCleanup` and clears room/media scopes
before writing fresh defaults. It advances the five playback/media/card attempt
counters instead of resetting them to zero, fencing responses from previous
operations. Connection similarly advances its own request generations.

Video handlers have one disposer in `state.js`, used by both `playback/bind.js`
and `app/cleanup.js`. Removing listeners precedes clearing their references;
clearing the video scope precedes discarding timer handles. Room reset does not
detach the video or stop unrelated connection/lifecycle/UI work.

## Adding a field

Choose its owner and lifetime first. Add its default to that domain's factory,
not separately to initialization and a reset literal. If it is room-local,
decide whether it is membership, playback work, room UI or invite work. A
persistent credential, preference, binding or generation fence must not be
placed in a room-reset factory. Cancel resources before discarding their handles.

Keep the existing flat property contract when adding a field. Grouping defaults
and reset ownership does not require simultaneously renaming every consumer.
Any later nested-domain migration should be a separate change with all consumers
updated together, rather than introducing temporary aliases.

Run client tests, lint, syntax checks and the authenticated lifecycle E2E suite.
Tests characterize preserved identity/preferences, fresh mutable defaults,
timer boundaries, monotonic generations and complete listener disposal; existing
reconnect/host-transfer/media tests cover late responses and reentry.
