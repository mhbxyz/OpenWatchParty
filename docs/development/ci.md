---
title: CI/CD
parent: Development
nav_order: 5
---

# Continuous Integration

OpenWatchParty uses GitHub Actions for continuous integration and security scanning.

## Workflows

### CI Workflow (`ci.yml`)

Runs on every push and pull request to `main` and `dev` branches.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Rust Tests    │     │   .NET Tests    │     │   JS Lint       │
│  (formatting,   │     │  (build, test)  │     │  (syntax check) │
│  clippy, test)  │     │                 │     │                 │
└────────┬────────┘     └─────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Build Server   │
│  (Docker image) │
└─────────────────┘
```

#### Jobs

| Job | Steps | Duration |
|-----|-------|----------|
| **Rust Tests** | Format check, Clippy, Unit tests | ~3 min |
| **.NET Tests** | Build, Unit tests | ~2 min |
| **JavaScript Lint** | Syntax validation | ~30s |
| **Build Server** | Docker multi-stage build | ~5 min |

### Security Workflow (`security.yml`)

Runs on every push/PR and weekly (Monday 00:00 UTC).

| Scan | Tool | Purpose |
|------|------|---------|
| **Cargo Audit** | `cargo-audit` | Rust dependency vulnerabilities (RustSec) |
| **Trivy** | `aquasecurity/trivy` | Container image CVEs |
| **CodeQL** | `github/codeql-action` | JavaScript static analysis |

Results are uploaded to the GitHub Security tab.

### Publish Workflow (`publish.yml`)

Handles Docker image publishing to GHCR and release artifacts.

#### Triggers

| Event | Condition | Tags Generated |
|-------|-----------|----------------|
| Push to `main` | Changes in `src/server/**` | `beta` |
| GitHub Release | Published | `vX.Y.Z`, `vX.Y`, `latest` |

#### Jobs

| Job | Trigger | Description |
|-----|---------|-------------|
| **Build & Push Docker Image** | All | Builds multi-platform image (amd64, arm64) and pushes to GHCR |
| **Build Jellyfin Plugin** | Release only | Builds plugin and creates zip archive |
| **Upload Release Assets** | Release only | Attaches plugin zip to GitHub Release |
| **Update Plugin Manifest** | Release only | Updates `manifest.json` for Jellyfin plugin repository |

#### Plugin Repository

On release, the workflow automatically updates the [Jellyfin plugin repository](https://mhbxyz.github.io/OpenWatchParty/jellyfin-plugin-repo/manifest.json):

1. Downloads the built plugin zip
2. Calculates MD5 checksum
3. Updates `docs/jellyfin-plugin-repo/manifest.json` with new version
4. Commits and pushes to `main`
5. Triggers GitHub Pages deployment

Users can then install/update the plugin directly from Jellyfin's plugin interface.

#### Docker Image

```bash
# Latest stable release
docker pull ghcr.io/mhbxyz/owp-session-server:latest

# Specific version
docker pull ghcr.io/mhbxyz/owp-session-server:v0.2.1

# Development (latest from main)
docker pull ghcr.io/mhbxyz/owp-session-server:beta
```

## Build Configuration

### Rust (Alpine + musl)

The Docker build uses Alpine with musl libc for smaller images:

```dockerfile
FROM rust:1.88-alpine AS builder
RUN apk add --no-cache musl-dev
# ... build with musl target

FROM alpine:3.21
# ~26MB final image
```

**Note:** The repository toolchain is pinned to Rust `1.88.0`. Local development uses glibc (standard Rust). The `.cargo/config.toml` configures the `mold` linker for faster local builds, but this is excluded from Docker builds via `.dockerignore`.

### .NET

The plugin uses NuGet packages from nuget.org:

```xml
<PackageReference Include="Jellyfin.Controller" Version="10.11.3" />
<PackageReference Include="Jellyfin.Model" Version="10.11.3" />
```

CI copies JavaScript files (including subdirectories) to the `Web/` directory before building:

```yaml
- name: Copy JS files to plugin Web directory
  run: |
    mkdir -p OpenWatchParty/Web
    cp -r ../../clients/jellyfin-web/* OpenWatchParty/Web/
```

**Note:** The `cp -r` is required because JS modules are now organized in subdirectories (`utils/`, `ui/`, `playback/`, `chat/`, `ws/`, `app/`). The `justfile` handles this correctly via `client_js_files` variable.

## Troubleshooting

### CI Failures

**Rust formatting:**
```bash
cd src/server && cargo fmt
git add -u && git commit --amend --no-edit
```

**Clippy warnings:**
```bash
cd src/server && cargo clippy -- -D warnings
# Fix warnings or add #[allow(...)] with justification
```

**Docker build fails:**
```bash
# Test locally
docker build -t test ./src/server
```

## Badges

The README includes CI status badges:

```markdown
[![CI](https://img.shields.io/github/actions/workflow/status/mhbxyz/OpenWatchParty/ci.yml?branch=main)](https://github.com/mhbxyz/OpenWatchParty/actions/workflows/ci.yml)
```

| Badge | Meaning |
|-------|---------|
| ![CI passing](https://img.shields.io/badge/CI-passing-brightgreen) | All checks pass |
| ![CI failing](https://img.shields.io/badge/CI-failing-red) | One or more checks failed |

## Security Alerts

View security findings:

1. Go to repository **Security** tab
2. Click **Code scanning alerts** or **Dependabot alerts**
3. Review and address as needed

Current alert policy:
- **CRITICAL/HIGH**: Must fix before release
- **MEDIUM**: Fix in next release
- **LOW/NOTE**: Track, fix when convenient

## Next Steps

- [Setup](setup) - Development environment
- [Contributing](contributing) - Contribution guidelines
- [Testing](testing) - Test documentation
