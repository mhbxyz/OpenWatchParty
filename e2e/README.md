# End-to-end tests

Playwright suite that drives the real Jellyfin Web UI with two browser contexts
(`testhost` and `testclient1`) against the development stack.

## Run

```bash
# Boots the stack (just up) and then runs the suite
just e2e
```

When the stack is already running with the current code, iterate without
rebuilding:

```bash
cd e2e
npm test
```

## Requirements

- The dev stack from `just up` (Jellyfin on `localhost:8096`, session server on
  `localhost:3000`) with the `testhost` / `testclient1` users.
- Google Chrome installed. The suite uses `channel: chrome` so H.264 playback
  works without downloading a Playwright browser.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `OWP_WEB_URL` | `http://localhost:8096/web` | Jellyfin Web base URL |
| `OWP_BROWSER_CHANNEL` | `chrome` | Playwright browser channel |
| `OWP_DEV_PASSWORD` | `owp-dev-test` | Password of the dev users |

## Tests

`watch-party.spec.js`:

- host creates a room and the guest joins from the home card;
- the guest joins from the header button;
- pause, play and seek propagate to the guest;
- a guest cannot press play while the room is paused: the player never
  starts and the guest sees the toast (regression for #52);
- the host leaving closes the room for the guest;
- the guest leaving keeps the room open for the host;
- the guest reconnects and rejoins the room;
- the home card disappears when the host closes the room.

The suite runs serially (one worker) because both contexts share one stack.

## CI

`.github/workflows/e2e.yml` runs `just e2e` on pull requests that touch the
client, server, plugin, stack or this directory. The Playwright report and
traces are uploaded when the job fails.
