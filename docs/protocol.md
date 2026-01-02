# Spécification du Protocole WebSocket

## Vue d'ensemble

OpenSyncParty utilise un protocole JSON sur WebSocket pour la communication temps réel entre les clients et le serveur de session.

**Endpoint:** `ws(s)://<jellyfin-host>:3000/ws`

---

## Format des messages

Tous les messages suivent cette structure:

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

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `type` | string | Oui | Type de message |
| `room` | string | Non | ID de la room concernée |
| `client` | string | Non | ID du client émetteur |
| `payload` | object | Non | Données spécifiques au message |
| `ts` | number | Oui | Timestamp client (ms depuis epoch) |
| `server_ts` | number | Non | Timestamp serveur (ajouté par le serveur) |

---

## Messages Client → Serveur

### `list_rooms`

Demande la liste des rooms actives.

```json
{
  "type": "list_rooms",
  "ts": 1678900000000
}
```

**Réponse:** `room_list`

---

### `create_room`

Crée une nouvelle room.

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

| Champ payload | Type | Description |
|---------------|------|-------------|
| `name` | string | Nom de la room |
| `start_pos` | number | Position initiale (secondes) |
| `media_id` | string | ID Jellyfin du média (optionnel) |

**Réponse:** `room_state`

**Effets:**
- Le client devient l'hôte
- Broadcast `room_list` à tous les clients

---

### `join_room`

Rejoint une room existante.

```json
{
  "type": "join_room",
  "room": "uuid-de-la-room",
  "ts": 1678900000000
}
```

**Réponse:** `room_state`

**Effets:**
- Le client est ajouté à `room.clients`
- Le client est retiré de `room.ready_clients`
- Broadcast `participants_update` aux autres participants

---

### `leave_room`

Quitte la room actuelle.

```json
{
  "type": "leave_room",
  "room": "uuid-de-la-room",
  "ts": 1678900000000
}
```

**Effets:**
- Si l'hôte quitte: fermeture de la room, broadcast `room_closed`
- Sinon: broadcast `participants_update`
- Broadcast `room_list` à tous

---

### `ready`

Indique que le client est prêt à recevoir des commandes de lecture.

```json
{
  "type": "ready",
  "room": "uuid-de-la-room",
  "payload": {
    "media_id": "abc123def456"
  },
  "ts": 1678900000000
}
```

**Effets:**
- Le client est ajouté à `room.ready_clients`
- Si `pending_play` existe et `all_ready()`: déclenche le play programmé

---

### `player_event`

Envoie un événement de lecture (hôte uniquement).

```json
{
  "type": "player_event",
  "room": "uuid-de-la-room",
  "payload": {
    "action": "play",
    "position": 120.5
  },
  "ts": 1678900000000
}
```

| Champ payload | Type | Description |
|---------------|------|-------------|
| `action` | string | `"play"`, `"pause"`, ou `"seek"` |
| `position` | number | Position actuelle (secondes) |

**Comportement selon action:**

| Action | Comportement serveur |
|--------|---------------------|
| `play` | Si `all_ready()`: broadcast avec `target_server_ts = now + 1500ms`. Sinon: crée `pending_play` |
| `pause` | Broadcast avec `target_server_ts = now + 300ms` |
| `seek` | Broadcast avec `target_server_ts = now + 300ms` |

**Effets:**
- Met à jour `room.state`
- Met à jour `room.last_command_ts` (cooldown)
- Broadcast aux autres participants

---

### `state_update`

Mise à jour périodique de l'état de lecture (hôte uniquement).

```json
{
  "type": "state_update",
  "room": "uuid-de-la-room",
  "payload": {
    "position": 125.3,
    "play_state": "playing"
  },
  "ts": 1678900000000
}
```

| Champ payload | Type | Description |
|---------------|------|-------------|
| `position` | number | Position actuelle (secondes) |
| `play_state` | string | `"playing"` ou `"paused"` |

**Filtrage serveur:**
1. Ignoré si `now - last_command_ts < 2000ms` (cooldown)
2. Ignoré si `now - last_state_ts < 500ms` (rate limit)
3. Ignoré si position recule de 0.5s-2s (jitter HLS)
4. Ignoré si position avance de < 0.5s (non significatif)
5. Toujours accepté si `play_state` change

---

### `ping`

Mesure de latence et synchronisation d'horloge.

```json
{
  "type": "ping",
  "payload": {
    "client_ts": 1678900000000
  },
  "ts": 1678900000000
}
```

**Réponse:** `pong`

---

## Messages Serveur → Client

### `client_hello`

Envoyé immédiatement après la connexion WebSocket.

```json
{
  "type": "client_hello",
  "client": "uuid-du-client",
  "payload": {
    "client_id": "uuid-du-client"
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

---

### `room_list`

Liste des rooms actives.

```json
{
  "type": "room_list",
  "payload": [
    {
      "id": "uuid-de-la-room",
      "name": "Movie Night",
      "count": 3,
      "media_id": "abc123def456"
    }
  ],
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

---

### `room_state`

État complet d'une room. Envoyé après `create_room` ou `join_room`.

```json
{
  "type": "room_state",
  "room": "uuid-de-la-room",
  "client": "uuid-du-client",
  "payload": {
    "name": "Movie Night",
    "host_id": "uuid-de-l-hote",
    "participant_count": 3,
    "media_id": "abc123def456",
    "state": {
      "position": 120.5,
      "play_state": "playing"
    }
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

---

### `participants_update`

Mise à jour du nombre de participants.

```json
{
  "type": "participants_update",
  "room": "uuid-de-la-room",
  "payload": {
    "participant_count": 4
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

---

### `player_event`

Commande de lecture relayée de l'hôte.

```json
{
  "type": "player_event",
  "room": "uuid-de-la-room",
  "payload": {
    "action": "play",
    "position": 120.5,
    "target_server_ts": 1678900001500
  },
  "ts": 1678900000000,
  "server_ts": 1678900001500
}
```

| Champ payload | Type | Description |
|---------------|------|-------------|
| `action` | string | `"play"`, `"pause"`, ou `"seek"` |
| `position` | number | Position de référence (secondes) |
| `target_server_ts` | number | Timestamp serveur cible pour l'exécution |

**Traitement client:**
1. Activer `isSyncing` (verrou 2s)
2. Calculer la position ajustée avec le temps écoulé
3. Programmer l'action à `target_server_ts`

---

### `state_update`

Mise à jour périodique de l'état relayée de l'hôte.

```json
{
  "type": "state_update",
  "room": "uuid-de-la-room",
  "payload": {
    "position": 125.3,
    "play_state": "playing"
  },
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

---

### `room_closed`

La room a été fermée (hôte déconnecté ou room vide).

```json
{
  "type": "room_closed",
  "ts": 1678900000000
}
```

---

### `client_left`

Un participant a quitté la room.

```json
{
  "type": "client_left",
  "room": "uuid-de-la-room",
  "client": "uuid-du-client-parti",
  "ts": 1678900000000,
  "server_ts": 1678900000000
}
```

---

### `pong`

Réponse au ping.

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

**Calcul RTT côté client:**
```javascript
const rtt = Date.now() - payload.client_ts;
const serverOffset = server_ts + (rtt / 2) - Date.now();
```

---

## Diagramme de séquence: Session complète

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
    │                          │                          │
    │                          │◄── ready ────────────────┤
    │                          │                          │
    ├── player_event (play) ──►│                          │
    │                          │   all_ready() = true     │
    │◄─ player_event ──────────┼─── player_event ────────►│
    │   target_ts = T+1500     │   target_ts = T+1500     │
    │                          │                          │
    │   [T+1500ms]             │                [T+1500ms]│
    │   video.play()           │              video.play()│
    │                          │                          │
    ├── state_update ─────────►│                          │
    │                          ├─── state_update ────────►│
    │                          │                          │
    ├── ping ─────────────────►│                          │
    │◄─── pong ────────────────┤                          │
    │                          │                          │
    ├── leave_room ───────────►│                          │
    │                          ├─── room_closed ─────────►│
    │◄─── room_list ───────────┼─── room_list ───────────►│
    │                          │                          │
```
