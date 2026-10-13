# End-to-end tests

Playwright suite that drives the real Jellyfin Web UI with separate browser
contexts (`testhost`, `testclient1` and `testclient2`) against the development
stack, including a second tab sharing the host's browser context.

## Run

```bash
# Use one disposable key for both the plugin and session server. Host recovery
# requires JWT authentication; the lifecycle tests fail clearly in insecure mode.
JWT_SECRET="$(openssl rand -base64 32)"
export JWT_SECRET
export ALLOW_INSECURE_NO_AUTH=false
# Boots and provisions the stack (just up) and then runs the suite
just e2e
```

When the stack is already running with the current code, iterate without
rebuilding:

```bash
cd e2e
npm test
```

## Requirements

- The JWT-authenticated dev stack from `just up` (Jellyfin on `localhost:8096`,
  session server on `localhost:3000`) with all three documented dev users.
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
- a guest pause pauses the host, and the host play resumes the guest;
- a guest play resumes the paused room;
- the host choosing Close for everyone closes the room for the guest;
- the guest leaving keeps the room open for the host;
- the guest reconnects and rejoins the room;
- the home card disappears when the host closes the room.

`room-lifecycle.spec.js`:

- an authenticated host reconnects within the real 10-second recovery window,
  retains the room and role under a new connection ID, and still controls playback;
- recovery expiry promotes the first eligible guest; the returning former host
  rejoins as a guest, and the new host's controls reach both followers;
- the host's separate Leave action transfers the room without closing it or
  waiting for the recovery window;
- a third participant leaves while the host has a second tab open under the same
  login; closing that non-member tab preserves the original room and host;
- one guest leaves while another loses transport, leaving the original host alone
  in the same room.

The suite uses one worker because the scenarios share one stack. Lifecycle
scenarios use fresh browser contexts and close the current host's room during
cleanup. They inspect received membership/host events and wait for observable
state, without changing the server's recovery duration. Transport faults use a
real socket close; reconnect is disabled only when testing expiry and re-enabled
through the client's public connect action afterward. These scenarios do not
simulate packet loss, every possible departure ordering, or browser timer
throttling.

`waitForSettled` requires listeners bound to the active video as well as the end
of initial-sync/suppression, so control tests cannot click before events are bound.

## CI

`.github/workflows/e2e.yml` runs `just e2e` on pull requests that touch the
client, server, plugin, stack or this directory. The job creates an ephemeral JWT
key and starts both components in authenticated mode. When the job fails, it
uploads the Playwright report and traces and prints the session server
container's status and last 200 log lines.
