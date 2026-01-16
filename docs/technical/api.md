# REST API

## Overview

The OpenWatchParty plugin exposes REST API endpoints through Jellyfin's web server.

**Base URL:** `http(s)://<jellyfin-host>:<port>/OpenWatchParty`

## Endpoints

### GET /OpenWatchParty/ClientScript

Serves the client JavaScript bundle.

**Authentication:** None required

**Response:**
- Content-Type: `text/javascript`
- Cache-Control: `public, max-age=3600`
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
  "user_name": "John"
}
```

**When JWT not configured:**
```json
{
  "token": null,
  "auth_enabled": false,
  "user_id": "abc123",
  "user_name": "John"
}
```

**Status Codes:**
| Code | Description |
|------|-------------|
| 200 | Token generated successfully |
| 401 | Not authenticated or claims missing |
| 429 | Rate limit exceeded (10 tokens/min) |
| 500 | Plugin not configured |

**Rate Limiting:**
- Maximum 10 tokens per minute per user
- Counter resets after 1 minute of inactivity

**Example:**
```bash
# With Jellyfin API key
curl -H "X-Emby-Token: YOUR_API_KEY" \
  "http://localhost:8096/OpenWatchParty/Token"

# Response
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "auth_enabled": true,
  "expires_in": 3600,
  "user_id": "d4f8a2b1-c3e4-5f6a-7b8c-9d0e1f2a3b4c",
  "user_name": "admin"
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
  "exp": 1678903600
}
```

**Claims:**
| Claim | Description |
|-------|-------------|
| `sub` | Subject (user ID) |
| `name` | User display name |
| `aud` | Audience (configurable) |
| `iss` | Issuer (configurable) |
| `iat` | Issued at timestamp |
| `exp` | Expiration timestamp |

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
curl -H "X-Emby-Token: $TOKEN" \
  "http://localhost:8096/OpenWatchParty/Token"
```

## Configuration API

Plugin configuration is managed through Jellyfin's standard plugin configuration API:

### GET /System/Configuration/Plugin/{pluginId}

Get plugin configuration.

```bash
curl -H "X-Emby-Token: $TOKEN" \
  "http://localhost:8096/System/Configuration/Plugin/0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d"
```

### POST /System/Configuration/Plugin/{pluginId}

Update plugin configuration.

```bash
curl -X POST \
  -H "X-Emby-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "JwtSecret": "your-secret-key-at-least-32-characters",
    "JwtAudience": "OpenWatchParty",
    "JwtIssuer": "Jellyfin",
    "TokenTtlSeconds": 3600,
    "InviteTtlSeconds": 3600,
    "SessionServerUrl": "",
    "DefaultMaxBitrate": 0,
    "PreferDirectPlay": true,
    "AllowHostQualityControl": true
  }' \
  "http://localhost:8096/System/Configuration/Plugin/0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d"
```

**Note:** Requires admin privileges.

### Configuration Fields Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `JwtSecret` | string | `""` | Secret key for signing JWT tokens. **Must be at least 32 characters** with high entropy. When empty, authentication is disabled and any client can connect. |
| `JwtAudience` | string | `"OpenWatchParty"` | The `aud` (audience) claim in generated tokens. Must match the session server's expected audience if configured. |
| `JwtIssuer` | string | `"Jellyfin"` | The `iss` (issuer) claim in generated tokens. Must match the session server's expected issuer if configured. |
| `TokenTtlSeconds` | int | `3600` | Token lifetime in seconds. Valid range: 60-86400 (1 min to 24 hours). Values outside this range are clamped. |
| `InviteTtlSeconds` | int | `3600` | *Reserved for future use.* Intended for room invite link expiration. Currently not implemented. |
| `SessionServerUrl` | string | `""` | WebSocket server URL (e.g., `wss://party.example.com/ws`). **When empty**, the client auto-detects using the same hostname with port 3000 (e.g., `ws://jellyfin.local:3000/ws`). |
| `DefaultMaxBitrate` | int | `0` | Maximum streaming bitrate in bits per second. `0` = Auto (no limit). Common values: `8000000` (1080p), `4000000` (720p), `1500000` (480p). |
| `PreferDirectPlay` | bool | `true` | When `true`, attempts direct play without transcoding if the client supports the media format. Reduces server load and improves quality. |
| `AllowHostQualityControl` | bool | `true` | When `true`, the host can change quality settings during a watch party. When `false`, quality is locked to default settings. |

### SessionServerUrl Behavior

The `SessionServerUrl` field determines how clients connect to the session server:

| Value | Behavior |
|-------|----------|
| Empty string `""` | Auto-detect: uses current hostname with port 3000. Protocol matches page (http→ws, https→wss). Example: browsing `https://jellyfin.example.com` connects to `wss://jellyfin.example.com:3000/ws` |
| Full URL | Uses the specified URL exactly. Must include protocol (`ws://` or `wss://`) and path (`/ws`). Example: `wss://party.example.com/ws` |

**When to set explicitly:**
- Session server runs on a different host
- Using a reverse proxy that routes `/ws` to the session server
- Port 3000 is not accessible from clients

## WebSocket API

The session server uses WebSocket for real-time communication:

**Endpoint:** `ws(s)://<host>:3000/ws`

See [Protocol Documentation](protocol.md) for the complete WebSocket message specification.
