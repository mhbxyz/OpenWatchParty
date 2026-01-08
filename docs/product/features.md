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
- **Drift correction** - Automatic playback speed adjustment (0.95x-1.05x)
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
| Browser | Status |
|---------|--------|
| Chrome/Chromium | Supported |
| Firefox | Supported |
| Safari | Supported |
| Edge | Supported |
| Mobile browsers | Partial |

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
