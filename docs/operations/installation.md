# Installation Guide

## Prerequisites

- **Jellyfin Server** 10.8.x or 10.9.x
- **Docker** and **Docker Compose** (recommended)
- **Port 3000** available for the session server
- Admin access to Jellyfin

## Quick Start (Docker)

The easiest way to run OpenWatchParty is with Docker Compose.

### 1. Clone the Repository

```bash
git clone https://github.com/mhbxyz/OpenWatchParty.git
cd OpenWatchParty
```

### 2. Start Services

```bash
make up
```

This starts:
- Jellyfin on `http://localhost:8096`
- Session server on `http://localhost:3000`

### 3. Enable the Client Script

1. Log in to Jellyfin as an administrator
2. Go to **Dashboard** > **General**
3. Scroll to **Custom HTML** (Branding section)
4. Add this line to the "Custom HTML body" field:
   ```html
   <script src="/web/plugins/openwatchparty/plugin.js"></script>
   ```
5. Click **Save**
6. Hard refresh your browser (Ctrl+F5)

### 4. Configure the Plugin (Optional)

1. Go to **Dashboard** > **Plugins** > **OpenWatchParty**
2. Set a JWT Secret (min 32 characters) for authentication
3. Click **Save**

## Manual Installation

### Session Server

#### Option A: Docker

```bash
# Build the image
docker build -t openwatchparty-session-server ./session-server-rust

# Run the container
docker run -d \
  --name owp-session \
  -p 3000:3000 \
  -e ALLOWED_ORIGINS="http://localhost:8096" \
  openwatchparty-session-server
```

#### Option B: Build from Source

Requirements:
- Rust 1.70+

```bash
cd session-server-rust
cargo build --release
./target/release/session-server
```

### Jellyfin Plugin

1. **Download the Plugin**

   Get the latest release from the [releases page](https://github.com/mhbxyz/OpenWatchParty/releases):
   - `OpenWatchParty.dll`

2. **Install to Jellyfin**

   Copy the DLL to your Jellyfin plugins directory:

   ```bash
   # Linux (Docker)
   docker cp OpenWatchParty.dll jellyfin:/config/plugins/OpenWatchParty/

   # Linux (native)
   sudo cp OpenWatchParty.dll /var/lib/jellyfin/plugins/OpenWatchParty/

   # Windows
   copy OpenWatchParty.dll "C:\ProgramData\Jellyfin\Server\plugins\OpenWatchParty\"
   ```

3. **Restart Jellyfin**

   ```bash
   # Docker
   docker restart jellyfin

   # Systemd
   sudo systemctl restart jellyfin
   ```

4. **Enable the Client Script**

   Follow step 3 from the Quick Start section above.

## Verification

### Check Session Server

```bash
# Check if server is running
curl http://localhost:3000/health

# Expected response: 200 OK with "OK"
```

### Check Plugin

1. Go to **Dashboard** > **Plugins**
2. "OpenWatchParty" should appear in the plugin list
3. Check the logs for startup messages:
   ```
   [OpenWatchParty] JWT authentication is enabled.
   ```
   or
   ```
   [OpenWatchParty] JwtSecret is not configured. Authentication is DISABLED.
   ```

### Test the UI

1. Open any video in Jellyfin
2. Look for the Watch Party button (group icon) in the top header
3. Click to open the panel

## Environment Variables

### Session Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `ALLOWED_ORIGINS` | `*` | CORS allowed origins (comma-separated) |
| `JWT_SECRET` | (none) | JWT secret for authentication |
| `LOG_LEVEL` | `info` | Logging level |

### Example

```bash
docker run -d \
  -p 3000:3000 \
  -e ALLOWED_ORIGINS="https://jellyfin.example.com" \
  -e JWT_SECRET="your-32-character-secret-key-here" \
  -e LOG_LEVEL="debug" \
  openwatchparty-session-server
```

## Firewall Configuration

Ensure these ports are accessible:

| Port | Service | Direction |
|------|---------|-----------|
| 8096 | Jellyfin HTTP | Inbound |
| 8920 | Jellyfin HTTPS | Inbound (if using SSL) |
| 3000 | Session Server | Inbound |

### UFW (Ubuntu)

```bash
sudo ufw allow 8096/tcp
sudo ufw allow 3000/tcp
```

### firewalld (Fedora/CentOS)

```bash
sudo firewall-cmd --permanent --add-port=8096/tcp
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

## Troubleshooting Installation

### Plugin not appearing
- Ensure the DLL is in the correct plugins directory
- Check file permissions
- Restart Jellyfin completely

### Script not loading
- Verify the Custom HTML entry is exactly correct
- Check browser console for errors (F12)
- Try a hard refresh (Ctrl+F5)

### Cannot connect to session server
- Verify the server is running: `docker ps`
- Check firewall rules
- Verify the WebSocket URL in client

For more troubleshooting, see [Troubleshooting Guide](troubleshooting.md).

## Next Steps

- [Configuration](configuration.md) - Configure options
- [Security](security.md) - Set up authentication
- [Deployment](deployment.md) - Production deployment
