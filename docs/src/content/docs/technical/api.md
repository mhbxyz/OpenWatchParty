---
title: "REST API"
---

<span id="rest-api" class="legacy-anchor"></span>

## Overview

The OpenWatchParty plugin exposes REST API endpoints through Jellyfin's web server.

**Base URL:** `http(s)://<jellyfin-host>:<port>/OpenWatchParty`

## Endpoints

### GET /OpenWatchParty/ClientScript

Serves the client JavaScript bundle.

**Authentication:** None required

**Response:**
- Content-Type: `text/javascript`
- Cache-Control: `public, max-age=31536000, immutable` when the `v` query value matches the current client hash (the URL the plugin injects into Jellyfin), `no-store` when `v` is any other value, and `public, max-age=3600` without `v`. Module responses under `/OpenWatchParty/Client/` follow the same rule.
- ETag: Hash-based cache validation

**Headers:**
| Header | Description |
|--------|-------------|
| `If-None-Match` | Send cached ETag for validation |

**Status Codes:**
| Code | Description |
|------|-------------|
| 200 | JavaScript content returned |
| 304 | Not Modified (cache valid) |
| 404 | Script resource not found |

**Example:**
```bash
# First request
curl -i "http://localhost:8096/OpenWatchParty/ClientScript"

# Subsequent request with caching
curl -i -H "If-None-Match: \"abc123...\"" \
  "http://localhost:8096/OpenWatchParty/ClientScript"
```

### GET /OpenWatchParty/Token

Generates a JWT token for the authenticated user.

**Authentication:** Required (Jellyfin auth)

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "auth_enabled": true,
  "expires_in": 3600,
  "user_id": "abc123",
  "user_name": "John",
  "session_server_url": "wss://jellyfin.example.com/ws",
  "hide_native_syncplay_button": false,
  "show_sync_nudge_button": false,
  "appearance_opacity": 55,
  "appearance_text_size": 14,
  "appearance_preset": "glass",
  "invite_ttl_seconds": 3600,
  "protocol_version": 1
}
```

**When insecure development is explicitly enabled:**
```json
{
  "token": null,
  "auth_enabled": false,
  "insecure_mode": true,
  "user_id": "abc123",
  "user_name": "John",
  "session_server_url": "wss://jellyfin.example.com/ws",
  "hide_native_syncplay_button": false,
  "show_sync_nudge_button": false,
  "appearance_opacity": 55,
  "appearance_text_size": 14,
  "appearance_preset": "glass",
  "invite_ttl_seconds": 3600,
  "protocol_version": 1
}
```

`hide_native_syncplay_button` is `true` when the administrator enabled **Hide Jellyfin's SyncPlay button**; the web client then hides the built-in SyncPlay button, and shows it again when a later response turns the setting off.

`show_sync_nudge_button` is `true` when the administrator enabled **Show the sync adjustment button in rooms**; guests then get the sync adjustment in the room bar. Only an explicit `true` turns it on.

`appearance_opacity` (40-100, in steps of 5) and `appearance_text_size` (12-18) are the **Room bar opacity** in percent and the **Text size** in pixels. The web client applies them to the room bar, its drop-downs, the lobby panel, the up-next strip and the toasts, and uses the defaults (55 and 14) for a missing or out-of-range value. `appearance_preset` is the **Theme**: `glass`, `solid`, `light` or `contrast`; the client uses `glass` for a missing or unknown one.

`invite_ttl_seconds` is the configured **Invite TTL** (60-86400 seconds). The client sends it when asking the session server for a new invite link; the session server clamps it again.

`protocol_version` is the WebSocket protocol version the issued token authorizes; it is carried in the client's `auth` message (see the [protocol specification](/technical/protocol/#protocol-version)).

**Status Codes:**
| Code | Description |
|------|-------------|
| 200 | Token generated successfully |
| 401 | Not authenticated or claims missing |
| 429 | Rate limit exceeded (30 tokens/min) |
| 500 | Plugin not configured |
| 503 | Invalid or missing session destination, automatic discovery not opted into, or JWT signing configuration missing or invalid |

**Rate Limiting:**
- JWT issuance is limited to 30 tokens per fixed one-minute window per user
- The window starts with the first accepted request; the insecure no-token response does not consume a token slot

**Example:**
```bash
# With Jellyfin API key
curl -H "Authorization: MediaBrowser Token=\"YOUR_API_KEY\"" \
  "http://localhost:8096/OpenWatchParty/Token"

# Response
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "auth_enabled": true,
  "expires_in": 3600,
  "user_id": "d4f8a2b1-c3e4-5f6a-7b8c-9d0e1f2a3b4c",
  "user_name": "admin",
  "session_server_url": "wss://party.example.com/ws",
  "hide_native_syncplay_button": false,
  "show_sync_nudge_button": false,
  "appearance_opacity": 55,
  "appearance_text_size": 14,
  "appearance_preset": "glass",
  "invite_ttl_seconds": 3600,
  "protocol_version": 1
}
```

## JWT Token Structure

When authentication is enabled, the generated token contains:

**Header:**
```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

**Payload:**
```json
{
  "sub": "user-uuid",
  "name": "username",
  "aud": "OpenWatchParty",
  "iss": "Jellyfin",
  "iat": 1678900000,
  "exp": 1678903600,
  "jti": "unique-token-id"
}
```

The default signer is HS256 using the configured shared secret. An activated
plugin-managed RSA signing key instead issues RS256 tokens; the session server
can validate them using its configured public-key trust store. `aud` and `iss`
are string claims, and `jti` is generated per token.

**Claims:**
| Claim | Description |
|-------|-------------|
| `sub` | Subject (user ID) |
| `name` | User display name |
| `aud` | Audience (configurable) |
| `iss` | Issuer (configurable) |
| `iat` | Issued at timestamp |
| `exp` | Expiration timestamp |
| `jti` | Unique token identifier |

## Error Responses

All error responses follow this format:

```json
{
  "error": "Error description"
}
```

**Common Errors:**

| Status | Error | Description |
|--------|-------|-------------|
| 401 | "User identity not found in claims" | Jellyfin auth failed or claims missing |
| 429 | "Rate limit exceeded. Try again later." | Too many token requests |
| 500 | "Plugin not configured" | Plugin configuration issue |
| 503 | Configuration error | Invalid session URL, automatic discovery not opted into, or unavailable/invalid JWT signing configuration |

## Using the API

### From JavaScript

```javascript
// Get token
async function getToken() {
  const response = await fetch('/OpenWatchParty/Token', {
    credentials: 'include'  // Include Jellyfin auth cookies
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  return await response.json();
}

// Load client script
function loadClientScript() {
  const script = document.createElement('script');
  script.src = '/OpenWatchParty/ClientScript';
  document.head.appendChild(script);
}
```

### From External Applications

```bash
# Authenticate with Jellyfin first
TOKEN=$(curl -s -X POST "http://localhost:8096/Users/AuthenticateByName" \
  -H "X-Emby-Authorization: MediaBrowser Client=\"App\", Device=\"CLI\", DeviceId=\"abc\", Version=\"1.0\"" \
  -H "Content-Type: application/json" \
  -d '{"Username":"admin","Pw":"password"}' | jq -r '.AccessToken')

# Get OpenWatchParty token
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "http://localhost:8096/OpenWatchParty/Token"
```

## Plugin information, diagnostics and signing key

`GET /OpenWatchParty/Info` returns the plugin ID, name and version for the
configuration UI.

The diagnostics routes require administrator elevation:

- `GET /OpenWatchParty/Diagnostics/Status` returns redacted readiness checks and
  plugin, Jellyfin, ABI and protocol version details.
- `POST /OpenWatchParty/Diagnostics/Run` repeats the checks and attempts a
  session-server `/health` request with a five-second timeout. A failed check is
  reported in the response rather than changing the plugin configuration.

The RSA signing-key routes also require administrator elevation:

- `GET /OpenWatchParty/SigningKey` returns the public JWK, issuer and whether
  the plugin-managed key is active. It creates the key if one does not exist.
- `POST /OpenWatchParty/SigningKey/Activate` activates the key matching the
  request's `kid` and returns `204`; a mismatch returns `409`.

## Configuration API

Plugin configuration is managed through Jellyfin's standard plugin configuration API:

### GET /System/Configuration/Plugin/{pluginId}

Get plugin configuration.

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "http://localhost:8096/System/Configuration/Plugin/0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d"
```

### POST /System/Configuration/Plugin/{pluginId}

Update plugin configuration.

```bash
curl -X POST \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H "Content-Type: application/json" \
  -d '{
    "JwtSecret": "<output-of-openssl-rand-base64-32>",
    "JwtAudience": "OpenWatchParty",
    "JwtIssuer": "Jellyfin",
    "TokenTtlSeconds": 3600,
    "InviteTtlSeconds": 3600,
    "SessionServerUrl": "wss://party.example.com/ws",
    "AllowAutoDetectedSessionServer": false,
    "HideNativeSyncPlayButton": false,
    "ShowSyncNudgeButton": false,
    "AppearanceOpacity": 55,
    "AppearanceTextSize": 14,
    "AppearancePreset": "glass"
  }' \
  "http://localhost:8096/System/Configuration/Plugin/0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d"
```

**Note:** Requires admin privileges.

### Configuration Fields Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `JwtSecret` | string | `""` | Base64/Base64URL secret generated from at least 32 random bytes. Required unless `AllowInsecureNoAuth` is explicitly enabled. |
| `AllowInsecureNoAuth` | bool | `false` | Explicit local-development override. Never enable in production. |
| `JwtAudience` | string | `"OpenWatchParty"` | The `aud` (audience) claim in generated tokens. Must match the session server's expected audience if configured. |
| `JwtIssuer` | string | `"Jellyfin"` | The `iss` (issuer) claim in generated tokens. Must match the session server's expected issuer if configured. |
| `TokenTtlSeconds` | int | `3600` | Token lifetime in seconds. Valid range: 60-86400 (1 min to 24 hours). Values outside this range are clamped. |
| `InviteTtlSeconds` | int | `3600` | Lifetime of room invite links in seconds. Valid range: 60-86400 (1 min to 24 hours). Values outside this range are clamped. The session server enforces the same bounds when minting a ticket. |
| `SessionServerUrl` | string | `""` | Absolute WebSocket URL (for example, `wss://party.example.com/ws`). An empty value requires the auto-detection opt-in below. |
| `AllowAutoDetectedSessionServer` | bool | `false` | Explicitly permits same-host, port-3000 auto-detection when `SessionServerUrl` is empty. Without it, token issuance returns HTTP 503. |
| `HideNativeSyncPlayButton` | bool | `false` | Hides Jellyfin's built-in SyncPlay controls in Jellyfin Web headers. |
| `ShowSyncNudgeButton` | bool | `false` | Gives guests a local sync-adjustment control; it does not issue a room seek. |
| `AppearanceOpacity` | int | `55` | Opacity from 40 to 100, rounded to steps of 5. Applies to the room bar, drop-downs, lobby panel, up-next strip and toasts. |
| `AppearanceTextSize` | int | `14` | Base text size from 12 to 18 px for those surfaces; icons and spacing scale with it. |
| `AppearancePreset` | string | `"glass"` | Colors of those surfaces: `glass`, `solid`, `light` or `contrast`. Any other value is stored as `glass`. |

### SessionServerUrl Behavior

The `SessionServerUrl` field determines how clients connect to the session server. A configured URL must be absolute `ws://` or `wss://`, include a host, and have no credentials, query string or fragment. When it is empty, `AllowAutoDetectedSessionServer` must be true for token issuance to succeed:

| Value | Behavior |
|-------|----------|
| Empty string `""`, opt-in enabled | Auto-detect: uses current hostname with port 3000. Protocol matches page (http→ws, https→wss). Example: browsing `https://jellyfin.example.com` connects to `wss://jellyfin.example.com:3000/ws` |
| Full URL | Uses the validated URL after URI normalization. The session server endpoint normally ends in `/ws`. Example: `wss://party.example.com/ws` |

**When to set explicitly:**
- Session server runs on a different host
- Using a [reverse proxy](/operations/deployment/#reverse-proxy-configuration) that routes both `/ws` and `/invite` to the session server
- Port 3000 is not accessible from clients

## Session Server API

Besides `/health`, the session server exposes `/ready` and `/metrics` for operators (see the [Monitoring guide](/operations/monitoring/)) and one endpoint for clients.

### POST /invite

Mints a short-lived, room-scoped invite ticket for a watch party host.

**Authentication:** Required (session JWT from `GET /OpenWatchParty/Token`, sent as `Authorization: Bearer <token>`)

**Request:**
```json
{
  "room_id": "uuid-room-id",
  "ttl_seconds": 3600
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `room_id` | string | Yes | Room the ticket is scoped to; the authenticated user must be its host |
| `ttl_seconds` | number | No | Requested lifetime; clamped to 60-86400 seconds (default 3600) |

**Response (200):**
```json
{
  "ticket": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": 1678903600
}
```

**Status Codes:**
| Code | Description |
|------|-------------|
| 200 | Ticket minted |
| 401 | Missing or invalid session JWT |
| 403 | The authenticated user is not the room host |
| 404 | Room not found (closed rooms included) |
| 429 | Rate limit exceeded (10 requests/min per user) |
| 503 | Invite links require JWT authentication with a shared secret |

The link never contains the Jellyfin API token or the session JWT: the browser-side ticket is scoped to one room, expires, and only ever appears in the invite URL (`?owp_invite=<ticket>`).

## WebSocket API

The session server uses WebSocket for real-time communication:

**Endpoint:** `ws(s)://<host>:3000/ws`

See [Protocol Documentation](/technical/protocol/) for the complete WebSocket message specification.
