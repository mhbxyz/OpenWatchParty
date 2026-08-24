---
title: Setup
parent: Development
nav_order: 1
---

# Development Setup

## Prerequisites

- **Docker** and **Docker Compose**
- **[Just](https://just.systems/)** — command runner (`cargo install just` or [other methods](https://just.systems/man/en/packages.html))
- **.NET 9.0 SDK** (for plugin development)
- **Rust 1.83+** (for server development)
- **Node.js 20+** (optional, for JS tooling)
- **mold** (recommended, for faster Rust linking)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/mhbxyz/OpenWatchParty.git
cd OpenWatchParty

# Configure git hooks (required once after clone)
just setup

# Start development environment
just up
```

This will:
1. Start Jellyfin on `http://localhost:8096`
2. Build and mount the plugin
3. Start the Rust session server on `http://localhost:3000`
4. Auto-inject the client script into Jellyfin's `index.html`

## First-Time Setup

### 1. Jellyfin Configuration

After running `just up`:

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
├── src/
│   ├── clients/
│   │   └── jellyfin-web/          # JavaScript client modules
│   │       ├── plugin.js          # Loader/entry point
│   │       ├── state.js           # State management
│   │       ├── utils/             # Utility functions
│   │       │   ├── log.js, media.js, misc.js
│   │       │   ├── time.js, video.js
│   │       ├── ui/                # User interface
│   │       │   ├── cards.js, home.js, indicators.js
│   │       │   ├── render.js, styles.js, toasts.js
│   │       ├── playback/          # Video sync
│   │       │   ├── bind.js, play.js, sync.js
│   │       ├── chat/              # Text chat
│   │       │   ├── input.js, messages.js
│   │       ├── ws/                # WebSocket
│   │       │   ├── auth.js, connection.js, send.js
│   │       │   └── handlers/
│   │       │       ├── clock.js, playback.js
│   │       │       ├── room.js, sync.js
│   │       └── app/               # Initialization
│   │           ├── cleanup.js, lifecycle.js
│   │
│   ├── plugins/
│   │   └── jellyfin/
│   │       └── OpenWatchParty/    # C# Jellyfin plugin
│   │           ├── Plugin.cs
│   │           ├── Controllers/
│   │           ├── Configuration/
│   │           └── Web/           # Bundled JS (copied from clients/)
│   │
│   └── server/                    # Rust WebSocket server
│       ├── src/
│       │   ├── main.rs
│       │   ├── types.rs
│       │   ├── routes.rs
│       │   ├── tasks.rs
│       │   ├── messaging.rs
│       │   ├── auth.rs
│       │   ├── utils.rs
│       │   ├── ws/
│       │   │   ├── mod.rs, connection.rs, dispatch.rs
│       │   │   ├── constants.rs, validation.rs, pending_play.rs
│       │   │   └── handlers/
│       │   │       ├── auth.rs, chat.rs, create.rs
│       │   │       ├── join.rs, misc.rs, playback.rs
│       │   └── room/
│       │       ├── mod.rs, leave.rs, close.rs
│       └── Cargo.toml
│
├── .githooks/
│   └── pre-commit             # cargo fmt check on staged .rs files
│
├── infra/
│   ├── docker/                # Docker configuration
│   │   ├── server.Dockerfile
│   │   ├── dev/
│   │   │   ├── docker-compose.yml   # Dev environment
│   │   │   ├── config/             # Jellyfin runtime config (gitignored)
│   │   │   └── scripts/
│   │   │       └── jellyfin-entrypoint.sh
│   │   └── prod/
│   │       └── docker-compose.yml   # Prod / release builds
│   └── just/                  # Just modules
│       ├── common.just        # Shared variables
│       ├── build.just
│       ├── test.just
│       ├── lint.just
│       ├── logs.just
│       ├── clean.just
│       └── shell.just
│
├── docs/                      # Documentation
│
├── justfile                   # Build automation
├── CLAUDE.md                  # AI assistant context
└── README.md                  # Project overview
```

## Commands

Run `just` for a full list (with submodules). Key commands:

### Development
| Command | Description |
|---------|-------------|
| `just up` | Start full development environment |
| `just down` | Stop all services |
| `just dev` | Start stack and follow logs |
| `just restart` | Restart all services |
| `just watch` | Watch JS files and auto-restart on change |
| `just status` | Show service status with health checks |

### Build (`just build ...`)
| Command | Description |
|---------|-------------|
| `just build` | Build the Jellyfin plugin (default) |
| `just build plugin` | Build the Jellyfin plugin |
| `just build server` | Build the session server locally (Rust) |
| `just build image` | Rebuild session server Docker image |
| `just build all` | Build everything (plugin + server image) |
| `just rebuild` | Clean + rebuild + restart everything |
| `just release` | Build release artifacts (zip) |

### Testing (`just test ...`)
| Command | Description |
|---------|-------------|
| `just test` | Run all tests (Rust + .NET) |
| `just test server` | Run Rust server tests |
| `just test plugin` | Run .NET plugin tests |

### Linting (`just lint ...`)
| Command | Description |
|---------|-------------|
| `just lint` | Run all linters (Rust + JS) |
| `just lint server` | Lint Rust code (clippy) |
| `just lint client` | Lint JavaScript (eslint) |
| `just fmt` | Format all code |
| `just check` | Run cargo check (fast compile check) |

### Logs (`just logs ...`)
| Command | Description |
|---------|-------------|
| `just logs` | Follow logs from all services |
| `just logs server` | Follow session server logs |
| `just logs jellyfin` | Follow Jellyfin logs |

### Clean (`just clean ...`)
| Command | Description |
|---------|-------------|
| `just clean` | Clean all build artifacts |
| `just clean plugin` | Clean plugin build artifacts |
| `just clean server` | Clean server build artifacts |
| `just clean docker` | Remove Docker images and volumes |
| `just reset` | Full reset (containers + artifacts) |

### Shell (`just shell ...`)
| Command | Description |
|---------|-------------|
| `just shell server` | Open shell in session server container |
| `just shell jellyfin` | Open shell in Jellyfin container |

**Quick aliases:** `u`=up, `d`=down, `s`=status

## Development Workflow

### JavaScript Client

1. **Edit files** in `src/clients/jellyfin-web/`
2. **Rebuild and restart**:
   ```bash
   just rebuild
   ```
3. **Hard refresh browser** (Ctrl+F5)

**Tip:** Use `just watch` to automatically restart Jellyfin when JS files change.

### Rust Session Server

1. **Edit files** in `src/server/src/`
2. **Rebuild everything**:
   ```bash
   just rebuild
   ```

### C# Plugin

1. **Edit files** in `src/plugins/jellyfin/OpenWatchParty/`
2. **Build and restart**:
   ```bash
   just rebuild
   ```

## Hot Reload

### JavaScript

Use `just watch` for automatic reload on JS file changes. Otherwise:
1. Run `just rebuild`
2. Hard refresh browser (Ctrl+F5)

### Rust

The session server needs restart after changes:
```bash
just rebuild
```

For faster iteration, run locally:
```bash
cd src/server
cargo watch -x run
```

### C# Plugin

Requires rebuilding and restarting Jellyfin:
```bash
just rebuild
```

## Debugging

### JavaScript (Browser)

1. Open Developer Tools (F12)
2. Go to Console tab
3. Filter by "OWP"
4. Set breakpoints in Sources tab

**Useful console commands:**
```javascript
// View current state
console.log(OWP.state);

// Check WebSocket connection
console.log(OWP.state.ws?.readyState);

// View rooms
console.log(OWP.state.rooms);
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

### Script Not Updating

1. Clear browser cache (Ctrl+Shift+Delete)
2. Hard refresh (Ctrl+F5)
3. Check ETag is changing:
   ```bash
   curl -I http://localhost:8096/OpenWatchParty/ClientScript
   ```

**Tip:** Use `just watch` to automatically restart Jellyfin when JS files change, avoiding stale cache issues.

For other issues (plugin not loading, WebSocket connection problems, build errors), see the [Troubleshooting Guide](../operations/troubleshooting.md).

## Build Optimization (Rust)

The Rust server has optimized build configuration for faster development cycles.

### Docker Build Modes

The Dockerfile supports a `BUILD_MODE` argument:

| Mode | Usage | Optimization |
|------|-------|--------------|
| `dev` | Local development (`docker-compose.yml`) | Fast builds, debug symbols |
| `release` | CI/CD and production | Full optimization, smaller binary |

Development builds use `BUILD_MODE=dev` by default. CI releases use `BUILD_MODE=release`.

### Mold Linker (Recommended)

Install the `mold` linker for 5-10x faster linking:

```bash
# Arch Linux / Manjaro
sudo pacman -S mold

# Ubuntu/Debian
sudo apt install mold

# macOS (via Homebrew)
brew install mold
```

The project's `.cargo/config.toml` automatically uses mold when available.

### Cargo Configuration

Located in `src/server/.cargo/config.toml`:

```toml
[build]
rustflags = ["-C", "link-arg=-fuse-ld=mold"]

[profile.dev]
incremental = true
opt-level = 0

[profile.dev.package."*"]
opt-level = 2  # Optimize dependencies (they rarely change)
```

### Tokio Features

The server uses minimal tokio features to reduce compile times:

```toml
# Only what's needed (instead of "full")
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time", "signal"] }
```

### Build Times

| Build Type | Without Optimization | With Optimization |
|------------|---------------------|-------------------|
| Clean build | ~4-5 min | ~2-3 min |
| Incremental rebuild | ~15-20s | ~2-3s |

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
JWT_SECRET=<output-of-openssl-rand-base64-32>
ALLOWED_ORIGINS=http://localhost:8096
LOG_LEVEL=debug
```

## Next Steps

- [Contributing](contributing.md) - How to contribute
- [Testing](testing.md) - Running tests
- [Architecture](../technical/architecture.md) - System design
