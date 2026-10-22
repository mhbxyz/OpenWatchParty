---
title: "Frequently Asked Questions"
---

<span id="frequently-asked-questions" class="legacy-anchor"></span>

## General

### What is OpenWatchParty?
OpenWatchParty is a Jellyfin plugin that lets multiple users watch the same video in sync. When the host plays, pauses, or seeks, everyone follows automatically.

### Is it free?
Yes, OpenWatchParty is open source and free to use.

### Does it work with Plex or Emby?
No, OpenWatchParty is designed specifically for Jellyfin. It uses Jellyfin's plugin API and web interface.

### Do all participants need Jellyfin accounts?
Yes, everyone needs access to the same Jellyfin server and the media library.

## Setup

### Why do I need a separate session server?
The session server handles real-time WebSocket communication between clients. Jellyfin's plugin architecture doesn't support WebSocket endpoints, so a separate lightweight server is needed.

### Can I run everything on one machine?
Yes, you can run Jellyfin and the session server on the same machine. They use different ports (8096 for Jellyfin, 3000 for session server by default).

### Is Docker required?
No, but it's recommended. You can build and run the Rust session server manually if preferred.

### Do I need to add a script tag manually?
No in the supported Jellyfin environment. OpenWatchParty includes native client injection. File Transformation and Custom HTML remain compatibility fallbacks for unusual Jellyfin Web deployments.

## Usage

### Who controls playback?
The host controls seeking. Play and pause are shared: a guest can pause or resume playback for everyone, including the host.

### Can participants control playback?
Play and pause, yes: a guest's pause pauses the whole room, the host included, and anyone's play resumes everyone. Seeking stays with the host.

### What happens if the host leaves or disconnects?
On a compatible session server, another participant using a compatible client can become host when the host leaves. If the host briefly disconnects, the server holds the host role for 10 seconds so the same signed-in user can reconnect. If no compatible participant can take over, the room closes. The host can also choose **Close for everyone**.

### Can I chat with other viewers?
Yes! A text chat is available from the chat icon in the room bar. Messages are sent to all room participants in real time via the session server.

### Does everyone need the same video quality?
No. Each client transcodes independently based on their connection and device. Sync is based on playback position, not video quality.

## Sync Quality

### How does synchronization work?
The clients synchronize their clocks and compare playback position. Small drift is corrected gradually; larger differences may trigger a seek. Network delay, buffering and browser behavior affect how closely playback stays aligned, so there is no fixed accuracy guarantee.

### Why do I see slight speed changes?
OpenWatchParty temporarily adjusts playback speed to correct drift. The allowed adjustment range is 0.90x to 1.15x; the client may seek when drift is too large to correct this way.

### Can a guest adjust synchronization manually?
If the administrator enables **Show the sync adjustment button in rooms**, guests can move their own video up to half a second toward the host. It does not affect anyone else's playback or allow guests to seek the room.

### Does buffering affect sync?
Yes. A buffering client may fall behind while its video loads; the participant list can show its status when the session server supports participant status.

### Does OpenWatchParty queue TV episodes?
Yes. For an episode, the host's client can fill the room queue with up to five following episodes. The room queue holds up to 20 items, including the current one. The host controls the queue and can cancel the 10-second up-next countdown. Queue controls require compatible client and session-server versions.

## Technical

### What ports are used?
Jellyfin commonly uses port **8096** and the session server commonly uses port **3000**, but deployments can configure different ports or use reverse proxies. Remote participants' browsers must be able to reach the configured WebSocket endpoint.

### What protocol is used?
WebSocket with JSON messages. See the [Protocol Documentation](/technical/protocol/) for details.

### Is the connection encrypted?
Use HTTPS for Jellyfin Web and WSS (WebSocket Secure) for the session server when serving the service remotely. See the [Security Guide](/operations/security/).

### How is authentication handled?
The plugin issues signed session tokens after Jellyfin authentication. Production installations require a configured JWT secret; the unauthenticated mode is for isolated development only. Invite links also require JWT authentication. See the [Security Guide](/operations/security/).

### Does updating the Jellyfin plugin update the session server?
No. They are separate components. OpenWatchParty 0.7.0 includes a session-server security fix, so update the session server to 0.7.0 as well as keeping the plugin compatible with your Jellyfin version. See [Plugin Updates](/operations/plugin-updates/).

## Troubleshooting

### The Watch Party button doesn't appear
1. Check that the plugin is installed (Dashboard > Plugins)
2. Open the OpenWatchParty plugin dashboard and verify client injection
3. Hard refresh the page (Ctrl+F5)

See [Troubleshooting Guide](/operations/troubleshooting/#watch-party-button-not-visible) for detailed solutions.

### I can't connect to the session server
1. Ensure the session server is running
2. For remote guests, check that the reverse proxy routes `/ws` to the session server
3. Verify the WebSocket URL is correct

See [Troubleshooting Guide](/operations/troubleshooting/#cannot-connect-to-session-server) for detailed solutions.

### We're out of sync
1. Wait a few seconds - sync corrects automatically
2. If persistent, have the host pause and play again
3. Check network quality (high latency = worse sync)

See [Troubleshooting Guide](/operations/troubleshooting/#sync-issues) for detailed solutions.

### The room keeps closing
1. Check if the host is having connection issues
2. Verify the session server is stable

See [Troubleshooting Guide](/operations/troubleshooting/#room-closes-unexpectedly) for detailed solutions.

## Support

### Where can I report bugs?
Open an issue on the [GitHub repository](https://github.com/mhbxyz/OpenWatchParty/issues).

### How can I contribute?
See the [Contributing Guide](/development/contributing/) for how to submit pull requests.

### Where can I get help?
- [GitHub Issues](https://github.com/mhbxyz/OpenWatchParty/issues/new/choose) for bugs, feature requests, and questions
- Jellyfin community forums
