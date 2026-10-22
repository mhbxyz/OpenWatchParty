---
title: "Overview"
---

<span id="overview" class="legacy-anchor"></span>

OpenWatchParty is a Jellyfin plugin for watching the same movie or TV episode together in Jellyfin Web. The room host controls seeking; every participant can play or pause for the whole room. Clients use clock synchronization and drift correction to keep playback aligned.

## How a watch party works

1. The host starts a video and creates a room from the Watch Party panel.
2. Guests sign in to the same Jellyfin server and join from the room list or a host's invite link.
3. The room coordinates playback while each person's Jellyfin client streams the media.
4. The host can leave the room open for a compatible participant to take over, or close it for everyone.

Each participant needs an account on the Jellyfin server and access to the media being watched. OpenWatchParty supports direct play and HLS streams; each client receives video according to its Jellyfin playback and network conditions.

## What you can do

- Create and join rooms, see who's watching and chat in real time.
- Share play and pause control while keeping seek control with the host.
- Invite guests with an expiring, room-specific link.
- Watch a series with a shared episode queue and synchronized up-next countdown.
- Check participant playback status, recover the host role after a short reconnect, and optionally adjust your own sync as a guest.

See [Features](/product/features/) for current capabilities, the [User Guide](/product/user-guide/) for controls, or the [illustrated walkthrough](/product/first-watch-party/) to try a two-account session.
