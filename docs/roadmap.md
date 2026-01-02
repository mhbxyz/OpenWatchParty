# Roadmap

## Phase 1: MVP (Completed) ✅

*   [x] Core Jellyfin Plugin (C#)
*   [x] WebSocket Server implementation within Plugin
*   [x] Basic Client (OSD Panel)
*   [x] Play/Pause/Seek synchronization
*   [x] Room management (Create/Join)
*   [x] Docker-based development environment

## Phase 2: Polish & Security (Current) 🚧

*   [x] Plugin Configuration Page (JWT Secret)
*   [x] Secure WebSocket (WSS) support
*   [x] Host migration handling
*   [x] Auto-reconnect logic
*   [ ] Persistent Room State (survive server restart)
*   [ ] Better error handling in UI

## Phase 3: Advanced Features 🔮

*   [ ] **Chat System**: Integrated text chat in the panel.
*   [ ] **Playback Rate Smoothing**: Instead of hard seeking, adjust playback speed to drift clients back in sync.
*   [ ] **Shared Playlists**: Allow multiple users to add items to a shared queue.
*   [ ] **Permissions System**: Granular control over who can pause/seek (Host-only vs Democratic).
*   [ ] **Mobile Support**: Better UI responsiveness for Jellyfin mobile apps.

## Phase 4: Distribution 📦

*   [ ] Publish to Jellyfin Plugin Repository
*   [ ] Automated Release Workflows (GitHub Actions)
