---
title: "Features"
---

<span id="features" class="legacy-anchor"></span>

OpenWatchParty 0.7.0 adds shared playback controls, host recovery, participant status, episode queues and player appearance settings. It runs in Jellyfin Web; it does not add controls to Jellyfin's native mobile or TV apps.

## Rooms and playback

- Create a room from the video player. The host's current media starts the room.
- Join from the Watch Party panel, an invite link, or a Watch Parties home row when available.
- Play and pause are shared by the host and guests. Seeking remains host-only.
- Clients correct playback drift automatically. The host can leave a room open for a compatible participant to take over; a short disconnect gives the same host 10 seconds to reconnect first.
- Hosts can create short-lived, room-specific invite links. The invite ticket does not contain a Jellyfin password, API token, or session token. Invites require configured JWT authentication.
- The room bar shows connection and synchronization state, participant names and (with a compatible session server) participant playback status.

## Series queue

When the room is watching a TV episode, the host's client can fill a shared queue with the current episode and up to five following episodes. The room queue supports up to 20 items. The host can start an upcoming episode, move or remove upcoming items, and use Previous or Next; guests can view the queue. Missing episodes are skipped. A removed item is not restored by a page reload or host change.

Near an episode's outro, or near its end when no outro segment is available, the room shows a 10-second **Up next** countdown. The host can cancel it or advance immediately. Pausing or seeking back before the outro cancels the countdown. This feature requires a session server and clients that support the queue; older clients can still follow a room when it advances.

## Interface and accessibility

- Watch Party is available in the Jellyfin app bar beside SyncPlay and Cast, and in the video player's controls beside Cast. The player control is available while media is playing.
- The slide-out panel lists active rooms and contains the room bar, chat, participant list, queue and invite controls when applicable.
- First-run help appears once per browser and can be reopened from the panel's **?** control.
- Administrators can hide Jellyfin's native SyncPlay control and adjust the room interface's opacity (40 to 100 percent, default 55) and base text size (12 to 18 px, default 14) under **Web Client** in plugin settings. Changes apply after Jellyfin Web reloads. If the operating system requests reduced transparency, the interface stays opaque.
- Controls have accessible names, and the participant, chat, queue and leave sections can be operated with the keyboard. The panel follows the Jellyfin display language; English, Spanish, French and German are included.

## Compatibility

OpenWatchParty **0.7.0** targets Jellyfin ABI **12.0.0.0**. Its plugin package is built against Jellyfin packages **12.0.0**, and the project validates the plugin on Jellyfin **12.1**. The plugin is for Jellyfin 12; use the release and compatibility information for the supported Jellyfin 10.11 line when running that server version.

See the [Compatibility Matrix](/operations/compatibility/) for release-specific details. Client features are negotiated with the session server, so older servers or clients may not show newer controls.

## Security and updates

The Jellyfin plugin and session server are separate components. For 0.7.0, update the session server to 0.7.0 to receive its security fix; updating only the plugin does not fix an older session server. Keep the plugin version compatible with your Jellyfin line. Follow the [installation guide](/operations/installation/) and [security guide](/operations/security/) for upgrade steps.

## Other capabilities

- Real-time WebSocket messaging for playback, room activity and chat
- Clock synchronization and playback drift correction
- Optional JWT authentication, origin validation, bounded messages and rate limiting
- HLS and direct-play media support

See the [User Guide](/product/user-guide/) for the room controls and the [First Watch Party walkthrough](/product/first-watch-party/) for an illustrated two-account example.
