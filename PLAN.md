# 1. Vision & périmètre

Objectif : permettre à plusieurs utilisateurs de **regarder le même média de façon synchronisée** en partant de fichiers/URLs servis par Jellyfin.
Périmètre initial (MVP) :

* Clients ciblés : **Web HTML5** (fork/plugin du client Jellyfin), **MPV** (script Lua / JSON IPC) et **VLC** (optionnel via telnet/http).
* Serveur de session indépendant (WebSocket) qui gère rooms, état, permissions.
* Aucun changement profond sur le core Jellyfin ; un plugin serveur léger et/ou un front-end personnalisé pour ajouter le bouton « Watch Party » et injecter le client Web.

# 2. Architecture globale (haute niveau)

```
┌────────────┐        ┌─────────────────────┐        ┌─────────────┐
│  Jellyfin  │ ─────> │  Client Web / MPV   │ <────> │  Utilisateurs│
│ (media URL)│        │ (Watch UI + WS)     │        └─────────────┘
└────────────┘        └─────────────────────┘
        ▲                       ▲
        │                       │
        │                       │
  (plugin) / (share token)      │
                                ▼
                       ┌───────────────────┐
                       │ Session Server WS │
                       │ (rooms, events)   │
                       └───────────────────┘
                                ▲
                                │
                     ┌────────────────────────┐
                     │  Auth / ACL (Jellyfin) │
                     │  Metrics / Persistence │
                     └────────────────────────┘
```

# 3. Composants détaillés

## 3.1 Serveur de session (WS)

* Tech stack recommandé : **FastAPI (uvicorn) + websockets / redis (pubsub)** ou **Node.js (ws) + Redis** si préfères JS.
* Responsabilités :

  * CRUD rooms
  * Join/leave
  * Broadcast events (`play`, `pause`, `seek`, `buffering`, `host_change`, `sync_request`)
  * Gestion de la latence et resync
  * Auth (JWT signé par Jellyfin server plugin / user token)
  * Optional : persistance légère (Redis for ephemeral, Postgres pour historique)

### API WebSocket — messages (JSON)

Format général :

```json
{
  "type": "event_type",
  "room": "room_id",
  "client": "client_id",
  "payload": { ... },
  "ts": 1733820000   // epoch ms
}
```

Exemples d’événements :

* `create_room` → payload: `{ "media_url", "start_pos", "host_id", "options" }`
* `join_room` → payload: `{ "name", "auth_token" }`
* `player_event` → payload: `{ "action":"play"|"pause"|"seek", "position":float }`
* `state_update` → payload: `{ "position", "play_state", "reported_latency" }`
* `force_resync` → payload: `{ "target_position" }`
* `ping` / `pong` → payload: `{ "client_ts" }`
* `error` → payload: `{ "code","message" }`

## 3.2 Protocole & philosophie maître/esclave

Deux modes possibles :

* **Host authoritative** : l'hôte envoie l’état maître ; les autres syncent sur l’hôte. Simple à implémenter.
* **Consensus (democratic)** : moyenne des positions, règles de quorum ; plus complexe.

MVP : **Host authoritative** (option “follow host” + option “free play” pour permettre local control).

## 3.3 Compte rendu temps / compensation latence

* Chaque événement inclut `ts` du client (horloge monotone) et `server_ts`.
* Le client envoie son `ping` RTT (mesuré via `ping/pong`). Le serveur calcule `rtt/2` pour estimer latence.
* Resync policy (exemples de seuils, paramétrables) :

  * `delta < 250 ms` → no action
  * `250 ms <= delta < 750 ms` → smooth adjust (set playbackRate 0.98–1.02 pour combler sur 5–10s)
  * `delta >= 750 ms` → hard seek to target_position
* Gestion du buffering : si host bufferise plus de N secondes, pause la room et envoie `buffering_start`.

## 3.4 Plugin/server Jellyfin (C# minimal)

* Ajoute bouton UI « Create Watch Party » (ou « Start room »).
* Optionnel : fournir un token JWT signé pour auth vers le Session Server (user_id, roles, expiry).
* Fournit l’URL média (share token / direct link) pour la room.

## 3.5 Client Web (JS) — intégration

* Injecter un overlay UI (bouton, room info, chat léger).
* Hooker les events du HTML5 video element :

  * `onplay`, `onpause`, `onseeking`, `onseeked`, `ontimeupdate`, `onwaiting`
* Envoyer events au WS et appliquer events reçus.
* Implémenter smoothing (playbackRate) et hard seek.
* UI pour host controls (lock, kick, set password).

## 3.6 Client MPV (script)

* MPV expose JSON IPC via socket : tu peux écrire un petit client qui :

  * se connecte au WebSocket
  * écoute les events MPV (`observe_property` pour `pause`, `time-pos`, `speed`)
  * applique commandes (`set_property` pour `time-pos`, `speed`, `pause`)
* Livre un script Lua / Python (mpv supports Lua) qui join la room et sync automatiquement.

# 4. Messages exemple (cas d’usage)

1. Host crée room :

```json
{ "type":"create_room", "room":"abcd1234", "client":"host-1",
  "payload":{"media_url":"https://example/jellyfin/stream?X-Auth-Token=...", "start_pos":0}
}
```

2. Client rejoint :

```json
{ "type":"join_room", "room":"abcd1234", "client":"user-2", "payload":{"name":"Bob"} }
```

3. Host lance lecture :

```json
{ "type":"player_event", "room":"abcd1234", "client":"host-1",
  "payload":{"action":"play","position":0,"ts":1733820000}
}
```

4. Server broadcast → clients appliquent la logique de resync.

# 5. Exemple minimal de serveur (FastAPI + WebSocket) — pseudo code

```python
# sketch, pas production
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
app = FastAPI()
rooms = {}  # {room_id: {clients: set(), host: client_id, state: {...}}}

@app.websocket("/ws")
async def ws(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            msg = await ws.receive_json()
            # handle create_room, join_room, player_event, ping...
            # forward to room clients
    except WebSocketDisconnect:
        # cleanup
```

(à compléter avec Redis pubsub, auth JWT, reconnection logic)

# 6. Déploiement & infra (Docker + Cloudflare)

* Docker Compose services :

  * `session-server` (FastAPI / Node)
  * `redis` (ephemeral / message bus)
  * optional `postgres` for persistance
  * `nginx` or `cloudflared` tunnel container for exposer `session-server`
* Cloudflare :

  * Utilise **Cloudflare Tunnel** (Argo Tunnel / Cloudflare Zero Trust) pour exposer host `ws://session.example.com:8999` via `https` endpoint.
  * Si tu utilises Tunnel web, assure-toi que WebSocket passthrough est activé ou utiliser `cloudflared tunnel --url ws://...`.
  * Gérer TLS via Cloudflare (client speak wss://session.example.com).

# 7. Auth & sécurité

* Auth flow :

  * Jellyfin plugin signe un **short-lived JWT** (claims: `user_id`, `username`, `exp`, `permissions`) avec shared secret between Jellyfin and Session Server.
  * Client includes token in WS handshake (`?token=xyz`) or first message.
* Permissions :

  * Only authenticated users can create rooms (configurable).
  * Room visibility: `private` (invite link + password), `public` (anyone with link).
* Rate limiting / abuse prevention:

  * Rate limit messages per client to avoid spam.
  * Validate media_url belongs to same Jellyfin server or allowed hosts.
* Data privacy :

  * Don’t persist access tokens in clear; store hashed if needed.
  * Optionally, use ephemeral rooms that auto-expire.

# 8. Monitoring, metrics, logs

* Expose Prometheus metrics:

  * rooms_active, clients_connected, avg_rtt, resync_events
* Logs structured JSON for debugging.
* Health endpoint `/health` for orchestration.

# 9. Tests & QA

* Unit tests for server logic (join/leave, broadcast).
* Integration tests using headless Chromium to validate web client sync.
* Stress tests: simulate N clients with variable delay (locust/k6).
* Edge case tests: host disconnects, network partition, jitter.

# 10. Extensibilité & roadmap (milestones)

* **M1** — Spec protocol + PoC server + simple web client (injected overlay) + MPV script. (MVP)
* **M2** — Jellyfin server plugin + JWT auth + invite links.
* **M3** — Resync algorithme avancé (playbackRate smoothing), buffering detection.
* **M4** — QA, metrics, documentation, packaging (docker-compose), publish on GitHub.
* **M5** — Add VLC integration, mobile client improvements, multi-host modes.

(Je ne fournis pas d’estimation temporelle chiffrée ici ; les milestones servent de roadmap technique.)

# 11. Exemple Docker Compose (squelette)

```yaml
version: "3.8"
services:
  redis:
    image: redis:7
    restart: unless-stopped

  session:
    build: ./session
    ports:
      - "8999:8999"
    environment:
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=changeme
    depends_on:
      - redis
```

# 12. UX / UI suggestions

* Afficher lag affiché pour chaque participant (ping ms).
* Mode host: button « resync everyone » + password-protect room.
* Chat minimal + reactions (raise hand, pause request).
* Indicateur « local buffering » with explanation.

# 13. Points techniques critiques / pièges à anticiper

* **Horloges des clients** : ne pas faire confiance aveuglément aux timestamps ; utiliser ping/pong.
* **DRM** : si média est DRM-protected (Widevine), impossible de simply share URL to MPV/others. DRM = dealbreaker.
* **Transcoding** : si Jellyfin doit transcoder, latence supplémentaire → author should prefer direct play links.
* **Clients non modifiables (TV apps)** : si tu veux supporter, il faudra écrire wrappers/apps TV dédiés.

# 14. Licence & gouvernance open-source

* Licence recommandée : **MIT** ou **Apache 2.0**.
* Structure de contribution : issues/PR template, CODEOWNERS, roadmap visible.
* Make it modular: server core agnostic (clients can be built in many languages).
