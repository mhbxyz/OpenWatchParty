---
title: Security
parent: Operations
nav_order: 4
---

# Security Guide

## Overview

OpenWatchParty includes several security features to protect your installation:

- **JWT Authentication** - Token-based access control
- **CORS Protection** - Origin validation
- **Rate Limiting** - Abuse prevention
- **Message Validation** - Input sanitization

## Authentication

### How It Works

1. User authenticates with Jellyfin
2. Client requests JWT token from plugin
3. Client sends token to session server
4. Server validates token before allowing actions

### Enabling Authentication

#### 1. Generate a Secret

```bash
# Generate a secure 32+ character secret
openssl rand -base64 32
# Example output: K7xR9mPqN2wLhVbE4cT8fY0jU5sA3dG1
```

#### 2. Configure Plugin

1. Go to **Dashboard** > **Plugins** > **OpenWatchParty**
2. Enter the secret in **JWT Secret**
3. Click **Save**

#### 3. Configure Session Server

```yaml
# docker-compose.yml
services:
  session-server:
    environment:
      - JWT_SECRET=K7xR9mPqN2wLhVbE4cT8fY0jU5sA3dG1
```

Both must use the **same secret**.

### Token Structure

Generated tokens contain:

| Claim | Description |
|-------|-------------|
| `sub` | Jellyfin user ID |
| `name` | User display name |
| `aud` | Audience (configurable) |
| `iss` | Issuer (configurable) |
| `iat` | Issued at timestamp |
| `exp` | Expiration timestamp |

### Token Lifetime

Default: 1 hour (3600 seconds)

Configurable in plugin settings:
- Minimum: 60 seconds
- Maximum: 86400 seconds (24 hours)

## CORS (Cross-Origin Resource Sharing)

### Why It Matters

CORS prevents unauthorized websites from connecting to your session server.

### Configuration

```yaml
environment:
  # Single origin (recommended)
  - ALLOWED_ORIGINS=https://jellyfin.example.com

  # Multiple origins
  - ALLOWED_ORIGINS=https://jellyfin.example.com,https://jellyfin2.example.com

  # Wildcard (NOT recommended for production)
  - ALLOWED_ORIGINS=*
```

### Security Warning

Using `*` logs a warning:
```
SECURITY: Wildcard origin (*) configured - ALL origins allowed!
```

This allows any website to connect to your session server.

## Rate Limiting

### Token Endpoint (Plugin)

- **Limit:** 30 tokens per minute per user
- **Purpose:** Prevents token abuse
- **Scope:** Per authenticated Jellyfin user

### WebSocket Messages (Server)

- **Limit:** 30 messages per second per client
- **Purpose:** Prevents message flooding
- **Scope:** Per WebSocket connection (client UUID)

### Message Size

- **Limit:** 64 KB per message
- **Purpose:** Prevents memory exhaustion attacks

### Important: Rate Limiting is Per-Client, Not Per-IP

The session server rate limits by **client UUID** (WebSocket connection), not by IP address. This means:

- An attacker could bypass rate limits by opening multiple WebSocket connections
- Each new connection gets a fresh rate limit quota

**Why this design?**
- The server doesn't have direct access to client IPs (often behind reverse proxy)
- Per-connection limiting is simpler and works in most scenarios
- Most abuse cases are prevented by JWT authentication

**For production deployments**, implement IP-based rate limiting at the reverse proxy level:

```nginx
# nginx example
limit_req_zone $binary_remote_addr zone=ws_limit:10m rate=10r/s;

location /ws {
    limit_req zone=ws_limit burst=20 nodelay;
    proxy_pass http://session-server:3000;
    # ... websocket config
}
```

```yaml
# Traefik example
http:
  middlewares:
    rate-limit:
      rateLimit:
        average: 10
        burst: 20
```

## HTTPS/WSS

### Why Use Encrypted Connections

- Protects JWT tokens from interception
- Prevents man-in-the-middle attacks
- Required for production use

### Setup

1. **Configure reverse proxy with SSL** (see [Deployment](deployment.md))
2. **Update Session Server URL** to use `wss://`:
   ```
   wss://jellyfin.example.com/ws
   ```

### Certificate Validation

The session server validates certificates by default. For self-signed certificates (development only), you may need to disable validation in the client or add the CA to the trust store.

## Input Validation

### URL Validation

Image URLs are validated to prevent XSS:
```javascript
// Only allows http(s) URLs
if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
  // Safe to use
}
```

This blocks:
- `javascript:` URLs
- `data:` URLs
- Other potentially malicious schemes

### Message Validation

The server validates:
- Message type (must be known type)
- Room existence (for room operations)
- Host permissions (for playback control)
- Payload structure

## Security Best Practices

### Production Checklist

- [ ] JWT authentication enabled
- [ ] Strong JWT secret (32+ characters)
- [ ] CORS restricted to specific origins
- [ ] HTTPS enabled (via reverse proxy)
- [ ] Session server not directly exposed to internet
- [ ] Regular updates applied
- [ ] Logs monitored for suspicious activity

### Network Security

```yaml
services:
  session-server:
    # Only expose to reverse proxy
    expose:
      - "3000"
    # Don't publish port externally
    # ports:
    #   - "3000:3000"  # BAD
    networks:
      - internal
```

### Secret Management

**DO:**
- Use environment variables for secrets
- Use `.env` files (not committed to git)
- Rotate secrets periodically
- Use different secrets per environment

**DON'T:**
- Hardcode secrets in configuration files
- Commit secrets to version control
- Share secrets across environments
- Use short or predictable secrets

### Logging

Log security-relevant events:

```yaml
environment:
  - LOG_LEVEL=warn  # Logs security warnings
```

Security warnings logged:
- Wildcard CORS configuration
- Invalid token attempts
- Rate limit violations
- Oversized messages

## Threat Model

### Threats Addressed

| Threat | Mitigation |
|--------|------------|
| Unauthorized access | JWT authentication |
| Token theft | Short expiration, HTTPS |
| Cross-site attacks | CORS validation, URL sanitization |
| Denial of service | Rate limiting, message size limits |
| Man-in-the-middle | HTTPS/WSS encryption |

### Known Limitations

| Limitation | Status |
|------------|--------|
| No room passwords | Planned |
| No user permissions (democratic mode) | Planned |
| Ephemeral sessions | By design |
| Single secret for all users | By design |
| Rate limiting per client, not IP | By design (use reverse proxy) |
| No token revocation | By design (short TTL, rotate secret) |

## What JWT Authentication Does NOT Protect

It's important to understand the scope of JWT authentication. While it verifies user identity, it has limitations:

### Not Protected by JWT

| Scenario | Current Behavior | Mitigation |
|----------|------------------|------------|
| **Room creation** | Any authenticated user can create rooms | By design - all Jellyfin users are trusted |
| **Room joining** | Any authenticated user can join any room | Planned: room passwords |
| **Room enumeration** | All users see all active rooms | By design - rooms are public within your Jellyfin instance |
| **Token revocation** | Tokens valid until expiration | Rotate JWT secret to invalidate all tokens |

### Token Lifecycle

- **Tokens cannot be individually revoked** - Once issued, a token is valid until it expires
- **Secret rotation invalidates ALL tokens** - Changing the JWT secret requires all users to re-authenticate
- **No refresh tokens** - Users get a new token on each session, not a refresh mechanism

### Trust Model

JWT authentication operates on a **trust boundary at the Jellyfin level**:

```
Internet → [Jellyfin Auth] → Trusted Zone → [OpenWatchParty]
                ↑                               ↑
           Auth boundary              All users equally trusted
```

**Implications:**
- If a user can log into Jellyfin, they can use OpenWatchParty
- There's no additional access control layer within OpenWatchParty
- Restrict Jellyfin access to control who can use watch parties

### Recommendations

1. **For private instances** - JWT provides sufficient protection
2. **For shared/public instances** - Wait for room passwords feature or restrict Jellyfin user creation
3. **For sensitive content** - Use Jellyfin's library permissions to control media access

## Incident Response

### If Secret is Compromised

1. **Immediately** change the JWT secret on both plugin and server
2. Restart all services
3. All existing tokens become invalid
4. Users must re-authenticate

### If Suspicious Activity Detected

1. Check logs for details
2. Consider temporarily disabling the service
3. Review CORS and authentication settings
4. Update to latest version

## Container Security

### Base Image

The session server uses **Alpine Linux** as its base image for minimal attack surface:

| Image | Size | CVEs |
|-------|------|------|
| `debian:bookworm-slim` | ~100MB | 30+ |
| `alpine:3.21` | ~26MB | ~6 (low severity) |

### Security Scanning

Container images are automatically scanned on every push:

- **Trivy**: Scans for CVEs in OS packages and dependencies
- **Results**: Uploaded to GitHub Security tab
- **Severity filter**: CRITICAL and HIGH vulnerabilities are flagged

### Current Security Posture

The Alpine-based image has minimal remaining vulnerabilities:

| CVE | Component | Severity | Impact |
|-----|-----------|----------|--------|
| CVE-2024-58251 | BusyBox netstat | Warning | Not used by application |
| CVE-2025-46394 | BusyBox tar | Note | Not used by application |

These vulnerabilities:
- Affect tools not used by the application (tar, netstat)
- Require local access to exploit
- Are low severity (warning/note, not critical/high)

### Hardening Recommendations

For maximum security in sensitive environments:

```dockerfile
# Option 1: Distroless (no shell, no package manager)
FROM gcr.io/distroless/static
# Requires custom healthcheck binary

# Option 2: Scratch (empty image)
FROM scratch
# Requires static binary compilation
```

### Runtime Security

The container runs with:

- **Non-root user**: `appuser` (UID 1000)
- **Read-only filesystem**: Mount volumes as needed
- **Resource limits**: CPU and memory limits in docker-compose
- **Health checks**: Automatic container restart on failure

```yaml
# docker-compose.yml security settings
services:
  session-server:
    user: "1000:1000"
    read_only: true
    security_opt:
      - no-new-privileges:true
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: '0.5'
```

## Security Updates

Stay informed about security updates:
- Watch the [GitHub repository](https://github.com/mhbxyz/OpenWatchParty)
- Check release notes for security fixes
- Update promptly when security patches are available
- Monitor the Security tab for vulnerability alerts

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do not** open a public issue
2. Email the maintainer directly
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact

## Next Steps

- [Deployment](deployment.md) - Production deployment
- [Monitoring](monitoring.md) - Monitor for issues
- [Troubleshooting](troubleshooting.md) - Common problems
