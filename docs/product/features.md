# Features

## Current Features

### Room Management
- **Create rooms** - Start a watch party with a custom name
- **Join rooms** - Enter a room ID to join an existing session
- **Leave rooms** - Exit cleanly with proper cleanup
- **Room list** - See all active rooms on the server
- **Participant count** - Track how many people are watching

### Playback Synchronization
- **Play/Pause sync** - Host controls playback state for all clients
- **Seek sync** - Jumping to a position syncs everyone
- **Position sync** - Continuous updates keep clients aligned
- **Drift correction** - Automatic playback speed adjustment (0.85x-2.0x)
- **HLS support** - Works with Jellyfin's adaptive streaming

### User Interface
- **OSD button** - Watch Party button in the video player controls
- **Slide-out panel** - Room list and controls
- **Home section** - Watch parties shown on Jellyfin homepage
- **Toast notifications** - Join/leave notifications
- **Connection status** - Online/offline indicator

### Networking
- **WebSocket communication** - Low-latency real-time sync
- **Auto-reconnect** - Automatic reconnection on disconnect
- **Clock synchronization** - NTP-like time sync between clients
- **Rate limiting** - Protection against abuse (10 tokens/min)

### Security
- **JWT authentication** - Optional token-based auth
- **Configurable secret** - Admin-controlled JWT signing key
- **CORS protection** - Origin validation (configurable)
- **Message size limits** - 64KB max message size

## Compatibility

### Jellyfin Versions
| Version | Status |
|---------|--------|
| 10.9.x | Supported |
| 10.8.x | Supported |
| 10.7.x | Not tested |

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

1. **Host-only control** - Only the host can control playback
2. **No chat** - Text chat not yet implemented
3. **Single media** - One media item per room
4. **No persistence** - Rooms are lost on server restart
5. **No mobile apps** - Only works in web browser

## Roadmap

### Planned Features

| Feature | Priority | Status |
|---------|----------|--------|
| Text chat | High | Planned |
| Persistent rooms | Medium | Planned |
| Democratic mode | Medium | Planned |
| Shared playlists | Low | Planned |
| Mobile UI improvements | Low | Planned |

### Future Considerations

- **Chat system** - Integrated text chat in the panel
- **Permissions** - Granular control (host-only vs democratic)
- **Shared playlists** - Queue management for multiple items
- **Better mobile support** - Responsive UI for mobile apps
- **Plugin repository** - Publish to official Jellyfin repository

## Version History

See the [CHANGELOG](../../CHANGELOG.md) for release notes.
