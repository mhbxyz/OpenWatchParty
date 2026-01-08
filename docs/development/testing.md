# Testing Guide

## Overview

OpenWatchParty uses a combination of automated tests and manual testing procedures.

## Automated Tests

### Rust Session Server

```bash
cd session-server-rust

# Run all tests
cargo test

# Run with output
cargo test -- --nocapture

# Run specific test
cargo test test_name

# Run with coverage (requires cargo-tarpaulin)
cargo tarpaulin
```

#### Test Categories

| Test Type | Description |
|-----------|-------------|
| Unit tests | Individual function tests |
| Integration tests | Module interaction tests |

#### Example Test

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_ready_empty_room() {
        let room = Room {
            clients: vec![],
            ready_clients: HashSet::new(),
            ..Default::default()
        };
        assert!(all_ready(&room));
    }

    #[test]
    fn test_all_ready_partial() {
        let room = Room {
            clients: vec!["a".into(), "b".into()],
            ready_clients: HashSet::from(["a".into()]),
            ..Default::default()
        };
        assert!(!all_ready(&room));
    }
}
```

### C# Plugin

```bash
cd plugins/jellyfin/OpenWatchParty

# Run tests
dotnet test

# With coverage
dotnet test --collect:"XPlat Code Coverage"
```

## Manual Testing

### Test Environment

1. Start the development environment:
   ```bash
   make up
   ```

2. Open Jellyfin in two browser windows/tabs

3. Log in to both

### Test Scenarios

#### Room Management

| Test | Steps | Expected Result |
|------|-------|-----------------|
| Create room | Click Watch Party > Enter name > Start Room | Room created, you are host |
| Join room | Click Watch Party > Select room > Join | Joined room, synced to host |
| Leave room | In room > Leave | Left room, panel shows lobby |
| Host leaves | Host leaves room | All participants see "Room closed" |

#### Playback Sync

| Test | Steps | Expected Result |
|------|-------|-----------------|
| Play sync | Host plays | All clients start playing |
| Pause sync | Host pauses | All clients pause |
| Seek sync | Host seeks to position | All clients seek to same position |
| Drift correction | Play for 5 minutes | Clients stay within 200ms |

#### Edge Cases

| Test | Steps | Expected Result |
|------|-------|-----------------|
| Rapid seek | Seek multiple times quickly | Only last seek applied |
| Buffering | Let video buffer mid-play | No false pause sent |
| Disconnect | Disconnect network briefly | Auto-reconnect when restored |
| Different quality | Clients use different quality | Sync maintained |

### Browser Testing

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome | Primary | Full support |
| Firefox | Secondary | Full support |
| Safari | Test | May need WebSocket fixes |
| Edge | Test | Same as Chrome |
| Mobile Chrome | Test | Touch interactions |
| Mobile Safari | Test | iOS-specific issues |

### Network Testing

#### Simulate Latency

```bash
# Linux (requires tc)
tc qdisc add dev eth0 root netem delay 200ms

# Reset
tc qdisc del dev eth0 root
```

#### Test Scenarios

| Condition | Test |
|-----------|------|
| High latency (500ms+) | Sync should work but feel delayed |
| Packet loss (5%) | Should recover gracefully |
| Disconnect/reconnect | Auto-reconnect after 3s |

## Load Testing

### WebSocket Connections

Using `websocat`:

```bash
# Multiple concurrent connections
for i in {1..100}; do
  websocat -n ws://localhost:3000/ws &
done
```

### Stress Test Script

```python
#!/usr/bin/env python3
import asyncio
import websockets
import json

async def client(client_id):
    async with websockets.connect('ws://localhost:3000/ws') as ws:
        # Receive client_hello
        await ws.recv()

        # Create room
        await ws.send(json.dumps({
            'type': 'create_room',
            'payload': {'name': f'Room {client_id}'},
            'ts': 0
        }))

        # Wait
        await asyncio.sleep(60)

async def main():
    tasks = [client(i) for i in range(50)]
    await asyncio.gather(*tasks)

asyncio.run(main())
```

## Performance Testing

### Sync Accuracy

1. Start playing video with precise timestamp
2. Record actual playback time from multiple clients
3. Calculate drift over time

Target: < 200ms drift after 10 minutes

### Message Latency

```javascript
// In browser console
const start = Date.now();
OSP.ws.send(JSON.stringify({type: 'ping', ts: start}));
// Check pong response for round-trip time
```

Target: < 100ms RTT on local network

## Test Data

### Sample Media

For testing, use:
- Short video clips (1-5 minutes)
- Various formats (MP4, MKV)
- HLS streams (to test buffering)

### Test Users

Create test users in Jellyfin:
- `testhost` - For hosting
- `testclient1` - For joining
- `testclient2` - For joining

## Continuous Integration

### GitHub Actions (Planned)

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test-rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - run: cargo test
        working-directory: session-server-rust

  test-csharp:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-dotnet@v3
        with:
          dotnet-version: '9.0'
      - run: dotnet test
        working-directory: plugins/jellyfin/OpenWatchParty
```

## Debugging Test Failures

### Rust Test Failures

```bash
# Run with backtrace
RUST_BACKTRACE=1 cargo test

# Run single test with logging
RUST_LOG=debug cargo test test_name -- --nocapture
```

### JavaScript Issues

1. Check browser console for errors
2. Enable debug logging:
   ```javascript
   OSP.constants.DEBUG = true;
   ```

### Network Issues

```bash
# Check WebSocket is accessible
curl http://localhost:3000/health

# Test WebSocket connection
wscat -c ws://localhost:3000/ws
```

## Writing New Tests

### Test File Location

| Component | Location |
|-----------|----------|
| Rust | `session-server-rust/src/*.rs` (inline) |
| Rust integration | `session-server-rust/tests/` |
| C# | `plugins/jellyfin/OpenWatchParty.Tests/` |

### Test Naming

```rust
// Rust
#[test]
fn test_function_name_scenario() { }

// Example
#[test]
fn test_all_ready_returns_false_when_not_all_clients_ready() { }
```

```csharp
// C#
[Fact]
public void MethodName_Scenario_ExpectedResult() { }

// Example
[Fact]
public void GetToken_WhenAuthenticated_ReturnsValidToken() { }
```

## Test Coverage Goals

| Component | Goal |
|-----------|------|
| Rust business logic | 80% |
| C# controllers | 70% |
| JavaScript | Manual testing |

## Next Steps

- [Contributing](contributing.md) - How to submit tests
- [Setup](setup.md) - Development environment
- [Release](release.md) - Release process
