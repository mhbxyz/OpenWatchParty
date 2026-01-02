# Algorithmes de Synchronisation

## Vue d'ensemble

OpenSyncParty utilise plusieurs algorithmes pour maintenir la synchronisation de lecture entre les clients, en gérant les défis spécifiques du streaming HLS/transcodé.

---

## 1. Synchronisation d'horloge (NTP simplifié)

### Problème
Les clients ont des horloges système différentes. Pour synchroniser les actions, il faut connaître le décalage entre l'horloge client et l'horloge serveur.

### Algorithme

```
Client                          Server
   │                              │
   ├─── ping { client_ts: T1 } ──►│
   │                              │
   │◄── pong { client_ts: T1,     │
   │           server_ts: T2 } ───┤
   │                              │
   T3 (réception)                 │
```

**Calcul:**
```javascript
rtt = T3 - T1;                           // Round-trip time
serverTimeAtT3 = T2 + (rtt / 2);         // Estimation du temps serveur actuel
serverOffsetMs = serverTimeAtT3 - T3;    // Décalage client/serveur
```

**Lissage EMA (Exponential Moving Average):**
```javascript
// Évite les sauts brusques dus aux variations de latence
serverOffsetMs = hasTimeSync
    ? (0.6 * serverOffsetMs + 0.4 * newOffset)
    : newOffset;
```

### Utilisation
```javascript
// Obtenir le temps serveur actuel
function getServerNow() {
    return Date.now() + serverOffsetMs;
}
```

---

## 2. Programmation d'actions synchronisées

### Problème
Quand l'hôte clique "Play", tous les clients doivent démarrer la lecture au même instant, malgré la latence réseau variable.

### Solution: Target Server Timestamp

```
Host                  Server                    Client B
  │                      │                          │
  ├─ play @ pos 120s ───►│                          │
  │                      │                          │
  │                      ├── target_server_ts ─────►│
  │                      │   = now + 1500ms         │
  │                      │                          │
  │                      │                    scheduleAt(target_ts)
  │                      │                          │
  │                      │                          ▼
  │                      │                    [Attente...]
  │                      │                          │
  ◄──────────────────────┼──────────────────────────┤
                    [T = target_server_ts]          │
                                              video.play()
```

### Implémentation côté client

```javascript
function scheduleAt(serverTs, fn) {
    const serverNow = getServerNow();
    const delay = Math.max(0, serverTs - serverNow);

    if (delay === 0) {
        fn();  // Exécution immédiate
    } else {
        setTimeout(fn, delay);
    }
}
```

### Délais configurés

| Action | Délai (ms) | Raison |
|--------|------------|--------|
| `play` | 1500 | Plus long pour synchroniser le buffering |
| `pause` | 300 | Plus court car pas de buffering |
| `seek` | 300 | Plus court car position directe |

---

## 3. Correction de position avec lead time

### Problème
Le message met du temps à arriver. Quand le client reçoit "position = 120s", l'hôte est déjà plus loin.

### Solution: Lead Time Compensation

```javascript
function adjustedPosition(position, serverTs) {
    const serverNow = getServerNow();
    const elapsed = Math.max(0, serverNow - serverTs);  // Temps écoulé depuis envoi
    const lead = SYNC_LEAD_MS;  // 120ms de marge

    return position + (elapsed + lead) / 1000;
}
```

### Exemple

```
Temps serveur:  1000ms         1050ms         1100ms
                  │               │               │
Host envoie:    pos=120s        ─────────────────►│
                  │                               │
Client reçoit:  ──────────────────────────────────│
                                               pos=120s
                                               elapsed=100ms
                                               lead=120ms
                                               adjusted=120.22s
```

---

## 4. Correction de drift en continu

### Problème
Même avec une synchronisation initiale parfaite, les clients dérivent dans le temps (vitesse de lecture légèrement différente, buffers, etc.).

### Algorithme: syncLoop (non-hôtes uniquement)

```javascript
function syncLoop() {
    // Calcul de la position attendue
    const elapsed = (getServerNow() - lastSyncServerTs) / 1000;
    const expected = lastSyncPosition + elapsed;

    // Mesure du drift
    const drift = expected - video.currentTime;
    const absDrift = Math.abs(drift);

    // Zone morte: pas de correction
    if (absDrift < DRIFT_DEADZONE_SEC) {  // 0.04s
        video.playbackRate = 1;
        return;
    }

    // Drift excessif: seek forcé
    if (absDrift >= DRIFT_SOFT_MAX_SEC) {  // 2.5s
        video.currentTime = expected;
        video.playbackRate = 1;
        return;
    }

    // Zone de correction douce: ajustement de vitesse
    // drift > 0 = en retard = accélérer
    // drift < 0 = en avance = ralentir
    const rate = clamp(1 + drift * DRIFT_GAIN, 0.95, 1.05);
    video.playbackRate = rate;
}
```

### Visualisation

```
                    DRIFT_SOFT_MAX_SEC = 2.5s
                           │
    ◄─────────────────────┼────────────────────►
    │         │           │           │        │
  SEEK     SLOW      DEADZONE     FAST      SEEK
 (<−2.5s) (−2.5s     (±0.04s)   (+0.04s   (>+2.5s)
           to −0.04s)            to +2.5s)
    │         │                     │          │
    │    rate = 0.95           rate = 1.05     │
    │         │                     │          │
    └─────────┴──────────┬──────────┴──────────┘
                         │
                    rate = 1.0
```

### Formule de rate

```
rate = 1 + (drift * DRIFT_GAIN)
     = 1 + (drift * 0.5)

Exemples:
- drift = +0.2s → rate = 1.10 (clamped to 1.05)
- drift = -0.1s → rate = 0.95
- drift = +0.05s → rate = 1.025
```

---

## 5. Gestion du HLS et prévention des boucles de feedback

### Le problème HLS

Le HLS (HTTP Live Streaming) est un protocole de streaming adaptatif qui découpe la vidéo en segments. Cela crée des comportements problématiques:

1. **Faux états**: Pendant le buffering, `video.paused` peut être `true` même si l'utilisateur n'a pas cliqué pause
2. **Position instable**: `currentTime` peut sauter ou reculer pendant le chargement d'un segment
3. **Latence variable**: Chaque seek déclenche le chargement de nouveaux segments

### Scénario de boucle de feedback

```
                    SANS PROTECTION

Host ──► Server ──► Client
  │                   │
  │  "play @ 10:00"   │
  │                   │
  │            HLS bufférise...
  │            video.paused = true (faux)
  │            video.currentTime = 9:58 (retard)
  │                   │
  │◄─ "pause @ 9:58" ─┤  ← ERREUR!
  │                   │
Server broadcast "pause" à tous
  │                   │
Tout le monde s'arrête!
```

### Solutions implémentées

#### A. Verrou de synchronisation (`isSyncing`)

```javascript
// Quand on reçoit une commande serveur
function onServerCommand() {
    isSyncing = true;

    // ... appliquer la commande ...

    // Libère après 2 secondes
    setTimeout(() => { isSyncing = false; }, 2000);
}

// Avant d'envoyer au serveur
function onEvent() {
    if (isSyncing) return;  // Bloqué!
    // ...
}
```

#### B. Détection du buffering

```javascript
// Tracking des événements vidéo
video.addEventListener('waiting', () => { isBuffering = true; });
video.addEventListener('canplay', () => { isBuffering = false; });
video.addEventListener('playing', () => { isBuffering = false; });

// Filtrage
function onPauseEvent() {
    if (isBuffering) return;  // Faux pause, ignorer
    // ...
}
```

#### C. Vérification du readyState

```javascript
function isVideoReady() {
    return video.readyState >= 3;  // HAVE_FUTURE_DATA
}

function sendStateUpdate() {
    if (!isVideoReady()) return;  // Pas assez de données
    // ...
}
```

#### D. Vérification du seeking

```javascript
function onEvent() {
    if (video.seeking) return;  // En cours de seek
    // ...
}
```

### Protection côté serveur

#### Cooldown après commande

```rust
const COMMAND_COOLDOWN_MS: u64 = 2000;

// Après broadcast d'un player_event
room.last_command_ts = now_ms();

// À la réception d'un state_update
if now_ms() - room.last_command_ts < COMMAND_COOLDOWN_MS {
    return;  // Ignorer pendant le cooldown
}
```

#### Filtrage du jitter de position

```rust
const POSITION_JITTER_THRESHOLD: f64 = 0.5;

let pos_diff = new_pos - room.state.position;

// Petit saut arrière = bruit HLS
if pos_diff < -0.5 && pos_diff > -2.0 {
    return;  // Ignorer
}

// Micro-avance = pas significatif
if pos_diff >= 0.0 && pos_diff < 0.5 {
    return;  // Ignorer
}
```

---

## 6. Mécanisme Ready/Pending Play

### Problème
Quand un nouveau participant rejoint, il doit charger le média avant de pouvoir lire. Si l'hôte clique Play avant que tout le monde soit prêt, certains rateront le début.

### Solution

```
Host                     Server                   Client B
  │                         │                         │
  │                         │◄── join_room ───────────┤
  │                         │                         │
  │                         │  B pas dans ready_clients
  │                         │                         │
  ├── player_event: play ──►│                         │
  │                         │                         │
  │                    all_ready() = false            │
  │                         │                         │
  │                    pending_play = {               │
  │                      position: 120,               │
  │                      created_at: now              │
  │                    }                              │
  │                         │                         │
  │                    schedule_timeout(2s)           │
  │                         │                         │
  │                         │◄── ready ───────────────┤
  │                         │                         │
  │                    all_ready() = true             │
  │                    pending_play = None            │
  │                         │                         │
  │◄── player_event: play ─┼── player_event: play ──►│
  │    target_ts = T+1.5s   │   target_ts = T+1.5s    │
  │                         │                         │
  ▼                         │                         ▼
video.play() @ T+1.5s       │              video.play() @ T+1.5s
```

### Timeout de sécurité

Si un client ne devient jamais ready (problème réseau, etc.), le play est forcé après 2 secondes:

```rust
fn schedule_pending_play(room_id, created_at, rooms, clients) {
    tokio::spawn(async move {
        sleep(Duration::from_millis(2000)).await;

        if room.pending_play.created_at == created_at {
            // Timeout: force le play
            broadcast_scheduled_play(room, clients, position, now + 1500);
            room.pending_play = None;
        }
    });
}
```

---

## Résumé des seuils et timings

| Paramètre | Valeur | Localisation | Description |
|-----------|--------|--------------|-------------|
| `SUPPRESS_MS` | 2000ms | Client | Durée du verrou anti-feedback |
| `SEEK_THRESHOLD` | 2.5s | Client | Différence min pour seek |
| `STATE_UPDATE_MS` | 1000ms | Client | Intervalle d'envoi state |
| `SYNC_LEAD_MS` | 120ms | Client | Avance de compensation |
| `DRIFT_DEADZONE_SEC` | 0.04s | Client | Zone sans correction |
| `DRIFT_SOFT_MAX_SEC` | 2.5s | Client | Seuil de seek forcé |
| `PLAYBACK_RATE_MIN` | 0.95 | Client | Vitesse min de rattrapage |
| `PLAYBACK_RATE_MAX` | 1.05 | Client | Vitesse max de rattrapage |
| `DRIFT_GAIN` | 0.5 | Client | Gain proportionnel |
| `PLAY_SCHEDULE_MS` | 1500ms | Server | Délai avant play |
| `CONTROL_SCHEDULE_MS` | 300ms | Server | Délai avant pause/seek |
| `MAX_READY_WAIT_MS` | 2000ms | Server | Timeout ready |
| `MIN_STATE_UPDATE_INTERVAL_MS` | 500ms | Server | Rate limit state |
| `POSITION_JITTER_THRESHOLD` | 0.5s | Server | Seuil de bruit position |
| `COMMAND_COOLDOWN_MS` | 2000ms | Server | Cooldown après commande |
