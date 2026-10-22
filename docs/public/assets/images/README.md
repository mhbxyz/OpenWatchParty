# Product screenshot provenance

The Jellyfin UI captures in this directory were taken with Playwright in
Microsoft Edge, with Jellyfin in English, against an isolated Jellyfin
**12.1.0** demo with the OpenWatchParty plugin **0.7.0.0** and the published
session server image **0.7.0**. The setup wizard captures show the published
`owpctl` **0.7.0** dry-run preview targeting a local Jellyfin demo; they were
saved through Orca's browser with
`orca-ide screenshot --page <browser-page-id> --json`, and cropped. The queue, up-next,
host transfer, host role, participant status and chat closeup images are
crops of captured UI at twice the page scale, to keep the controls readable.
The numbered markers on the player button and API keys captures were drawn
over the real page before the capture. There are no generated or simulated
interface images here.

| Image | UI shown |
| --- | --- |
| `tutorial-first-run.png` | First-use Watch Party panel and help |
| `tutorial-player-button.png` | Jellyfin player header and Watch Party button |
| `tutorial-lobby.png` | Online room list and Create Room control |
| `tutorial-guest-home.png`, `watch-parties-home.png` | Guest home and active host room card, with the card's Join button shown |
| `tutorial-guest-join.png` | Guest room join flow |
| `tutorial-guest-sync.png`, `watch-party-panel.png`, `watch-party-sync.png` | Room participant list, host badge and sync status |
| `watch-party-panel-closeup.png` | Room bar and chat, with a message from each account |
| `watch-party-queue.png` | Current and automatically queued episodes |
| `watch-party-up-next.png` | Real up-next countdown with Cancel and Next controls above the live queue |
| `watch-party-host-transfer.png` | Host leave confirmation naming the eligible next host |
| `watch-party-host-role.png` | Participant list after the real host transfer, with the promoted account marked Host |
| `plugin-diagnostics.png` | Plugin settings after **Run diagnostics**, with the plugin, client injection and session server ready |
| `plugin-configuration.png` | Web Client controls, guest sync adjustment enabled, and room appearance sliders |
| `tutorial-setup-form.png` | Actual 0.7.0 setup form with the local demo URL and blank API token; captured before Preview |
| `tutorial-setup-preview.png` | Actual 0.7.0 dry-run plan for the local Jellyfin demo; Install was not selected |
| `tutorial-api-keys.png` | Jellyfin 12.1 API Keys page with the New API Key button marked |

In the demo, Jellyfin shares the session server's network namespace, so
`localhost:3000` reaches the session server both from the browser and from
the plugin's server-side diagnostics.

The optional guest sync adjustment was enabled through Jellyfin's plugin
configuration API for the admin capture only. It is off by default, so the
room captures do not show its button. The admin screenshot documents that
setting, not a verified guest-side manual adjustment. Guest-side manual
adjustment and host reconnect have no separate capture. The up-next
screenshot shows seven seconds remaining in the normal ten-second countdown.

Screenshots use harmless demo room and account names. The setup preview's
temporary API token field is blank. The plugin's JWT field is masked in the
admin captures, and no secret was captured or included in these images.

## Media credits

Movie frames are from [Wing It!](https://studio.blender.org/films/wing-it/)
and [Sprite Fright](https://studio.blender.org/films/sprite-fright/) by
Blender Studio, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The demo's **Blender Shorts** series groups these open movies for illustrating
the episode queue; it is not an official episodic release.
