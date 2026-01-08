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

## License

This project is open source. See the [LICENSE](../LICENSE) file for details.
