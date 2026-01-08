# Development Setup

## Prerequisites

- **Docker** and **Docker Compose**
- **Make**
- **.NET 9.0 SDK** (for plugin development)
- **Rust 1.70+** (for server development)
- **Node.js 18+** (optional, for JS tooling)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/mhbxyz/OpenWatchParty.git
cd OpenWatchParty

# Start development environment
make up
```

This will:
1. Start Jellyfin on `http://localhost:8096`
2. Build and mount the plugin
3. Start the Rust session server on `http://localhost:3000`
4. Auto-inject the client script into Jellyfin's `index.html`

## First-Time Setup

### 1. Jellyfin Configuration

After running `make up`:

1. Open `http://localhost:8096`
2. Complete the Jellyfin setup wizard
3. Add a media library (can use sample media)
4. Create a user account

### 2. Plugin Configuration (Optional)

1. Go to Dashboard > Plugins > OpenWatchParty
2. Configure JWT Secret if testing authentication
3. Save and restart Jellyfin

### 3. Verify Installation

1. Play any video
2. Look for the Watch Party button in the header
3. Click to open the panel

## Project Structure

```
OpenWatchParty/
├── clients/
│   └── web-plugin/          # JavaScript client modules
│       ├── plugin.js        # Loader/entry point
│       ├── owp-state.js     # State management
│       ├── owp-utils.js     # Utilities
│       ├── owp-ui.js        # User interface
│       ├── owp-playback.js  # Video sync
│       ├── owp-ws.js        # WebSocket
│       └── owp-app.js       # Initialization
│
├── plugins/
│   └── jellyfin/
│       └── OpenWatchParty/  # C# Jellyfin plugin
│           ├── Plugin.cs
│           ├── Controllers/
│           ├── Configuration/
│           └── Web/         # Bundled JS (copied from clients/)
│
├── session-server-rust/     # Rust WebSocket server
│   ├── src/
│   │   ├── main.rs
│   │   ├── types.rs
│   │   ├── ws.rs
│   │   ├── room.rs
│   │   ├── messaging.rs
│   │   └── auth.rs
│   └── Cargo.toml
│
├── infra/
│   └── docker/              # Docker configuration
│       ├── docker-compose.yml
│       └── entrypoint.sh
│
├── docs/                    # Documentation
│
├── Makefile                 # Build automation
├── CLAUDE.md               # AI assistant context
└── README.md               # Project overview
```

## Make Commands

| Command | Description |
|---------|-------------|
| `make up` | Start full development environment |
| `make down` | Stop all services |
| `make build` | Build all components |
| `make build-plugin` | Build Jellyfin plugin only |
| `make build-server` | Build session server only |
| `make logs` | View logs from all services |
| `make logs-server` | View session server logs |
| `make restart` | Restart all services |
| `make clean` | Clean build artifacts |

## Development Workflow

### JavaScript Client

1. **Edit files** in `clients/web-plugin/`
2. **Rebuild plugin** (copies JS to plugin directory):
   ```bash
   make build-plugin
   ```
3. **Restart Jellyfin**:
   ```bash
   docker compose -f infra/docker/docker-compose.yml restart jellyfin-dev
   ```
4. **Hard refresh browser** (Ctrl+F5)

### Rust Session Server

1. **Edit files** in `session-server-rust/src/`
2. **Restart server**:
   ```bash
   docker compose -f infra/docker/docker-compose.yml restart session-server
   ```
3. Or rebuild completely:
   ```bash
   make build-server
   make up
   ```

### C# Plugin

1. **Edit files** in `plugins/jellyfin/OpenWatchParty/`
2. **Build**:
   ```bash
   make build-plugin
   ```
3. **Restart Jellyfin**:
   ```bash
   docker compose -f infra/docker/docker-compose.yml restart jellyfin-dev
   ```

## Hot Reload

### JavaScript

The client script is served from the plugin. After changes:
1. Run `make build-plugin`
2. Restart Jellyfin
3. Hard refresh browser

**Tip:** During development, you can temporarily serve the script from a local web server and modify the script tag URL for faster iteration.

### Rust

The session server needs restart after changes:
```bash
docker compose -f infra/docker/docker-compose.yml restart session-server
```

For faster iteration, run locally:
```bash
cd session-server-rust
cargo watch -x run
```

### C# Plugin

Requires rebuilding and restarting Jellyfin.

## Debugging

### JavaScript (Browser)

1. Open Developer Tools (F12)
2. Go to Console tab
3. Filter by "OWP" or "OSP"
4. Set breakpoints in Sources tab

**Useful console commands:**
```javascript
// View current state
console.log(OSP.state);

// Check WebSocket connection
console.log(OSP.state.ws?.readyState);

// View rooms
console.log(OSP.state.rooms);
```

### Rust (Server)

Enable debug logging:
```yaml
# docker-compose.yml
environment:
  - LOG_LEVEL=debug
```

Or use RUST_LOG:
```bash
RUST_LOG=debug cargo run
```

### C# (Plugin)

Check Jellyfin logs:
```bash
docker logs jellyfin-dev
```

Or enable debug logging in Jellyfin settings.

## Testing Changes

### Manual Testing

1. Open Jellyfin in two browser windows
2. Play the same video in both
3. Create a room in one window
4. Join from the other window
5. Test sync functionality

### Sync Testing

Things to test:
- [ ] Room creation
- [ ] Room joining
- [ ] Play/pause sync
- [ ] Seek sync
- [ ] Drift correction (watch for 5+ minutes)
- [ ] Disconnect/reconnect
- [ ] Host leaving

## Common Development Issues

### Plugin Not Loading

```bash
# Check plugin is mounted correctly
docker exec jellyfin-dev ls /config/plugins/

# Check plugin logs
docker logs jellyfin-dev | grep OpenWatchParty
```

### Script Not Updating

1. Clear browser cache (Ctrl+Shift+Delete)
2. Hard refresh (Ctrl+F5)
3. Check ETag is changing:
   ```bash
   curl -I http://localhost:8096/OpenWatchParty/ClientScript
   ```

### WebSocket Connection Issues

```bash
# Check session server is running
curl http://localhost:3000/health

# Check WebSocket endpoint
wscat -c ws://localhost:3000/ws
```

### Build Errors

**Rust:**
```bash
cd session-server-rust
cargo clean
cargo build
```

**C#:**
```bash
cd plugins/jellyfin/OpenWatchParty
dotnet clean
dotnet build
```

## IDE Setup

### VS Code

Recommended extensions:
- **rust-analyzer** - Rust support
- **C# Dev Kit** - C# support
- **ESLint** - JavaScript linting
- **Docker** - Docker support

`.vscode/settings.json`:
```json
{
  "rust-analyzer.cargo.buildScripts.enable": true,
  "editor.formatOnSave": true
}
```

### JetBrains

- **RustRover** for Rust
- **Rider** for C#

## Environment Variables

For local development, create `.env` file:

```bash
# .env
JWT_SECRET=dev-secret-at-least-32-characters-long
ALLOWED_ORIGINS=http://localhost:8096
LOG_LEVEL=debug
```

## Next Steps

- [Contributing](contributing.md) - How to contribute
- [Testing](testing.md) - Running tests
- [Architecture](../technical/architecture.md) - System design
