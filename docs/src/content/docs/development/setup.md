---
title: "Development Setup"
---

<span id="development-setup" class="legacy-anchor"></span>

## Requirements

- Docker Engine with Docker Compose v2
- [Just](https://just.systems/)
- Git, Python 3, `jq`, `curl`, `unzip`, and OpenSSL
- Node.js 20.20.2 for the CI-matched client and end-to-end workflows (the client package also accepts `^20.19.0 || ^22.13.0 || >=24`)

Rust server work uses Rust 1.88.0, pinned in `rust-toolchain.toml` and CI. The Jellyfin plugin builds in the pinned .NET SDK 10.0.401 container; a local .NET installation is not needed. The Astro documentation site uses Node.js 24 in CI (minimum `>=22.23.4`). `mold` is optional and only speeds up local Rust linking.

## Start the development stack

```bash
git clone https://github.com/mhbxyz/OpenWatchParty.git
cd OpenWatchParty
just setup  # install client development dependencies and configure Git hooks
just up     # build and start Jellyfin and the session server
```

`just up` also downloads the pinned development media, installs File Transformation, builds the plugin, initializes Jellyfin, provisions local test users, and checks session-server health. The first media download needs network access and about 176 MB of disk space. See [Testing](/development/testing/) for test commands and [the first watch-party tutorial](/product/first-watch-party/) for a user walkthrough.

### Sample movie library

The development stack downloads *Wing It!* (2023) and *Sprite Fright* (2021)
into the ignored `media/dev/Movies/` directory and creates the **Blender Open
Movies (Dev)** library at `/media/DevMovies`. Pinned sizes and SHA-256 checksums
are verified, and subsequent starts reuse the local copies. Both films are
shared by Blender Studio under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):
[Wing It!](https://studio.blender.org/projects/wing-it/) and
[Sprite Fright](https://studio.blender.org/projects/sprite-fright/). The
separate `MEDIA_DIR` mount remains available for your own library.

Jellyfin is available at `http://localhost:8096`; the server health endpoint is `http://localhost:3000/health` and its WebSocket endpoint is `ws://localhost:3000/ws`.

### Development authentication

The dev Compose file binds both services to loopback. With no `JWT_SECRET`, its default `ALLOW_INSECURE_NO_AUTH=true` starts the session server in unauthenticated local-development mode. For authenticated development and end-to-end runs, set a disposable secret in `.env` and use the same value for the server and plugin:

```bash
printf 'JWT_SECRET=%s\nALLOW_INSECURE_NO_AUTH=false\n' "$(openssl rand -base64 32)" >> .env
just up
```

`just up` configures the dev plugin to match the server mode and waits for the server health check. The three local Jellyfin accounts are `testhost`, `testclient1`, and `testclient2`; their default password is `owp-dev-test`. Override it with `OWP_DEV_PASSWORD` before first provisioning. These are development credentials only. Production Compose forces `ALLOW_INSECURE_NO_AUTH=false`; configure JWT authentication on both the plugin and server before use. See [server configuration](/operations/configuration/) and [deployment](/operations/deployment/).

The automated Jellyfin configuration is stored under ignored `infra/docker/dev/config-auto/`. To recreate it, stop the stack with `just down`, remove only that directory, then run `just up`. Existing user passwords are not changed by provisioning.

#### Development logins

| Username | Password | Purpose |
|---|---|---|
| `testhost` | `owp-dev-test` | Local administrator and host |
| `testclient1` | `owp-dev-test` | First guest |
| `testclient2` | `owp-dev-test` | Second guest |

These credentials are local only. `just up` creates missing accounts but does not change an existing password. If you change `OWP_DEV_PASSWORD` after provisioning, update the accounts in Jellyfin too.

## First-Time Setup

After `just up`, sign in at `http://localhost:8096/web/` as `testhost`, play a sample movie, then open the Watch Party button in the header. Use another browser profile to sign in as `testclient1` and test room creation and joining. The illustrated [first watch-party tutorial](/product/first-watch-party/) covers the host and guest flow.

## Common commands

Use `just` to list all recipes and `just <module>` to list module recipes.

| Command | Purpose |
|---|---|
| `just up`, `just down`, `just status`, `just logs` | Start, stop, inspect, and follow the dev stack |
| `just dev` | Start the stack and follow logs |
| `just watch` | Restart Jellyfin when client JavaScript files change; needs `inotifywait` or `fswatch` |
| `just build plugin`, `just build server`, `just build image`, `just build all` | Build the plugin, local server, server image, or all components |
| `just test` | Run server, plugin, client, `owpctl`, and release-script checks |
| `just lint` | Run Rust/`owpctl` Clippy and client ESLint |
| `just fmt` | Format Rust code |
| `just e2e` | Start the dev stack and run Playwright end-to-end scenarios |
| `just setup` | Install client dependencies and configure Git hooks |
| `just clean` | Remove build artifacts |
| `just shell server`, `just shell jellyfin` | Open a shell in a development container |

The stack mounts the plugin output and client source. Rebuild the relevant artifact after changes; `just rebuild` cleans and builds all components, then recreates the services.

## Repository map

- `src/clients/jellyfin-web/`: JavaScript client, tests, and package manifest
- `src/plugins/jellyfin/`: Jellyfin plugin and .NET tests
- `src/server/`: Rust session server
- `src/owpctl/`: Rust administration CLI
- `infra/just/` and `justfile`: build, test, lint, and development recipes
- `infra/docker/`: development and production Compose files and server Dockerfile
- `docs/`: product, operation, technical, and development documentation

## Development Workflow

### Rebuild after changes

`just up` builds the File Transformation plugin and Jellyfin plugin before starting the stack. For a clean rebuild after changes across multiple components, run:

```bash
just rebuild
```

For a focused plugin or client change, `just build plugin` recopies the client modules and rebuilds the plugin; restart Jellyfin to load the new assembly and assets. `just build server` builds a local release binary, while `just build image` rebuilds the development Docker image. To apply a rebuilt server image, recreate that Compose service:

```bash
docker compose -f infra/docker/dev/docker-compose.yml up -d --force-recreate session-server
```

`just watch` watches client source files and restarts Jellyfin automatically. Otherwise restart Jellyfin and hard-refresh the browser after a client or plugin change. Changes to Rust server source require a rebuilt image and recreated service.

### Hot Reload

For client edits, keep `just watch` running and reload Jellyfin Web when the restart finishes. The watcher uses `inotifywait` or `fswatch`, with a polling fallback. Plugin and server code require rebuilding; `just rebuild` is the simplest reliable path.

## Debugging

Check stack and server health first:

```bash
just status
curl -fsS http://localhost:3000/health
```

Follow logs with `just logs server` or `just logs jellyfin`; Jellyfin's container log is also available with `docker logs jellyfin-dev`. For client errors, open the browser developer console and inspect the failed `OpenWatchParty/ClientScript` request. The plugin configuration page's diagnostics can verify script injection, server reachability, and matching auth configuration.

For Rust diagnostics, run the server tests with `RUST_BACKTRACE=1 just test server` or use `RUST_LOG=debug cargo run --manifest-path src/server/Cargo.toml` for a local server process. Do not start a second local process on port 3000 while the Compose server is running.

## Common Development Issues

### Client script is not updating

Restart Jellyfin or allow `just watch` to do it, then hard-refresh the browser. Check that `http://localhost:8096/OpenWatchParty/ClientScript` responds and inspect the browser network panel for failed module requests.

### Authentication mode mismatch

The dev plugin and session server must use the same `JWT_SECRET` and auth mode. `just up` provisions the plugin configuration from the environment and checks the server health endpoint; inspect `.env` and `just logs server` if startup reports a mismatch. Use the plugin diagnostics after changing configuration.

For deployment and browser-origin failures, see the [Troubleshooting Guide](/operations/troubleshooting/).

## Environment Variables

Create a root `.env` file to customize local development. Common values include:

```dotenv
JWT_SECRET=<disposable-base64-secret>
ALLOW_INSECURE_NO_AUTH=false
ALLOWED_ORIGINS=http://localhost:8096
LOG_LEVEL=debug
OWP_DEV_PASSWORD=<local-test-password>
```

Leave `JWT_SECRET` empty only for loopback-only unauthenticated development. Never reuse a production secret locally. See [server configuration](/operations/configuration/) for all server settings.

See [Contributing](/development/contributing/), [Testing](/development/testing/), and [CI/CD](/development/ci/) for the contribution and validation workflow.

## Work on the project site

The site uses Astro for the product pages and Starlight for guides and developer references. From the repository root:

```bash
cd docs
npm ci
npm run dev
```

Open the printed address with the `/OpenWatchParty/` base path. `npm run build` checks the Astro components, builds the static site and search index, and verifies local links. See [the site README](https://github.com/mhbxyz/OpenWatchParty/blob/main/docs/README.md) for source organization and deployment settings.
