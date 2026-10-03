---
title: First Watch Party (Illustrated)
parent: Getting Started
nav_order: 3
---

# Your First Watch Party: Illustrated Walkthrough

This walkthrough takes you from a working Jellyfin server to a room with two
people watching together. Follow **one** setup path, then continue with the
shared host-and-guest steps. The screenshots show Jellyfin 12.1 and
OpenWatchParty 0.4.0; labels may vary with your language or version.

## Choose a setup path

| Your situation | Start here |
| --- | --- |
| I want to try it on this computer | [Local development demo](#path-a-local-demo) |
| I already run Jellyfin | [Install into existing Jellyfin](#path-b-existing-jellyfin) |

In both cases, use **two different Jellyfin accounts in separate browser
profiles or devices**. Two tabs sharing one browser profile are still one user.

## Path A: local demo

You need Docker, Docker Compose, `just`, Node.js 20+, Python 3, `jq`, `curl`
and `unzip`. Allow about 176 MB for the films plus space for Docker images
and build caches. In a terminal:

```bash
git clone https://github.com/mhbxyz/OpenWatchParty.git
cd OpenWatchParty
just setup
just up
just status
```

**Expected result:** Jellyfin is healthy at `http://localhost:8096/web/`, the
session server is healthy on port 3000, and the **Blender Open Movies (Dev)**
library contains *Wing It!* and *Sprite Fright*. The first run downloads the
movies; later runs reuse them. Open Jellyfin in one profile as `testhost` and
in another as `testclient1`, both with the development-only password
`owp-dev-test`. No Jellyfin setup wizard or manual library creation is needed.

> The development stack binds both ports to `127.0.0.1`. It is for testing on
> this computer, not for inviting people over the internet. Continue at
> [Host: create a room](#host-create-a-room).

## Path B: existing Jellyfin

You need an administrator account on a compatible Jellyfin server, Docker and
Docker Compose on the machine that will run the session server, and a movie accessible to both
participants. Check the [compatibility matrix]({{ '/operations/compatibility/' | relative_url }})
before installing. The guided installer takes care of the plugin and session
server; do not run `just up` against your existing Jellyfin.

### 1. Download the installer and create a temporary API key

Download and verify `owpctl` using the commands in
[Guided Setup and owpctl]({{ '/operations/owpctl/#download' | relative_url }}). Log into Jellyfin
as an administrator and open **Dashboard → Advanced → API Keys → New API Key**.
Give the key a name such as `OpenWatchParty setup`. Copy it for the next step;
remove the key from Jellyfin after setup and diagnostics. The documented
installer download is for Linux x86_64; for another host platform, use the
[manual installation alternatives]({{ '/operations/installation/#manual-installation' | relative_url }}).

![Jellyfin Dashboard API Keys page, with the New API Key button marked 1]({{ '/assets/images/tutorial-api-keys.png' | relative_url }})

**1** — Create the temporary key here. Do not put its value into a screenshot,
documentation file or terminal command history.

### 2. Preview the graphical installation

Run `owpctl setup --web` on the machine running Docker. This uses your user's
configuration directory; the user needs permission to run Docker. For a
system-wide installation, use `sudo owpctl --scope system setup --web` and
open the one-time URL printed in the terminal yourself if the browser does not
open. The assistant binds only to `127.0.0.1` and expires after 30 minutes.

![OpenWatchParty setup form with Jellyfin URL, temporary API token, Preview plan and Install marked 2 through 5]({{ '/assets/images/tutorial-setup-form.png' | relative_url }})

**2** — Enter the Jellyfin address reachable **from the installer's machine**.
For a local-only test this can be `http://localhost:8096`; if guests will use
`https://jellyfin.example.com`, make that address reachable before running
the assistant (the Jellyfin proxy site below is one option), then enter the
public HTTPS address here so the installer's allowed browser origin matches.
**3** — Paste the temporary API key.
**4** — Select **Preview plan** and read the operations. **5** — Select
**Install** only when the URL and plan are correct. Keep the terminal open
until installation and checks complete.

![Dry-run preview listing the plugin, authentication, session-server and verification operations, marked 6]({{ '/assets/images/tutorial-setup-preview.png' | relative_url }})

**6** — The preview lists the plugin update, synchronized authentication,
session-server image and health checks. This capture was made in an isolated
dry run; its `/tmp/` config path is not an installation instruction.

### 3. Verify the installation

In Jellyfin, open **Dashboard → Plugins → OpenWatchParty** and run diagnostics.
The plugin, client injection and session server should all report **Ready**.
If a check is blocked, follow the [installation guide]({{ '/operations/installation/#verification' | relative_url }})
and [troubleshooting guide]({{ '/operations/troubleshooting/' | relative_url }}) before inviting
anyone. Keep the temporary key until any remote-network configuration below
is complete; then delete it from Jellyfin.

![OpenWatchParty plugin configuration showing Ready status, authentication enabled and session-server settings]({{ '/assets/images/plugin-configuration.png' | relative_url }})

The screenshot shows a working setup, not values to copy: its private
WebSocket address belongs to a particular deployment. On another device, the
configured WebSocket URL must be reachable **from that device's browser**.

### 4. If your guest is on another network

The installer defaults to a session server bound to `127.0.0.1:3000` on its
machine. A guest's browser cannot connect to **your** `localhost`. Publish
the WebSocket securely before following the guest steps. Here is one complete
example with Caddy running on the same host as Jellyfin and the session
server. It assumes Jellyfin is reachable there on `127.0.0.1:8096`.

1. Point DNS for `jellyfin.example.com` and `party.example.com` to your
   server. Open inbound TCP 80 and 443 for Caddy, and install Caddy on the
   host. The `jellyfin.example.com` site must be working **before** you use
   its HTTPS URL in the assistant above; the `party.example.com` site becomes
   useful once the session server is installed. Keep port 3000 bound only to
   `127.0.0.1`.
2. Add these site blocks to your Caddyfile (adapt hostnames and Jellyfin's
   local port):

   ```caddyfile
   jellyfin.example.com {
       reverse_proxy 127.0.0.1:8096
   }

   party.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Caddy obtains TLS certificates and proxies WebSocket upgrades. Reload it
   after validating the configuration. The proxy must run on the host, or
   the upstream addresses must be adjusted to its container network.
3. In **Dashboard → Plugins → OpenWatchParty**, set **Session Server URL** to
   `wss://party.example.com/ws`. The session server's `ALLOWED_ORIGINS` must
   contain `https://jellyfin.example.com`; this is why the public Jellyfin
   address must be used in the installer above when guests are remote. Keep
   the same authentication configuration on both sides. If `owpctl` manages
   this installation, set the public URL with
   `owpctl configure --set session.public-url=wss://party.example.com/ws --api-token-file /path/to/temporary-token-file`
   (include `--scope system` if installed system-wide). This updates its
   managed plugin configuration; the token file must be readable only by you.
4. From **the guest's network**, confirm
   `https://jellyfin.example.com/web/` loads and
   `https://party.example.com/health` returns JSON with `"status":"ok"`.
   Reload Jellyfin Web and check that the Watch Party panel says **Online**.

Only the two HTTPS hostnames need to be public. The Jellyfin and session
server ports remain local to the host. See [Deployment]({{ '/operations/deployment/' | relative_url }})
for containerized proxies and other topologies.

## Host: create a room

As the host, play **the same movie** your guest can access. For the local
demo, choose *Wing It!* from **Blender Open Movies (Dev)**. Pause while
your guest gets ready. Reveal the player controls (move the pointer over the
video), then select the **Watch Party** groups icon near the right end of the
control bar.

![Jellyfin player showing the Watch Party button circled at the right end of the controls]({{ '/assets/images/tutorial-player-button.png' | relative_url }})

**1** — This is OpenWatchParty's player button, not Jellyfin's separate
**SyncPlay** button in the normal header. OpenWatchParty also adds a Watch
Party button to the header, just before SyncPlay; it opens the same panel.

Check that the panel says **Online**, then select **Create Room**. It will
show `Room de <your username>` and **Online: 1**. Keep the movie open.

![OpenWatchParty lobby in the player showing Online and the Create Room button marked 2]({{ '/assets/images/tutorial-lobby.png' | relative_url }})

**2** — An empty room list before creation is normal. If you see **Offline**,
check the [connection troubleshooting]({{ '/operations/troubleshooting/#cannot-connect-to-session-server' | relative_url }}).

## Guest: find and join the room

In a **second browser profile or device**, sign in with a different Jellyfin
account. On the home page, the **Watch Parties** row shows the host's room and
movie while the room is active.

![Guest's Jellyfin home page showing a Wing It! watch-party card for Room de testhost, marked 3]({{ '/assets/images/tutorial-guest-home.png' | relative_url }})

**3** — The card's movie title and host name let you confirm you picked the
right room. If the row is absent, reload the page and check that the host is
still in the room.

Open the card, then start **the same movie** in the player. The card opens
the movie details; it does not join by itself. The play overlay may start
playback and attempt an automatic join, but you can always use the manual
path: select **Watch Party** in the player, find `Room de <host>` under
**Available Rooms**, and select **Join**.

![Guest's OpenWatchParty panel showing the host's room and its Join button marked 4]({{ '/assets/images/tutorial-guest-join.png' | relative_url }})

**4** — Select **Join** for the correct host. You can leave and rejoin while
the host keeps the movie and room open.

Look for **Online: 2** in the room and **In sync** on the guest side. Initial
catch-up may take a few seconds. Ask the host to resume playback, pause and
seek once; the guest should follow. Chat is available in the panel. The
host's **Close** button ends the room for everyone; the guest's **Leave**
button exits only their participation.

![Real participant panel showing Online 2, In sync and Leave, with the sync indicator marked 5]({{ '/assets/images/tutorial-guest-sync.png' | relative_url }})

**5** — The green **In sync** state is the confirmation on the guest side.

**Done:** two distinct accounts see the same room and movie, and the guest
follows the host. If the guest can play the movie but cannot join, compare the
movie on both sides and check the [user guide]({{ '/product/user-guide/' | relative_url }}) and
[troubleshooting guide]({{ '/operations/troubleshooting/' | relative_url }}).
