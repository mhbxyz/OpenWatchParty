---
title: "Troubleshooting Guide"
---

<span id="troubleshooting-guide" class="legacy-anchor"></span>

## Quick Diagnostic Checklist

1. [ ] Session server running? (`curl http://localhost:3000/health`)
2. [ ] Plugin installed? (Check Dashboard > Plugins)
3. [ ] Client injection ready in the OpenWatchParty plugin dashboard? (Custom HTML is only a fallback.)
4. [ ] Browser cache cleared? (Ctrl+F5)
5. [ ] Correct WebSocket URL?
6. [ ] Reverse proxy routes `/ws` to the session server, and the server port is reachable only from trusted hosts?

**Related documentation:**
- [Architecture - Edge Cases](/technical/architecture/#edge-cases-and-behavior) - Expected behavior in various scenarios
- [Security Guide](/operations/security/) - Authentication and CORS issues
- [Configuration](/operations/configuration/) - Server and plugin settings

## Common Issues

### Watch Party Button Not Visible

**Symptoms:**
- No Watch Party button (a screen with two viewers) in the video player header
- Panel doesn't appear

**Solutions:**

1. **Check the OpenWatchParty plugin dashboard**
   - Go to Dashboard > Plugins > OpenWatchParty and run diagnostics.
   - Verify client injection reports ready. Native injection does not need a Custom HTML entry.
   - If native injection is blocked, follow [Client Injection Compatibility Fallbacks](/operations/installation/#client-injection-compatibility-fallbacks). For the Custom HTML fallback, add this line under Dashboard > General > Branding:
     ```html
     <script src="/OpenWatchParty/ClientScript"></script>
     ```

2. **Hard refresh the browser**
   - Press Ctrl+F5 (Windows/Linux) or Cmd+Shift+R (Mac)
   - Or clear browser cache completely

3. **Check browser console**
   - Press F12 to open developer tools
   - Look for errors in the Console tab
   - Common errors:
     - `404` - Script not found (plugin not installed)
     - `CORS` - WebSocket blocked (check CORS config)

4. **Verify plugin is installed**
   - Dashboard > Plugins should show "OpenWatchParty"
   - Check Jellyfin logs for plugin load errors

5. **Validate automatic injection runtime (File Transformation)**
   - Registration alone is not sufficient. Confirm callback execution in logs.
   - Look for OpenWatchParty logs:
     - `Registered File Transformation pattern 'index.html' -> callback 'TransformIndexHtml'`
     - `Registered File Transformation pattern 'home-html\..*\.chunk\.js' -> callback 'TransformHomeChunkScript'`
     - `TransformIndexHtml invoked for file ...`
     - `TransformHomeChunkScript invoked for file ...`
   - Validate script endpoint:
     ```bash
     curl -I http://localhost:8096/OpenWatchParty/ClientScript
     ```
   - If endpoint is reachable but callback logs never appear, keep manual Custom HTML injection enabled until integration is fixed.

### Cannot Connect to Session Server

**Symptoms:**
- "Offline" status in the panel
- Console shows WebSocket errors

**Solutions:**

1. **Check server is running**
   ```bash
   # Docker
   docker ps | grep session

   # Check health endpoint
   curl http://localhost:3000/health
   ```

2. **Check the network path**
   ```bash
   # Test the local server health endpoint
   nc -zv localhost 3000
   ```
   Keep raw port 3000 private. For remote guests, publish HTTPS/WSS through the reverse proxy and route `/ws` to the session server; see [Deployment](/operations/deployment/#reverse-proxy-configuration).

3. **Check WebSocket URL**
   - Browser console will show the attempted URL
   - Should be `ws://host:3000/ws` or `wss://host:3000/ws`

4. **Check CORS**
   - Session server logs show CORS errors
   - Set `ALLOWED_ORIGINS` to include your Jellyfin URL

### Invite button says Room not found (or 404)

The reverse proxy is not routing `/invite` to the session server. Configure both the WebSocket and invite routes as shown in [Reverse Proxy Configuration](/operations/deployment/#reverse-proxy-configuration).

### Sync Issues

**Symptoms:**
- Participants out of sync
- Playback drifts apart over time
- Frequent jumping or stuttering

**Solutions:**

1. **Wait a few seconds**
   - Initial sync takes 2-3 seconds
   - Drift correction works gradually

2. **Host: pause and play again**
   - This re-syncs all participants

3. **Check network quality**
   - High latency causes sync issues
   - Check the latency value in the room bar
   - Ideal RTT: < 100ms

4. **HLS/transcoding issues**
   - Transcoded streams have higher latency
   - Try direct play if possible
   - Reduce quality if network is slow

5. **Check if everyone has the same media**
   - Different versions may have different durations
   - Ensure all users can access the media

**Technical details:** See [Architecture - Clock Offset and Playback Drift](/technical/architecture/#clock-offset-and-playback-drift) and [Sync Algorithms](/technical/sync/)

### Room queue is missing or does not advance

- Queue controls are available to the host in a room only when the server and client negotiate the `media_queue` capability. Confirm both sides are current and compatible; older clients can still follow the current room item but do not receive queue state.
- A queue can contain up to 20 Jellyfin items. Episode autofill applies to the host's episodic item; it does not create a queue for a movie.
- Only the host can change the queue. The countdown is 10 seconds and is canceled by a pause, the host seeking back before the credits, removing the next item, or changing the room item.
- Rooms and queues live in memory. A server restart closes the room and clears its queue; reconnect by creating a new room.

See [Configuration: Room queue and lifecycle](/operations/configuration/#room-queue-and-lifecycle) for the persistence and capability details.

### Room Closes Unexpectedly

**Symptoms:**
- "Room closed" notification
- Participants disconnected

**Causes:**

1. **Host disconnected**
   - Host's network dropped
   - Host closed the browser
   - Host's computer went to sleep

2. **Server restart**
   - Rooms, participant lists, queues and countdowns are in-memory (ephemeral)
   - Check if server was restarted

3. **Network issues**
   - Check host's connection
   - Check server logs for errors

**Technical details:** See [Architecture - Host Network Disconnect](/technical/architecture/#host-network-disconnect)

### Authentication Errors

**Symptoms:**
- Cannot join rooms
- "Unauthorized" errors
- Token issues

**Solutions:**

1. **Check the selected JWT mode and keys**
   - In `hs256`, the plugin JWT Secret must match server `JWT_SECRET`; both are required in production.
   - In `hybrid`, the shared secret is still required for legacy HS256 tokens, and the server also needs a valid public-key trust store for RS256.
   - In `asymmetric`, the plugin's active RSA key must be present in the server trust store; `JWT_SECRET` is not used.
   - Empty secrets are allowed only in explicitly enabled local development mode on both sides. Never expose that mode.
   - If diagnostics say the RSA signing key file cannot be read, token issuance stops until `keys/signing-key.json` in the plugin's data folder is restored from a backup, or removed and the server paired again.

2. **Check token expiration**
   - Default: 1 hour
   - Refresh the page to get a new token

3. **Rate limiting**
   - Max 30 token requests per fixed one-minute window
   - Wait and try again

### Jellyfin 12: every OpenWatchParty request returns 401

**Symptoms:**
- The Watch Party panel loads but no request succeeds
- `401 Unauthorized` responses in the browser console or Jellyfin logs

**Cause:**

Jellyfin 12 disables legacy authorization. The `DisableLegacyAuthorization` migration turns off `EnableLegacyAuthorization`, so the legacy `X-Emby-Token` header no longer resolves and only `Authorization: MediaBrowser Token="..."` is accepted.

OpenWatchParty `0.7.0` is the current Jellyfin 12 plugin release and sends the modern `Authorization` header. `0.3.4` is the current release for Jellyfin 10.11. Do not assume historical plugin releases target or support Jellyfin 12; check the [compatibility matrix](/operations/compatibility/).

**Solutions:**

1. **Upgrade OpenWatchParty**
   - Install `0.7.0` on Jellyfin 12, or `0.3.4` on Jellyfin 10.11, from the compatible plugin repository entry or manually.
   - Verify the installed version in **Dashboard** > **Plugins** > **OpenWatchParty**.

2. **Temporary stopgap only**

   As a short-lived workaround, set the following in Jellyfin's `system.xml`:

   ```xml
   <EnableLegacyAuthorization>true</EnableLegacyAuthorization>
   ```

   Then restart Jellyfin.

   This is deprecated and unsupported long term. It re-enables a legacy authentication path that Jellyfin 12 is removing and only restores access until you can upgrade. Do not rely on it.

### The WebSocket connects but the session server rejects the token

**Symptoms:**
- The OpenWatchParty panel loads but never joins a room
- The session server logs `Client connected: …` immediately followed by `Auth failed for …: Invalid token: InvalidSignature`
- The plugin diagnostics may report `authentication_configuration` as passing

**Cause:**

In `hs256` and `hybrid` modes, the plugin signs with `JwtSecret` and the server verifies with `JWT_SECRET`; mismatched values cause `InvalidSignature`. In `asymmetric` mode, check that the plugin's active RSA key is present in the server trust store and that the issuer and audience match.

The plugin's **Allow insecure unauthenticated development** setting does not work around this. It only makes the plugin omit the token, it is ignored while a `JwtSecret` is configured, and the session server independently requires `ALLOW_INSECURE_NO_AUTH=true` before it accepts unauthenticated clients.

**Solutions:**

1. **Managed deployments** (installed with `owpctl`): run `owpctl doctor`, which performs an authenticated WebSocket ping/pong and reports this failure directly. For HS256 or hybrid, use `owpctl configure --rotate-jwt-secret --yes --api-token-file <protected-file>` to update the shared secret on both sides. In asymmetric mode, verify the trust store and use `owpctl pair` to register the plugin's current signing key.
2. **Manual HS256 or hybrid deployments**: set the same strong value in *Dashboard → Plugins → OpenWatchParty → JWT secret* and in the session server's `JWT_SECRET` environment variable, then restart the session server. For asymmetric mode, ensure the active plugin public key is in the server trust store. Confirm the server started with `JWT authentication is enabled` and check for `InvalidSignature` after a browser reload.

### Diagnostics report the session server as unreachable

**Symptoms:**
- `Run diagnostics` fails the `session_http` check with `SESSION_UNREACHABLE` or `Connection refused (host:3000)`
- The browser still appears to connect, or the panel times out while `just up` looks healthy

**Cause:**

The health probe runs inside the Jellyfin process, so it resolves the session server from Jellyfin's network namespace — not the browser's. A same-host auto-detected URL such as `ws://192.168.1.10:3000/ws` can be reachable from the browser and refused from the Jellyfin container, especially when the two run on different Docker networks or the port is only published on loopback.

**Solutions:**

1. Set an explicit **Session server URL** (`ws://host:port/ws`) that is reachable from both Jellyfin and the browser, rather than relying on same-host auto-detection.
2. In Docker, put Jellyfin and the session server on a shared network and use the service name (for example `ws://owp-session-server:3000/ws`) if the browser reaches it through a reverse proxy.
3. Re-run `Run diagnostics`: `session_http` must report the session server version and protocol before a watch party can work.

### HLS Streaming Issues

**Symptoms:**
- Sync works initially but drifts during playback
- Frequent buffering interrupts sync
- Position jumps backward unexpectedly
- "False pauses" trigger unwanted sync events

**Understanding HLS:**

HLS (HTTP Live Streaming) breaks video into small segments (typically 2-10 seconds). This causes:
- Buffering gaps between segments
- Position reporting delays
- `readyState` changes during segment loads

**Solutions:**

1. **Buffering during sync**
   ```
   Problem: Video buffers, reports paused state, triggers sync issues
   Solution: OpenWatchParty filters these "false pauses" automatically
   If issues persist: reduce video quality to improve buffering
   ```

2. **Position jumps backward**
   ```
   Problem: HLS reports position from previous segment during load
   Solution: Server ignores small backward jumps (< 2s) automatically
   If large jumps: check network stability, try different quality
   ```

3. **Segment loading delays**
   - Reduce bitrate/quality in Jellyfin playback settings
   - Use direct play instead of transcoding when possible
   - Check network bandwidth between client and Jellyfin server

4. **Direct play vs transcoding**
   ```bash
   # Check if transcoding is happening
   # In Jellyfin Dashboard > Playback > Active Devices
   # Look for "Transcoding" indicator

   # For better sync, prefer:
   # - Direct Play (no transcoding)
   # - Direct Stream (container change only)
   # Avoid if possible:
   # - Transcoding (full re-encode)
   ```

5. **Safari-specific HLS issues**
   - Safari uses native HLS (not hls.js like other browsers)
   - May report `readyState` differently during buffering
   - Workaround: Keep Safari tab in focus, or use Chrome/Firefox

**Technical details:** See [Sync Algorithms - HLS Handling](/technical/sync/#5-hls-handling-and-feedback-loop-prevention)

### Rate Limiting Issues

**Symptoms:**
- "Rate limit exceeded" error
- `429` while requesting a Jellyfin token or opening a WebSocket at the connection limit
- WebSocket closes with policy code `1008` after exceeding the per-connection message limit
- Cannot get new token

**Types of rate limiting:**

| Limit | Value | Applies to |
|-------|-------|------------|
| Token requests | 30 per fixed 60-second window | Per Jellyfin user; excess token requests return HTTP `429` |
| WebSocket messages | 30 per 1000 ms window | Per connection; excess closes the WebSocket with policy code `1008` |
| WebSocket connections | 256 total; 32 per effective IP by default | Excess upgrades return HTTP `429` |
| Message size | 64 KiB per frame and assembled message | WebSocket input |

**Solutions:**

1. **Token rate limit (30/min)**
   ```
   Cause: Too many page refreshes or reconnection attempts
   Solution: Wait 1 minute, then refresh once
   Prevention: Don't rapidly refresh the page
   ```

2. **Message rate limit (30/sec)**
   ```
   Cause: A client sent over 30 messages within a 1000 ms window
   Solution: Wait for the client to reconnect; avoid rapid repeated actions
   Note: Normal usage won't hit this limit
   ```

3. **Debugging rate limits**
   ```bash
   # Check server logs for rate limit messages
   docker logs session-server 2>&1 | grep -i "rate"

   # Token endpoint logs "Token rate limit exceeded"; the session server logs "Rate limited"
   ```

4. **If rate limited frequently**
   - Check for browser extensions that might cause extra requests
   - Check for scripts auto-refreshing the page
   - Verify you're not running multiple tabs with OpenWatchParty

### Panel Opens But Empty

**Symptoms:**
- Panel slides out but shows nothing
- No room list

**Solutions:**

1. **Wait for connection**
   - WebSocket may still be connecting
   - Check for "Connecting..." status

2. **Check console for JavaScript errors**
   - Press F12 and check Console tab
   - Look for script loading errors

3. **Clear browser cache**
   - Old script version may be cached

## Log Analysis

### Session Server Logs

```bash
# Docker logs
docker logs session-server

# Follow logs
docker logs -f session-server
```

**What to look for:**

| Log Message | Meaning |
|-------------|---------|
| `Client connected` | New WebSocket connection |
| `Client disconnected` | Connection closed |
| `Room created` | New room started |
| `Room closed` | Room ended |
| `SECURITY: Wildcard origin` | CORS warning |
| `Message too large` | Size limit exceeded |
| `Invalid token` | Authentication failure |

### Jellyfin Logs

Location varies by installation:
- Docker: `docker logs jellyfin`
- Linux: `/var/log/jellyfin/`
- Windows: `%ProgramData%\Jellyfin\Server\log\`

**Look for:**
```
[OpenWatchParty] JWT authentication is enabled.
[OpenWatchParty] JWT authentication is enabled with the RSA signing key.
[OpenWatchParty] JwtSecret is not configured.
```

### Browser Console

1. Press F12 to open Developer Tools
2. Go to Console tab
3. Filter by "OWP" or "OpenWatchParty"

**Common messages:**

| Message | Meaning |
|---------|---------|
| `[OWP] Loaded` | Client initialized |
| `[OWP] Connected` | WebSocket connected |
| `[OWP] Disconnected` | WebSocket closed |
| `[OWP] Room joined` | Successfully joined room |

## Network Debugging

### Check WebSocket Connection

In browser console:
```javascript
// Check if connected
console.log(OWP.state.ws?.readyState);
// 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
```

### Test Session Server

```bash
# Health check
curl http://localhost:3000/health

# WebSocket test (requires wscat)
npm install -g wscat
wscat -c ws://localhost:3000/ws
```

### Check Network Traffic

1. Open Developer Tools (F12)
2. Go to Network tab
3. Filter by "WS" for WebSocket
4. Click on the WebSocket connection
5. View Messages to see all communication

## Performance Issues

### High CPU Usage

**Session Server:**
- Check number of rooms/clients
- Compare active connections and rooms with the configured limits; the server does not share in-memory rooms between replicas.

**Client:**
- Reduce video quality
- Close other tabs
- Check for JavaScript errors

### Memory Usage

**Session Server:**
- Rooms are in-memory
- There is no verified per-client or per-room RSS estimate. Use [container metrics and the measured load runs](/operations/monitoring/#capacity-planning) for your deployment; the sample measurements are not a capacity guarantee.
- The room queue is capped at 20 media items. Its serialized-size regression tests do not establish a process memory or out-of-memory result.
- Restarting the server closes rooms and discards the in-memory queue state.

### Slow Sync

- Reduce `SYNC_LEAD_MS` if latency is low
- Increase if latency is high
- Check client hardware (old browsers may struggle)

## Getting Help

### Information to Provide

When reporting issues, include:

1. **Environment**
   - Jellyfin version
   - Browser and version
   - Operating system
   - Docker version (if applicable)

2. **Configuration**
   - Session server settings (without secrets!)
   - Plugin configuration
   - Reverse proxy setup

3. **Logs**
   - Session server logs
   - Jellyfin logs
   - Browser console output

4. **Steps to Reproduce**
   - What you did
   - What you expected
   - What happened instead

### Where to Get Help

- [GitHub Issues](https://github.com/mhbxyz/OpenWatchParty/issues) - Bug reports
- [GitHub Issues](https://github.com/mhbxyz/OpenWatchParty/issues/new/choose) - Questions (choose the question template)
- [Jellyfin Forums](https://forum.jellyfin.org/) - Community help

## Reset Procedures

### Reset Client State

1. Clear browser cache and cookies
2. Hard refresh (Ctrl+F5)
3. Or in console:
   ```javascript
   localStorage.clear();
   location.reload();
   ```

### Reset Server State

```bash
# Restart session server (clears all rooms)
docker restart session-server
```

### Reset Plugin Configuration

1. Dashboard > Plugins > OpenWatchParty
2. Clear all fields
3. Save
4. Restart Jellyfin

### Complete Reset

1. Stop all services
2. Remove plugin DLL
3. Clear Jellyfin config cache
4. Reinstall from scratch
