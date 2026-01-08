# Monitoring Guide

## Health Checks

### Session Server Health

The session server exposes a health endpoint:

```bash
curl http://localhost:3000/health
# Expected: 200 OK with "OK"
```

### Docker Health Check

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

Check health status:
```bash
docker inspect --format='{{.State.Health.Status}}' session-server
```

### Jellyfin Plugin Health

Check if plugin is loaded:
```bash
curl -H "X-Emby-Token: TOKEN" \
  "http://localhost:8096/System/Plugins" | jq '.[] | select(.Name == "OpenWatchParty")'
```

## Logging

### Log Levels

Configure via environment variable:

| Level | Description | Use Case |
|-------|-------------|----------|
| `error` | Errors only | Minimal logging |
| `warn` | Warnings and errors | Production (recommended) |
| `info` | General info | Normal operation |
| `debug` | Debug details | Troubleshooting |
| `trace` | Everything | Deep debugging |

```yaml
environment:
  - LOG_LEVEL=warn
```

### Log Output

**Docker logs:**
```bash
# View logs
docker logs session-server

# Follow logs
docker logs -f session-server

# Last 100 lines
docker logs --tail 100 session-server
```

**Log format:**
```
2024-01-15T10:30:00.000Z INFO  [session_server] Client connected: abc123
2024-01-15T10:30:01.000Z INFO  [session_server] Room created: xyz789
```

### Log Aggregation

#### Docker Compose with Logging

```yaml
services:
  session-server:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

#### Forward to Syslog

```yaml
services:
  session-server:
    logging:
      driver: syslog
      options:
        syslog-address: "udp://localhost:514"
        tag: "owp-session"
```

#### Forward to Loki

```yaml
services:
  session-server:
    logging:
      driver: loki
      options:
        loki-url: "http://loki:3100/loki/api/v1/push"
        labels: "service=owp-session"
```

## Metrics

### Current Status

The session server doesn't currently expose Prometheus metrics, but you can monitor:

- Container resource usage (CPU, memory)
- Connection count (from logs)
- Room count (from logs)

### Container Metrics

**Docker stats:**
```bash
docker stats session-server
```

**cAdvisor:**
```yaml
services:
  cadvisor:
    image: gcr.io/cadvisor/cadvisor
    ports:
      - "8080:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
```

### Planned Metrics

Future versions may include:

| Metric | Type | Description |
|--------|------|-------------|
| `owp_connections_total` | Counter | Total WebSocket connections |
| `owp_connections_active` | Gauge | Current active connections |
| `owp_rooms_total` | Counter | Total rooms created |
| `owp_rooms_active` | Gauge | Current active rooms |
| `owp_messages_total` | Counter | Total messages processed |
| `owp_message_latency_seconds` | Histogram | Message processing time |

## Alerting

### Simple Alerting with cron

```bash
#!/bin/bash
# /usr/local/bin/check-owp.sh

if ! curl -sf http://localhost:3000/health > /dev/null; then
    echo "OpenWatchParty session server is DOWN" | mail -s "ALERT: OWP Down" admin@example.com
fi
```

```cron
*/5 * * * * /usr/local/bin/check-owp.sh
```

### Alertmanager (Prometheus)

```yaml
# alertmanager.yml
route:
  receiver: 'slack'

receivers:
  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/...'
        channel: '#alerts'
```

Example alert rule:
```yaml
# prometheus/rules/owp.yml
groups:
  - name: owp
    rules:
      - alert: OWPSessionServerDown
        expr: up{job="session-server"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "OpenWatchParty session server is down"
```

### Uptime Monitoring

**Uptime Kuma:**
```yaml
services:
  uptime-kuma:
    image: louislam/uptime-kuma
    ports:
      - "3001:3001"
    volumes:
      - ./uptime-kuma:/app/data
```

Add monitor for `http://session-server:3000/health`.

## Dashboard

### Grafana Dashboard

While waiting for native metrics, use Docker/container metrics:

```json
{
  "title": "OpenWatchParty",
  "panels": [
    {
      "title": "Container CPU",
      "targets": [
        {
          "expr": "rate(container_cpu_usage_seconds_total{name='session-server'}[5m])"
        }
      ]
    },
    {
      "title": "Container Memory",
      "targets": [
        {
          "expr": "container_memory_usage_bytes{name='session-server'}"
        }
      ]
    }
  ]
}
```

### Simple Status Page

Create a simple status page:

```html
<!DOCTYPE html>
<html>
<head><title>OpenWatchParty Status</title></head>
<body>
  <h1>OpenWatchParty Status</h1>
  <div id="status">Checking...</div>
  <script>
    fetch('/api/health')
      .then(r => r.ok ? 'Online' : 'Offline')
      .then(s => document.getElementById('status').textContent = s)
      .catch(() => document.getElementById('status').textContent = 'Offline');
  </script>
</body>
</html>
```

## Capacity Planning

### Resource Estimates

| Metric | Per Client | Per Room |
|--------|------------|----------|
| Memory | ~1 KB | ~5 KB |
| CPU | Minimal | Minimal |
| Bandwidth | ~1 KB/s | ~10 KB/s |

### Scaling Considerations

**Current limitations:**
- Single instance (stateful)
- In-memory storage
- No persistence

**Future improvements:**
- Redis-backed state
- Horizontal scaling
- Persistent rooms

### Connection Limits

**WebSocket connections:**
- Default OS limit: 1024 file descriptors
- Increase if needed:
  ```bash
  ulimit -n 65535
  ```

**Docker:**
```yaml
services:
  session-server:
    ulimits:
      nofile:
        soft: 65535
        hard: 65535
```

## Troubleshooting Monitoring

### Health Check Failing

1. Check container is running:
   ```bash
   docker ps | grep session
   ```

2. Check container logs:
   ```bash
   docker logs session-server
   ```

3. Test from inside container:
   ```bash
   docker exec session-server curl localhost:3000/health
   ```

### No Logs Appearing

1. Check log level isn't too restrictive
2. Check Docker logging driver
3. Verify container is running

### High Resource Usage

1. Check number of active connections
2. Look for error loops in logs
3. Consider restart if memory leak suspected

## Next Steps

- [Troubleshooting](troubleshooting.md) - Fix issues
- [Security](security.md) - Secure your installation
- [Deployment](deployment.md) - Production setup
