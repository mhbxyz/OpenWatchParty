# Landing page recordings

`watch-party-host.mp4` and `watch-party-guest.mp4` are simultaneous captures of
two real Chromium browser contexts, signed in as `testhost` and `testclient1`
on the local Jellyfin 12.1 development stack. The plugin was built from the
current checkout before recording. These are browser recordings of the actual
service, not rendered or generated product mockups.

The host creates a room, the guest joins it, both watch the same film, exchange
chat messages, pause from the guest's browser, and resume from the host's.
The JSON file contains the shared recording duration and action timestamps.
Both silent MP4s use the same recording clock and duration. The JPGs are
fallback posters from the same session.

To capture another take with the local demo stack running and E2E dependencies
installed:

```sh
node e2e/capture-site-demo.js
```

This uses Playwright's browser control, Chrome DevTools screencast frames and
`ffmpeg` to produce the paired H.264 assets. It requires Chromium (by default
`/usr/bin/chromium`; override with `OWP_BROWSER_PATH`). Login occurs before
recording, and the script closes its demo room afterward. Only disposable demo
accounts should be used.

Film: [Wing It!](https://studio.blender.org/films/wing-it/) © Blender Studio,
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The landing page includes the same attribution.

The interactive menus elsewhere on the landing page are HTML/CSS previews of
OpenWatchParty controls and use its existing outline icons. They are separate
from these real recordings.
