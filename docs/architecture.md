# Architecture

OpenSyncParty is a Jellyfin plugin paired with a lightweight Rust session server.

## Components

### 1. Jellyfin Plugin (C#)

*   **Static File Server**: Serves the client-side JavaScript bundle on `/OpenSyncParty/ClientScript`.
*   **Configuration**: Standard Jellyfin plugin configuration page.

### 2. Session Server (Rust)

*   **WebSocket Server**: Listens on `/ws` (default port `3001`) for real-time sync messages.
*   **Room Manager**: In-memory state management for watch parties.

### 3. Web Client (JavaScript)

*   **Injection**: Loaded via the "Custom HTML" feature of Jellyfin, fetching the script from the plugin's API.
*   **UI**: Adds a button to the Jellyfin header bar.
*   **Sync Logic**: Communicates with the session server WebSocket endpoint on `:3001`.

## Data Flow

1.  **Load**: Browser loads Jellyfin -> `index.html` -> `<script src="/OpenSyncParty/ClientScript">` -> Plugin Controller returns JS.
2.  **Connect**: Script initializes, finds the header, injects the button, and connects WS to `ws(s)://<host>:3001/ws`.
3.  **Sync**: Playback events are intercepted and sent over WS.

## Security

*   **Authentication**: JWT config exists in the plugin but is not enforced by the session server yet.
*   **Persistence**: Room state is ephemeral (RAM). Configuration is persistent (XML).
