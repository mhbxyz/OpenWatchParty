---
title: "Testing Guide"
---

<span id="testing-guide" class="legacy-anchor"></span>

## Run the project checks

From the repository root:

```bash
just test       # server, plugin, client, owpctl, and release-script checks
just lint       # Rust/owpctl Clippy and client ESLint
just fmt        # format Rust code
just e2e        # start the dev stack and run Playwright
```

`just test` runs locked Cargo tests for the session server and `owpctl`, .NET tests using the pinned .NET 10 SDK container, JavaScript unit tests, and release-script/contract checks. The JavaScript checks can also be run from `src/clients/jellyfin-web` with `npm ci`, `npm run lint`, `npm run check:syntax`, and `npm test`. The plugin suite can be run through `just test plugin`.

### Run one test suite or case

```bash
just test server
just test plugin
just test client
just test owpctl

# Run one Rust server test with output
cd src/server
cargo test --locked test_name -- --nocapture
```

The Rust toolchain is pinned to 1.88.0. Run Cargo commands from the relevant crate directory so the repository toolchain file is applied.

## End-to-end tests

The Playwright suite drives the development stack with separate browser contexts for `testhost`, `testclient1`, and `testclient2`, plus a second tab in the host's browser context. It covers room creation and joining, shared playback controls, host recovery and transfer, guest departure, reconnection, and room-card updates. These are development-stack test results; they do not establish the behavior of an already deployed release.

The server's dev Compose default is unauthenticated. The end-to-end suite requires authenticated host recovery, so use one disposable JWT key for the plugin and server:

```bash
export JWT_SECRET="$(openssl rand -base64 32)"
export ALLOW_INSECURE_NO_AUTH=false
just e2e
```

The CI workflow creates an ephemeral key and uses the same authenticated development setup. For iteration against an already running stack built from current source, run `npm ci && npm test` in `e2e/`. The suite uses installed Google Chrome by default so H.264 playback is available; see [`e2e/README.md`](https://github.com/mhbxyz/OpenWatchParty/blob/main/e2e/README.md) for environment variables and scenario limits.

## Manual Testing

Start the development environment with `just up`, then sign in as `testhost` and `testclient1` in separate browser profiles. See [Development logins](/development/setup/#development-logins) for local credentials.

| Scenario | Expected behavior |
|---|---|
| Create and join a room | Host starts a room; guest joins from the room list, home card, or invite link. |
| Shared playback | Play, pause, and seek changes reach the other room members. |
| Guest departure | Guest leaves; the room remains open for the host and other guests. |
| Host recovery | Authenticated host reconnects during the recovery window and retains host role. |
| Host Leave | Host uses Leave to transfer the room; use Close for everyone to end the room. |
| Client refresh | Reload the Jellyfin page and confirm injection, session connection, and room state recover as expected. |

These are manual checks against the development stack. The automated E2E scenarios cover additional lifecycle orderings and report their limits in [`e2e/README.md`](https://github.com/mhbxyz/OpenWatchParty/blob/main/e2e/README.md).

## Fuzz and load workflows

The `Server Hardening` workflow runs a bounded inbound WebSocket fuzz campaign on pushes and pull requests, with a longer weekly campaign. It replays the committed corpus and runs a disposable load smoke scenario. These jobs exercise test builds under stated time and resource limits; they do not prove the absence of defects or establish production RSS, memory exhaustion, or OOM behavior. See the [fuzzing guide](https://github.com/mhbxyz/OpenWatchParty/blob/main/src/server/fuzz/README.md) for local reproduction.

## Test Data

`just up` creates the development movie library with *Wing It!* and *Sprite Fright* and provisions `testhost`, `testclient1`, and `testclient2`. Use short media clips when checking playback synchronization; the development suite uses the bundled sample films. See [Development Setup](/development/setup/#sample-movie-library) for media provenance and credentials.

## Debugging Test Failures

- Check server and Jellyfin logs with `just logs server` and `just logs jellyfin`.
- Run server tests with `RUST_BACKTRACE=1 just test server` to get Rust backtraces.
- Check the browser console and network panel for failed client module or WebSocket requests.
- Confirm both sides use the same JWT secret and authentication mode for authenticated development tests.

## Writing New Tests

Rust server tests are generally colocated with modules under `src/server/src/`; the `owpctl` CLI has integration tests under `src/owpctl/tests/`. Plugin tests live in `src/plugins/jellyfin/OpenWatchParty.Tests/`, client tests in `src/clients/jellyfin-web/tests/`, and Playwright scenarios in `e2e/`. Add a focused regression case with behavior changes and run the relevant `just test` module.

## CI

GitHub Actions runs Rust and `owpctl` formatting, Clippy, and locked tests; .NET restore/build/tests; JavaScript lint, syntax, and unit tests; and release-script checks. The `E2E` workflow runs on relevant pull requests and manually. See [CI/CD](/development/ci/) for workflow triggers and security checks.
