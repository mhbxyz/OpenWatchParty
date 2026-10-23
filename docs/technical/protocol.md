---
title: Protocol
parent: Technical
nav_order: 2
---

# WebSocket Protocol Specification

## Overview

OpenWatchParty uses a JSON-over-WebSocket protocol for real-time communication between clients and the session server.

**Endpoint:** `ws(s)://<host>:3000/ws`

## Protocol Version

The WebSocket protocol has its own version, independent of the product release. The current version is `1`.

| Version | Status | Notes |
|---------|--------|-------|
| `1` | Current | Initial negotiated version. |

**Negotiation:** clients declare their version in the `protocol_version` field of the `auth` message. A missing field is treated as `1`, so clients that predate negotiation keep working. The server echoes `protocol_version` in `auth_success` only when the client declared one, which keeps the previous `auth_success` payload for older clients. The version is also reported by `GET /health` (`protocol_version`) and by the plugin's `/OpenWatchParty/Token` response.

**Mismatch policy:** the server only speaks version `1`. A declared version other than `1`, or a malformed `protocol_version`, is rejected with an `error` whose code is `PROTOCOL_VERSION_UNSUPPORTED`; the WebSocket is then closed with close code `1008`.

**Compatibility rules:**

- Protocol version 1 supports additive, feature-negotiated message extensions. Clients advertise supported features in `auth`; `auth_success.features` acknowledges the server-supported subset. Current extensions include `host_transfer`, `participant_status`, `shared_playback_control`, `media_queue` and `chat_history`.
- The web client validates known message and payload schemas strictly. An unknown server message type or unknown field is warned about and dropped by the client; the session continues. An unknown client request type receives `UNKNOWN_MESSAGE_TYPE`. Do not assume new fields on an existing payload are ignored by every client.
- A server may send an optional extension only to clients that advertised the corresponding feature, or use a new message whose absence leaves legacy behavior intact. Version 1 remains unchanged for these additive extensions; changing an existing field's meaning or removing/retyping it requires a compatibility review and protocol version change.

The minimum supported client protocol version is `1`.

## Message Format

All messages follow this structure:

```json
{
  "type": "message_type",
  "room": "room_id",
  "client": "client_id",
  "payload": { ... },
  "ts": 1678900000000,
  "server_ts": 1678900000100
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Message type |
| `room` | string | No | Room ID (if applicable) |
| `client` | string | No | Sender client ID |
| `payload` | object | No | Message-specific data |
| `ts` | number | Yes | Client timestamp (ms since epoch) |
| `server_ts` | number | No | Server timestamp (added by server) |

## Client → Server Messages

### `auth`

Authenticate with a JWT token (if authentication is enabled), declare the client protocol version, and advertise optional features.

```json
{
  "type": "auth",
  "payload": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "protocol_version": 1,
    "features": ["host_transfer", "participant_status", "shared_playback_control", "media_queue", "chat_history"]
  },
  "ts": 1678900000000
}
```

| Payload Field | Type | Required | Description |
|---------------|------|----------|-------------|
| `token` | string | No | JWT issued by the `/OpenWatchParty/Token` endpoint |
| `protocol_version` | number | No | Client protocol version; defaults to `1` when omitted |
| `features` | array of strings | No | Optional client capabilities. The server currently recognizes `host_transfer`, `participant_status`, `shared_playback_control`, `media_queue` and `chat_history` |

On a protocol version mismatch the server answers with `error` (`PROTOCOL_VERSION_UNSUPPORTED`) and closes the connection.
Unknown feature names, non-string array entries, and a non-array `features` value are ignored. A client is eligible to become host only when it declared `host_transfer`, gets `queue_state` only when it declared `media_queue`, and gets `chat_history` only when it declared `chat_history`; the web client sends the [room queue](#room-queue) messages only to a server that acknowledged `media_queue`. The web client sends `participant_status` to a server that declared `participant_status`, or one that already sent `participant_statuses` for its room.

### `list_rooms`

Request the list of active rooms.

```json
{
  "type": "list_rooms",
  "ts": 1678900000000
}
```

**Response:** `room_list`

### `create_room`

Create a new watch party room.

```json
{
  "type": "create_room",
  "payload": {
    "name": "Movie Night",
    "start_pos": 0.0,
    "media_id": "abc123def456"
  },
  "ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `name` | string | Room display name |
| `start_pos` | number | Initial position (seconds) |
| `media_id` | string | Jellyfin media ID (optional) |

**Response:** `room_state`

**Effects:**
- Client becomes host
- After `room_state`, the host receives `room_capabilities` if it negotiated shared playback control, then its `participant_list` and `participant_statuses`
- Members that negotiated `media_queue` receive the initial `queue_state`
- Broadcast `room_list` to all clients

### `join_room`

Join an existing room.

```json
{
  "type": "join_room",
  "room": "uuid-room-id",
  "ts": 1678900000000
}
```

**Response:** `room_state`

**Effects:**
- Client added to `room.clients`
- Client removed from `room.ready_clients`
- Broadcast `participants_update` to other participants
- Broadcast `participant_list`, then `participant_statuses`, to everyone in the room, including the new client
- Send `room_capabilities` to negotiated members; this reports whether the current host also supports shared guest playback
- Send the new client `queue_state` if it negotiated `media_queue`
- Send the new client `chat_history` if it negotiated `chat_history` and the room has messages
- Broadcast `room_list` to all clients, with the room's new count (and the previous room's, when the client moved)

### `leave_room`

Leave the current room.

```json
{
  "type": "leave_room",
  "room": "uuid-room-id",
  "ts": 1678900000000
}
```

**Effects:**
- If the host leaves and another member declared `host_transfer`: promote the earliest-joined supporting member, preserve media and playback state, clear `pending_play`, and broadcast `client_left`, `host_changed`, then `participant_list` and `participant_statuses`
- If the host leaves and no remaining member supports transfer, or the room is empty: close the room and broadcast `room_closed` as before
- Otherwise: broadcast `client_left`, then `participant_list` and `participant_statuses` (the leaving client's status is dropped)
- Broadcast `room_list` to all

A non-host WebSocket disconnect has the same room behavior as `leave_room`. When a
transfer-capable host disconnects, the server reserves the host role for 10 seconds,
keyed by the authenticated Jellyfin user ID. A new connection for that user can join
the room during the grace period and reclaim the role with its new client ID. If the
grace period expires first, the server promotes the earliest transfer-capable member,
or closes the room when no such member remains. An explicit `leave_room` still
transfers or closes the room immediately. A disconnect broadcasts `room_list` only
when the client was in a room.

### `close_room`

Explicitly close the current room. The message has no payload.

```json
{
  "type": "close_room",
  "ts": 1678900000000
}
```

Only the current host may close a room. Success broadcasts `room_closed` with reason `Host closed the room` and removes every member. A guest receives `HOST_PERMISSION_REQUIRED`; a client outside a room receives `NOT_IN_ROOM`. Either error leaves the room unchanged.

### `ready`

Indicate client is ready to receive playback commands.

```json
{
  "type": "ready",
  "room": "uuid-room-id",
  "payload": {
    "media_id": "abc123def456"
  },
  "ts": 1678900000000
}
```

**Effects:**
- Client added to `room.ready_clients`
- If `pending_play` exists and `all_ready()`: triggers scheduled play
- A `ready` whose `media_id` names another item than the room's was sent before the room moved to another queue item: it is ignored

### `player_event`

Send a playback event. Guests may send `play` and `pause` only when both they and the current host negotiated `shared_playback_control` in `auth`. Otherwise guest commands receive `HOST_PERMISSION_REQUIRED`. `seek`, `buffering` and `state_update` remain host only.

The server sends `room_capabilities` with `{ "features": ["shared_playback_control"] }` (or an empty array) only to clients that negotiated this extension. It follows room creation/join, host transfer/reclaim and authentication changes. Legacy clients receive no new fields or message types. A new client uses shared controls only after both the server acknowledgement and the room announcement; otherwise it keeps the guest seek/play lock and private pause behavior.

```json
{
  "type": "player_event",
  "room": "uuid-room-id",
  "payload": {
    "action": "play",
    "position": 120.5
  },
  "ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `action` | string | `"play"`, `"pause"`, `"seek"`, or `"buffering"` |
| `position` | number | Current position (seconds) |

**Behavior by action:**

| Action | Server Behavior |
|--------|-----------------|
| `play` | If `all_ready()`: broadcast with `target_server_ts = now + 1000ms`. Otherwise: create `pending_play` |
| `pause` | Broadcast with `target_server_ts = now + 300ms` |
| `seek` | Broadcast with `target_server_ts = now + 300ms` |
| `buffering` | Broadcast with `target_server_ts = now + 300ms` (treat as paused) |

**Effects:**
- Updates `room.state`
- Starts a monotonic command-cooldown deadline (`command_cooldown_until`)
- Broadcasts the canonical event in server order; negotiated play/pause senders receive it too as an acknowledgement. Applying it must suppress playback-event feedback. Legacy host senders retain their previous exclusion behavior.

A guest's `play` or `pause` holds the room's play state: until its cooldown ends, a host `state_update` with the other play state is ignored, since the host sent it before applying the command. For a pending play the hold lasts until it starts, then for the same cooldown. Any host `player_event` ends the hold.

`PendingPlay` retains the initiating client ID. Both readiness completion and the readiness timeout emit the scheduled event under that ID, including the sender in the broadcast. Readiness updates do not turn a guest's play into a host command.

Only the host seeks, so a guest's `play` or `pause` cannot move the room: its `position` is replaced by where the room is (the last position, moved on by the time since it took effect while playing).

### `state_update`

Periodic playback state update (host only).

```json
{
  "type": "state_update",
  "room": "uuid-room-id",
  "payload": {
    "position": 125.3,
    "play_state": "playing"
  },
  "ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `position` | number | Current position (seconds) |
| `play_state` | string | `"playing"` or `"paused"` |

**Server filtering:**

- A changed `play_state` is accepted immediately unless it conflicts with an active guest-command hold; the server uses monotonic deadlines for that hold.
- If `play_state` is unchanged, the server ignores updates during the 2-second monotonic command cooldown or within 500 ms of the last accepted state update.
- Unchanged-state position updates that move backward by 0.5–2 seconds or forward by less than 0.5 seconds are filtered as HLS jitter or insignificant movement.

### `ping`

Latency measurement and clock synchronization.

```json
{
  "type": "ping",
  "payload": {
    "client_ts": 1678900000000
  },
  "ts": 1678900000000
}
```

**Response:** `pong`. Pings are available before authentication. Only a
`client_ts` representable as an unsigned 64-bit integer is echoed; extra payload
fields and the request's `room` and `client` fields are not reflected. A missing
or invalid `client_ts` produces a bounded pong without a `payload` field. The web
client discards that pong as a schema error and logs a warning; normal clock-sync
pings always include a valid timestamp.

### `chat_message`

Send a text message to the room.

```json
{
  "type": "chat_message",
  "room": "uuid-room-id",
  "payload": {
    "text": "Hello everyone!"
  },
  "ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `text` | string | Message text (max 500 characters) |

**Effects:**
- Message broadcast to all clients in the room (including sender)
- The room keeps its last 50 messages for members who join later (`chat_history`); they go with the room when it closes
- Rate limited by existing 30 msg/sec limit

**Error responses:**
- `"Chat message cannot be empty"` - Empty or whitespace-only text
- `"Chat message too long (max 500 characters)"` - Text exceeds limit
- `"Room ID required for chat"` - Missing room ID

### `participant_status`

Report how this client is doing, for the room's participants list. Informational only: it never changes playback.

```json
{
  "type": "participant_status",
  "payload": {
    "status": "in_sync"
  },
  "ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `status` | string | One of `playing`, `paused` (the host), `in_sync`, `catching_up`, `buffering`, `loading`, `blocked` (autoplay blocked: needs to press Play), `not_watching` |

**Effects:**
- The status is stored for the client's current room; a change is sent to the room as `participant_statuses`
- An unknown status, extra fields, an unchanged status, or a client outside a room are ignored silently (no error)
- A room gets at most one `participant_statuses` every 250 ms for status changes: the first change is sent at once, and later changes within the 250 ms are sent together when they end, with the latest statuses
- The web client sends it only to a server that sent `participant_statuses` for its room (an older server answers unknown types with an error), once a status has held for a second, and again after reconnecting

### Room queue

`queue_add`, `queue_remove`, `queue_move`, `queue_advance` and `queue_countdown` change the server-authoritative room queue, bounded to 20 items by count, watched ones included. This count limit is not a byte-size or process-memory bound. Only the host sends them: other members get `HOST_PERMISSION_REQUIRED`, a client outside a room `NOT_IN_ROOM`, and a malformed payload `INVALID_QUEUE_PAYLOAD`. A command that changes nothing (an item already queued, an unknown id, the room's own item, a countdown already running) is ignored without an error. Members that declared `media_queue` get the result as `queue_state` (see below).

```json
{
  "type": "queue_add",
  "payload": {
    "items": [{ "id": "0123456789abcdef0123456789abcdef", "title": "S1:E2 · The Storm" }]
  },
  "ts": 1678900000000
}
```

| Message | Payload | Effect |
|---------|---------|--------|
| `queue_add` | `items`: 1 to 20 `{ id, title }`. `id` is a Jellyfin item id like `media_id` (32 hexadecimal characters); `title` is cleaned like a name and cut to 100 characters | Appends the items not queued yet. A full queue evicts its oldest watched item for each new item; the current and upcoming items are not evicted. Items that still do not fit are left out |
| `queue_remove` | `id` | Removes an item other than the room's own |
| `queue_move` | `id`, `to` (the item's new index) | Moves an upcoming item to another upcoming place; the room's item and the watched ones keep theirs |
| `queue_advance` | `id` | Moves the room to that queued item |
| `queue_countdown` | `start` (boolean) | Starts a 10-second countdown toward the next item, or cancels it |

**Moving to another item** (`queue_advance`, or a countdown that ends):
- The room's `media_id` becomes the item's; the position goes back to 0, paused, and the ready set is cleared
- A pending play at 0, started by the host, plays the room once every member sent `ready` for the new item, or when the usual wait for them ends
- Every member gets `room_state` with the new `media_id`, so clients without `media_queue` follow it as on joining; members with `media_queue` then get `queue_state`, and every client gets `room_list`
- Until that pending play starts, the host's position updates and play events don't move it, because they may still describe the previous item; a pause still cancels it

**Countdown:** the deadline and its timer live on the server, so a host tab that the browser slows down in the background doesn't delay the move. A generation identifies each scheduled countdown; canceling, replacing or ending it invalidates its task, so an older timer cannot move the room later. It starts only toward a next item and ends when the host cancels it, on any move to another item, when the next item is removed, or when the server accepts a `pause` from the host or a guest (members with `media_queue` then get `queue_state` right after that `player_event`). The host's web client starts it when its video reaches the credits (Jellyfin's `Outro` media segment) or, at the latest, 15 seconds before the end: Jellyfin closes the player when a video ends, which takes the member out of the room, so the room moves on while the video still plays. It cancels it when its video pauses or the host seeks back before the credits, and doesn't start it while a room play or pause is on its way to its player.

## Server → Client Messages

### `client_hello`

Sent immediately after WebSocket connection, before the client authenticates.
Its envelope `server_ts` lets the web client establish an initial clock offset
while JWT token acquisition or authentication is still in progress.

```json
{
  "type": "client_hello",
  "client": "uuid-client-id",
  "payload": {
    "client_id": "uuid-client-id"
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

### `auth_success`

Sent after a successful `auth` with a JWT, and for feature-aware clients in insecure mode.

```json
{
  "type": "auth_success",
  "client": "uuid-client-id",
  "payload": {
    "user_name": "Alice",
    "protocol_version": 1,
    "features": ["host_transfer", "participant_status", "shared_playback_control", "media_queue", "chat_history"]
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

`protocol_version` is present only when the client declared it in `auth`; the server echoes the negotiated version.
`features` is present only when the client declared the field. It contains the subset supported by the server, so malformed or unknown declarations produce an empty array. Feature-aware insecure clients receive the same acknowledgement after identity handling.

### `room_list`

List of active rooms.

```json
{
  "type": "room_list",
  "payload": [
    {
      "id": "uuid-room-id",
      "name": "Movie Night",
      "count": 3,
      "media_id": "abc123def456"
    }
  ],
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

### `room_state`

Full room state. Sent after `create_room` or `join_room`, and to every member when the room moves to another [queue](#room-queue) item.

```json
{
  "type": "room_state",
  "room": "uuid-room-id",
  "client": "uuid-client-id",
  "payload": {
    "name": "Movie Night",
    "host_id": "uuid-host-id",
    "participant_count": 3,
    "media_id": "abc123def456",
    "state_server_ts": 1678900000000,
    "target_server_ts": null,
    "state": {
      "position": 120.5,
      "play_state": "playing"
    }
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

### `room_capabilities`

Room-specific capabilities for clients that advertised
`shared_playback_control`. Sent after room creation or join, after the host
changes or reclaims the role, and when authentication changes negotiated
capabilities. `features` contains `shared_playback_control` only when the
current host also supports it; otherwise it is an empty array. The server does
not send this message to legacy clients or clients that did not advertise the
feature. This announcement is additive in protocol version 1.

```json
{
  "type": "room_capabilities",
  "room": "uuid-room-id",
  "payload": { "features": ["shared_playback_control"] },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

### `participants_update`

Participant count update.

```json
{
  "type": "participants_update",
  "room": "uuid-room-id",
  "payload": {
    "participant_count": 4
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

### `participant_list`

Display names of the room's participants, in join order. Sent to the host when the room is created, and to everyone in the room after a client joins or leaves.

```json
{
  "type": "participant_list",
  "room": "uuid-room-id",
  "payload": {
    "participants": [
      { "name": "Alice", "is_host": true },
      { "name": "Bob", "is_host": false }
    ]
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `participants[].name` | string | Display name of the participant |
| `participants[].is_host` | boolean | Whether the participant is the room host |

It is a separate message so that `room_state`, `participants_update` and `client_left` keep their payloads: clients validate those strictly. A client that does not know `participant_list` ignores it, and the web client keeps showing the participant count until it receives one.

### `host_changed`

Sent before the updated `participant_list` when host transfer succeeds or when the
same authenticated host reclaims the role after reconnecting.

```json
{
  "type": "host_changed",
  "room": "uuid-room-id",
  "payload": {
    "host_id": "uuid-new-host-id",
    "host_name": "Bob"
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

Clients from 0.6.0 treat an unknown message type as an invalid schema and stop processing that message, so they safely ignore `host_changed`. They are never selected as the new host because they did not declare `host_transfer`.

### `participant_statuses`

Each participant's last reported `participant_status`, in the same order as the latest `participant_list`. Sent right after every `participant_list` and to the whole room whenever a status change.

```json
{
  "type": "participant_statuses",
  "room": "uuid-room-id",
  "payload": {
    "statuses": ["playing", null]
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `statuses[]` | string or null | The participant's status, or `null` if they have not reported one (an older client, say) |

It is a separate message because `participant_list` rejects unknown fields: clients that do not know `participant_statuses` ignore it. The web client ignores a list of statuses whose length does not match its participants list.

### `queue_state`

The room's authoritative [queue](#room-queue), sent only to members that declared `media_queue`: after each change, on creating the room and on joining it (after `room_state`, participant list/statuses and `room_capabilities`), and after a move to another item (after `room_state`).

```json
{
  "type": "queue_state",
  "room": "uuid-room-id",
  "payload": {
    "items": [
      { "id": "0123456789abcdef0123456789abcdef", "title": "S1:E1 · Pilot" },
      { "id": "fedcba9876543210fedcba9876543210", "title": "S1:E2 · The Storm" }
    ],
    "current": 0,
    "last_added": "fedcba9876543210fedcba9876543210",
    "countdown_until": 1678900010000
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `items` | array | Up to 20 `{ id, title }`, watched ones first |
| `current` | number or null | Index of the room's `media_id` in `items`, or `null` when it isn't queued |
| `last_added` | string or null | The last item `queue_add` appended, or `null` before the first. It stays after that item is removed: the host's web client fills the queue on from it, so an episode the host removed doesn't come back after a reload or a host change |
| `countdown_until` | number or null | Server time (ms) at which the room moves to the next item, or `null` |

### `player_event`

Playback command relayed from host.

```json
{
  "type": "player_event",
  "room": "uuid-room-id",
  "payload": {
    "action": "play",
    "position": 120.5,
    "target_server_ts": 1678900001000
  },
  "ts": 1678900000000,
  "server_ts": 1678900001000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `action` | string | `"play"`, `"pause"`, `"seek"`, or `"buffering"` |
| `position` | number | Reference position (seconds) |
| `target_server_ts` | number | Target server timestamp for execution |

**Client processing:**
1. Enable `isSyncing` lock (2s)
2. Calculate adjusted position with elapsed time
3. Schedule action at `target_server_ts`

### `state_update`

Periodic state update relayed from host.

```json
{
  "type": "state_update",
  "room": "uuid-room-id",
  "payload": {
    "position": 125.3,
    "play_state": "playing"
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

### `room_closed`

Room was closed because the host explicitly closed it, no transfer-capable member
remained after the host left or after its reconnect grace period expired, or the room
became empty.

```json
{
  "type": "room_closed",
  "ts": 1678900000000
}
```

### `client_left`

A participant left the room.

```json
{
  "type": "client_left",
  "room": "uuid-room-id",
  "client": "uuid-left-client-id",
  "payload": {
    "participant_count": 2
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `participant_count` | number | Updated participant count after the client left |

### `pong`

Response to ping. The optional payload contains only an unsigned 64-bit
`client_ts` copied from the request; `server_ts` in the envelope is the server
clock sample. If `client_ts` is missing, malformed or outside that range, the
server omits the payload entirely. The web client's strict schema validator
warns and drops such a pong, so it is not used as a clock sample. The server
never reflects arbitrary payload fields or request `room`/`client` identifiers.

```json
{
  "type": "pong",
  "payload": {
    "client_ts": 1678900000000
  },
  "ts": 1678900000050,
  "server_ts": 1678900000050
}
```

**Client-side RTT calculation:**
```javascript
const rtt = Date.now() - payload.client_ts;
const serverOffset = server_ts + (rtt / 2) - Date.now();
```

### `chat_message`

Chat message broadcast from server.

```json
{
  "type": "chat_message",
  "room": "uuid-room-id",
  "client": "uuid-sender-id",
  "payload": {
    "username": "Alice",
    "text": "Hello everyone!"
  },
  "ts": 1678900000000,
  "server_ts": 1678900000050
}
```

| Payload Field | Type | Description |
|---------------|------|-------------|
| `username` | string | Sender's display name |
| `text` | string | Message text |

**Client processing:**
1. Add message to local chat history (max 100 messages)
2. If chat panel not visible, increment unread badge
3. Render message in chat UI

### `chat_history`

The room's last chat messages (up to 50, oldest first), sent once to a member that declared `chat_history`, right after it joins (after `room_state`, the participant list and statuses, `room_capabilities` and `queue_state`). Not sent when the room has none.

```json
{
  "type": "chat_history",
  "room": "uuid-room-id",
  "payload": {
    "messages": [
      { "client": "uuid-client-id", "username": "Franco", "text": "Starting in a minute", "server_ts": 1678899990000, "own": false }
    ]
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

| Entry Field | Type | Description |
|-------------|------|-------------|
| `client` | string | The sender's client id when it sent the message (a reconnection gives it a new one) |
| `username` | string | The sender's name, as in `chat_message` |
| `text` | string | The message |
| `server_ts` | number | When the server relayed it |
| `own` | boolean | Whether the joiner's user sent it, from this or an earlier connection (the server compares Jellyfin user ids without sending them) |

### `error`

Error response.

```json
{
  "type": "error",
  "payload": {
    "code": "ROOM_NOT_FOUND",
    "message": "Error description"
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

`payload.code` is a stable machine-readable identifier in `SCREAMING_SNAKE_CASE`.
`payload.message` remains present for display and compatibility with existing clients.

| Code | Meaning |
|------|---------|
| `AUTHENTICATION_REQUIRED` | Authentication is required or the token is missing |
| `AUTHENTICATION_FAILED` | Token validation failed |
| `AUTHENTICATION_EXPIRED` | The authenticated session expired; the WebSocket is then closed |
| `AUTHENTICATION_TIMEOUT` | Authentication was not completed in time; the WebSocket is then closed |
| `PROTOCOL_VERSION_UNSUPPORTED` | The declared `protocol_version` is unsupported or malformed; the WebSocket is then closed |
| `RATE_LIMITED` | The message rate limit was exceeded; the WebSocket is then closed |
| `MESSAGE_TOO_LARGE` | The WebSocket message exceeds the protocol size limit |
| `UNSUPPORTED_MESSAGE_FORMAT` | The client sent a non-text message, including a binary message |
| `INVALID_JSON` | The text message is not a valid protocol JSON envelope |
| `UNKNOWN_MESSAGE_TYPE` | The message `type` is unknown |
| `ROOM_ID_REQUIRED` | A room-scoped operation omitted `room` |
| `ROOM_NOT_FOUND` | The requested room does not exist |
| `ROOM_FULL` | The requested room reached its participant limit |
| `NOT_ROOM_MEMBER` | The client is not a member of the requested room |
| `HOST_PERMISSION_REQUIRED` | A non-host client sent a `seek`, a `buffering` event, a `state_update`, `close_room` or a queue message |
| `INVALID_PLAYBACK_PAYLOAD` | A playback payload is absent, malformed, or outside accepted bounds |
| `NOT_IN_ROOM` | `leave_room`, `close_room` or a queue message was sent while the client had no room |
| `INVALID_READY` | A `ready` transition is missing required room context |
| `INVALID_CHAT_PAYLOAD` | The chat payload does not contain a string `text` field |
| `CHAT_MESSAGE_EMPTY` | Chat text is empty |
| `CHAT_MESSAGE_TOO_LONG` | Chat text exceeds the configured limit |
| `INVALID_QUEUE_PAYLOAD` | A queue message's payload is absent, malformed, or outside accepted bounds |

## Sequence Diagram: Complete Session

```
Client A                    Server                    Client B
    │                          │                          │
    ├── WebSocket connect ────►│                          │
    │◄─── client_hello ────────┤                          │
    │◄─── room_list ───────────┤                          │
    │                          │                          │
    ├── create_room ──────────►│                          │
    │◄─── room_state ──────────┤                          │
    │                          ├─── room_list (broadcast) │
    │                          │                          │
    │                          │◄── WebSocket connect ────┤
    │                          ├─── client_hello ────────►│
    │                          ├─── room_list ───────────►│
    │                          │                          │
    │                          │◄── join_room ────────────┤
    │◄─ participants_update ───┤─── room_state ──────────►│
    │◄─ participant_list ──────┼─── participant_list ────►│
    │◄─── room_list ───────────┼─── room_list ───────────►│
    │                          │                          │
    │                          │◄── ready ────────────────┤
    │                          │                          │
    ├── player_event (play) ──►│                          │
    │                          │   all_ready() = true     │
    │◄─ player_event ──────────┼─── player_event ────────►│
    │   target_ts = T+1000     │   target_ts = T+1000     │
    │                          │                          │
    │   [T+1000ms]             │                [T+1000ms]│
    │   video.play()           │              video.play()│
    │                          │                          │
    ├── state_update ─────────►│                          │
    │                          ├─── state_update ────────►│
    │                          │                          │
    ├── ping ─────────────────►│                          │
    │◄─── pong ────────────────┤                          │
    │                          │                          │
    ├── close_room ───────────►│                          │
    │                          ├─── room_closed ─────────►│
    │◄─── room_list ───────────┼─── room_list ───────────►│
    │                          │                          │
```

## Invite Links

A host can share a short-lived invite link instead of asking guests to pick the room from the room list. The link carries a room-scoped **invite ticket**; it never contains the Jellyfin API token or the session JWT.

### Minting a ticket

The session server exposes an HTTP endpoint beside `/health`:

```http
POST /invite
Authorization: Bearer <session JWT>
Content-Type: application/json

{ "room_id": "uuid-room-id", "ttl_seconds": 3600 }
```

| Field | Type | Description |
|-------|------|-------------|
| `room_id` | string | Room the ticket is scoped to; the caller must be its host |
| `ttl_seconds` | number | Requested lifetime; optional. Clamped to 60-86400 seconds, default 3600 |

The endpoint is rate limited per authenticated user. Responses:

| Status | Body | Description |
|--------|------|-------------|
| 200 | `{ "ticket": "...", "expires_at": 1678903600 }` | Ticket minted; `expires_at` is Unix seconds |
| 401 | `{ "error": "Authentication required" }` | Missing or invalid session JWT |
| 403 | `{ "error": "Only the room host can create invite links" }` | The caller is not the room host |
| 404 | `{ "error": "Room not found" }` | The room does not exist (or has closed) |
| 429 | `{ "error": "Rate limit exceeded" }` | Too many ticket requests from this user, or 1024 other users are already within their 60-second windows |
| 503 | `{ "error": "..." }` | Invite links require a shared JWT secret |

The ticket is an HS256 JWT signed with the session server's shared secret:

| Claim | Description |
|-------|-------------|
| `room` | Room the ticket is scoped to |
| `typ` | Token marker: `invite` (a session token is rejected as an invite and vice versa) |
| `nonce` | Unique ticket identifier |
| `aud`, `iss`, `iat`, `exp` | Standard claims; the ticket expires at `exp` and cannot be extended |

### Joining with a ticket

`join_room` accepts an optional `invite_ticket` payload field:

```json
{
  "type": "join_room",
  "room": "uuid-room-id",
  "payload": {
    "user_name": "Ana",
    "invite_ticket": "eyJhbGciOiJIUzI1NiIs..."
  },
  "ts": 1678900000000
}
```

The session server validates the signature, the expiry **and** the room before joining. Failures use the existing error codes and leave the client's membership untouched:

| Condition | Error code | Message |
|-----------|------------|---------|
| Malformed, tampered or unverifiable ticket | `AUTHENTICATION_FAILED` | `Invalid invite ticket` |
| Ticket minted for a different room | `AUTHENTICATION_FAILED` | `Invite ticket does not match this room` |
| Expired ticket | `AUTHENTICATION_EXPIRED` | `Invite ticket has expired` |
| Room closed after minting | `ROOM_NOT_FOUND` | `Room not found` (normal join path) |

A valid ticket does not bypass the normal join rules: a full room still answers `ROOM_FULL`, and a closed room is still rejected by the room lookup.

### Client link format

The web client opens the Jellyfin Web root with the ticket in a query parameter:

```
https://jellyfin.example/web/?owp_invite=<ticket>
```

The client reads `owp_invite` on load, waits for the WebSocket authentication to finish, then sends `join_room` for the room named in the ticket and removes the parameter from the URL. Invalid or expired tickets show a toast and leave the client on the normal room list.
