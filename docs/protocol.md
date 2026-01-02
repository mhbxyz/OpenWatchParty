# Protocol Specification

OpenSyncParty uses a JSON-based protocol over WebSocket.

**Endpoint:** `ws(s)://<jellyfin-host>:3001/ws`

## Message Format

All messages sent between client and server follow this structure:

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

## Message Types

### Client -> Server

*   **`list_rooms`**:
    *   Payload: none
    *   Response: `room_list`

*   **`create_room`**:
    *   Payload:
        *   `start_pos` (number): Initial position in seconds.
        *   `name` (string): Room name.
    *   Response: `room_state`

*   **`join_room`**:
    *   Payload: none
    *   Response: `room_state` (to joiner), `participants_update` (broadcast)

*   **`player_event`**:
    *   Payload:
        *   `action` (string): "play", "pause", or "seek".
        *   `position` (number): Current playback position in seconds.
    *   Behavior: Broadcasts the event to all other clients in the room.

*   **`state_update`**:
    *   Payload:
        *   `position` (number): Current position.
        *   `play_state` (string): "playing" or "paused".
    *   Behavior: Updates server state and broadcasts to others (typically sent periodically by host).

*   **`ping`**:
    *   Payload: `client_ts` (number).
    *   Response: `pong`

### Server -> Client

*   **`client_hello`**:
    *   Payload: `client_id` (string).

*   **`room_list`**:
    *   Payload: array of `{ id, name, count }` objects.

*   **`room_state`**:
    *   Payload: room name, host ID, state, participant count. Sent on join/create.

*   **`participants_update`**:
    *   Payload: `participant_count` (number).

*   **`player_event`**:
    *   Relayed from the host. Contains `action` and `position`.

*   **`state_update`**:
    *   Relayed from the host. Contains authoritative state.

*   **`pong`**:
    *   Payload: `client_ts` (echoed back for RTT calculation).

*   **`error`**:
    *   Payload: `code` (string), `message` (string).
