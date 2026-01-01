# Architecture

OpenSyncParty is a self-contained Jellyfin plugin.

## Components

### 1. Jellyfin Plugin (C#)

*   **WebSocket Server**: Listens on `/OpenSyncParty/ws` for real-time sync messages.
*   **Static File Server**: Serves the client-side JavaScript bundle on `/OpenSyncParty/ClientScript`.
*   **Room Manager**: In-memory state management for watch parties.
*   **Configuration**: Standard Jellyfin plugin configuration page.

### 2. Web Client (JavaScript)

*   **Injection**: Loaded via the "Custom HTML" feature of Jellyfin, fetching the script from the plugin's API.
*   **UI**: Adds a button to the Jellyfin header bar.
*   **Sync Logic**: Communicates with the WebSocket endpoint relative to the current page (auto-detects wss/ws).

## Data Flow

1.  **Load**: Browser loads Jellyfin -> `index.html` -> `<script src="/OpenSyncParty/ClientScript">` -> Plugin Controller returns JS.
2.  **Connect**: Script initializes, finds the header, injects the button, and connects WS to `/OpenSyncParty/ws`.
3.  **Sync**: Playback events are intercepted and sent over WS.

## Security

*   **Authentication**: The plugin can verify Jellyfin authentication tokens (if configured).
*   **Persistence**: Room state is ephemeral (RAM). Configuration is persistent (XML).