---
title: Monitoring
parent: Operations
nav_order: 6
---

# Monitoring Guide

## Health Checks

### Session Server Health

The session server exposes a health endpoint and a readiness endpoint:

```bash
curl http://localhost:3000/health
# 200 {"status":"ok","auth_enabled":true,"version":"...","protocol_version":1}

curl http://localhost:3000/ready
# 200 {"status":"ready"} while the server accepts new sessions
# 503 {"status":"shutting_down"} once a graceful shutdown has started
```

`/health` answers until the process exits, so keep it for liveness and container health checks. Use `/ready` where a load balancer or orchestrator should stop sending new connections during a shutdown.

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
curl -H "Authorization: MediaBrowser Token=\"TOKEN\"" \
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
[2026-10-06T15:46:15Z INFO  session_server::ws::connection] Client connected client_id=4f2a... auth_required=true
[2026-10-06T15:46:15Z INFO  session_server::ws::handlers::auth] Client authenticated client_id=4f2a... user="alice"
[2026-10-06T15:47:02Z INFO  session_server::ws::handlers::create] Creating room room_id=9c1e... client_id=4f2a... name="alice's room"
```

Session and room lifecycle lines (connect, authentication, create, join, leave, disconnect, close, rate limit, heartbeat) carry `client_id=` and, when a room is involved, `room_id=` as `key=value` fields after the message text, so a log collector can extract them, for example with Loki's `logfmt` parser. Values that come from a client or an error (user and room names, error text) are quoted and escaped.

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

The session server serves Prometheus metrics at `GET /metrics`, in the text exposition format (version 0.0.4), on the same port as `/ws` and `/health`:

```bash
curl http://localhost:3000/metrics
```

`/metrics` has no authentication and no CORS headers: it is meant for a scraper on the internal network. Keep it off the public reverse proxy, which only needs to forward `/ws`. The metrics carry counts only, never a user name, room name, token or id, and every label value comes from a fixed list, so clients cannot create new series.

### Metric Reference

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `owp_build_info` | Gauge | `version`, `protocol_version` | Always `1`; identifies the running build |
| `owp_start_time_seconds` | Gauge | | Unix time the server started |
| `owp_connections_active` | Gauge | | WebSocket sessions currently open |
| `owp_clients_authenticated` | Gauge | | Open sessions that have authenticated |
| `owp_rooms_active` | Gauge | | Rooms currently open |
| `owp_room_participants` | Gauge | | Participants across all open rooms |
| `owp_connections_total` | Counter | | WebSocket sessions opened |
| `owp_connections_rejected_total` | Counter | `reason` | Upgrades refused before a session started: `origin`, `connection_limit` |
| `owp_rooms_total` | Counter | | Rooms created |
| `owp_messages_received_total` | Counter | `type` | Client messages parsed, by protocol type (`unknown` for unrecognized types) |
| `owp_messages_sent_total` | Counter | `type` | Messages queued to clients, by protocol type (`other` for anything unlisted) |
| `owp_send_failures_total` | Counter | | Messages dropped because a client's outbound queue was full or closed |
| `owp_invalid_messages_total` | Counter | `reason` | Messages dropped before dispatch: `invalid_json`, `too_large` (over 64 KiB, which also ends the session), `unsupported_format` |
| `owp_errors_sent_total` | Counter | `code` | `error` messages queued to clients, by error code (`ROOM_FULL`, `RATE_LIMITED`, ...); one that cannot be queued counts as a send failure instead |
| `owp_rate_limited_total` | Counter | `scope` | Requests rejected by a rate limit: `messages` (per client), `invites` (per user) |
| `owp_websocket_closes_total` | Counter | `reason` | Sessions ended, one per session (see below) |
| `owp_zombie_connections_removed_total` | Counter | | Sessions removed after missing the heartbeat |

Close reasons for `owp_websocket_closes_total`:

| `reason` | Meaning |
|----------|---------|
| `client_closed` | The client sent a close frame (tab closed, page reloaded, leaving Jellyfin) |
| `client_disconnected` | The connection ended without a close frame |
| `receive_error` | Reading from the socket failed |
| `rate_limited` | The client exceeded the message rate limit |
| `authentication_timeout` | The client did not authenticate in time |
| `authentication_expired` | The client's session token expired |
| `outbound_queue_failed` | The client stopped reading and its outbound queue filled up or closed |
| `server_shutdown` | The server is shutting down |
| `message_too_large` | The client sent a message over the 64 KiB limit |
| `heartbeat_timeout` | The session missed the heartbeat and was removed (also counted by `owp_zombie_connections_removed_total`) |

### Prometheus Scrape Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: session-server
    static_configs:
      - targets: ['session-server:3000']
```

Useful queries:

```promql
# Open sessions and rooms
owp_connections_active
owp_rooms_active

# Client messages per second, by type
sum by (type) (rate(owp_messages_received_total[5m]))

# Errors sent to clients, by code
sum by (code) (rate(owp_errors_sent_total[5m]))

# Why sessions ended in the last hour
sum by (reason) (increase(owp_websocket_closes_total[1h]))
```

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

      - alert: OWPConnectionLimitReached
        expr: increase(owp_connections_rejected_total{reason="connection_limit"}[10m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "OpenWatchParty refused connections at its connection limit"

      - alert: OWPClientsFallingBehind
        expr: rate(owp_send_failures_total[5m]) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "OpenWatchParty is dropping messages for clients that cannot keep up"
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

Combine the session server metrics with container metrics:

```json
{
  "title": "OpenWatchParty",
  "panels": [
    {
      "title": "Sessions and Rooms",
      "targets": [
        { "expr": "owp_connections_active" },
        { "expr": "owp_rooms_active" }
      ]
    },
    {
      "title": "Client Messages by Type",
      "targets": [
        { "expr": "sum by (type) (rate(owp_messages_received_total[5m]))" }
      ]
    },
    {
      "title": "Errors by Code",
      "targets": [
        { "expr": "sum by (code) (rate(owp_errors_sent_total[5m]))" }
      ]
    },
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
