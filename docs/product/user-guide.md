# User Guide

## Getting Started

Before using OpenWatchParty, ensure your Jellyfin administrator has:
1. Installed the OpenWatchParty plugin
2. Started the session server
3. Enabled the client script in Jellyfin settings

## Creating a Watch Party

1. **Start playing a video** - Open any movie or TV episode in Jellyfin
2. **Find the Watch Party button** - Look for the group icon in the top header bar (right side)
3. **Click to open the panel** - A slide-out panel appears
4. **Enter a room name** - Give your party a descriptive name
5. **Click "Start Room"** - You are now the host

As the host, you control playback for everyone. When you play, pause, or seek, all participants follow.

## Joining a Watch Party

### From the Player
1. **Open any video** - The same video the host is watching
2. **Click the Watch Party button** - Opens the panel
3. **Find the room** - Rooms appear in the list with participant counts
4. **Click "Join"** - You'll automatically sync to the host's position

### From the Homepage

The Jellyfin homepage displays active watch parties in a dedicated "Watch Parties" section, making it easy to discover and join ongoing sessions.

**How it works:**

1. **Go to Jellyfin home** - Active watch parties appear in a dedicated section below your media libraries
2. **Browse party cards** - Each card shows:
   - Media cover image (movie poster or episode thumbnail)
   - Room name (set by the host)
   - Participant count (e.g., "2 watching")
   - Play button overlay for quick join
3. **Join options:**
   - **Click the card** - Navigates to the video player and joins the room
   - **Click the play button** - Starts playback immediately and auto-joins

**What happens when you click:**

1. The correct media automatically loads in the video player
2. You join the watch party room
3. Your playback syncs to the host's current position
4. You'll see a brief catch-up period as your video aligns with others

**Notes:**
- The Watch Parties section only appears when there are active rooms
- Cards refresh automatically every 5 seconds
- If a room closes while you're viewing the homepage, the card disappears
- You must be logged into Jellyfin to see and join watch parties

## Host Controls

As the host, your actions control everyone:

| Action | Effect |
|--------|--------|
| Play | All clients start playing |
| Pause | All clients pause |
| Seek | All clients jump to that position |
| Close panel | Room stays active |
| Leave room | Room closes, all participants disconnected |

## Participant Experience

As a participant:

| What Happens | What You See |
|--------------|--------------|
| Host plays | Video starts automatically |
| Host pauses | Video pauses automatically |
| Host seeks | Video jumps to new position |
| Host leaves | "Room closed" notification |
| Drift detected | Playback speed adjusts (0.85x-2.0x) to catch up |

## The Panel Interface

### Lobby View (Not in a room)
- **Room list** - Active watch parties with names and participant counts
- **Create room** - Input for room name and "Start Room" button
- **Connection status** - Online/Offline indicator

### In-Room View
- **Room name** - Current watch party name
- **Participants** - Number of people watching
- **RTT** - Round-trip time to server (latency indicator)
- **Leave button** - Exit the watch party

## Tips for Best Experience

### For Hosts
- **Wait for everyone** - Check participant count before starting
- **Announce pauses** - Use external chat to communicate
- **Avoid rapid seeking** - Give clients time to sync

### For Participants
- **Same media** - Make sure you're watching the same title
- **Stable connection** - WiFi or wired connection recommended
- **Let it sync** - Wait a few seconds after joining before judging sync

### Network Considerations
- **Port 3000** - Session server default port must be accessible
- **WebSocket support** - Some firewalls block WebSocket connections
- **HTTPS** - Use WSS (secure WebSocket) in production

## Troubleshooting

### "Watch Party button not visible"
- Ensure the client script is enabled in Jellyfin Dashboard > General > Custom HTML
- Try refreshing the page (Ctrl+F5)

### "Cannot connect to server"
- Check that the session server is running
- Verify the WebSocket URL is correct
- Check firewall rules for port 3000

### "Out of sync with others"
- This is normal for a few seconds after joining
- If persistent, try leaving and rejoining the room
- Check your network connection quality

### "Room closed unexpectedly"
- The host left or disconnected
- Server may have restarted
- Create a new room to continue

For more troubleshooting, see [Troubleshooting Guide](../operations/troubleshooting.md).
