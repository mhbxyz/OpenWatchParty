# OpenWatchParty Documentation

OpenWatchParty is a Jellyfin plugin that enables synchronized media playback across multiple clients. Watch movies and shows together with friends, no matter where they are.

## Quick Links

| Getting Started | For Developers | Operations |
|-----------------|----------------|------------|
| [Overview](product/overview.md) | [Architecture](technical/architecture.md) | [Installation](operations/installation.md) |
| [Features](product/features.md) | [Protocol](technical/protocol.md) | [Configuration](operations/configuration.md) |
| [User Guide](product/user-guide.md) | [Server](technical/server.md) | [Deployment](operations/deployment.md) |
| [FAQ](product/faq.md) | [Client](technical/client.md) | [Security](operations/security.md) |
| | [Plugin](technical/plugin.md) | [Troubleshooting](operations/troubleshooting.md) |
| | [Sync Algorithms](technical/sync.md) | [Monitoring](operations/monitoring.md) |
| | [REST API](technical/api.md) | |

## Development

- [Development Setup](development/setup.md) - Get started contributing
- [Contributing Guide](development/contributing.md) - Code style and PR process
- [Testing](development/testing.md) - Running tests
- [Release Process](development/release.md) - How releases are made

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
| **HLS** | HTTP Live Streaming | Adaptive streaming protocol that breaks video into small segments. Used by Jellyfin for transcoded content. Introduces buffering challenges for synchronization. |
| **RTT** | Round-Trip Time | Time for a message to travel from client to server and back. Displayed in the Watch Party panel as latency indicator. Lower is better (typically 20-100ms on local network). |
| **EMA** | Exponential Moving Average | Smoothing algorithm used for clock synchronization. Prevents sudden jumps in time offset by averaging new measurements with previous values (α=0.4). |
| **JWT** | JSON Web Token | Compact, URL-safe token format for authentication. Contains user identity claims signed with a secret key. Used to verify users connecting to the session server. |
| **CORS** | Cross-Origin Resource Sharing | Browser security mechanism controlling which websites can connect to the session server. Configure `ALLOWED_ORIGINS` to restrict access. |
| **WebSocket** | - | Full-duplex communication protocol over a single TCP connection. Used for real-time sync between clients and session server. Prefix: `ws://` (unencrypted) or `wss://` (encrypted). |
| **Drift** | - | Difference between expected and actual playback position. Caused by varying playback speeds, buffering, or clock differences. Corrected by adjusting playback rate. |
| **Host** | - | The user who created the watch party room. Has exclusive control over playback (play, pause, seek). Room closes when host disconnects. |

## License

This project is open source. See the [LICENSE](../LICENSE) file for details.
