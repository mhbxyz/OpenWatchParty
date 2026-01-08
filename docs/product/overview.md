# Overview

## What is OpenWatchParty?

OpenWatchParty is a plugin for [Jellyfin](https://jellyfin.org/) that enables synchronized media playback across multiple clients. It allows users to watch movies, TV shows, and other media together in real-time, regardless of their physical location.

## The Problem

Watching media together remotely is challenging:
- Video players drift out of sync over time
- Pausing, seeking, and resuming must be coordinated manually
- Network latency makes coordination difficult
- Different streaming qualities cause timing differences

## The Solution

OpenWatchParty provides:
- **Real-time synchronization** - All participants see the same content at the same time
- **Host-controlled playback** - One person controls play/pause/seek for everyone
- **Automatic drift correction** - Playback speed adjusts to keep clients in sync
- **HLS/transcoding support** - Works with Jellyfin's adaptive streaming

## Target Audience

- **Home media enthusiasts** running their own Jellyfin servers
- **Friend groups** who want to watch together remotely
- **Families** spread across different locations
- **Communities** organizing watch parties

## How It Works

1. **Host creates a room** - Starts a watch party from the Jellyfin player
2. **Guests join** - Enter the room ID to join the session
3. **Synchronized playback** - Everyone sees the same frame at the same time
4. **Continuous sync** - Background algorithms keep everyone aligned

## Key Features

| Feature | Description |
|---------|-------------|
| Room management | Create and join watch party rooms |
| Play/Pause sync | All clients respond to host controls |
| Seek sync | Jumping to a position syncs everyone |
| Drift correction | Gradual speed adjustments prevent desync |
| Auto-reconnect | Handles network interruptions gracefully |
| JWT authentication | Optional security for rooms |

## Comparison with Alternatives

| Feature | OpenWatchParty | SyncPlay | Teleparty |
|---------|---------------|----------|-----------|
| Self-hosted | Yes | Yes | No |
| Jellyfin native | Yes | Yes | No |
| Lightweight | Yes | Moderate | Heavy |
| Browser-based | Yes | No | Yes |
| Open source | Yes | Yes | No |

## Next Steps

- [Features](features.md) - Detailed feature list
- [User Guide](user-guide.md) - How to use OpenWatchParty
- [Installation](../operations/installation.md) - Set up on your server
