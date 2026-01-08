# Production Deployment

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
    image: jellyfin/jellyfin:latest
    container_name: jellyfin
    volumes:
      - ./config:/config
      - ./cache:/cache
      - /path/to/media:/media:ro
      - ./plugins/OpenWatchParty.dll:/config/plugins/OpenWatchParty/OpenWatchParty.dll:ro
    environment:
      - JELLYFIN_PublishedServerUrl=https://jellyfin.example.com
    restart: unless-stopped
    networks:
      - internal

  session-server:
    image: openwatchparty-session-server
    container_name: owp-session
    environment:
      - ALLOWED_ORIGINS=https://jellyfin.example.com
      - JWT_SECRET=${JWT_SECRET}
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

### Environment File

```bash
# .env
JWT_SECRET=your-very-secure-32-character-secret-key
```

## Reverse Proxy Configuration

### Caddy (Recommended)

```caddyfile
# Caddyfile
jellyfin.example.com {
    # Jellyfin main
    reverse_proxy jellyfin:8096

    # WebSocket for session server
    handle_path /ws* {
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
}
```

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
      - "traefik.http.routers.owp-ws.rule=Host(`jellyfin.example.com`) && PathPrefix(`/ws`)"
      - "traefik.http.routers.owp-ws.tls.certresolver=letsencrypt"
      - "traefik.http.services.owp-ws.loadbalancer.server.port=3000"
```

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

### 3. Restrict CORS

```yaml
environment:
  - ALLOWED_ORIGINS=https://jellyfin.example.com
```

### 4. Use Read-Only Volumes

```yaml
volumes:
  - ./plugins/OpenWatchParty.dll:/config/plugins/OpenWatchParty/OpenWatchParty.dll:ro
  - /path/to/media:/media:ro
```

### 5. Drop Capabilities

```yaml
services:
  session-server:
    cap_drop:
      - ALL
    read_only: true
    security_opt:
      - no-new-privileges:true
```

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

### 3. Update Plugin

```bash
# Download new plugin version
wget https://github.com/mhbxyz/OpenWatchParty/releases/latest/download/OpenWatchParty.dll

# Replace plugin
mv OpenWatchParty.dll ./plugins/OpenWatchParty/
```

### 4. Restart

```bash
docker compose up -d
```

### 5. Verify

- Check Jellyfin Dashboard for plugin status
- Test Watch Party functionality
- Check logs for errors

## Monitoring

See [Monitoring Guide](monitoring.md) for observability setup.

## Next Steps

- [Security](security.md) - Security best practices
- [Monitoring](monitoring.md) - Set up monitoring
- [Troubleshooting](troubleshooting.md) - Common issues
