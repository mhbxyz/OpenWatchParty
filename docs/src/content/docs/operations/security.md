---
title: "Security Guide"
---

<span id="security-guide" class="legacy-anchor"></span>

Report vulnerabilities privately through the repository [Security Policy](https://github.com/mhbxyz/OpenWatchParty/security/policy), never through a public issue.

## Overview

OpenWatchParty includes several security features to protect your installation:

- **JWT Authentication** - Token-based access control
- **CORS Protection** - Origin validation
- **Rate Limiting** - Abuse prevention
- **Message Validation** - Input sanitization
- **Threat Model and Abuse Limits** - see [Threat Model](#threat-model) below

## Authentication

### JWT Modes and Key Rotation

Manual installations can use `hs256` (a shared secret), `hybrid` (shared-secret HS256 plus trusted RS256 during migration), or `asymmetric` (trusted RS256 only). The plugin signs tokens with the configured shared secret or its active RSA key; the session server must be configured to accept the matching key type, audience and issuer. In asymmetric mode, the plugin keeps its RSA private key in Jellyfin's plugin data and the server stores only the public key. `owpctl setup` defaults to hybrid; `owpctl pair` registers the plugin public key and switches the managed server to asymmetric mode. Back up the trust store with the managed configuration and protect it from unauthorized writes.

For a managed HS256 or hybrid install, rotate the shared secret on both sides with `owpctl configure --rotate-jwt-secret --yes --api-token-file <protected-file>`. Rotation restarts the managed server and invalidates outstanding HS256 tokens and invite tickets. In asymmetric mode, revoke a compromised key with `owpctl trust --store <trust-store> revoke --kid <key-id>`. The current `owpctl pair` command reads the plugin's existing signing key; it does not rotate that key. Back up the plugin configuration, secrets and trust store before changing keys. Invite links require a shared secret and are unavailable in asymmetric-only mode.

### How It Works

1. User authenticates with Jellyfin
2. Client requests JWT token from plugin
3. Client sends token to session server
4. Server validates token before allowing actions

### Enabling Authentication

The steps below configure shared-secret HS256 authentication. For hybrid or asymmetric mode, see [JWT Modes and Key Rotation](#jwt-modes-and-key-rotation) and use `owpctl pair` for a managed installation.

#### 1. Generate a Secret

```bash
# Generate a secure 32+ character secret
openssl rand -base64 32
# Store the output in your secret manager; never commit it or paste it into a document
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
      - JWT_SECRET=<generated-base64-value>
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

The server checks browser `Origin` values against this allowlist before upgrading a WebSocket. This is a browser-origin filter, not authentication: non-browser clients can forge `Origin`, so production must also require JWT authentication.

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

This removes the browser-origin filter. JWT authentication is still required because non-browser clients can forge the `Origin` header.

## Rate Limiting and Connection Limits

### Token Endpoint (Plugin)

- **Limit:** 30 tokens per minute per Jellyfin user
- **Purpose:** Limits token issuance to authenticated users and prevents token abuse
- **Scope:** Per authenticated Jellyfin user, enforced by `MaxTokensPerMinute` in `src/plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs` with the window logic in `src/plugins/jellyfin/OpenWatchParty/TokenRateLimiter.cs` (HTTP `429` when exceeded)
- **Tests:** `SequentialRequestsStopExactlyAtLimit` and `ParallelBurstNeverExceedsLimit` in `src/plugins/jellyfin/OpenWatchParty.Tests/TokenRateLimiterTests.cs`

### WebSocket Messages (Server)

- **Limit:** 30 messages per 1000 ms window per connection
- **Purpose:** Prevents message flooding
- **Scope:** Per WebSocket connection, counted by `update_rate_limit` in `src/server/src/ws/dispatch.rs` using `RATE_LIMIT_MESSAGES` and `RATE_LIMIT_WINDOW_MS` from `src/server/src/ws/constants.rs`. A connection that exceeds the window is closed with WebSocket policy code `1008`.
- **Tests:** `check_rate_limit_under`, `check_rate_limit_at_limit` and `rate_limit_violation_is_terminal` in `src/server/src/ws/dispatch.rs`

### WebSocket Connections (Server)

- **Global limit:** 256 concurrent connections (`MAX_CONNECTIONS`)
- **Per-IP limit:** 32 concurrent connections per effective client IP (`MAX_CONNECTIONS_PER_IP`)
- **Purpose:** Prevents connection exhaustion and bounds the work a single source can create before authenticating
- **Enforcement:** `ConnectionLimiter` in `src/server/src/routes.rs`; an upgrade over either limit is rejected with HTTP `429`
- **Tests:** `connection_limits_are_global_per_ip_and_released_on_drop` and `forwarded_for_requires_a_trusted_proxy` in `src/server/src/routes.rs`

### Message Size

- **Limit:** 64 KiB per WebSocket frame and per assembled message
- **Purpose:** Bounds individual frames and messages; this is not a process-wide memory limit or proof against every memory-exhaustion condition
- **Enforcement:** `MAX_FRAME_SIZE` and `MAX_MESSAGE_SIZE` in `src/server/src/ws/constants.rs`, applied to the connection in `src/server/src/routes.rs` and re-checked in `src/server/src/ws/dispatch.rs`
- **Test:** `transport_limits_are_fixed_at_sixty_four_kibibytes` in `src/server/src/routes.rs`

### Published session-server advisory

[GHSA-fjpr-3g28-27r9](https://github.com/mhbxyz/OpenWatchParty/security/advisories/GHSA-fjpr-3g28-27r9) affects session-server releases `>=0.1.0,<0.7.0`. Before 0.7.0, an unauthenticated client could send oversized application-level pings that were reflected into queued pong responses. Version `0.7.0` fixes this by returning a bounded response containing only a validated clock-sync timestamp. The regression tests measure serialized queued-pong response sizes; there is no demonstrated RSS increase or out-of-memory incident. Upgrade the **session server** to `0.7.0` or newer; changing only the Jellyfin plugin does not install this fix.

### Playback Command Cooldown (Server)

- **Limit:** 2000 ms cooldown after an accepted playback command (`COMMAND_COOLDOWN_MS`)
- **Purpose:** Prevents command spam and rapid state flapping
- **Scope:** Per room, enforced in `src/server/src/ws/handlers/playback.rs`
- **Tests:** `should_process_state_update_during_cooldown` and `cooldown_and_interval_ignore_wall_clock_rollback` in `src/server/src/ws/handlers/playback.rs`

### Other Resource Limits

| Limit | Value | Code and tests |
|-------|-------|----------------|
| Clients per room | 20 (`MAX_CLIENTS_PER_ROOM`) | Enforced in `src/server/src/ws/handlers/join.rs` (`ROOM_FULL`); tests `full_destination_preserves_previous_membership` and `full_room_returns_explicit_error` |
| Queue items per room | 20 (`MAX_QUEUE_ITEMS`) | `src/server/src/room/queue.rs` and `src/server/src/ws/handlers/queue.rs`; queue bounds tests in the latter |
| JWT authentication deadline | 10 s (`AUTH_TIMEOUT_SECONDS`) | Scheduled in `src/server/src/ws/connection.rs`, configured in `src/server/src/routes.rs`; test `unauthenticated_jwt_connection_times_out_and_is_cleaned_up` |
| Name length | 100 characters (`MAX_NAME_LENGTH`) | `src/server/src/ws/validation.rs`; tests `test_is_valid_name_invalid` and `test_sanitize_name_truncation`. Mirrored in the browser by `MAX_NAME_LENGTH` in `src/clients/jellyfin-web/ws/validation.js` |
| Chat message length | 500 characters (`MAX_CHAT_MESSAGE_LENGTH`) | Enforced in `src/server/src/ws/handlers/chat.rs`; tests `validate_chat_too_long` and `validate_chat_counts_characters_not_bytes`. Mirrored in the browser by `MAX_CHAT_LENGTH` in `src/clients/jellyfin-web/ws/validation.js` |

### Message Rate Limiting is Per Connection, Not Per IP

Message rate limiting is tracked per WebSocket connection. A client can open additional connections and gets a fresh message budget on each one.

**Why this design?**

- The message limiter stays local to one connection: no shared counter, no cross-connection contention, and no cleanup of idle per-IP buckets.
- Unauthenticated connections cannot use rooms, chat or playback, and they are closed after the authentication deadline.
- The per-IP connection limit caps how many simultaneous message budgets one effective IP can hold. It does not by itself cap aggregate messages per second: with the defaults, 32 connections times 30 messages per second is a ceiling of 960 messages per second for one IP.
- Per-IP **message** rate limiting is still explicitly out of scope; see [Per-IP Limits: Verdict](#per-ip-limits-verdict).

**For production deployments**, add request-rate limiting at the reverse proxy (on top of the server's connection and message limits):

```nginx
# nginx example
limit_req_zone $binary_remote_addr zone=ws_limit:10m rate=10r/s;

location /ws {
    limit_req zone=ws_limit burst=20 nodelay;
    proxy_pass http://session-server:3000;
    # ... websocket config
}
```

This rate-limit excerpt covers `/ws` only. The proxy must also route `/invite` to the session server; see [Reverse Proxy Configuration](/operations/deployment/#reverse-proxy-configuration) for complete examples.

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

1. **Configure reverse proxy with SSL** (see [Deployment](/operations/deployment/))
2. **Update Session Server URL** to use `wss://`:
   ```
   wss://jellyfin.example.com/ws
   ```

### Certificate Validation

The browser validates the TLS certificate for a `wss://` connection. Use a certificate trusted by each participant's browser; do not disable certificate validation. For private deployments, install your private CA on every client device.

## Input Validation

### Session-server URL Validation

The client accepts an absolute `ws://` or `wss://` URL with a hostname. It rejects credentials, query strings and fragments, requires `wss://` from an HTTPS Jellyfin page, and asks for confirmation before saving a different host or effective port. The client repeats destination checks on the plugin's token response and immediately before opening the WebSocket. See `src/clients/jellyfin-web/utils/url.js` and [Configuration](/operations/configuration/#url-format).

### Message Validation

The server validates:
- Message type (must be known type)
- Room existence (for room operations)
- Host permissions (for playback control)
- Payload structure

## Security Best Practices

### Production Checklist

- [ ] JWT authentication configured and verified for the selected mode
- [ ] For HS256 or hybrid, a strong secret generated with `openssl rand -base64 32` is configured on both sides
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

This model assumes production settings: JWT authentication enabled (`JWT_SECRET` or the asymmetric trust store), TLS terminated at a reverse proxy, and the session server reachable only through that proxy. Insecure development mode (`ALLOW_INSECURE_NO_AUTH`) removes the authentication boundary entirely and must never be exposed to untrusted users.

### Assets

| Asset | Why it matters | Where it lives |
|-------|----------------|----------------|
| Jellyfin identity | Maps a connection to a Jellyfin user and decides who may create, join or control a room | Jellyfin user database; asserted to the session server through plugin-signed JWTs |
| Session JWTs | Bearer credential for the session server; anyone holding a valid one can act as that user until it expires | Signed by the plugin, held by the browser, validated in `src/server/src/auth.rs` |
| Room state | Participants, host, playback position, scheduled commands, queue items and countdown | In memory in the session server; never persisted |
| Media access | Ability to play the Jellyfin library items a room is watching | Jellyfin's own authorization and stream URLs; the session server never proxies or stores media credentials |

### Actors

| Actor | Capability | Assumed hostile? |
|-------|------------|------------------|
| Anonymous visitor | Can open a WebSocket and send messages before authenticating | Yes |
| Authenticated guest | Holds a valid JWT for its own Jellyfin identity; can create or join rooms and chat | Yes, once inside a room |
| Hostile room member | Authenticated guest that forges event envelopes, spams commands or attempts host-only actions | Yes |
| Compromised token holder | Attacker in possession of a stolen, unexpired JWT | Yes |
| Misconfigured proxy or CDN | Reverse proxy that forwards spoofed `X-Forwarded-For`, allows the wrong origins, buffers or caches WebSocket traffic, or exposes port 3000 directly | Configuration error, not an attacker |

### Trust Boundaries

| Boundary | What crosses it | Controls |
|----------|-----------------|----------|
| Browser (Jellyfin Web origin) to session server WebSocket | WebSocket upgrade with an `Origin` header | Exact-match origin allowlist (`ALLOWED_ORIGINS`) checked before upgrade in `src/server/src/routes.rs`; JWT authentication for every room, chat and playback action |
| Network to session server HTTP/WS ingress | TCP connections, WebSocket frames | Global and per-IP connection caps, 64 KiB frame limit, 10 s authentication deadline, 30 messages/1000 ms window, `TRUSTED_PROXIES`-gated `X-Forwarded-For` |
| Browser/Jellyfin UI to plugin API and configuration | Plugin settings, diagnostics, client script, and per-user session JWT | Jellyfin restricts plugin configuration to administrators; diagnostics require administrator elevation and the custom diagnostics responses omit secret values. The standard authenticated administrator configuration GET returns the full plugin configuration, including `JwtSecret`, which the admin page loads into its password field. Treat administrator API credentials and configuration responses as secret-bearing, and never log or expose them. The public client script and ordinary viewing-client/token endpoint responses do not include the secret; token issuance requires Jellyfin authentication and is rate limited per user. |
| Browser to Jellyfin media API | Playback and library requests | Jellyfin library permissions; OpenWatchParty does not proxy media or store Jellyfin credentials |

### STRIDE Threats

| STRIDE | Threat | Mitigation | Code or test |
|--------|--------|------------|--------------|
| Spoofing | Unauthenticated clients connect and try room, chat or playback actions | JWT validation gates every action; the room list is withheld until authentication; unauthenticated sockets are closed after the authentication deadline | `is_authenticated` in `src/server/src/ws/dispatch.rs`, `handle_auth` in `src/server/src/ws/handlers/auth.rs`, and the session loop in `src/server/src/ws/connection.rs`; test `unauthenticated_jwt_connection_times_out_and_is_cleaned_up` |
| Spoofing, Tampering | Hostile room members forge envelope fields (`client`, `room`, `server_ts`) or send host-only playback commands | The server rebuilds envelope fields from the connection identity before broadcasting, and accepts only `play` and `pause` from non-hosts (seeking and state updates are host only) | Tests `forged_envelope_fields_are_replaced_in_broadcast` and `playback_rejects_non_member_and_non_host` in `src/server/src/ws/handlers/playback.rs`; `ROOM_FULL` coverage in `src/server/src/ws/handlers/join.rs` |
| Spoofing, Information disclosure | Token theft or replay | Tokens are bearer credentials with a short lifetime (default 3600 s, allowed range 60-86400 s) and are only useful over TLS; `exp` is enforced at the exact second with zero leeway; rotating the JWT secret or revoking the signing key invalidates outstanding tokens. An attacker who steals an unexpired token can replay it until it expires: there is no per-token revocation. | `JWT_EXPIRATION_LEEWAY_SECONDS` in `src/server/src/auth.rs`; session expiration handling in `src/server/src/ws/connection.rs`; plugin `TokenTtlSeconds` in `OpenWatchPartyController.cs`; test `authenticated_session_expires_without_inbound_traffic_and_is_cleaned_up` |
| Denial of service | Message flooding | 30 messages per 1000 ms per connection; violations receive `RATE_LIMITED` and are closed with policy code `1008` | `update_rate_limit` in `src/server/src/ws/dispatch.rs`; tests `check_rate_limit_at_limit` and `rate_limit_violation_is_terminal` |
| Denial of service | Oversized frames or messages | 64 KiB limits for both individual frames and assembled messages, applied at the transport before assembly, with an application-level `MESSAGE_TOO_LARGE` check as a second line of defense | `MAX_FRAME_SIZE` and `MAX_MESSAGE_SIZE` in `src/server/src/ws/constants.rs`; `src/server/src/routes.rs`; test `transport_limits_are_fixed_at_sixty_four_kibibytes` |
| Spoofing, Tampering | Cross-origin WebSocket connections | The `Origin` header must exactly match `ALLOWED_ORIGINS` before the upgrade; wildcard origin logs a warning and disables this control. Non-browser clients can forge `Origin`, so JWT authentication remains the real control. | `get_allowed_origins` and `is_origin_allowed` in `src/server/src/routes.rs`; tests `is_origin_allowed_exact_match`, `is_origin_allowed_no_match` and `is_origin_allowed_wildcard` |
| Information disclosure, Denial of service | Proxy or CDN misconfiguration | `X-Forwarded-For` is honored only when the direct peer belongs to `TRUSTED_PROXIES`, and the selected address is the first untrusted hop counting from the right; connection caps still apply. Deployments must terminate TLS correctly, avoid caching or buffering WebSockets, and never expose port 3000 directly. | `parse_trusted_proxies` and `client_ip` in `src/server/src/routes.rs`; test `forwarded_for_requires_a_trusted_proxy`; [Configuration](/operations/configuration/#reverse-proxy-trust) and [Deployment](/operations/deployment/#security-hardening) |
| Repudiation | No durable audit trail: security-relevant events are logs only | Rejections and violations are logged at warn level; room state is ephemeral by design. Operators who need durable attribution must collect container logs. | `src/server/src/ws/dispatch.rs`, `src/server/src/routes.rs`; [Monitoring](/operations/monitoring/) |

Every control above is implemented in the referenced code, and the authentication, rate limiting, size limiting, origin checking and proxy-trust behaviours each have the cited tests. The repudiation row records a known gap rather than a control: the service emits logs, not an audit trail. The properties of the authentication boundary are covered by `authenticated_session_is_valid_before_its_expiration`, `authenticated_session_expires_without_inbound_traffic_and_is_cleaned_up` and `valid_refresh_rearms_the_session_expiration` in `src/server/src/routes.rs`.

### Abuse Limits Inventory

| Limit | Value | Code reference | Test reference |
|-------|-------|----------------|----------------|
| Global concurrent connections | 256 (`MAX_CONNECTIONS`) | `src/server/src/routes.rs` (`ConnectionLimiter`) | `connection_limits_are_global_per_ip_and_released_on_drop` |
| Concurrent connections per effective IP | 32 (`MAX_CONNECTIONS_PER_IP`) | `src/server/src/routes.rs` (`ConnectionLimiter`, `client_ip`) | `connection_limits_are_global_per_ip_and_released_on_drop`, `an_ip_keeps_its_entry_and_its_limit_while_a_connection_is_open`, `concurrent_connections_from_one_ip_keep_its_limit_and_leave_no_entry`, `the_last_connection_of_an_ip_removes_its_entry_while_its_semaphore_is_referenced`, `forwarded_for_requires_a_trusted_proxy` |
| WebSocket frame size | 64 KiB (`MAX_FRAME_SIZE`) | `src/server/src/ws/constants.rs`, applied in `src/server/src/routes.rs` | `transport_limits_are_fixed_at_sixty_four_kibibytes` |
| Assembled message size | 64 KiB (`MAX_MESSAGE_SIZE`) | `src/server/src/ws/constants.rs`, re-checked in `src/server/src/ws/dispatch.rs` | `transport_limits_are_fixed_at_sixty_four_kibibytes` |
| WebSocket message rate | 30 per 1000 ms per connection (`RATE_LIMIT_MESSAGES`, `RATE_LIMIT_WINDOW_MS`) | `update_rate_limit` in `src/server/src/ws/dispatch.rs` | `check_rate_limit_under`, `check_rate_limit_at_limit`, `rate_limit_violation_is_terminal` |
| Playback command cooldown | 2000 ms (`COMMAND_COOLDOWN_MS`) | `src/server/src/ws/constants.rs`, `src/server/src/ws/handlers/playback.rs` | `should_process_state_update_during_cooldown`, `cooldown_and_interval_ignore_wall_clock_rollback` |
| Clients per room | 20 (`MAX_CLIENTS_PER_ROOM`) | `src/server/src/ws/constants.rs`, `src/server/src/ws/handlers/join.rs` | `full_destination_preserves_previous_membership`, `full_room_returns_explicit_error` |
| JWT authentication deadline | 10 s (`AUTH_TIMEOUT_SECONDS`) | `src/server/src/routes.rs`, `src/server/src/ws/connection.rs` | `unauthenticated_jwt_connection_times_out_and_is_cleaned_up` |
| Plugin token issuance | 30 tokens per minute per Jellyfin user (`MaxTokensPerMinute`) | `src/plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs`, `src/plugins/jellyfin/OpenWatchParty/TokenRateLimiter.cs` | `SequentialRequestsStopExactlyAtLimit`, `ParallelBurstNeverExceedsLimit`, `WindowResetAndUsersAreIndependent` |
| Name length | 100 characters (`MAX_NAME_LENGTH`) | `src/server/src/ws/constants.rs`, `src/server/src/ws/validation.rs` | `test_is_valid_name_invalid`, `test_sanitize_name_truncation` |
| Chat message length | 500 characters (`MAX_CHAT_MESSAGE_LENGTH`) | `src/server/src/ws/constants.rs`, `src/server/src/ws/handlers/chat.rs` | `validate_chat_too_long`, `validate_chat_counts_characters_not_bytes` |
| Client-side name length | 100 characters (`MAX_NAME_LENGTH`) | `src/clients/jellyfin-web/ws/validation.js` | `src/clients/jellyfin-web/tests/participant-names.test.js` |
| Client-side chat length | 500 characters (`MAX_CHAT_LENGTH`) | `src/clients/jellyfin-web/ws/validation.js`, `src/clients/jellyfin-web/chat/input.js` | `src/clients/jellyfin-web/tests/chat-input-length.test.js` |
| Trusted proxy handling | Comma-separated IPs/CIDRs (`TRUSTED_PROXIES`) | `parse_trusted_proxies` and `client_ip` in `src/server/src/routes.rs` | `forwarded_for_requires_a_trusted_proxy` |
| Slow client queue | Channel buffer 100, 250 ms close enqueue, 1 s writer shutdown (`CLIENT_CHANNEL_BUFFER`, `CLOSE_ENQUEUE_TIMEOUT_MS`, `WRITER_SHUTDOWN_TIMEOUT_MS`) | `src/server/src/ws/constants.rs`, `src/server/src/ws/connection.rs` | `slow_client_does_not_block_shutdown_close_enqueue` |

### Per-IP Limits: Verdict

**Connection admission per IP is implemented and tested.** The session server caps concurrent WebSocket connections both globally (`MAX_CONNECTIONS`, default 256) and per effective client IP (`MAX_CONNECTIONS_PER_IP`, default 32). The effective IP is the direct peer address unless that peer is listed in `TRUSTED_PROXIES`, in which case the first address from the right of `X-Forwarded-For` that is not itself trusted is used. An upgrade over either cap is rejected with HTTP `429`, before any authentication or room work. Tests: `connection_limits_are_global_per_ip_and_released_on_drop` and `forwarded_for_requires_a_trusted_proxy` in `src/server/src/routes.rs`. Configuration: `TRUSTED_PROXIES` and `MAX_CONNECTIONS_PER_IP`.

**Per-IP message rate limiting is out of scope for now.** Messages remain limited per connection (30 per 1000 ms window).

- **Rationale:** A per-IP message bucket requires storing the effective IP on every client plus a shared, synchronized bucket map with eviction and cleanup. That adds contention to the hot message path and more state to reason about, while the connection cap already limits how many independent budgets one IP can hold. The intended production topology terminates traffic at a reverse proxy, which can rate limit by address with thresholds the operator controls.
- **Residual risk:** An authenticated client can open up to `MAX_CONNECTIONS_PER_IP` connections and multiply the per-connection message allowance (32 x 30 = 960 messages per second with defaults), and the connection cap also applies to unauthenticated sockets. Operators facing abuse should rate limit at the reverse proxy and may lower `MAX_CONNECTIONS_PER_IP`.
- **Safe configuration:** Set `TRUSTED_PROXIES` only to addresses or narrow CIDRs of proxies you operate, for example `TRUSTED_PROXIES=10.20.0.0/16`. A too-broad value lets direct clients spoof `X-Forwarded-For`, bypassing the per-IP connection cap and defeating future per-IP limits. Behind shared NAT, keep in mind that all users of that address share the 32-connection budget.

The verdict is revisited if real deployments report flooding spread across many connections from a single address.

### Known Limitations

| Limitation | Status |
|------------|--------|
| No room passwords | Planned |
| No per-user permissions inside a room (the host seeks, everyone can play, pause and chat) | Planned |
| Ephemeral sessions and rooms | By design |
| Automated asymmetric signing-key rotation | Not available; the operator must coordinate key replacement and trust-store updates |
| Message rate limiting per connection, not per IP | Documented above (see [Per-IP Limits: Verdict](#per-ip-limits-verdict)) |
| No per-token revocation | By design (short TTL; rotate the secret or revoke the signing key) |
| No durable audit log | By design (warn-level logs only) |

## What JWT Authentication Does NOT Protect

It's important to understand the scope of JWT authentication. While it verifies user identity, it has limitations:

### Not Protected by JWT

| Scenario | Current Behavior | Mitigation |
|----------|------------------|------------|
| **Room creation** | Any authenticated user can create rooms | By design - all Jellyfin users are trusted |
| **Room joining** | Any authenticated user can join any room | Planned: room passwords |
| **Room enumeration** | All users see all active rooms | By design - rooms are public within your Jellyfin instance |
| **Token revocation** | Tokens remain valid until expiration unless their verification key is changed or revoked | Rotate the shared secret to invalidate HS256 tokens; revoke a trusted RSA key to invalidate RS256 tokens |

### Token Lifecycle

- **Tokens cannot be individually revoked** - Once issued, a token is valid until it expires
- **Shared-secret rotation invalidates HS256 tokens and invite tickets** - It does not invalidate tokens signed with an active asymmetric key
- **Revoking an RSA public key invalidates RS256 tokens signed by that key**
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

### If a JWT Key Is Compromised

1. For HS256 or hybrid, immediately rotate the shared secret on the plugin and session server; restart the server. Existing HS256 tokens and invite tickets become invalid.
2. For asymmetric mode, revoke the compromised key from the session-server trust store. There is no automated signing-key rotation command, so coordinate replacement-key generation and pairing before relying on asymmetric authentication again.
3. Ask users to reload Jellyfin Web to obtain a fresh session token.

### If Suspicious Activity Detected

1. Check logs for details
2. Consider temporarily disabling the service
3. Review CORS and authentication settings
4. Update to latest version

## Container Security

### Base Image

The session-server runtime uses Alpine Linux. Its base image is pinned by digest, and the Dockerfile upgrades Alpine packages during the image build; the installed package versions can therefore change between builds from the same source commit.

The runtime stage is pinned by digest (`alpine:3.24@sha256:…`) and Dependabot
re-pins it weekly (docker ecosystem, `infra/docker`). The builder stage
(`rust:*-alpine`) is not part of the shipped image and is not scanned.

### Security Scanning

Container images are automatically scanned on every push and weekly:

- **Trivy**: Scans for CVEs in OS packages and dependencies
- **Results**: Uploaded to GitHub Security tab
- **Severity filter**: CRITICAL and HIGH vulnerabilities are flagged
- **`ignore-unfixed`**: only findings with a published fix are blocking

### CVE Policy

The build runs `apk upgrade --no-cache` in the runtime stage before installing
`ca-certificates` and `curl`. Every build therefore ships the latest security
fixes published in the Alpine 3.24 repositories, even when the pinned base
digest still contains older packages (for example a vulnerable `zlib`).

Together with `ignore-unfixed: true`, this makes the gate self-healing: once
Alpine publishes a fixed package, the next build picks it up and Trivy passes
without waiting for a digest bump. A PR is blocked only when a fixable HIGH or
CRITICAL vulnerability is still present in the built image — that is a real
actionable finding, not database drift.

Consequence: two builds of the same commit can produce slightly different
package versions. The digest pin fixes the base layer; `apk upgrade` floats
the installed packages to the latest security state of the branch.

### Current Security Posture

The release build recorded 0 findings against Trivy 0.70 with CI-equivalent
flags (`--severity CRITICAL,HIGH --ignore-unfixed`), and 0 findings at any
severity with `--ignore-unfixed`. This is a result for that scanned build, not
a guarantee about future image rebuilds. Check the current Security workflow
and the digest of the image you deploy.

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
2. Use [GitHub Private Vulnerability Reporting](https://github.com/mhbxyz/OpenWatchParty/security/advisories/new), as described in `SECURITY.md`.
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact

## Next Steps

- [Deployment](/operations/deployment/) - Production deployment
- [Monitoring](/operations/monitoring/) - Monitor for issues
- [Troubleshooting](/operations/troubleshooting/) - Common problems
