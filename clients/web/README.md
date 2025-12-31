# Web Client

Browser-based client integration (Jellyfin web overlay or fork).

## PoC overlay

`overlay.js` injects a small control panel on any page with a `<video>` element.

Usage:

1. Run the session server (see `session-server/README.md` or `make server`).
2. Open a Jellyfin web player or any HTML5 video page.
3. Paste the script in the browser console or load it with a userscript manager.
4. Connect, then create or join a room.

If auth is enabled on the server, fill in `Auth token (JWT)` and optionally
`Invite token (JWT)` before joining.

Le bouton `Create invite` génère un token d'invitation (si JWT actif).

Le JWT peut être émis par le plugin Jellyfin (`/OpenSyncParty/token`).

## Demo page

Open `clients/web/demo.html` in a local server (or with a simple `python -m http.server`).
The overlay loads automatically and provides a quick room sync test.

Option rapide:

```bash
make demo
```

Via Docker:

```bash
docker compose up --build web-demo
```
