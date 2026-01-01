# Jellyfin Web UI Plugin (OpenSyncParty)

This plugin injects a Watch Party control panel into the Jellyfin Web video OSD.

## Install

1) Copy the folder to your Jellyfin Web plugins directory:

```bash
cp -r clients/web-plugin /path/to/jellyfin-web/plugins/opensyncparty
```

2) Restart Jellyfin (or reload the web client).

## Notes

- The plugin uses DOM injection and listens for the video OSD to appear.
- The WebSocket server URL defaults to `ws://localhost:8999/ws`.
