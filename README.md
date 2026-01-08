# OpenWatchParty — Synchronized Watch Parties for Jellyfin

OpenWatchParty is an open-source Jellyfin plugin that brings real-time watch-party functionality to your media server. It uses a lightweight Rust session server to coordinate synchronization between clients.

## Key Features

* **Plugin + Session Server**: Jellyfin handles UI injection; a dedicated session server manages WebSocket sync.
* **Real-time Sync**: Instant synchronization of play, pause, and seek actions.
* **Integrated UI**: Injected "Watch Party" button and controls directly within the Jellyfin web player.
* **Latency Compensation**: RTT-based adjustments to handle different network conditions.
* **Easy Setup**: One plugin + one session server; advanced options available in the Dashboard.

## Getting Started

### Prerequisites

* Jellyfin Server 10.8.x or 10.9.x
* Docker & Docker Compose (recommended)

### Quick Launch (Dev Mode)

1. Clone the repository.
2. Build and start the environment:
   ```bash
   make up
   ```
3. Open Jellyfin at `http://localhost:8096`.
4. Ensure the session server is reachable at `ws://localhost:3000/ws`.
5. Start a video and click the "Watch Party" icon in the player controls.

## Documentation

Comprehensive documentation is available in the [`docs/`](docs/) directory:

### Getting Started
* [Overview](docs/product/overview.md) - What is OpenWatchParty?
* [Features](docs/product/features.md) - Full feature list
* [User Guide](docs/product/user-guide.md) - How to use watch parties
* [FAQ](docs/product/faq.md) - Frequently asked questions

### Operations
* [Installation](docs/operations/installation.md) - Step-by-step installation
* [Configuration](docs/operations/configuration.md) - Configuration options
* [Deployment](docs/operations/deployment.md) - Production deployment
* [Security](docs/operations/security.md) - Security hardening
* [Troubleshooting](docs/operations/troubleshooting.md) - Common issues

### Technical
* [Architecture](docs/technical/architecture.md) - System design
* [Protocol](docs/technical/protocol.md) - WebSocket message specification
* [Sync Algorithms](docs/technical/sync.md) - How synchronization works

### Development
* [Development Setup](docs/development/setup.md) - Set up dev environment
* [Contributing](docs/development/contributing.md) - How to contribute

## Project Structure

* `plugins/jellyfin/OpenWatchParty`: Core C# plugin source code.
* `clients/web-plugin`: JavaScript client-side logic.
* `session-server-rust`: Rust WebSocket session server.
* `infra/docker`: Development stack configuration.
* `docs/`: Comprehensive documentation.

## License

This project is open-source and available under the MIT License.
