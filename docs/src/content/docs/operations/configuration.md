---
title: "Configuration Guide"
---

<span id="configuration-guide" class="legacy-anchor"></span>

For most installations, use `owpctl configure` or the plugin health dashboard. Directly editing both sides is an advanced fallback because authentication parameters must remain synchronized.

## Plugin Configuration

Access the plugin configuration page at **Dashboard** > **Plugins** > **OpenWatchParty**.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| JWT Secret | (empty) | Shared HS256 signing secret. Required for HS256 and hybrid mode; unused in asymmetric-only mode. Production must use authenticated mode. |
| Allow insecure unauthenticated development | disabled | Explicit local-development override; never enable in production. |
| JWT Audience | `OpenWatchParty` | Audience claim in generated tokens |
| JWT Issuer | `Jellyfin` | Issuer claim in generated tokens |
| Token TTL | `3600` | Token lifetime in seconds (1 hour default) |
| Invite TTL | `3600` | Invite link lifetime in seconds |
| Session Server URL | (empty) | Absolute `ws://` or `wss://` URL. Empty requires explicit trust of same-host port 3000 auto-detection. |
| Trust automatic session server | disabled | Allows tokens to be sent to `ws(s)://[host]:3000/ws` when URL is empty. |
| Hide Jellyfin's SyncPlay button | disabled | Hides the built-in SyncPlay button in Jellyfin Web (both headers and the player), leaving the Watch Party button as the only group-watching control. Applies after Jellyfin Web is reloaded or refreshes its token. |
| Show the sync adjustment button in rooms | disabled | Gives guests a sync adjustment drop-down in the room bar, to move their own video up to 0.5 s toward the host when the automatic correction cannot keep them in sync. It never changes the room's playback. Applies after Jellyfin Web is reloaded or refreshes its token. |
| Theme | Glass | Colors of the room bar, its drop-downs, the lobby panel, the up-next strip and the toasts: **Glass** (translucent dark, the default), **Solid dark**, **Light** or **High contrast**. Choosing one moves the opacity to its suggested value (55, 100, 85 and 100 %), which can then be changed. Applies after Jellyfin Web is reloaded or refreshes its token. |
| Room bar opacity | `55` % | Opacity of the room bar, its drop-downs, the lobby panel, the up-next strip and the toasts over the player, from 40 to 100 % in steps of 5. Lower values show more of the video behind them, blurred. Browsers set to reduce transparency always get an opaque surface. Applies after Jellyfin Web is reloaded or refreshes its token. |
| Text size | `14` px | Base text size of the same elements, from 12 to 18 px; their buttons, icons and spacing scale with it. Applies after Jellyfin Web is reloaded or refreshes its token. |

### JWT Secret Guidelines

For production use:
- **Base64/Base64URL generated from at least 32 random bytes**
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
| `ALLOWED_ORIGINS` | `http://localhost:8096,https://localhost:8096` | CORS allowed origins (comma-separated) |
| `JWT_SECRET` | required in `hs256` and `hybrid` | Shared secret for HS256 tokens; unused in asymmetric-only mode |
| `JWT_AUTH_MODE` | `hs256` | `hs256` accepts shared-secret HS256 tokens; `hybrid` accepts HS256 and trusted RS256 during migration; `asymmetric` accepts only trusted RS256 tokens |
| `JWT_TRUST_STORE_PATH` | Compose default `/var/lib/openwatchparty/trust-store.json` | Required by the server in `hybrid` and `asymmetric`; `owpctl pair` manages it for managed installs |
| `ALLOW_INSECURE_NO_AUTH` | `false` | Explicit development-only override for HS256/hybrid mode when the shared secret is empty; never use in production |
| `AUTH_TIMEOUT_SECONDS` | `10` | Time allowed to authenticate a JWT WebSocket connection; disabled in insecure mode |
| `MAX_CONNECTIONS` | `256` | Maximum concurrent WebSocket connections |
| `MAX_CONNECTIONS_PER_IP` | `32` | Maximum concurrent WebSocket connections per effective client IP |
| `TRUSTED_PROXIES` | (empty) | Comma-separated proxy IPs/CIDRs allowed to supply `X-Forwarded-For` |
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug`, `trace` |

In `hs256` mode, configure the same strong secret in the plugin and session server. `hybrid` also needs that secret while it accepts legacy HS256 tokens, and uses the trust store for RS256 tokens. `asymmetric` uses the plugin's RSA signing key and the server's trusted public key, so the session server does not need the shared JWT secret. `owpctl setup` defaults to hybrid; `owpctl pair` registers the plugin public key, activates RS256 issuance and switches its managed server to asymmetric mode. Invite links require a shared secret, so they are unavailable in asymmetric-only mode.

### Docker Compose Example

```yaml
services:
  session-server:
    image: ghcr.io/mhbxyz/owp-session-server:0.8.0@sha256:e0634bf2fafd59bcb612c0ec93cb7e54190eb5b00c8c37ee0680b9e92ee29f68
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      - ALLOWED_ORIGINS=https://jellyfin.example.com
      - JWT_SECRET=${JWT_SECRET}
      - ALLOW_INSECURE_NO_AUTH=false
      - LOG_LEVEL=info
    restart: unless-stopped
```

This example publishes the session server only on loopback for a reverse proxy on the same host. If the proxy runs in the same Compose network, omit `ports` and route to the service name. Never expose the unauthenticated development mode or raw port 3000 to an untrusted network.

### CORS Configuration

The server checks browser origins before a WebSocket upgrade. Specify the exact Jellyfin origins instead of using wildcard (`*`). This is not authentication: non-browser clients can forge `Origin`, so production still requires JWT authentication.

```bash
# Single origin
ALLOWED_ORIGINS=https://jellyfin.example.com

# Multiple origins
ALLOWED_ORIGINS=https://jellyfin.example.com,http://localhost:8096

# Development (not for production!)
ALLOWED_ORIGINS=*
```

**Warning:** Using `*` for ALLOWED_ORIGINS logs a security warning and is not recommended for production.

### Reverse Proxy Trust

The server ignores `X-Forwarded-For` unless the direct peer address belongs to `TRUSTED_PROXIES`. Configure only reverse proxies you operate, using exact addresses or narrow CIDRs. When trusted, the per-IP connection limit uses the first address from the right of `X-Forwarded-For` that is not itself in a trusted network, so a client cannot spoof its address by prepending values; otherwise the direct peer IP is used.

```bash
TRUSTED_PROXIES=127.0.0.1/32,10.20.0.0/16
```

WebSocket messages and individual frames are capped at 64 KiB by Warp before message assembly. Connections exceeding either concurrent connection limit receive HTTP `429`; clients exceeding the application message rate or the JWT authentication deadline are closed with WebSocket policy code `1008`.

### Room queue and lifecycle

The host's optional media queue holds at most 20 Jellyfin items. Queue messages are sent only when the client and server negotiate the `media_queue` capability; older clients can still join and follow the room's current item but do not receive queue controls or queue state. The host can reorder upcoming items and start or cancel a 10-second up-next countdown. The queue, countdown and room are held in server memory; a server restart closes rooms and discards queues. If an eligible authenticated host disconnects, the server holds the host role for 10 seconds so the same user can reclaim it. After that, the role transfers to an eligible participant or the room closes if none can take over. An explicit Leave transfers the role immediately when possible; Close for everyone closes the room. There is no queue persistence or multi-instance synchronization.

See the [threat model](/operations/security/#threat-model) for the proxy misconfiguration threat and the explicit [per-IP limits verdict](/operations/security/#per-ip-limits-verdict), and [Trust Only Your Reverse Proxy](/operations/deployment/#7-trust-only-your-reverse-proxy) for deployment guidance.

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

The value is normalized when saved and must be an absolute `ws://` or `wss://` URL with a hostname. Sub-paths and IPv6 hosts are supported. Credentials (`user:password@`), query strings, and fragments are rejected. An HTTPS Jellyfin page requires `wss://`; browsers must never downgrade it to `ws://` mixed content.

Saving a destination whose hostname or effective port differs from the Jellyfin page requires explicit confirmation. The client repeats these checks on the Token response and immediately before constructing the WebSocket, so invalid or tampered configuration fails closed.

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
| `SEEK_THRESHOLD` | 1.0 | Position difference to trigger seek (s) |
| `PAUSED_SEEK_THRESHOLD` | 0.04 | Position difference a pause aligns (s) |
| `STATE_UPDATE_MS` | 1000 | State update interval (ms) |
| `SYNC_LEAD_MS` | 300 | Latency compensation (ms) |
| `DRIFT_DEADZONE_SEC` | 0.04 | No-correction zone (s) |
| `DRIFT_SOFT_MAX_SEC` | 2.0 | Forced seek threshold (s) |
| `PLAYBACK_RATE_MIN` | 0.90 | Minimum catchup speed |
| `PLAYBACK_RATE_MAX` | 1.15 | Maximum catchup speed |
| `DRIFT_GAIN` | 0.15 | Speed adjustment gain |

### Server Tuning

Server constants in `src/server/src/ws/constants.rs`:

| Constant | Default | Description |
|----------|---------|-------------|
| `PLAY_SCHEDULE_MS` | 1000 | Delay before play broadcast (ms) |
| `CONTROL_SCHEDULE_MS` | 300 | Delay before pause/seek broadcast (ms) |
| `MAX_READY_WAIT_MS` | 2000 | Max wait for ready clients (ms) |
| `MIN_STATE_UPDATE_INTERVAL_MS` | 500 | Min state update interval (ms) |
| `POSITION_JITTER_THRESHOLD` | 0.5 | HLS noise filter (s) |
| `COMMAND_COOLDOWN_MS` | 2000 | Cooldown after commands (ms) |
| `MAX_MESSAGE_SIZE` | 65536 | Max message size (bytes) |

## Configuration Examples

### Minimal Setup (Development)

```bash
# From a source checkout, starts the loopback-only local development stack.
just up
```

Plugin settings:
- JWT Secret: (empty)
- Allow insecure unauthenticated development: enabled explicitly
- Session Server URL: (empty)
- Trust automatic same-host port 3000 session server: enabled explicitly

This no-JWT example is only for local development on loopback. Do not expose it through a reverse proxy, firewall rule, LAN binding or public interface. The repository's `infra/docker/dev/docker-compose.yml` binds the development server to `127.0.0.1`; production must use JWT authentication.

After upgrading, an empty plugin secret requires a prepared and paired asymmetric signing key, or an explicit insecure-development opt-in. For HS256 or hybrid production installs, configure the same strong secret in the plugin and server. Insecure mode is for loopback-only development and must never be exposed.

### Production Setup

```yaml
# docker-compose.yml
services:
  session-server:
    image: ghcr.io/mhbxyz/owp-session-server:0.8.0@sha256:e0634bf2fafd59bcb612c0ec93cb7e54190eb5b00c8c37ee0680b9e92ee29f68
    ports:
      - "127.0.0.1:3000:3000"  # Only localhost
    environment:
      - ALLOWED_ORIGINS=https://jellyfin.example.com
      - JWT_SECRET=${JWT_SECRET}
      - LOG_LEVEL=warn
    restart: unless-stopped
```

Plugin settings:
- JWT Secret: the generated Base64/Base64URL value from `openssl rand -base64 32` (same value as `JWT_SECRET`)
- Session Server URL: `wss://jellyfin.example.com/ws` (via reverse proxy)

The reverse proxy must send both `/ws` and `/invite` to the session server; see [Reverse Proxy Configuration](/operations/deployment/#reverse-proxy-configuration).

### Shared Server for Multiple Jellyfin Instances

One session-server can accept connections from multiple Jellyfin origins:

```yaml
services:
  session-server:
    image: ghcr.io/mhbxyz/owp-session-server:0.8.0@sha256:e0634bf2fafd59bcb612c0ec93cb7e54190eb5b00c8c37ee0680b9e92ee29f68
    environment:
      - ALLOWED_ORIGINS=https://jellyfin1.example.com,https://jellyfin2.example.com
```

Every Jellyfin instance must use the same JWT audience and issuer. In HS256 mode, each plugin must use the same shared secret; in asymmetric mode, pair each plugin signing key with the session server. The session server stores rooms and queues in memory. This configuration shares one session-server across Jellyfin instances; it is not high availability. Do not run replicas against independent in-memory state and expect rooms to synchronize. A server restart clears all rooms and queues.

## Validating Configuration

### Check Plugin Config

```bash
curl -H "Authorization: MediaBrowser Token=\"YOUR_API_KEY\"" \
  "http://localhost:8096/System/Configuration/Plugin/0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d"
```

### Check Server Health

```bash
curl http://localhost:3000/health
```

### Test JWT Token Generation

```bash
curl -H "Authorization: MediaBrowser Token=\"YOUR_API_KEY\"" \
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

- [Security](/operations/security/) - Security hardening
- [Deployment](/operations/deployment/) - Production deployment
- [Troubleshooting](/operations/troubleshooting/) - Common issues
