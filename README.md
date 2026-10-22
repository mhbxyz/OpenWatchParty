<p align="center">
  <img src="docs/public/readme-logo.png" alt="OpenWatchParty — Real-time sync for Jellyfin" width="640">
</p>

<p align="center">
  <strong>Watch movies together, no matter the distance.</strong>
</p>

<p align="center">
  <a href="https://github.com/mhbxyz/OpenWatchParty/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/mhbxyz/OpenWatchParty/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/OpenWatchParty-0.7.0-blue?style=flat-square" alt="OpenWatchParty 0.7.0">
  <img src="https://img.shields.io/badge/Jellyfin-12.1-00a4dc?style=flat-square&logo=jellyfin" alt="Jellyfin 12.1">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License">
</p>

---

OpenWatchParty enables synchronized media playback for [Jellyfin](https://jellyfin.org/). It consists of a **Jellyfin Plugin** (C#) that integrates the UI and a **Session Server** (Rust) that manages rooms and synchronization via WebSocket.

<p align="center">
  <img src="docs/public/assets/images/watch-party-panel.png" alt="A synchronized watch party in the Jellyfin player" width="720">
</p>

OpenWatchParty 0.7 adds shared playback controls for room members, room queues
with an up-next countdown, expiring room invite links, and host recovery and
transfer. Browse the [feature guide](https://mhbxyz.github.io/OpenWatchParty/product/features/)
for the current capabilities and the [first watch-party tutorial](https://mhbxyz.github.io/OpenWatchParty/product/first-watch-party/)
for an illustrated setup.

## Quick Start

### Users

Already running Jellyfin? Follow the [illustrated first watch-party tutorial](https://mhbxyz.github.io/OpenWatchParty/product/first-watch-party/) to install the plugin and session server, verify them, and invite a second user. The server needs authentication configured on **both** sides; starting its container alone is not a complete installation.

### Developers

```bash
git clone https://github.com/mhbxyz/OpenWatchParty.git
cd OpenWatchParty
just setup
just up
```

The development Compose stack binds to loopback and defaults to unauthenticated local development when `JWT_SECRET` is empty. Production requires JWT authentication configured on both the plugin and session server. See the [Development Setup Guide](https://mhbxyz.github.io/OpenWatchParty/development/setup/) for details, then follow the [illustrated two-user walkthrough](https://mhbxyz.github.io/OpenWatchParty/product/first-watch-party/#host-create-a-room).

## Documentation

**[mhbxyz.github.io/OpenWatchParty](https://mhbxyz.github.io/OpenWatchParty/)**

## Contributing

- [Report bugs](https://github.com/mhbxyz/OpenWatchParty/issues)
- [Submit pull requests](https://github.com/mhbxyz/OpenWatchParty/pulls)
- [Contributing Guide](CONTRIBUTING.md)

## License

MIT
