---
title: Sync Algorithms
parent: Technical
nav_order: 6
---

# Synchronization Algorithms

## Overview

OpenWatchParty uses multiple algorithms to maintain playback synchronization between clients, addressing the specific challenges of HLS/transcoded streaming.

## 1. Clock Synchronization (Simplified NTP)

### Problem
Clients have different system clocks. To synchronize actions, we need to know the offset between client and server clocks.

### Algorithm

```
Client                          Server
   │                              │
   ├─── ping { client_ts: T1 } ──►│
   │                              │
   │◄── pong { client_ts: T1,     │
   │           server_ts: T2 } ───┤
   │                              │
   T3 (reception)                 │
```

**Calculation:**
```javascript
rtt = T3 - T1;                           // Round-trip time
serverTimeAtT3 = T2 + (rtt / 2);         // Estimated current server time
serverOffsetMs = serverTimeAtT3 - T3;    // Client/server offset
```

**EMA Smoothing (Exponential Moving Average):**
```javascript
// Prevents sudden jumps from latency variations
serverOffsetMs = hasTimeSync
    ? (0.6 * serverOffsetMs + 0.4 * newOffset)
    : newOffset;
```

### Usage
```javascript
function getServerNow() {
    return Date.now() + serverOffsetMs;
}
```

## 2. Synchronized Action Scheduling

### Problem
When the host clicks "Play", all clients must start playback at the same instant, despite variable network latency.

### Solution: Target Server Timestamp

```
Host                  Server                    Client B
  │                      │                          │
  ├─ play @ pos 120s ───►│                          │
  │                      │                          │
  │                      ├── target_server_ts ─────►│
  │                      │   = now + 1000ms         │
  │                      │                          │
  │                      │                    scheduleAt(target_ts)
  │                      │                          │
  │                      │                          ▼
  │                      │                    [Wait...]
  │                      │                          │
  ◄──────────────────────┼──────────────────────────┤
                    [T = target_server_ts]          │
                                              video.play()
```

### Client-Side Implementation

```javascript
function scheduleAt(serverTs, fn) {
    const serverNow = getServerNow();
    const delay = Math.max(0, serverTs - serverNow);

    if (delay === 0) {
        fn();  // Immediate execution
    } else {
        setTimeout(fn, delay);
    }
}
```

### Configured Delays

| Action | Delay (ms) | Reason |
|--------|------------|--------|
| `play` | 1000 | Allow buffering sync (reduced from 1500ms) |
| `pause` | 300 | Shorter, no buffering needed |
| `seek` | 300 | Shorter, direct position |

## 3. Position Correction with Lead Time

### Problem
Messages take time to arrive. When client receives "position = 120s", the host is already further ahead.

### Solution: Lead Time Compensation

```javascript
function adjustedPosition(position, serverTs) {
    const serverNow = getServerNow();
    const elapsed = Math.max(0, serverNow - serverTs);  // Time since send
    const lead = SYNC_LEAD_MS;  // 300ms margin

    return position + (elapsed + lead) / 1000;
}
```

### Example

```
Server time:    1000ms         1050ms         1100ms
                  │               │               │
Host sends:     pos=120s        ─────────────────►│
                  │                               │
Client receives: ──────────────────────────────────│
                                               pos=120s
                                               elapsed=100ms
                                               lead=120ms
                                               adjusted=120.22s
```

## 4. Continuous Drift Correction

### Problem
Even with perfect initial synchronization, clients drift over time (slightly different playback speeds, buffers, etc.).

### Algorithm: syncLoop (non-hosts only)

```javascript
function syncLoop() {
    // Calculate expected position
    const elapsed = (getServerNow() - lastSyncServerTs) / 1000;
    const expected = lastSyncPosition + elapsed;

    // Measure drift
    const drift = expected - video.currentTime;
    const absDrift = Math.abs(drift);

    // Dead zone: no correction
    if (absDrift < DRIFT_DEADZONE_SEC) {  // 0.04s
        video.playbackRate = 1;
        return;
    }

    // Excessive drift: forced seek
    if (absDrift >= DRIFT_SOFT_MAX_SEC) {  // 2.0s
        video.currentTime = expected;
        video.playbackRate = 1;
        return;
    }

    // Soft correction zone: progressive sqrt-based speed adjustment
    // drift > 0 = behind = speed up
    // drift < 0 = ahead = slow down
    const sign = drift > 0 ? 1 : -1;
    const correction = sign * Math.sqrt(absDrift) * DRIFT_GAIN;
    const rate = clamp(1 + correction, 0.90, 1.15);
    video.playbackRate = rate;
}
```

### Visualization

```
                    DRIFT_SOFT_MAX_SEC = 2.0s
                           │
    ◄─────────────────────┼────────────────────►
    │         │           │           │        │
  SEEK     SLOW      DEADZONE     FAST      SEEK
 (≤−2.0s) (−2.0s     (±0.04s)   (+0.04s   (≥+2.0s)
           to −0.04s)            to +2.0s)
    │         │                     │          │
    │    rate ≥ 0.90           rate ≤ 1.15     │
    │     (min)                   (max)        │
    └─────────┴──────────┬──────────┴──────────┘
                         │
                    rate = 1.0
```

### Rate Formula (Progressive Sqrt Curve)

```
rate = 1 + sign(drift) * sqrt(|drift|) * DRIFT_GAIN
     = 1 + sign(drift) * sqrt(|drift|) * 0.15

Examples:
- drift = +0.25s → rate = 1 + sqrt(0.25) * 0.15 = 1.075x
- drift = +1.0s  → rate = 1 + sqrt(1.0) * 0.15 = 1.15x
- drift = +1.9s  → rate = 1 + sqrt(1.9) * 0.15 = 1.21x (capped to 1.15x)
- drift = -0.1s  → rate = 1 - sqrt(0.1) * 0.15 = 0.95x
- drift = -0.5s  → rate = 1 - sqrt(0.5) * 0.15 = 0.89x (clamped to 0.90x)
```

The sqrt curve corrects small drifts gently and larger ones faster, within 0.90x-1.15x: voices still sound natural there (browsers also keep the pitch, `preservesPitch`), at the cost of a slower catch-up (about 10 s from 1.5 s behind to within 0.25 s). Drifts of 2 s or more seek instead, once the cooldown after joining (`INITIAL_SYNC_COOLDOWN_MS`) or after a host play or seek has passed (during the join cooldown only a drift over `INITIAL_SYNC_MAX_DRIFT`, 10 s, seeks); below 2 s, the guest keeps catching up, also when that cooldown ends.

### Paused Rooms

While the room plays, a guest may pause locally without being resumed by periodic state updates or host commands. The client keeps recording the room position while paused; when the guest plays again, the normal sync loop catches up to that position. A paused room sends no unchanged state updates, so the loop pauses a guest whose video plays while the room is paused. It waits while a room command is being applied or a host play is scheduled.

### Manual Nudge (Sync Adjustment)

When the plugin's **Show the sync adjustment button in rooms** setting is on, guests get a sync adjustment drop-down in the room bar (`playback.nudgeState()` and `playback.nudge()` in `playback/sync.js`). It uses the same expected position as `syncLoop`:

```
drift = expected - video.currentTime     (positive = behind the host)
step  = min(NUDGE_STEP_SEC, |drift|, room left in the buffered range)
video.currentTime += sign(drift) * step
```

- **Local only.** Guests never send seeks, so the room state does not change; the next host command or state update applies as usual, and the automatic correction keeps running.
- **No overshoot.** A nudge moves at most to the host's position.
- **In sync below `NUDGE_MIN_DRIFT_SEC`.** Nothing to nudge.
- **HLS segments.** The target stays inside the buffered range around the current position, `NUDGE_BUFFER_MARGIN_SEC` away from its edges, so a nudge never triggers a new segment fetch and the buffering that comes with it. If less than `NUDGE_MIN_MOVE_SEC` is left, the nudge waits.
- **Ignored while a room command is applied.** Nothing happens while `isSyncing`, a scheduled action or a scheduled play is pending, during the initial sync or its cooldown, or while the video is seeking. The same applies when the room is paused, the video is buffering, or the room's media is still loading.

`playback.trackDrift()` runs after `syncLoop` (only when the setting is on) and keeps `outOfSyncSince`, which the drop-down shows next to the current playback rate.

## 5. HLS Handling and Feedback Loop Prevention

### The HLS Problem

HLS (HTTP Live Streaming) is an adaptive streaming protocol that chunks video into segments. This creates problematic behaviors:

1. **False states**: During buffering, `video.paused` may be `true` even without user pause
2. **Unstable position**: `currentTime` may jump or go backward while loading segments
3. **Variable latency**: Each seek triggers new segment loading

### Feedback Loop Scenario

```
                    WITHOUT PROTECTION

Host ──► Server ──► Client
  │                   │
  │  "play @ 10:00"   │
  │                   │
  │            HLS buffering...
  │            video.paused = true (false!)
  │            video.currentTime = 9:58 (behind)
  │                   │
  │◄─ "pause @ 9:58" ─┤  ← ERROR!
  │                   │
Server broadcasts "pause" to all
  │                   │
Everyone stops!
```

### Implemented Solutions

#### A. Sync Lock (`isSyncing`)

```javascript
// When receiving server command
function onServerCommand() {
    isSyncing = true;

    // ... apply command ...

    // Release after 2 seconds
    setTimeout(() => { isSyncing = false; }, 2000);
}

// Before sending to server
function onEvent() {
    if (isSyncing) return;  // Blocked!
    // ...
}
```

#### B. Buffering Detection

```javascript
// Track video events
video.addEventListener('waiting', () => { isBuffering = true; });
video.addEventListener('canplay', () => { isBuffering = false; });
video.addEventListener('playing', () => { isBuffering = false; });

// Filtering
function onPauseEvent() {
    if (isBuffering) return;  // False pause, ignore
    // ...
}
```

#### C. ReadyState Check

```javascript
function isVideoReady() {
    return video.readyState >= 3;  // HAVE_FUTURE_DATA
}

function sendStateUpdate() {
    if (!isVideoReady()) return;  // Not enough data
    // ...
}
```

#### D. Seeking Check

```javascript
function onEvent() {
    if (video.seeking) return;  // Currently seeking
    // ...
}
```

### Server-Side Protection

#### Cooldown After Command

```rust
const COMMAND_COOLDOWN_MS: u64 = 2000;

// After broadcasting player_event
room.last_command_ts = now_ms();

// On receiving state_update
if now_ms() - room.last_command_ts < COMMAND_COOLDOWN_MS {
    return;  // Ignore during cooldown
}
```

#### Position Jitter Filtering

```rust
const POSITION_JITTER_THRESHOLD: f64 = 0.5;

let pos_diff = new_pos - room.state.position;

// Small backward jump = HLS noise
if pos_diff < -0.5 && pos_diff > -2.0 {
    return;  // Ignore
}

// Micro-advance = insignificant
if pos_diff >= 0.0 && pos_diff < 0.5 {
    return;  // Ignore
}
```

## 6. Ready/Pending Play Mechanism

### Problem
When a new participant joins, they must load the media before they can play. If the host clicks Play before everyone is ready, some will miss the start.

### Solution

```
Host                     Server                   Client B
  │                         │                         │
  │                         │◄── join_room ───────────┤
  │                         │                         │
  │                         │  B not in ready_clients │
  │                         │                         │
  ├── player_event: play ──►│                         │
  │                         │                         │
  │                    all_ready() = false            │
  │                         │                         │
  │                    pending_play = {               │
  │                      position: 120,               │
  │                      created_at: now              │
  │                    }                              │
  │                         │                         │
  │                    schedule_timeout(2s)           │
  │                         │                         │
  │                         │◄── ready ───────────────┤
  │                         │                         │
  │                    all_ready() = true             │
  │                    pending_play = None            │
  │                         │                         │
  │◄── player_event: play ─┼── player_event: play ──►│
  │    target_ts = T+1.0s   │   target_ts = T+1.0s    │
  │                         │                         │
  ▼                         │                         ▼
video.play() @ T+1.0s       │              video.play() @ T+1.0s
```

### Safety Timeout

If a client never becomes ready (network issue, etc.), play is forced after 2 seconds:

```rust
fn schedule_pending_play(room_id, created_at, rooms, clients) {
    tokio::spawn(async move {
        sleep(Duration::from_millis(2000)).await;

        if room.pending_play.created_at == created_at {
            // Timeout: force play
            broadcast_scheduled_play(room, clients, position, now + 1000);
            room.pending_play = None;
        }
    });
}
```

## Threshold and Timing Summary

| Parameter | Value | Location | Description |
|-----------|-------|----------|-------------|
| `SUPPRESS_MS` | 2000ms | Client | Anti-feedback lock duration |
| `SEEK_THRESHOLD` | 1.0s | Client | Min difference for seek broadcast |
| `STATE_UPDATE_MS` | 1000ms | Client | State send interval |
| `SYNC_LEAD_MS` | 300ms | Client | Compensation advance |
| `DRIFT_DEADZONE_SEC` | 0.04s | Client | No-correction zone |
| `DRIFT_SOFT_MAX_SEC` | 2.0s | Client | Forced seek threshold |
| `PLAYBACK_RATE_MIN` | 0.90 | Client | Min catchup speed |
| `PLAYBACK_RATE_MAX` | 1.15 | Client | Max catchup speed |
| `DRIFT_GAIN` | 0.15 | Client | Proportional gain (sqrt curve) |
| `INITIAL_SYNC_COOLDOWN_MS` | 8000ms | Client | Cooldown after join (no HARD_SEEK below `INITIAL_SYNC_MAX_DRIFT`; after it, only drifts of 2 s or more seek) |
| `INITIAL_SYNC_MAX_MS` | 30000ms | Client | Max initial sync phase duration |
| `INITIAL_SYNC_DRIFT_THRESHOLD` | 0.5s | Client | Exit initial sync when caught up |
| `SYNC_LOOP_MS` | 500ms | Client | Sync loop interval |
| `NUDGE_STEP_SEC` | 0.5s | Client | Largest manual nudge toward the host |
| `NUDGE_MIN_DRIFT_SEC` | 0.15s | Client | Drift below which there is nothing to nudge |
| `NUDGE_MIN_MOVE_SEC` | 0.05s | Client | Smallest nudge worth a seek |
| `NUDGE_BUFFER_MARGIN_SEC` | 0.1s | Client | Distance kept from the buffered range's edges |
| `PLAY_SCHEDULE_MS` | 1000ms | Server | Delay before play |
| `CONTROL_SCHEDULE_MS` | 300ms | Server | Delay before pause/seek |
| `MAX_READY_WAIT_MS` | 2000ms | Server | Ready timeout |
| `MIN_STATE_UPDATE_INTERVAL_MS` | 500ms | Server | State rate limit |
| `POSITION_JITTER_THRESHOLD` | 0.5s | Server | Position noise threshold |
| `COMMAND_COOLDOWN_MS` | 2000ms | Server | Cooldown after command |
