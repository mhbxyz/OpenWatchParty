---
title: Home
layout: home
nav_order: 1
---

<p align="center">
  <img src="logo.png" alt="OpenWatchParty" width="400">
</p>

# OpenWatchParty Documentation

OpenWatchParty is a Jellyfin plugin that enables synchronized media playback across multiple clients. Watch movies and shows together with friends, no matter where they are.

## Quick Start

### For Users

Install OpenWatchParty on your existing Jellyfin server:

1. **Deploy the Session Server**
   ```bash
   docker run -d --name owp-session -p 3000:3000 \
     -e ALLOWED_ORIGINS="http://your-jellyfin:8096" \
     ghcr.io/mhbxyz/openwatchparty-session-server:latest
   ```

2. **Install the Plugin** via Jellyfin UI
   - Go to **Dashboard** > **Plugins** > **Repositories**
   - Add: `https://mhbxyz.github.io/OpenWatchParty/jellyfin-plugin-repo/manifest.json`
   - Go to **Catalog** > **OpenWatchParty** > **Install**
   - Restart Jellyfin

3. **Enable the Client Script**
   - Go to **Dashboard** > **General** > **Custom HTML**
   - Add: `<script src="/web/plugins/openwatchparty/plugin.js"></script>`
   - Save and hard refresh (`Ctrl+F5`)

See [Installation Guide](operations/installation) for detailed instructions.

### For Developers

Set up a development environment:

```bash
git clone https://github.com/mhbxyz/OpenWatchParty.git
cd OpenWatchParty
make up      # Build and start Jellyfin + session server
make dev     # Start with log following
make watch   # Auto-restart on file changes
```

See [Development Setup](development/setup) for the full workflow.

---

## Documentation

| Getting Started | Operations | Technical |
|-----------------|------------|-----------|
| [Overview](product/overview) | [Installation](operations/installation) | [Architecture](technical/architecture) |
| [Features](product/features) | [Configuration](operations/configuration) | [Protocol](technical/protocol) |
| [User Guide](product/user-guide) | [Deployment](operations/deployment) | [Server](technical/server) |
| [FAQ](product/faq) | [Security](operations/security) | [Client](technical/client) |
| | [Troubleshooting](operations/troubleshooting) | [Plugin](technical/plugin) |
| | [Monitoring](operations/monitoring) | [Sync Algorithms](technical/sync) |
| | | [REST API](technical/api) |

## Development

- [Development Setup](development/setup) - Get started contributing
- [Contributing Guide](development/contributing) - Code style and PR process
- [Testing](development/testing) - Running tests
- [CI/CD](development/ci) - Automated workflows
- [Release Process](development/release) - How releases are made

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Jellyfin Web   │     │  Session Server │     │  Jellyfin Web   │
│    (Host)       │◄───►│     (Rust)      │◄───►│   (Clients)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                        │                       │
        └────────────────────────┴───────────────────────┘
                         WebSocket (ws://)
```

**Components:**
- **Jellyfin Plugin (C#)** - Serves client JavaScript, provides configuration UI
- **Session Server (Rust)** - Manages rooms and relays sync messages via WebSocket
- **Web Client (JavaScript)** - Injected into Jellyfin UI, handles playback synchronization

## Glossary

Technical terms used throughout this documentation:

| Term | Full Name | Description |
|------|-----------|-------------|
| **HLS** | HTTP Live Streaming | Adaptive streaming protocol that breaks video into small segments. Used by Jellyfin for transcoded content. |
| **RTT** | Round-Trip Time | Time for a message to travel from client to server and back. Displayed in the Watch Party panel as latency indicator. |
| **EMA** | Exponential Moving Average | Smoothing algorithm used for clock synchronization. Prevents sudden jumps in time offset. |
| **JWT** | JSON Web Token | Compact, URL-safe token format for authentication. Contains user identity claims signed with a secret key. |
| **CORS** | Cross-Origin Resource Sharing | Browser security mechanism controlling which websites can connect to the session server. |
| **WebSocket** | - | Full-duplex communication protocol over a single TCP connection. Used for real-time sync. |
| **Drift** | - | Difference between expected and actual playback position. Corrected by adjusting playback rate. |
| **Host** | - | The user who created the watch party room. Has exclusive control over playback. |
