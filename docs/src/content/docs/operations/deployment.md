---
title: "Production Deployment"
---

<span id="production-deployment" class="legacy-anchor"></span>

## Architecture Overview

A production deployment typically includes:

```
Internet
    │
    ▼
┌─────────────────────────────────────┐
│         Reverse Proxy               │
│    (nginx/Caddy/Traefik)           │
│    SSL termination, routing         │
└───────────┬─────────────┬───────────┘
            │             │
    ┌───────▼───────┐ ┌───▼───────────┐
    │   Jellyfin    │ │ Session Server│
    │   :8096       │ │    :3000      │
    └───────────────┘ └───────────────┘
```

## Docker Compose Deployment

### Complete Production Setup

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  jellyfin:
    image: jellyfin/jellyfin:12.1
    container_name: jellyfin
    volumes:
      - ./config:/config
      - ./cache:/cache
      - /path/to/media:/media:ro
      - ./plugins/OpenWatchParty:/config/plugins/OpenWatchParty:ro
    environment:
      - JELLYFIN_PublishedServerUrl=https://jellyfin.example.com
    restart: unless-stopped
    networks:
      - internal

  session-server:
    image: ghcr.io/mhbxyz/owp-session-server:0.7.0@sha256:8e925305e4fc750ad08c1bf50318ea4fa45996c6130a63486cbaf4a9d4b41c20
    container_name: owp-session
    environment:
      - ALLOWED_ORIGINS=https://jellyfin.example.com
      - JWT_SECRET=${JWT_SECRET}
      - ALLOW_INSECURE_NO_AUTH=false
      - LOG_LEVEL=warn
    restart: unless-stopped
    networks:
      - internal

  caddy:
    image: caddy:2-alpine
    container_name: caddy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped
    networks:
      - internal

networks:
  internal:

volumes:
  caddy_data:
  caddy_config:
```

The session-server image is pinned to the published 0.7.0 digest, which fixes [GHSA-fjpr-3g28-27r9](https://github.com/mhbxyz/OpenWatchParty/security/advisories/GHSA-fjpr-3g28-27r9). Do not use a floating `latest` tag for production. The immutable `v0.7.0` source tag still contains a Compose file pointing to the 0.6.0 image; if deploying from that checkout, update the image reference to the 0.7.0 release and verify the effective Compose configuration before pulling.

### Environment File

```bash
# .env
# Paste the output of: openssl rand -base64 32
JWT_SECRET=<generated-base64-value>
```

## Reverse Proxy Configuration

Whatever proxy you use, route both `/ws` (WebSocket) and `/invite` (HTTP `POST` for invite links) to the session server. The client derives `/invite` from the configured Session Server URL. If the session server has its own hostname and all paths on that hostname go to it, no extra route is needed.

Check the route with `curl -X POST https://jellyfin.example.com/invite`: it must reach the session server and return a 4xx response about the request body, not Jellyfin's 404.

### Caddy (Recommended)

```caddyfile
# Caddyfile
jellyfin.example.com {
    # Jellyfin main
    reverse_proxy jellyfin:8096

    # WebSocket for session server
    handle /ws {
        reverse_proxy session-server:3000
    }

    # Invite links
    handle /invite {
        reverse_proxy session-server:3000
    }
}
```

### nginx

```nginx
# /etc/nginx/sites-available/jellyfin
upstream jellyfin {
    server jellyfin:8096;
}

upstream session-server {
    server session-server:3000;
}

server {
    listen 443 ssl http2;
    server_name jellyfin.example.com;

    ssl_certificate /etc/ssl/certs/jellyfin.crt;
    ssl_certificate_key /etc/ssl/private/jellyfin.key;

    # Jellyfin
    location / {
        proxy_pass http://jellyfin;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support for Jellyfin
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Session Server WebSocket
    location /ws {
        proxy_pass http://session-server;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }

    # Session Server invite links
    location = /invite {
        proxy_pass http://session-server;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Nginx Proxy Manager

Open **Proxy Hosts**, edit the Jellyfin host, select **Advanced**, and add this to **Custom Nginx Configuration**:

```nginx
location = /ws {
    set $owp_upstream http://session-server:3000;
    proxy_pass $owp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
location = /invite {
    set $owp_upstream http://session-server:3000;
    proxy_pass $owp_upstream;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

`set $owp_upstream` makes nginx resolve the container name at request time, so Nginx Proxy Manager can start even when the session server is down. Press **Save**.

### Traefik

```yaml
# docker-compose with traefik labels
services:
  jellyfin:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.jellyfin.rule=Host(`jellyfin.example.com`)"
      - "traefik.http.routers.jellyfin.tls.certresolver=letsencrypt"
      - "traefik.http.services.jellyfin.loadbalancer.server.port=8096"

  session-server:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.owp-ws.rule=Host(`jellyfin.example.com`) && (PathPrefix(`/ws`) || Path(`/invite`))"
      - "traefik.http.routers.owp-ws.tls.certresolver=letsencrypt"
      - "traefik.http.services.owp-ws.loadbalancer.server.port=3000"
```

### Cloudflare Tunnel

Cloudflare Tunnel (`cloudflared`) creates an outbound-only connection to Cloudflare's edge, so you don't need to open any ports.

**Important:** In the tunnel configuration, use the Docker service name or the host IP to reach the session server — never `localhost`, which resolves to the tunnel container's own loopback.

```yaml
# ~/.cloudflared/config.yml
tunnel: your-tunnel-id
credentials-file: /path/to/credentials.json

ingress:
  # Jellyfin
  - hostname: jellyfin.example.com
    service: http://jellyfin:8096
  # Session server WebSocket
  - hostname: owp.example.com
    service: http://session-server:3000
  - service: http_status:404
```

Session server environment:

```yaml
services:
  session-server:
    image: owp-session-server
    environment:
      - ALLOWED_ORIGINS=https://jellyfin.example.com
      - JWT_SECRET=${JWT_SECRET}
    networks:
      - internal
```

Plugin settings:
- **Session Server URL**: `wss://owp.example.com/ws`

Because `owp.example.com` is dedicated to the session server and the tunnel forwards every path on that hostname, `/invite` already works and needs no additional ingress rule.

If `cloudflared` runs on the Docker host (not in a container), use the host IP or `host.docker.internal` instead of the service name.

Set `TRUSTED_PROXIES` to the address of the `cloudflared` container (or the host, when the tunnel runs on the host) so the session server can derive the real client address from `X-Forwarded-For` for the per-IP connection limit. Without it, every tunneled client shares the tunnel's address for that limit. See [Reverse Proxy Trust](/operations/configuration/#reverse-proxy-trust) and [Per-IP Limits: Verdict](/operations/security/#per-ip-limits-verdict).

### Caching Proxies and CDNs

The plugin injects the web client as `/OpenWatchParty/ClientScript?v=<hash>`, where `<hash>` changes whenever the client code changes. The loader and its modules are served with `Cache-Control: public, max-age=31536000, immutable` while `v` matches the current hash (see [GET /OpenWatchParty/ClientScript](/technical/api/#get-openwatchpartyclientscript)).

**Any cache in front of Jellyfin must keep the query string in its cache key.** A proxy or CDN that ignores query strings drops `v` from the key, so after a plugin update it keeps serving the files it cached for the previous version, and browsers get a stale or mixed client. Such a setup is not supported: Jellyfin's own image and API URLs rely on query values in the same way.

The defaults keep the query string: nginx's `proxy_cache_key` (`$scheme$proxy_host$request_uri`) and Cloudflare's Standard caching level both do. Avoid Cloudflare's "Ignore query string" level, and cache rules that remove the query string from the cache key.

## SSL/TLS Configuration

### Let's Encrypt with Caddy

Caddy automatically provisions Let's Encrypt certificates:

```caddyfile
jellyfin.example.com {
    reverse_proxy jellyfin:8096
}
```

### Let's Encrypt with Certbot

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d jellyfin.example.com

# Auto-renewal (usually configured automatically)
sudo systemctl enable certbot.timer
```

## Security Hardening

### 1. Use Internal Networks

```yaml
services:
  session-server:
    # Don't expose port externally
    expose:
      - "3000"
    networks:
      - internal
```

### 2. Enable Authentication

Set JWT Secret in both:
- Plugin configuration (Jellyfin Dashboard)
- Session server environment variable

### 3. Configure Session Server URL

When using a reverse proxy, set the WebSocket URL in the plugin settings so the client connects through the proxy instead of directly to port 3000:

1. Go to **Dashboard > Plugins > OpenWatchParty**
2. Set **Session Server URL** to `wss://jellyfin.example.com/ws`
3. Click **Save**

Without this, the client defaults to `ws://<current-host>:3000/ws`, which is not reachable through a reverse proxy.

### 4. Restrict CORS

```yaml
environment:
  - ALLOWED_ORIGINS=https://jellyfin.example.com
```

### 5. Use Read-Only Volumes

```yaml
volumes:
  - ./plugins/OpenWatchParty:/config/plugins/OpenWatchParty:ro
  - /path/to/media:/media:ro
```

### 6. Drop Capabilities

```yaml
services:
  session-server:
    cap_drop:
      - ALL
    read_only: true
    security_opt:
      - no-new-privileges:true
```

### 7. Trust Only Your Reverse Proxy

Set `TRUSTED_PROXIES` to the exact addresses or narrow CIDRs of the proxies you operate so the per-IP connection limit sees the real client address. Never trust `X-Forwarded-For` supplied by the public internet. See [Reverse Proxy Trust](/operations/configuration/#reverse-proxy-trust) and the [Threat Model](/operations/security/#threat-model).

## Health Checks

```yaml
services:
  session-server:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 5s
```

`GET /health` is a liveness check and continues to return 200 during graceful shutdown. Use `GET /ready` for routing decisions: it returns 200 while accepting sessions and 503 after shutdown begins. See the [Monitoring Guide](/operations/monitoring/#health-checks).

## Logging

### Container Logs

```yaml
services:
  session-server:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### Log Levels

| Level | Use Case |
|-------|----------|
| `error` | Production (minimal) |
| `warn` | Production (recommended) |
| `info` | Debugging |
| `debug` | Development |
| `trace` | Deep debugging |

## Backup Strategy

### What to Backup

1. **Jellyfin config** - `/config` directory
2. **Plugin config** - Part of Jellyfin config
3. **Docker Compose files** - Your deployment configuration
4. **Environment files** - `.env` with secrets

### What NOT to Backup

- Session server state (ephemeral, in-memory)
- Cache directories

### Example Backup Script

```bash
#!/bin/bash
BACKUP_DIR=/backup/jellyfin
DATE=$(date +%Y%m%d)

# Stop services for consistent backup
docker compose stop jellyfin

# Backup config
tar -czf $BACKUP_DIR/config-$DATE.tar.gz ./config

# Restart services
docker compose start jellyfin
```

## Upgrade Procedure

### 1. Backup First

```bash
docker compose stop
tar -czf backup-before-upgrade.tar.gz ./config
```

### 2. Pull New Images

```bash
docker compose pull
```

Before pulling, update the session-server image to the intended fixed release and digest. Confirm the resolved image reference with `docker compose config`; a plugin-only update does not fix an affected session server. Review the release notes and [security advisory](https://github.com/mhbxyz/OpenWatchParty/security/advisories/GHSA-fjpr-3g28-27r9), and verify downloaded plugin ZIP checksums. Release assets include checksum files, Sigstore bundles and build attestations; follow the published verification instructions when validating those artifacts.

### 3. Update Plugin

```bash
# Download the canonical plugin package
archive=/tmp/OpenWatchParty-v0.7.0.zip
release=https://github.com/mhbxyz/OpenWatchParty/releases/download/v0.7.0/OpenWatchParty-v0.7.0.zip
curl -fL "$release" -o "$archive"
curl -fL "$release.sha256" -o "$archive.sha256"
(cd /tmp && sha256sum -c "$(basename "$archive").sha256")

# Replace the complete plugin package, including its dependencies and metadata
rm -rf ./plugins/OpenWatchParty
mkdir -p ./plugins/OpenWatchParty
unzip "$archive" -d ./plugins/OpenWatchParty
rm "$archive" "$archive.sha256"
```

### 4. Restart

```bash
docker compose up -d
```

The session server keeps rooms, participants and queues in memory. Restarting or replacing it closes active rooms and discards their queues, so schedule the server update between watch parties and tell participants to create a new room afterward.

### 5. Verify

- Check Jellyfin Dashboard for plugin status
- Test Watch Party functionality
- Check logs for errors

## Monitoring

See [Monitoring Guide](/operations/monitoring/) for observability setup.

## Next Steps

- [Security](/operations/security/) - Security best practices
- [Monitoring](/operations/monitoring/) - Set up monitoring
- [Troubleshooting](/operations/troubleshooting/) - Common issues
