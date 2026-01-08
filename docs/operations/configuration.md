# Configuration Guide

## Plugin Configuration

Access the plugin configuration page at **Dashboard** > **Plugins** > **OpenWatchParty**.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| JWT Secret | (empty) | Secret key for signing tokens. Leave empty to disable authentication. Min 32 characters recommended. |
| JWT Audience | `OpenWatchParty` | Audience claim in generated tokens |
| JWT Issuer | `Jellyfin` | Issuer claim in generated tokens |
| Token TTL | `3600` | Token lifetime in seconds (1 hour default) |
| Invite TTL | `3600` | Invite link lifetime in seconds |
| Session Server URL | (empty) | Custom WebSocket server URL. If empty, uses `ws(s)://[host]:3000/ws` |

### JWT Secret Guidelines

For production use:
- **Minimum 32 characters**
- Use a cryptographically random string
- Never reuse secrets across environments

Generate a secure secret:
```bash
openssl rand -base64 32
```

## Session Server Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to bind to |
| `ALLOWED_ORIGINS` | `*` | CORS allowed origins (comma-separated) |
| `JWT_SECRET` | (empty) | Secret for validating tokens |
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug`, `trace` |

### Docker Compose Example

```yaml
services:
  session-server:
    image: openwatchparty-session-server
    ports:
      - "3000:3000"
    environment:
      - ALLOWED_ORIGINS=https://jellyfin.example.com
      - JWT_SECRET=${JWT_SECRET}
      - LOG_LEVEL=info
    restart: unless-stopped
```

### CORS Configuration

For security, specify allowed origins instead of using wildcard (`*`):

```bash
# Single origin
ALLOWED_ORIGINS=https://jellyfin.example.com

# Multiple origins
ALLOWED_ORIGINS=https://jellyfin.example.com,http://localhost:8096

# Development (not for production!)
ALLOWED_ORIGINS=*
```

**Warning:** Using `*` for ALLOWED_ORIGINS logs a security warning and is not recommended for production.

## Client Configuration

The client gets its configuration from the plugin. Most settings are automatic, but you can customize the WebSocket URL.

### Custom WebSocket URL

If the session server is on a different host or port:

1. Go to **Dashboard** > **Plugins** > **OpenWatchParty**
2. Set **Session Server URL** to your custom URL:
   ```
   wss://session.example.com/ws
   ```
3. Save and refresh

### URL Format

| Scheme | When to Use |
|--------|-------------|
| `ws://` | HTTP/unencrypted (development only) |
| `wss://` | HTTPS/encrypted (production) |

## Advanced Configuration

### Sync Tuning

The client has built-in constants that control synchronization behavior. These are not configurable at runtime but can be modified in the source code:

| Constant | Default | Description |
|----------|---------|-------------|
| `SUPPRESS_MS` | 2000 | Anti-feedback lock duration (ms) |
| `SEEK_THRESHOLD` | 2.5 | Position difference to trigger seek (s) |
| `STATE_UPDATE_MS` | 1000 | State update interval (ms) |
| `SYNC_LEAD_MS` | 120 | Latency compensation (ms) |
| `DRIFT_DEADZONE_SEC` | 0.04 | No-correction zone (s) |
| `DRIFT_SOFT_MAX_SEC` | 2.5 | Forced seek threshold (s) |
| `PLAYBACK_RATE_MIN` | 0.95 | Minimum catchup speed |
| `PLAYBACK_RATE_MAX` | 1.05 | Maximum catchup speed |
| `DRIFT_GAIN` | 0.5 | Speed adjustment gain |

### Server Tuning

Server constants in `src/ws.rs`:

| Constant | Default | Description |
|----------|---------|-------------|
| `PLAY_SCHEDULE_MS` | 1500 | Delay before play broadcast (ms) |
| `CONTROL_SCHEDULE_MS` | 300 | Delay before pause/seek broadcast (ms) |
| `MAX_READY_WAIT_MS` | 2000 | Max wait for ready clients (ms) |
| `MIN_STATE_UPDATE_INTERVAL_MS` | 500 | Min state update interval (ms) |
| `POSITION_JITTER_THRESHOLD` | 0.5 | HLS noise filter (s) |
| `COMMAND_COOLDOWN_MS` | 2000 | Cooldown after commands (ms) |
| `MAX_MESSAGE_SIZE` | 65536 | Max message size (bytes) |

## Configuration Examples

### Minimal Setup (Development)

```yaml
# docker-compose.yml
services:
  session-server:
    image: openwatchparty-session-server
    ports:
      - "3000:3000"
```

Plugin settings:
- JWT Secret: (empty)
- Session Server URL: (empty)

### Production Setup

```yaml
# docker-compose.yml
services:
  session-server:
    image: openwatchparty-session-server
    ports:
      - "127.0.0.1:3000:3000"  # Only localhost
    environment:
      - ALLOWED_ORIGINS=https://jellyfin.example.com
      - JWT_SECRET=${JWT_SECRET}
      - LOG_LEVEL=warn
    restart: unless-stopped
```

Plugin settings:
- JWT Secret: `your-secure-32-char-secret`
- Session Server URL: `wss://jellyfin.example.com/ws` (via reverse proxy)

### Multi-Instance Setup

For high availability or multiple Jellyfin instances:

```yaml
services:
  session-server:
    image: openwatchparty-session-server
    deploy:
      replicas: 1  # Single instance (stateful)
    environment:
      - ALLOWED_ORIGINS=https://jellyfin1.example.com,https://jellyfin2.example.com
```

**Note:** The session server is stateful (in-memory rooms), so only one instance should run. For scaling, consider adding persistence (planned feature).

## Validating Configuration

### Check Plugin Config

```bash
curl -H "X-Emby-Token: YOUR_API_KEY" \
  "http://localhost:8096/System/Configuration/Plugin/0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d"
```

### Check Server Health

```bash
curl http://localhost:3000/health
```

### Test JWT Token Generation

```bash
curl -H "X-Emby-Token: YOUR_API_KEY" \
  "http://localhost:8096/OpenWatchParty/Token"
```

Expected response:
```json
{
  "token": "eyJ...",
  "auth_enabled": true,
  "expires_in": 3600
}
```

## Next Steps

- [Security](security.md) - Security hardening
- [Deployment](deployment.md) - Production deployment
- [Troubleshooting](troubleshooting.md) - Common issues
