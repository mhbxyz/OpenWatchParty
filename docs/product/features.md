---
title: Features
parent: Getting Started
nav_order: 2
---

# Features

## Current Features

### Room Management
- **Create rooms** - Start a watch party with a custom name
- **Join rooms** - Enter a room ID to join an existing session
- **Leave rooms** - Exit cleanly with proper cleanup
- **Room list** - See all active rooms on the server
- **Participant count** - Track how many people are watching
- **Invite links** - Hosts copy a short-lived link (`?owp_invite=<ticket>`); opening it joins the room automatically. The ticket is room-scoped, expires, and stops working when the room closes

### Playback Synchronization
- **Play/Pause sync** - Anyone in the room can pause or resume it for everyone
- **Seek sync** - Jumping to a position syncs everyone
- **Position sync** - Continuous updates keep clients aligned
- **Drift correction** - Automatic playback speed adjustment (0.90x-1.15x)
- **HLS support** - Works with Jellyfin's adaptive streaming

### User Interface
- **OSD button** - Watch Party button in the video player controls
- **Header button** - Watch Party button in both Jellyfin 12 headers (MUI and legacy), on the pages that show the header (the player keeps its OSD button); joining from it starts the room's media
- **Hide native SyncPlay** - Optional admin setting that hides Jellyfin's SyncPlay button
- **Slide-out panel** - Room list and controls; opened from the header, it hangs from the button like a speech bubble
- **First-run help** - The panel opens by itself once per browser, with a short help that its **?** button brings back
- **Home section** - Watch parties shown on Jellyfin homepage
- **System notifications** - Centered toasts for play/pause, join/leave events
- **Chat notifications** - Stacking toasts for incoming messages (top-right)
- **Sync indicator** - Visual status showing sync state (synced/syncing/waiting)
- **Connection status** - Online/offline indicator

### Chat
- **Text chat** - Real-time messaging within watch party rooms
- **Username display** - Shows sender's Jellyfin username
- **Timestamps** - Message timestamps for context
- **Unread badge** - Notification when new messages arrive
- **XSS protection** - Messages are escaped to prevent injection

### Networking
- **WebSocket communication** - Low-latency real-time sync
- **Auto-reconnect** - Automatic reconnection on disconnect
- **Clock synchronization** - NTP-like time sync between clients
- **Rate limiting** - Protection against abuse (30 tokens/min)

### Security
- **JWT authentication** - Optional token-based auth
- **Configurable secret** - Admin-controlled JWT signing key
- **CORS protection** - Origin validation (configurable)
- **Message size limits** - 64KB max message size
- **Expiring invite tickets** - Invite links never carry the Jellyfin API token or session JWT; tickets are host-only, room-scoped, rate limited and rejected after the room closes

## Compatibility

### Jellyfin Versions
| Version | Status |
|---------|--------|
| 12.0 / 12.1 | Validated package (`12.0.0`, ABI `12.0.0.0`) and image (`12.1`) for OpenWatchParty `0.5.0` |
| ABI 12.0.0.0 | Plugin compatibility target |
| 10.11.3 / ABI 10.11.0.0 | Last supported by OpenWatchParty `0.3.4` |
| Others | See compatibility matrix |

Full details: [Compatibility Matrix](../operations/compatibility.md)

### Browsers

| Browser | Version | Status | Notes |
|---------|---------|--------|-------|
| Chrome/Chromium | 80+ | Fully supported | Recommended for best experience |
| Firefox | 75+ | Fully supported | |
| Edge | 80+ | Fully supported | Chromium-based versions |
| Safari | 14+ | Supported | See known issues below |
| Safari (iOS) | 14+ | Partial | See mobile limitations |
| Chrome (Android) | 80+ | Partial | See mobile limitations |
| Firefox (Android) | 79+ | Partial | See mobile limitations |

#### Safari Known Issues

Safari uses its native HLS implementation which behaves differently:

- **Buffering state reporting** - Safari may report incorrect `readyState` during HLS segment loading, causing brief sync hiccups
- **Playback rate limits** - Safari may clamp playback rates more aggressively than other browsers
- **Background tab throttling** - Aggressive throttling can affect sync when tab is not focused

**Workarounds:**
- Keep the Safari tab in focus during watch parties
- If sync issues persist, try leaving and rejoining the room

#### Mobile Browser Limitations

Mobile browsers have reduced functionality due to platform restrictions:

| Feature | Desktop | Mobile |
|---------|---------|--------|
| Background playback | Yes | Limited (OS may pause) |
| Playback rate adjustment | Full range | May be restricted |
| Auto-play | Yes | Requires user interaction |
| Picture-in-picture sync | Yes | Not supported |

**Mobile-specific notes:**
- **iOS Safari** - Auto-play restrictions require tapping play after joining
- **Android Chrome** - Background tabs may be suspended by the OS
- **Data saver modes** - May interfere with WebSocket connections

### Media Types
| Type | Status |
|------|--------|
| Movies | Supported |
| TV Episodes | Supported |
| HLS streams | Supported |
| Direct play | Supported |
| Live TV | Not supported |

## Known Limitations

1. **Host-only seeking** - Only the host can seek; play and pause are shared
2. **Single media** - One media item per room (by design)
3. **Ephemeral rooms** - Rooms are closed when the host leaves or server restarts (by design)
4. **Web only** - Only works in web browsers (no native mobile/TV apps planned)
5. **No message history** - Chat messages are not persisted; late joiners won't see previous messages
6. **Invite links need authentication** - With insecure development mode (`ALLOW_INSECURE_NO_AUTH`), there is no shared secret to sign tickets, so the Invite button reports an error

## Roadmap

### Planned Features

| Feature | Priority | Status |
|---------|----------|--------|
| Text chat | High | Done |
| Message history for late joiners | Medium | Planned |
| Democratic mode | Medium | Planned |
| Automatic host transfer | Medium | Planned |
| Room passwords | Low | Planned |

### Feature Descriptions

- **Message history for late joiners** - Send last N messages to clients joining a room
- **Democratic mode** - Allow all participants to control playback, not just the host
- **Automatic host transfer** - When host disconnects, transfer control to another participant instead of closing the room
- **Room passwords** - Optional password protection for private rooms

### Long-term Goals

- **Official Jellyfin plugin repository** - Publish to the [official Jellyfin plugin repository](https://jellyfin.org/docs/general/server/plugins/#official-plugins) for native discoverability and installation
