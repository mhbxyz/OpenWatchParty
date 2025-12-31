# OpenSyncParty — Synchronized Watch Parties for Jellyfin and Local Players

OpenSyncParty is an open-source synchronization layer designed to bring real-time watch-party functionality to Jellyfin and other local media players. It provides a lightweight, latency-aware coordinator that keeps multiple viewers perfectly in sync, regardless of their device or player.

The system operates through a small server component and client-side adapters, making it compatible with popular players such as VLC, MPV, or Jellyfin Web. Its modular architecture allows easy integration, community-driven extensions, and long-term maintainability.

## Key Features

* Real-time synchronization of play, pause, seek, and playback position
* Works with Jellyfin libraries, hosted locally or via Cloudflare tunnels
* Open client protocol for MPV, VLC, or browser-based players
* Group session management with rooms, permissions, and chat API
* Designed for WAN environments with jitter-tolerant syncing
* Fully open-source and easily extensible

OpenSyncParty aims to fill the gap left by missing native watch-party support in Jellyfin by providing a robust, player-independent, community-driven solution.

## M1 PoC

- Session server: `session-server/app.py`
- Web overlay: `clients/web/overlay.js`
- MPV adapter: `clients/mpv/opensyncparty.py`
- Docker Compose: `docker-compose.yml`
- Demo helper: `scripts/serve-demo.sh`

## Démarrage rapide (PoC)

1) Lancer le serveur (uv):

```bash
uv sync --group server
.venv/bin/python session-server/app.py
```

2) Ouvrir la démo web:

```bash
make demo
```

3) Adapter MPV:

```bash
mpv --input-ipc-server=/tmp/mpv-socket /path/to/video.mp4
make mpv-host ROOM=my-room
```

4) Vérifier le protocole:

```bash
make test-harness
```

## Contrôle centralisé

- `make server` / `make demo` / `make test-harness`
- `docker compose up --build session-server web-demo`
- `docker compose run --rm protocol-harness`

## Prérequis

- Python 3.11 (voir `.python-version`)
- `uv` pour la gestion des environnements et dépendances
- Dépendances centralisées dans `pyproject.toml` et verrouillées via `uv.lock`
