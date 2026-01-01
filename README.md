# OpenSyncParty — Synchronized Watch Parties for Jellyfin

OpenSyncParty is an open-source Jellyfin plugin that brings real-time watch-party functionality to your media server. It provides a lightweight, latency-aware synchronization layer that keeps multiple viewers in sync, requiring no external infrastructure other than the plugin itself.

## Key Features

* **All-in-One Plugin**: No external servers to deploy. Everything runs inside Jellyfin.
* **Real-time Sync**: Instant synchronization of play, pause, and seek actions.
* **Integrated UI**: Injected "Watch Party" button and controls directly within the Jellyfin web player.
* **Latency Compensation**: RTT-based adjustments to handle different network conditions.
* **Easy Setup**: Zero configuration needed for basic use; advanced options available in the Dashboard.

## Getting Started

### Prerequisites

* Jellyfin Server 10.11.x
* Docker & Docker Compose (for development)

### Quick Launch (Dev Mode)

1. Clone the repository.
2. Build and start the environment:
   ```bash
   make up
   ```
3. Open Jellyfin at `http://localhost:8096`.
4. Start a video and click the "Watch Party" icon in the player controls.

## Documentation

Comprehensive documentation is available in the `docs/` directory:

* [User Guide](docs/user-guide.md): Installation and usage instructions.
* [Architecture](docs/architecture.md): Technical overview of how the plugin works.
* [Development Guide](docs/development.md): How to contribute and build from source.
* [Protocol](docs/protocol.md): Detailed WebSocket message specifications.

## Project Structure

* `plugins/jellyfin/OpenSyncParty`: Core C# plugin source code.
* `clients/web-plugin`: JavaScript client-side logic.
* `infra/docker`: Development stack configuration.
* `scripts/`: Helper scripts for builds and environment management.

## Roadmap

Check our [Roadmap](docs/roadmap.md) for planned features like integrated chat, playback rate smoothing, and more.

## License

This project is open-source and available under the MIT License.