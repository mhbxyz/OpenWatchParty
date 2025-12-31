# Protocol (Draft)

This document defines the JSON message protocol used between clients and the
session server over WebSocket.

## Envelope

```json
{
  "type": "event_type",
  "room": "room_id",
  "client": "client_id",
  "payload": {},
  "ts": 1733820000
}
```

## Events

### create_room

Payload:

```json
{
  "media_url": "...",
  "start_pos": 0,
  "host_id": "...",
  "options": {}
}
```

### join_room

Payload:

```json
{
  "name": "...",
  "auth_token": "..."
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
