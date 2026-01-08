# Troubleshooting Guide

## Quick Diagnostic Checklist

1. [ ] Session server running? (`curl http://localhost:3000/health`)
2. [ ] Plugin installed? (Check Dashboard > Plugins)
3. [ ] Script tag in Custom HTML? (Dashboard > General)
4. [ ] Browser cache cleared? (Ctrl+F5)
5. [ ] Correct WebSocket URL?
6. [ ] Firewall allowing port 3000?

## Common Issues

### Watch Party Button Not Visible

**Symptoms:**
- No group icon in the video player header
- Panel doesn't appear

**Solutions:**

1. **Check Custom HTML configuration**
   - Go to Dashboard > General > Branding
   - Verify this line is in "Custom HTML body":
     ```html
     <script src="/web/plugins/openwatchparty/plugin.js"></script>
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

2. **Check firewall**
   ```bash
   # Test connection
   nc -zv localhost 3000

   # Open port (UFW)
   sudo ufw allow 3000/tcp
   ```

3. **Check WebSocket URL**
   - Browser console will show the attempted URL
   - Should be `ws://host:3000/ws` or `wss://host:3000/ws`

4. **Check CORS**
   - Session server logs show CORS errors
   - Set `ALLOWED_ORIGINS` to include your Jellyfin URL

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
   - Check RTT in the Watch Party panel
   - Ideal RTT: < 100ms

4. **HLS/transcoding issues**
   - Transcoded streams have higher latency
   - Try direct play if possible
   - Reduce quality if network is slow

5. **Check if everyone has the same media**
   - Different versions may have different durations
   - Ensure all users can access the media

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
   - Rooms are in-memory (ephemeral)
   - Check if server was restarted

3. **Network issues**
   - Check host's connection
   - Check server logs for errors

### Authentication Errors

**Symptoms:**
- Cannot join rooms
- "Unauthorized" errors
- Token issues

**Solutions:**

1. **Check JWT configuration matches**
   - Plugin JWT Secret must match server JWT_SECRET
   - Both must be configured or both must be empty

2. **Check token expiration**
   - Default: 1 hour
   - Refresh the page to get a new token

3. **Rate limiting**
   - Max 10 token requests per minute
   - Wait and try again

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
[OpenWatchParty] JwtSecret is not configured.
```

### Browser Console

1. Press F12 to open Developer Tools
2. Go to Console tab
3. Filter by "OSP" or "OpenWatchParty"

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
console.log(OSP.state.ws?.readyState);
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
- Consider scaling (future feature)

**Client:**
- Reduce video quality
- Close other tabs
- Check for JavaScript errors

### Memory Usage

**Session Server:**
- Rooms are in-memory
- Each client: ~1KB
- Each room: ~5KB + clients
- Restart to clear if needed

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
- [GitHub Discussions](https://github.com/mhbxyz/OpenWatchParty/discussions) - Questions
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
