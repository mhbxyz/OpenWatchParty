# Documentation Technique - Serveur Rust

## Vue d'ensemble

Le serveur de session OpenSyncParty est une application Rust asynchrone utilisant Warp pour le WebSocket et Tokio comme runtime async. Il gère les rooms, les clients et la synchronisation de lecture en mémoire.

## Architecture des modules

```
src/
├── main.rs       # Point d'entrée, configuration Warp
├── types.rs      # Structures de données
├── ws.rs         # Handler WebSocket et logique métier
├── room.rs       # Gestion du cycle de vie des rooms
├── messaging.rs  # Fonctions d'envoi de messages
└── utils.rs      # Utilitaires (timestamp)
```

---

## Module: `main.rs`

### Description
Point d'entrée de l'application. Configure le serveur Warp et les routes.

### Fonction `main()`

```rust
#[tokio::main]
async fn main() {
    // État partagé thread-safe
    let clients: Clients = Arc::new(Mutex::new(HashMap::new()));
    let rooms: Rooms = Arc::new(Mutex::new(HashMap::new()));

    // Route WebSocket: GET /ws
    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(clients_filter)
        .and(rooms_filter)
        .map(|ws, clients, rooms| {
            ws.on_upgrade(|socket| client_connection(socket, clients, rooms))
        });

    // Écoute sur 0.0.0.0:3000
    warp::serve(ws_route).run(([0, 0, 0, 0], 3000)).await;
}
```

### État global

| Variable | Type | Description |
|----------|------|-------------|
| `clients` | `Clients` | HashMap des clients connectés |
| `rooms` | `Rooms` | HashMap des rooms actives |

---

## Module: `types.rs`

### Description
Définit les structures de données utilisées par le serveur.

### Types alias

```rust
pub type Clients = Arc<Mutex<HashMap<String, Client>>>;
pub type Rooms = Arc<Mutex<HashMap<String, Room>>>;
```

### Struct `Client`

Représente un client WebSocket connecté.

| Champ | Type | Description |
|-------|------|-------------|
| `sender` | `mpsc::UnboundedSender<...>` | Canal pour envoyer des messages au client |
| `room_id` | `Option<String>` | ID de la room actuelle (si dans une room) |

### Struct `Room`

Représente une watch party.

| Champ | Type | Sérialisé | Description |
|-------|------|-----------|-------------|
| `room_id` | `String` | Oui | Identifiant unique (UUID) |
| `name` | `String` | Oui | Nom affiché de la room |
| `host_id` | `String` | Oui | ID du client hôte |
| `media_id` | `Option<String>` | Oui | ID Jellyfin du média en lecture |
| `clients` | `Vec<String>` | Oui | Liste des IDs des participants |
| `ready_clients` | `HashSet<String>` | Oui | Clients prêts à recevoir le play |
| `pending_play` | `Option<PendingPlay>` | Oui | Action play en attente de ready |
| `state` | `PlaybackState` | Oui | État de lecture actuel |
| `last_state_ts` | `u64` | Non | Timestamp du dernier state_update accepté |
| `last_command_ts` | `u64` | Non | Timestamp du dernier player_event (cooldown) |

### Struct `PlaybackState`

État de lecture d'une room.

| Champ | Type | Description |
|-------|------|-------------|
| `position` | `f64` | Position en secondes |
| `play_state` | `String` | `"playing"` ou `"paused"` |

### Struct `PendingPlay`

Action play en attente que tous les clients soient prêts.

| Champ | Type | Description |
|-------|------|-------------|
| `position` | `f64` | Position à laquelle démarrer |
| `created_at` | `u64` | Timestamp de création |

### Struct `WsMessage`

Format des messages WebSocket.

| Champ | Type | JSON | Description |
|-------|------|------|-------------|
| `msg_type` | `String` | `"type"` | Type de message |
| `room` | `Option<String>` | `"room"` | ID de la room concernée |
| `client` | `Option<String>` | `"client"` | ID du client émetteur |
| `payload` | `Option<Value>` | `"payload"` | Données du message |
| `ts` | `u64` | `"ts"` | Timestamp client |
| `server_ts` | `Option<u64>` | `"server_ts"` | Timestamp serveur |

---

## Module: `ws.rs`

### Description
Gère les connexions WebSocket et la logique métier principale.

### Constantes

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `PLAY_SCHEDULE_MS` | 1500 | Délai avant exécution du play (ms) |
| `CONTROL_SCHEDULE_MS` | 300 | Délai avant exécution pause/seek (ms) |
| `MAX_READY_WAIT_MS` | 2000 | Temps max d'attente des ready (ms) |
| `MIN_STATE_UPDATE_INTERVAL_MS` | 500 | Intervalle min entre state_update (ms) |
| `POSITION_JITTER_THRESHOLD` | 0.5 | Seuil de bruit de position (secondes) |
| `COMMAND_COOLDOWN_MS` | 2000 | Cooldown après player_event (ms) |

### Fonction `client_connection`

Gère le cycle de vie d'une connexion client.

```rust
pub async fn client_connection(ws: WebSocket, clients: Clients, rooms: Rooms) {
    // 1. Split du WebSocket en sender/receiver
    let (client_ws_sender, mut client_ws_rcv) = ws.split();

    // 2. Création d'un canal mpsc pour l'envoi asynchrone
    let (client_sender, client_rcv) = mpsc::unbounded_channel();

    // 3. Task pour forward les messages vers le WebSocket
    tokio::spawn(async move {
        client_rcv.forward(client_ws_sender).await;
    });

    // 4. Génération d'un UUID pour le client
    let client_id = Uuid::new_v4().to_string();

    // 5. Enregistrement du client
    clients.lock().unwrap().insert(client_id, Client { sender, room_id: None });

    // 6. Envoi du client_hello avec l'ID
    send_to_client(&client_id, &WsMessage {
        msg_type: "client_hello",
        payload: { "client_id": client_id }
    });

    // 7. Envoi de la liste des rooms
    send_room_list(&client_id, &clients, &rooms);

    // 8. Boucle de réception des messages
    while let Some(msg) = client_ws_rcv.next().await {
        client_msg(&client_id, msg, &clients, &rooms).await;
    }

    // 9. Nettoyage à la déconnexion
    handle_disconnect(&client_id, &clients, &rooms);
}
```

### Fonction `all_ready`

Vérifie si tous les clients d'une room sont prêts.

```rust
fn all_ready(room: &Room) -> bool {
    room.ready_clients.len() >= room.clients.len()
}
```

### Fonction `broadcast_scheduled_play`

Diffuse un événement play programmé à tous les participants.

```rust
fn broadcast_scheduled_play(room: &mut Room, clients: &Clients, position: f64, target_server_ts: u64) {
    // 1. Met à jour l'état de la room
    room.state.position = position;
    room.state.play_state = "playing";

    // 2. Crée le message avec target_server_ts
    let msg = WsMessage {
        msg_type: "player_event",
        payload: { "action": "play", "position": position, "target_server_ts": target_server_ts },
        server_ts: target_server_ts
    };

    // 3. Broadcast à tous les clients de la room
    broadcast_to_room(room, &clients, &msg, None);
}
```

### Fonction `schedule_pending_play`

Programme un play différé avec timeout.

```rust
fn schedule_pending_play(room_id: String, created_at: u64, rooms: Rooms, clients: Clients) {
    tokio::spawn(async move {
        // Attend MAX_READY_WAIT_MS (2s)
        tokio::time::sleep(Duration::from_millis(MAX_READY_WAIT_MS)).await;

        // Vérifie si le pending_play est toujours actif
        if let Some(room) = rooms.get_mut(&room_id) {
            if let Some(pending) = &room.pending_play {
                if pending.created_at == created_at {
                    // Timeout: force le play même si pas tous prêts
                    broadcast_scheduled_play(room, &clients, pending.position, now_ms() + PLAY_SCHEDULE_MS);
                    room.pending_play = None;
                }
            }
        }
    });
}
```

### Fonction `client_msg`

Handler principal des messages entrants.

#### Message `list_rooms`
Envoie la liste des rooms au client.

#### Message `create_room`

```rust
// 1. Parse le payload
let room_name = payload.get("name");
let start_pos = payload.get("start_pos");
let media_id = payload.get("media_id");

// 2. Crée la room
let room = Room {
    room_id: Uuid::new_v4().to_string(),
    name: room_name,
    host_id: client_id,
    media_id,
    clients: vec![client_id],
    ready_clients: HashSet::from([client_id]),
    pending_play: None,
    state: PlaybackState { position: start_pos, play_state: "paused" },
    last_state_ts: now_ms(),
    last_command_ts: 0,
};

// 3. Enregistre et notifie
rooms.insert(room_id, room);
send_to_client(client_id, room_state);
broadcast_room_list(clients, rooms);
```

#### Message `join_room`

```rust
// 1. Ajoute le client à la room
room.clients.push(client_id);
room.ready_clients.remove(client_id);  // Pas encore prêt
client.room_id = Some(room_id);

// 2. Envoie l'état de la room
send_to_client(client_id, room_state);

// 3. Notifie les autres participants
broadcast_to_room(room, participants_update, exclude: client_id);
```

#### Message `ready`

```rust
// 1. Marque le client comme prêt
room.ready_clients.insert(client_id);

// 2. Si tous prêts et play en attente, lance le play
if room.pending_play.is_some() && all_ready(room) {
    let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
    broadcast_scheduled_play(room, clients, position, target_server_ts);
    room.pending_play = None;
}
```

#### Message `leave_room`
Appelle `handle_leave()` et broadcast la nouvelle liste.

#### Message `player_event` | `state_update`

**Validation:**
```rust
// Seul l'hôte peut envoyer des commandes
if room.host_id != client_id {
    return;
}
```

**Filtrage pour `state_update` (anti-HLS jitter):**
```rust
let current_ts = now_ms();

// 1. Cooldown après player_event (2s)
if room.last_command_ts > 0 && current_ts - room.last_command_ts < COMMAND_COOLDOWN_MS {
    return;  // Ignore les échos HLS
}

// 2. Analyse du changement
let new_pos = payload.get("position");
let new_play_state = payload.get("play_state");
let play_state_changed = new_play_state != room.state.play_state;
let pos_diff = new_pos - room.state.position;

// 3. Si play_state n'a pas changé, appliquer les filtres position
if !play_state_changed {
    // Rate limit: min 500ms entre updates
    if current_ts - room.last_state_ts < MIN_STATE_UPDATE_INTERVAL_MS {
        return;
    }

    // Ignore les petits sauts arrière (jitter HLS: -0.5s à -2s)
    if pos_diff < -0.5 && pos_diff > -2.0 {
        return;
    }

    // Ignore les micro-avances (< 0.5s)
    if pos_diff >= 0.0 && pos_diff < 0.5 {
        return;
    }
}
```

**Traitement `player_event`:**
```rust
let action = payload.get("action");

// Marque le timestamp pour cooldown
room.last_command_ts = current_ts;

if action == "play" {
    if all_ready(room) {
        // Tous prêts: programme le play
        let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
        broadcast_scheduled_play(room, clients, position, target_server_ts);
    } else {
        // Pas tous prêts: met en attente
        room.pending_play = Some(PendingPlay { position, created_at: now_ms() });
        schedule_pending_play(room_id, created_at, rooms, clients);
    }
} else {
    // pause/seek: broadcast avec target_server_ts
    let target_server_ts = now_ms() + CONTROL_SCHEDULE_MS;
    payload["target_server_ts"] = target_server_ts;
    broadcast_to_room(room, clients, msg, exclude: client_id);
}
```

**Traitement `state_update`:**
```rust
// Broadcast aux autres clients
msg.server_ts = Some(now_ms());
broadcast_to_room(room, clients, msg, exclude: client_id);
```

#### Message `ping`

```rust
send_to_client(client_id, WsMessage {
    msg_type: "pong",
    payload: msg.payload,  // Echo client_ts
    server_ts: Some(now_ms()),
});
```

---

## Module: `room.rs`

### Description
Gère le cycle de vie des rooms et la déconnexion des clients.

### Fonction `handle_disconnect`

Appelée quand un client se déconnecte.

```rust
pub fn handle_disconnect(client_id: &str, clients: &Clients, rooms: &Rooms) {
    // 1. Retire le client de sa room
    handle_leave(client_id, &mut clients, &mut rooms);

    // 2. Supprime le client de la liste
    clients.remove(client_id);

    // 3. Met à jour la liste des rooms pour tous
    broadcast_room_list(clients, rooms);
}
```

### Fonction `handle_leave`

Retire un client d'une room.

```rust
pub fn handle_leave(client_id: &str, clients: &mut HashMap, rooms: &mut HashMap) {
    if let Some(room_id) = client.room_id.take() {
        if let Some(room) = rooms.get_mut(&room_id) {
            // Retire le client
            room.clients.retain(|id| id != client_id);
            room.ready_clients.remove(client_id);

            // Si c'était l'hôte, annule le pending_play
            if room.host_id == client_id {
                room.pending_play = None;
            }

            // Ferme la room si vide ou si l'hôte part
            if room.clients.is_empty() || room.host_id == client_id {
                // Notifie les participants restants
                for cid in &room.clients {
                    send_to_client(cid, { "type": "room_closed" });
                }
                rooms.remove(&room_id);
            } else {
                // Notifie que le client est parti
                broadcast_to_room(room, { "type": "client_left", "client": client_id });
            }
        }
    }
}
```

---

## Module: `messaging.rs`

### Description
Fonctions utilitaires pour l'envoi de messages.

### Fonction `send_room_list`

Envoie la liste des rooms à un client spécifique.

```rust
pub fn send_room_list(client_id: &str, clients: &Clients, rooms: &Rooms) {
    let list: Vec<Value> = rooms.values().map(|r| {
        json!({ "id": r.room_id, "name": r.name, "count": r.clients.len(), "media_id": r.media_id })
    }).collect();

    send_to_client(client_id, WsMessage {
        msg_type: "room_list",
        payload: Some(json!(list)),
        server_ts: Some(now_ms()),
    });
}
```

### Fonction `broadcast_room_list`

Envoie la liste des rooms à tous les clients connectés.

```rust
pub fn broadcast_room_list(clients: &Clients, rooms: &Rooms) {
    let client_ids: Vec<String> = clients.keys().cloned().collect();
    for id in client_ids {
        send_room_list(&id, clients, rooms);
    }
}
```

### Fonction `send_to_client`

Envoie un message à un client spécifique.

```rust
pub fn send_to_client(client_id: &str, clients: &HashMap, msg: &WsMessage) {
    if let Some(client) = clients.get(client_id) {
        let json = serde_json::to_string(msg).unwrap();
        let _ = client.sender.send(Ok(warp::ws::Message::text(json)));
    }
}
```

### Fonction `broadcast_to_room`

Envoie un message à tous les clients d'une room.

```rust
pub fn broadcast_to_room(room: &Room, clients: &HashMap, msg: &WsMessage, exclude: Option<&str>) {
    let json = serde_json::to_string(msg).unwrap();
    let warp_msg = warp::ws::Message::text(json);

    for client_id in &room.clients {
        if Some(client_id.as_str()) == exclude { continue; }
        if let Some(client) = clients.get(client_id) {
            let _ = client.sender.send(Ok(warp_msg.clone()));
        }
    }
}
```

---

## Module: `utils.rs`

### Description
Fonctions utilitaires.

### Fonction `now_ms`

Retourne le timestamp actuel en millisecondes depuis UNIX epoch.

```rust
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
```

---

## Diagramme: Cycle de vie d'une room

```
┌─────────────────────────────────────────────────────────────────┐
│                      CLIENT A (HOST)                            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼ create_room
┌─────────────────────────────────────────────────────────────────┐
│  Room créée:                                                    │
│  - host_id = A                                                  │
│  - clients = [A]                                                │
│  - ready_clients = {A}                                          │
│  - state = { position: 0, play_state: "paused" }               │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            │ broadcast_room_list
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CLIENT B                                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼ join_room
┌─────────────────────────────────────────────────────────────────┐
│  Room mise à jour:                                              │
│  - clients = [A, B]                                             │
│  - ready_clients = {A}    ← B pas encore prêt                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼ ready (B charge le média)
┌─────────────────────────────────────────────────────────────────┐
│  - ready_clients = {A, B}                                       │
│  → all_ready() = true                                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼ player_event (A clique play)
┌─────────────────────────────────────────────────────────────────┐
│  1. all_ready() = true                                         │
│  2. target_server_ts = now + 1500ms                            │
│  3. broadcast_scheduled_play()                                 │
│     → Tous les clients reçoivent le play programmé             │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼ (A se déconnecte)
┌─────────────────────────────────────────────────────────────────┐
│  handle_disconnect(A):                                          │
│  - room.host_id == A → fermeture de la room                    │
│  - broadcast room_closed à B                                   │
│  - rooms.remove(room_id)                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Performance et Threading

### Modèle de concurrence

```
┌──────────────────────────────────────────────────────────────────┐
│                        Tokio Runtime                             │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐     │
│  │  Task: Client1 │  │  Task: Client2 │  │  Task: Client3 │     │
│  │  WebSocket     │  │  WebSocket     │  │  WebSocket     │     │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘     │
│          │                   │                   │               │
│          └───────────────────┼───────────────────┘               │
│                              │                                   │
│                              ▼                                   │
│                   Arc<Mutex<Clients>>                            │
│                   Arc<Mutex<Rooms>>                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Points d'attention

1. **Mutex blocking**: Les opérations sur `clients` et `rooms` sont courtes et synchrones.
2. **Pas de deadlock**: Un seul lock est acquis à la fois dans chaque handler.
3. **Clone des messages**: `warp_msg.clone()` pour broadcast efficace.
4. **Channel unbounded**: Pas de backpressure, adapté au faible volume de messages.
