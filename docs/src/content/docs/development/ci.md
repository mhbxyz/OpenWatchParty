---
title: "Continuous Integration and Delivery"
---

<span id="continuous-integration-and-delivery" class="legacy-anchor"></span>

GitHub Actions validates code, audits dependencies and builds release artifacts. The workflow definitions under `.github/workflows/` are authoritative for triggers, tool versions, and pinned actions.

## CI (`ci.yml`)

Runs on pushes and pull requests targeting `main` or `dev`.

| Job | Checks |
|---|---|
| Rust Tests | Rust `1.88.0` formatting, locked Clippy and tests for the session server and `owpctl` |
| .NET Tests | .NET SDK 10.0.401 locked restore, build, and tests; verifies locked restore rejects dependency drift |
| JavaScript Lint & Tests | Node 20.20.2 install, recursive ESLint, syntax check, and client unit tests |
| Release Script Tests | shellcheck, workflow lint and repository release/script/contract regression checks |

## Security (`security.yml`)

Runs on pushes and pull requests to `main` or `dev`, and weekly on Monday at 00:00 UTC. It runs Gitleaks, Cargo Audit for both Rust lockfiles, NuGet and npm audits, a separate npm audit for the Astro site dependencies, Trivy on a release-mode server image, and JavaScript CodeQL analysis. Critical and high Trivy findings fail the scan when not ignored as unfixed.

## End-to-end and server hardening

`e2e.yml` runs on pull requests that touch the client, server, plugin, dev stack, or end-to-end suite, and supports manual dispatch. It creates a temporary JWT secret, starts the development stack in authenticated mode, and runs Playwright with Chrome. Failed runs upload Playwright reports and print session-server diagnostics. These results describe the checked-out development source, not a deployed release.

`server-hardening.yml` runs on pushes and pull requests to `main` or `dev`, weekly, and manually. It fuzzes the real WebSocket ingress with a 30-second campaign on regular runs and a 300-second weekly campaign, replays the committed corpus, and runs a bounded 10-room load smoke against a disposable server. Campaigns have explicit time/resource bounds; they do not prove that defects, leaks, excessive RSS, or OOM conditions are absent or occur in production.

## Publish (`publish.yml`)

Changes to server/image build inputs on `main` publish a `beta` image. Publishing a GitHub Release verifies version mirrors and the tag, scans the release image, and publishes the multi-platform versioned server image. The release workflow signs and attests the server image, Jellyfin plugin archive, and cross-platform `owpctl` binaries; it generates SBOMs and checksums, verifies the outputs, attaches them to the release, and updates the self-hosted plugin manifest on `main`.

For OpenWatchParty `0.7.0`, the source release tag is `v0.7.0`; CI documents its release image marker as `owp-session-server:v0.7.0`. The publish workflow removes the leading `v` for the GHCR semver tag, so the published image reference is `ghcr.io/mhbxyz/owp-session-server:0.7.0`; its source attestation identifies the correct 0.7 source commit `82f5658`. The plugin targets Jellyfin package `Version="12.0.0"` and ABI `12.0.0.0`, resolved from the version properties in `Directory.Build.props`.

After the release image has been published, the current maintainer must update the production Compose image to the new digest and run `infra/scripts/verify-pins.sh`. The publish workflow does not update production Compose. The production pin is a follow-up to image publication because the digest is only known after the build completes. Follow [the release process](/development/release/) for the sequence and verification details.

## Run checks locally

```bash
just fmt
just lint
just test
just e2e
```

`just test` includes Rust server, plugin, client, `owpctl`, and release-script checks. `just e2e` starts and provisions the development stack before running Playwright. See [Testing](/development/testing/) for prerequisites and authentication settings.

## Troubleshooting

- Rust formatting: run `just fmt`, then check with `cargo fmt --check` from the affected Rust crate.
- Clippy errors: run `just lint server` and address the warning before retrying CI.
- JavaScript failures: from `src/clients/jellyfin-web`, run `npm ci`, `npm run lint`, `npm run check:syntax`, and `npm test`.
- Plugin build or test failures: run `just test plugin`; it uses the pinned .NET 10.0.401 SDK container and locked restore.
- Docker image build failures: run `just build image`, then inspect the output from `just logs server` after recreating the service.
- Workflow validation failures: install both `actionlint` and `shellcheck`, or use Docker as described in [Contributing](/development/contributing/).

The security workflow fails on the configured critical/high vulnerability findings. Review the source and dependency path, then update the affected dependency or document why a finding is not applicable before merging.

The project-site build uses Node.js 24 and locked npm dependencies in `docs/`. `npm run build` runs Astro diagnostics, creates the static site and search index, and checks generated links, headings, existing public routes and required assets. The deployment workflow publishes `docs/dist/` to GitHub Pages.
