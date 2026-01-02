# Documentation Technique - Client JavaScript

## Vue d'ensemble

Le client OpenSyncParty est un ensemble de modules JavaScript (IIFE) injectés dans l'interface web de Jellyfin. Ces modules gèrent la synchronisation de lecture entre plusieurs utilisateurs via WebSocket.

## Architecture des modules

```
plugin.js          # Loader - charge les modules dans l'ordre
    ├── osp-state.js      # État global et constantes
    ├── osp-utils.js      # Fonctions utilitaires
    ├── osp-ui.js         # Interface utilisateur
    ├── osp-playback.js   # Gestion de la lecture vidéo
    ├── osp-ws.js         # Communication WebSocket
    └── osp-app.js        # Initialisation et boucles principales
```

---

## Module: `osp-state.js`

### Description
Définit l'état global partagé entre tous les modules et les constantes de configuration.

### Constantes (`OSP.constants`)

| Constante | Type | Valeur | Description |
|-----------|------|--------|-------------|
| `PANEL_ID` | string | `'osp-panel'` | ID du panneau UI |
| `BTN_ID` | string | `'osp-osd-btn'` | ID du bouton OSD |
| `STYLE_ID` | string | `'osp-style'` | ID de la balise style |
| `HOME_SECTION_ID` | string | `'osp-home-section'` | ID de la section accueil |
| `DEFAULT_WS_URL` | string | `ws(s)://host:3000/ws` | URL WebSocket du serveur |
| `SUPPRESS_MS` | number | `2000` | Durée de suppression des événements (ms) |
| `SEEK_THRESHOLD` | number | `2.5` | Seuil de différence pour déclencher un seek (secondes) |
| `STATE_UPDATE_MS` | number | `1000` | Intervalle d'envoi des mises à jour d'état (ms) |
| `SYNC_LEAD_MS` | number | `120` | Avance de synchronisation pour compenser la latence (ms) |
| `DRIFT_DEADZONE_SEC` | number | `0.04` | Zone morte où aucune correction n'est appliquée (secondes) |
| `DRIFT_SOFT_MAX_SEC` | number | `2.5` | Seuil au-delà duquel un seek forcé est effectué (secondes) |
| `PLAYBACK_RATE_MIN` | number | `0.95` | Vitesse minimale de lecture pour rattrapage |
| `PLAYBACK_RATE_MAX` | number | `1.05` | Vitesse maximale de lecture pour rattrapage |
| `DRIFT_GAIN` | number | `0.5` | Gain proportionnel pour l'ajustement de vitesse |

### État (`OSP.state`)

| Propriété | Type | Description |
|-----------|------|-------------|
| `ws` | WebSocket\|null | Instance de connexion WebSocket |
| `roomId` | string | ID de la room actuelle |
| `clientId` | string | ID unique du client (attribué par le serveur) |
| `name` | string | Nom de l'utilisateur |
| `isHost` | boolean | `true` si ce client est l'hôte de la room |
| `followHost` | boolean | `true` si le client suit les commandes de l'hôte |
| `suppressUntil` | number | Timestamp jusqu'auquel les événements sont ignorés |
| `rooms` | Array | Liste des rooms disponibles |
| `inRoom` | boolean | `true` si le client est dans une room |
| `bound` | boolean | `true` si les événements vidéo sont liés |
| `autoReconnect` | boolean | `true` pour reconnexion automatique |
| `serverOffsetMs` | number | Décalage horloge client/serveur (ms) |
| `lastSeekSentAt` | number | Timestamp du dernier seek envoyé |
| `lastStateSentAt` | number | Timestamp de la dernière mise à jour d'état |
| `lastSentPosition` | number | Dernière position envoyée (secondes) |
| `hasTimeSync` | boolean | `true` si la synchronisation d'horloge est établie |
| `pendingActionTimer` | number\|null | Timer pour actions programmées |
| `homeRoomCache` | Map | Cache des images de couverture |
| `lastParticipantCount` | number | Dernier nombre de participants connu |
| `joiningItemId` | string | ID du média en cours de chargement |
| `roomName` | string | Nom de la room actuelle |
| `participantCount` | number | Nombre de participants dans la room |
| `lastSyncServerTs` | number | Timestamp serveur de la dernière sync |
| `lastSyncPosition` | number | Position de la dernière sync (secondes) |
| `lastSyncPlayState` | string | État de lecture de la dernière sync (`'playing'`\|`'paused'`) |
| `readyRoomId` | string | ID de la room pour laquelle "ready" a été envoyé |
| `isBuffering` | boolean | `true` si la vidéo est en buffering (HLS) |
| `wantsToPlay` | boolean | `true` si l'utilisateur veut lire la vidéo |
| `isSyncing` | boolean | Verrou anti-feedback pendant la synchronisation |

---

## Module: `osp-utils.js`

### Description
Fonctions utilitaires partagées entre les modules.

### Fonctions

#### `nowMs() -> number`
Retourne le timestamp actuel en millisecondes.

#### `shouldSend() -> boolean`
Retourne `true` si le client peut envoyer des événements (hors période de suppression).

#### `suppress(ms?: number) -> void`
Active la suppression des événements pour `ms` millisecondes (défaut: `SUPPRESS_MS`).

#### `getVideo() -> HTMLVideoElement|null`
Retourne l'élément `<video>` de la page ou `null`.

#### `isVideoReady() -> boolean`
Retourne `true` si la vidéo a un `readyState >= 3` (peut jouer sans interruption).
- **Usage**: Vérifie que le HLS a suffisamment de buffer avant d'envoyer des événements.

#### `isBuffering() -> boolean`
Retourne `true` si la vidéo est en cours de buffering.
- **Logique**: `readyState < 3` OU (`networkState === 2` ET `readyState < 4`)

#### `isSeeking() -> boolean`
Retourne `true` si la vidéo est en cours de seek (`video.seeking === true`).

#### `startSyncing() -> void`
Active le verrou `isSyncing` pour `SUPPRESS_MS` millisecondes.
- **Usage**: Appelé lors de la réception d'une commande serveur pour éviter les boucles de feedback.
- **Effet**: Empêche l'envoi de `player_event` et `state_update` pendant 2 secondes.

#### `getPlaybackManager() -> PlaybackManager|null`
Retourne le gestionnaire de lecture Jellyfin.
- **Recherche**: `window.playbackManager`, `window.PlaybackManager`, `window.app?.playbackManager`

#### `getCurrentItem() -> object|null`
Retourne l'élément média actuellement en lecture.

#### `getCurrentItemId() -> string|null`
Retourne l'ID de l'élément média actuel.
- **Fallback**: Extrait l'ID depuis le hash de l'URL si non disponible via l'API.

#### `getItemImageUrl(itemId: string) -> string`
Retourne l'URL de l'image de couverture d'un élément.

#### `isHomeView() -> boolean`
Retourne `true` si l'utilisateur est sur la page d'accueil.

#### `getServerNow() -> number`
Retourne le timestamp actuel ajusté à l'horloge du serveur.
```javascript
return nowMs() + (state.serverOffsetMs || 0);
```

#### `adjustedPosition(position: number, serverTs: number) -> number`
Calcule la position ajustée en tenant compte du temps écoulé et de la latence.
```javascript
const elapsed = Math.max(0, serverNow - serverTs) + SYNC_LEAD_MS;
return position + (elapsed / 1000);
```
- **Usage**: Compense le délai de transmission du message.

#### `scheduleAt(serverTs: number, fn: Function) -> void`
Programme l'exécution d'une fonction à un timestamp serveur donné.
- **Usage**: Synchronise les actions play/pause/seek entre clients.

---

## Module: `osp-playback.js`

### Description
Gère l'interaction avec l'élément vidéo HTML5 et la synchronisation de lecture.

### Fonctions

#### `playItem(item: object) -> boolean`
Démarre la lecture d'un élément média via l'API Jellyfin.
- **Tentatives multiples**: Essaie différentes signatures de l'API Jellyfin.
- **Retour**: `true` si la lecture a démarré, `false` sinon.

#### `ensurePlayback(itemId: string, attempt?: number) -> void`
S'assure que le média spécifié est en lecture.
- **Usage**: Appelé quand un participant rejoint une room pour charger le même média que l'hôte.
- **Retry**: Jusqu'à 5 tentatives espacées de 500ms.

#### `notifyReady() -> void`
Envoie le message `ready` au serveur pour indiquer que le client est prêt à lire.
- **Condition**: Une seule notification par room.

#### `watchReady() -> void`
Attend que la vidéo soit prête (`readyState >= 2`) puis appelle `notifyReady()`.
- **Événements écoutés**: `canplay`, `loadeddata`

#### `bindVideo() -> void`
Lie les événements de la vidéo aux handlers de synchronisation.

**Événements écoutés:**
- `waiting`: Marque `isBuffering = true`
- `canplay`: Marque `isBuffering = false`
- `playing`: Marque `isBuffering = false`
- `play`: Envoie `player_event` si hôte
- `pause`: Envoie `player_event` si hôte (ignoré si buffering)
- `seeked`: Envoie `player_event` si hôte

**Logique d'envoi (`sendStateUpdate`):**
```
Si NON hôte → ignorer
Si isSyncing → ignorer (verrou anti-feedback)
Si isSeeking → ignorer (HLS ment pendant seek)
Si isBuffering OU readyState < 3 → ignorer
Si < 1000ms depuis dernier envoi → ignorer
Sinon → envoyer state_update
```

**Logique des événements (`onEvent`):**
```
Si NON hôte → ignorer
Si isSyncing → ignorer
Si readyState < 3 → ignorer
Si pause ET (isBuffering OU isSeeking) → ignorer (pas user-initiated)
Si play ET isSeeking → ignorer
Si seek ET < 500ms depuis dernier OU diff < SEEK_THRESHOLD → ignorer
Sinon → envoyer player_event
```

#### `syncLoop() -> void`
Boucle de synchronisation appelée toutes les secondes (non-hôtes uniquement).

**Algorithme de correction de drift:**
```
1. Si hôte ou pas dans room → reset playbackRate à 1
2. Si pas de sync ou état !== 'playing' → reset playbackRate à 1
3. Si isBuffering ou readyState < 3 → ne rien faire (laisser charger)
4. Si vidéo en pause → reset playbackRate à 1
5. Calculer position attendue:
   expected = lastSyncPosition + (serverNow - lastSyncServerTs) / 1000
6. Calculer drift:
   drift = expected - video.currentTime
7. Si |drift| < DRIFT_DEADZONE (0.04s) → playbackRate = 1
8. Si |drift| >= DRIFT_SOFT_MAX (2.5s) → seek forcé à expected
9. Sinon → ajuster playbackRate:
   rate = clamp(1 + drift * DRIFT_GAIN, 0.95, 1.05)
```

---

## Module: `osp-ws.js`

### Description
Gère la communication WebSocket avec le serveur de session.

### Fonctions

#### `send(type: string, payload?: object, roomOverride?: string) -> void`
Envoie un message au serveur WebSocket.
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
Crée une nouvelle room avec le nom saisi dans l'input.
- **Payload**: `{ name, start_pos, media_id }`

#### `joinRoom(id: string) -> void`
Rejoint une room existante.

#### `leaveRoom() -> void`
Quitte la room actuelle.

#### `connect() -> void`
Établit la connexion WebSocket.
- **Reconnexion auto**: Si `autoReconnect === true`, reconnecte après 3 secondes.

### Handler de messages (`handleMessage`)

#### `room_list`
Met à jour la liste des rooms disponibles et rafraîchit l'UI.

#### `client_hello`
Reçoit l'ID client attribué par le serveur.

#### `room_state`
Réponse à `create_room` ou `join_room`:
1. Met à jour l'état local (roomId, roomName, isHost, etc.)
2. Synchronise l'horloge si première connexion
3. Applique l'état de lecture initial (seek + play/pause)
4. Lance le chargement du média si non-hôte

#### `participants_update`
Met à jour le compteur de participants et affiche un toast si nouveau participant.

#### `room_closed`
Réinitialise l'état quand la room est fermée (hôte déconnecté).

#### `player_event`
Commande de lecture reçue de l'hôte:
1. Active `startSyncing()` (verrou 2s)
2. Seek si différence > SEEK_THRESHOLD
3. Met à jour l'état de sync local
4. Actions selon `action`:
   - `play`: Programme le play à `target_server_ts` ou immédiat avec compensation
   - `pause`: Programme le pause
   - `seek`: Programme le seek

#### `state_update`
Mise à jour périodique de l'hôte:
1. Seek si différence > SEEK_THRESHOLD
2. Synchronise l'état play/pause
3. Met à jour les timestamps de sync

#### `pong`
Réponse au ping pour calcul RTT:
```javascript
rtt = now - payload.client_ts;
// Ajustement EMA de l'offset serveur
sampleOffset = server_ts + (rtt / 2) - now;
serverOffsetMs = hasTimeSync ? (0.6 * old + 0.4 * sample) : sample;
```

---

## Module: `osp-ui.js`

### Description
Gère l'interface utilisateur du plugin.

### Fonctions

#### `injectStyles() -> void`
Injecte les styles CSS du panneau dans le `<head>`.

#### `updateStatusIndicator() -> void`
Met à jour l'indicateur de connexion (Online/Offline).

#### `updateRoomListUI() -> void`
Met à jour la liste des rooms dans le panneau.

#### `renderHomeWatchParties() -> void`
Affiche les watch parties sur la page d'accueil Jellyfin.
- **Cartes**: Affiche la couverture du média, le nom de la room et le nombre de participants.
- **Action**: Clic rejoint la room et charge le média.

#### `render() -> void`
Rendu principal du panneau:
- **Lobby**: Liste des rooms + formulaire de création
- **In-room**: Nom de la room, participants, RTT, bouton quitter

#### `injectOsdButton() -> void`
Injecte le bouton "Watch Party" dans les contrôles OSD du lecteur vidéo.

#### `showToast(message: string) -> void`
Affiche une notification toast.
- **Fallback**: Utilise `Dashboard.showToast()` si disponible, sinon crée un élément personnalisé.

---

## Module: `osp-app.js`

### Description
Point d'entrée principal et boucles d'initialisation.

### Fonction `init()`

1. Log de chargement
2. Injection des styles CSS
3. Création du panneau UI (caché par défaut)
4. Connexion WebSocket
5. Démarrage des intervalles:

| Intervalle | Fréquence | Action |
|------------|-----------|--------|
| UI injection | 1000ms | Injecte le bouton OSD si absent |
| Video binding | 1000ms | Lie les événements vidéo si vidéo présente |
| Ping | 3000ms | Envoie ping pour mesure RTT |
| Home render | 2000ms | Rafraîchit les watch parties sur l'accueil |
| Sync loop | 1000ms | Exécute la boucle de synchronisation |

---

## Diagramme de flux: Synchronisation

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
│        ├── Sets last_command_ts (cooldown)                      │
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
