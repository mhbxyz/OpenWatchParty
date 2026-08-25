---
title: Installation
parent: Operations
nav_order: 1
---

# Installation Guide

## Recommended: Guided Setup

Download `owpctl` and run the local graphical assistant:

```bash
owpctl --scope system setup --web
```

See [Guided Setup and owpctl](owpctl.md) for download verification, headless installation, diagnostics, upgrades and uninstall. The remaining sections on this page are manual and advanced alternatives.

## Prerequisites

- **Jellyfin Server** version compatible with your OpenWatchParty build (see [Compatibility Matrix](compatibility.md))
- **Docker** and **Docker Compose** (recommended)
- **Port 3000** available for the session server
- Admin access to Jellyfin

### Version Selection

- **OpenWatchParty `0.3.2`** targets Jellyfin ABI `10.11.0.0`
- **Validated environment**: Jellyfin packages and image `10.11.3`

## Choose Your Installation Path

| You are... | Recommended path |
|------------|------------------|
| Running an existing Jellyfin server | Install the plugin repository, then deploy the pre-built session-server image |
| Evaluating OpenWatchParty locally | Use the development stack documented under Development |
| Contributing code | Clone the repository and use `just up` |

> `just up` is a development command. It starts a separate Jellyfin test instance and must not be used to install OpenWatchParty into an existing Jellyfin deployment.

## Quick Start For An Existing Jellyfin Server

### 1. Install The Jellyfin Plugin

1. Open **Dashboard** > **Plugins** > **Repositories**.
2. Add:

```text
https://mhbxyz.github.io/OpenWatchParty/jellyfin-plugin-repo/manifest.json
```

3. Open **Catalog**, install **OpenWatchParty**, and restart Jellyfin.

The plugin includes native client-script injection. File Transformation and Custom HTML are optional compatibility fallbacks, not required installation steps.

### 2. Start The Session Server

```bash
JWT_SECRET="$(openssl rand -base64 32)"
docker run -d \
  --name owp-session \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e ALLOWED_ORIGINS="https://jellyfin.example.com" \
  -e JWT_SECRET="$JWT_SECRET" \
  ghcr.io/mhbxyz/owp-session-server:0.3.2
```

Keep the generated value temporarily. It must be entered in the plugin configuration in the next step.

### 3. Configure And Verify

1. Open **Dashboard** > **Plugins** > **OpenWatchParty**.
2. Paste the same JWT secret.
3. Set the session WebSocket URL, or explicitly trust same-host port 3000 auto-detection.
4. Save, reload Jellyfin Web, and open a movie.
5. Confirm that the **Watch Party** button appears in the video player.

Use the verification and troubleshooting sections below if any status remains blocked.

## Client Injection Compatibility Fallbacks

Native injection is enabled by the plugin and is the recommended mode. If another Jellyfin Web build prevents it, use one fallback only.

### File Transformation

Install [jellyfin-plugin-file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) version `2.5.3.0`. OpenWatchParty registers its transformation automatically.

### Custom HTML

1. Log in to Jellyfin as an administrator
2. Go to **Dashboard** > **General**
3. Scroll to **Custom HTML** (Branding section)
4. Add this line to the "Custom HTML body" field:
   ```html
   <script src="/OpenWatchParty/ClientScript"></script>
   ```
5. Click **Save**
6. Hard refresh your browser (Ctrl+F5)

## Manual Installation

### Session Server

#### Option A: Pre-built Image (Recommended)

Use the official image from GitHub Container Registry:

```bash
JWT_SECRET="$(openssl rand -base64 32)"
printf 'Configure this same JWT secret in the OpenWatchParty plugin: %s\n' "$JWT_SECRET"

# Latest stable release
docker run -d \
  --name owp-session \
  -p 3000:3000 \
  -e ALLOWED_ORIGINS="http://localhost:8096" \
  -e JWT_SECRET="$JWT_SECRET" \
  ghcr.io/mhbxyz/owp-session-server:latest

# Or use a specific version
docker run -d \
  --name owp-session \
  -p 3000:3000 \
  -e ALLOWED_ORIGINS="http://localhost:8096" \
  -e JWT_SECRET="$JWT_SECRET" \
  ghcr.io/mhbxyz/owp-session-server:v0.3.2

# Or use the beta (latest from main branch)
docker run -d \
  --name owp-session \
  -p 3000:3000 \
  -e ALLOWED_ORIGINS="http://localhost:8096" \
  -e JWT_SECRET="$JWT_SECRET" \
  ghcr.io/mhbxyz/owp-session-server:beta
```

#### Option B: Build from Source (Docker)

```bash
# Build the image
docker build --build-arg BUILD_MODE=release \
  -f infra/docker/server.Dockerfile \
  -t owp-session-server ./src/server

# Run the container
JWT_SECRET="$(openssl rand -base64 32)"
printf 'Configure this same JWT secret in the OpenWatchParty plugin: %s\n' "$JWT_SECRET"
docker run -d \
  --name owp-session \
  -p 3000:3000 \
  -e ALLOWED_ORIGINS="http://localhost:8096" \
  -e JWT_SECRET="$JWT_SECRET" \
  owp-session-server
```

#### Option C: Build from Source (Native)

Requirements:
- Rust 1.88.0

```bash
cd src/server
cargo build --release
./target/release/session-server
```

### Jellyfin Plugin

#### Option A: Via Jellyfin Plugin Repository (Recommended)

Install directly from Jellyfin's plugin interface:

1. Go to **Dashboard** > **Plugins** > **Repositories**
2. Click **Add** and enter:
   ```
   https://mhbxyz.github.io/OpenWatchParty/jellyfin-plugin-repo/manifest.json
   ```
3. Go to **Catalog** tab
4. Find **OpenWatchParty** and click **Install**
5. Restart Jellyfin
6. Open the plugin dashboard and verify native client injection

This method provides automatic update notifications when new versions are released.

#### Option B: Manual Download

1. **Download the Plugin**

   Download the canonical plugin archive from the [releases page](https://github.com/mhbxyz/OpenWatchParty/releases):

   ```bash
   curl -fLO https://github.com/mhbxyz/OpenWatchParty/releases/download/v0.3.2/OpenWatchParty-v0.3.2.zip
   ```

   The archive contains the canonical `OpenWatchPartyPlugin.dll` assembly, its dependencies, and `meta.json`.

2. **Install to Jellyfin**

   Extract the zip to your Jellyfin plugins directory:

   ```bash
   # Linux (Docker)
   unzip OpenWatchParty-v0.3.2.zip -d /tmp/owp
   docker cp /tmp/owp/. jellyfin:/config/plugins/OpenWatchParty/

   # Linux (native)
   sudo unzip OpenWatchParty-v0.3.2.zip -d /var/lib/jellyfin/plugins/OpenWatchParty/

   # Windows
   # Extract to: C:\ProgramData\Jellyfin\Server\plugins\OpenWatchParty\
   ```

3. **Restart Jellyfin**

   ```bash
   # Docker
   docker restart jellyfin

   # Systemd
   sudo systemctl restart jellyfin
   ```

4. **Verify Client Injection**

   Open the OpenWatchParty plugin dashboard, run diagnostics, then reload Jellyfin Web.

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
   Development only:
    ```
    [OpenWatchParty] Explicit insecure development mode is enabled.
    ```

   A missing secret without explicit insecure opt-in blocks token issuance and server startup.

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
| `JWT_SECRET` | required | JWT secret for authentication |
| `ALLOW_INSECURE_NO_AUTH` | `false` | Explicit development-only override; never enable in production |
| `LOG_LEVEL` | `info` | Logging level |

### Example

```bash
docker run -d \
  -p 3000:3000 \
  -e ALLOWED_ORIGINS="https://jellyfin.example.com" \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e LOG_LEVEL="debug" \
  ghcr.io/mhbxyz/owp-session-server:latest
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
