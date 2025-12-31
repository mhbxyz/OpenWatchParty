# Protocol (Draft)

This document defines the JSON message protocol used between clients and the
session server over WebSocket.

If `JWT_SECRET` is configured on the server, `create_room` requires `auth_token`
and `join_room` requires either `auth_token` or `invite_token`.

## Envelope

```json
{
  "type": "event_type",
  "room": "room_id",
  "client": "client_id",
  "payload": {},
  "ts": 1733820000,
  "server_ts": 1733820001
}
```

`server_ts` is optional and added by the session server when relaying messages.

## Events

### create_room

Payload:

```json
{
  "media_url": "...",
  "start_pos": 0,
  "host_id": "...",
  "options": {},
  "auth_token": "JWT"
}
```

### join_room

Payload:

```json
{
  "name": "...",
  "auth_token": "JWT",
  "invite_token": "JWT"
}
```

### player_event

Payload:

```json
{
  "action": "play|pause|seek",
  "position": 0.0
}
```

### state_update

Payload:

```json
{
  "position": 0.0,
  "play_state": "playing|paused|buffering",
  "reported_latency": 0
}
```

### room_state

Payload:

```json
{
  "room": "room_id",
  "host_id": "client_id",
  "media_url": "...",
  "options": {},
  "state": { "position": 0.0, "play_state": "playing|paused|buffering" },
  "participants": [
    { "client_id": "client-1", "name": "Alice", "is_host": true }
  ],
  "participant_count": 1
}
```

### client_joined / client_left

Payload:

```json
{
  "name": "..."
}
```

### participants_update

Payload:

```json
{
  "participants": [
    { "client_id": "client-1", "name": "Alice", "is_host": true }
  ],
  "participant_count": 1
}
```

### host_change

Payload:

```json
{
  "host_id": "client_id"
}
```

### force_resync

Payload:

```json
{
  "target_position": 0.0
}
```

### ping / pong

Payload:

```json
{
  "client_ts": 1733820000
}
```

### error

Payload:

```json
{
  "code": "...",
  "message": "..."
}
```

### create_invite

Payload:

```json
{
  "expires_in": 3600
}
```

### invite_created

Payload:

```json
{
  "invite_token": "JWT",
  "expires_at": 1733823600
}
```
