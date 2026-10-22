---
title: "Monitoring Guide"
---

<span id="monitoring-guide" class="legacy-anchor"></span>

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

The endpoint has no process-memory or queue-length gauge. Use container monitoring for actual CPU and memory. Do not infer RSS or OOM behavior from the serialized queue-response size regression tests; those test wire payload bounds, not process memory usage.

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

### Measured Session Capacity

These are short, reproducible session-server measurements, **not a maximum
capacity claim**. Jellyfin transcoding and video delivery are separate and are
not part of this test.

Measured on 2026-10-10 from `main` commit `3be7235`: optimized Rust 1.88.0 GNU
Linux build, Docker Desktop/WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, on
an Intel Core i9-9900KF (8 cores / 16 threads). The Docker VM had 16 logical
CPUs and approximately 9.7 GiB RAM. The server container was limited to **2 CPUs
and 512 MiB**; the Node load generator ran on the same Windows host through
loopback port forwarding. Normal background workloads remained running.
Authentication was explicitly disabled only in this disposable test server,
without TLS. `MAX_CONNECTIONS` and `MAX_CONNECTIONS_PER_IP` were both 256.

Each run lasted 30 seconds after room setup and a 1.2-second settling period.
Every client sent one application ping per second and one chat message every
five seconds; hosts sent one playback state per second and a play/pause command
every ten seconds. Every recipient's chat delivery and every ping response were
checked. CPU/memory were sampled using Docker stats (14 samples per run).

| Rooms × clients | Connections | Inbound messages/s | Chat p95 / p99 (ms) | Ping p95 / p99 (ms) | CPU mean / peak (%) | Peak memory (MiB) |
|---|---:|---:|---:|---:|---:|---:|
| 10 × 5 | 50 | 71.00 | 44.489 / 46.810 | 42.846 / 314.094 | 0.538 / 1.09 | 11.43 |
| 10 × 20 | 200 | 250.97 | 44.545 / 52.645 | 41.719 / 311.756 | 2.309 / 5.50 | 33.46 |
| 16 × 16 | 256 | 324.77 | 50.458 / 59.669 | 42.448 / 49.395 | 2.884 / 7.01 | 42.04 |

All three runs had zero server errors, unexpected closes, outstanding probes,
or outbound queue failures. Expected/delivered chat messages were respectively
1,500/1,500, 24,000/24,000 and 24,576/24,576. Docker's 100% CPU corresponds to
one fully used logical CPU. Latencies include network, client scheduling and
fan-out; memory is Docker's reported container usage, not a per-client estimate.
The 256-connection run reaches the configured connection limit, not a measured
CPU or memory ceiling. Longer runs, TLS/JWT, slower clients, WAN latency and
different traffic patterns need their own measurements before planning a
deployment. Keep room membership within the server's 20-client limit.

### Reproduce a Load Test

Use an empty **disposable** server. The generator refuses a server that already
has connections or rooms. Node 22 or newer provides its built-in WebSocket
client; there are no npm dependencies. For example, from the repository root:

```sh
docker build --build-arg BUILD_MODE=release -f infra/docker/server.Dockerfile \
  -t openwatchparty/session-server:test src/server
docker run -d --name owp-load --cpus 2 --memory 512m \
  -p 127.0.0.1:19000:3000 \
  -e ALLOW_INSECURE_NO_AUTH=true -e ALLOWED_ORIGINS='*' -e LOG_LEVEL=warn \
  -e MAX_CONNECTIONS=256 -e MAX_CONNECTIONS_PER_IP=256 \
  openwatchparty/session-server:test
node infra/scripts/load-session-server.mjs \
  --rooms 16 --clients 16 --seconds 30 --container owp-load
docker rm -f owp-load
```

The JSON report includes chat/ping percentiles, throughput, delivery counts,
errors, unexpected disconnects, outstanding probes, outbound send failures,
active state and sampled container CPU/memory. Exit status is nonzero if the
traffic test fails or sampling is unavailable. Without `--container`, resources
are explicitly `null`. `Session Load Smoke` runs a smaller 50-client/10-second
test in CI to catch generator/protocol regressions; its debug build is not used
as a capacity benchmark.

### Fuzzing Hostile Input

`Inbound WebSocket Fuzz` exercises real frame assembly, JSON parsing,
validation and dispatch with a committed seed corpus, bounded input/time/RSS
and room-state assertions. It runs for 30 seconds on pull requests and 300
seconds weekly. Crash reproducers are retained as workflow artifacts; every
server panic discovered must become a deterministic regression test.
See the [fuzzing instructions](https://github.com/mhbxyz/OpenWatchParty/tree/main/src/server/fuzz).

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

- [Troubleshooting](/operations/troubleshooting/) - Fix issues
- [Security](/operations/security/) - Secure your installation
- [Deployment](/operations/deployment/) - Production setup
