# Development Guide

## Prerequisites

*   Docker & Docker Compose
*   Make
*   .NET 9.0 SDK

## Quick Start

```bash
make up
```

This will:
1.  Start Jellyfin on `http://localhost:8096`.
2.  Build the plugin and mount it.
3.  Start the Rust session server on `http://localhost:3001`.
4.  **Auto-inject the script**: The `docker-compose.yml` uses a custom entrypoint to inject `<script src="/OpenSyncParty/ClientScript"></script>` into `index.html` automatically. This saves you from doing the manual step described in the User Guide during development.

## Project Structure

*   `plugins/jellyfin/OpenSyncParty`: C# Source.
    *   `Controllers/OpenSyncPartyController.cs`: Serves the client-side JS.
    *   `Web/plugin.js`: The client-side script (Embedded Resource).
*   `session-server-rust`: Rust WebSocket server that manages rooms.
*   `clients/web-plugin`: Source for the JS. **Note**: When building, this file is copied to `plugins/.../Web/plugin.js` to be embedded.

## Workflow

1.  Modify `clients/web-plugin/plugin.js`.
2.  Run `make build-plugin` (this copies the JS and rebuilds the DLL).
3.  Restart Jellyfin: `docker compose -f infra/docker/docker-compose.yml restart jellyfin-dev`.
