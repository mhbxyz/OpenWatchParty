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

## Pre-commit Hooks

Local hooks mirror CI checks to catch issues before push.

### Setup

```bash
# Install pre-commit
pip install pre-commit

# Install hooks
make setup
# or: pre-commit install
```

### Hooks Overview

| Hook | Stage | Language | Check |
|------|-------|----------|-------|
| `cargo-fmt` | commit | Rust | Code formatting |
| `cargo-clippy` | commit | Rust | Linting |
| `cargo-test` | push | Rust | Unit tests |
| `dotnet-build` | commit | C# | Compilation |
| `dotnet-test` | push | C# | Unit tests |
| `js-syntax` | commit | JavaScript | Syntax validation |
| `trailing-whitespace` | commit | All | Whitespace cleanup |
| `end-of-file-fixer` | commit | All | EOF newline |
| `check-yaml` | commit | YAML | Syntax |
| `check-json` | commit | JSON | Syntax |
| `detect-private-key` | commit | All | Secret detection |
| `hadolint` | commit | Dockerfile | Best practices |

### Running Manually

```bash
# All hooks on staged files
pre-commit run

# All hooks on all files
pre-commit run --all-files

# Specific hook
pre-commit run cargo-fmt --all-files

# Skip hooks (emergency only)
git commit --no-verify
```

## Build Configuration

### Rust (Alpine + musl)

The Docker build uses Alpine with musl libc for smaller images:

```dockerfile
FROM rust:1.83-alpine AS builder
RUN apk add --no-cache musl-dev
# ... build with musl target

FROM alpine:3.21
# ~26MB final image
```

**Note:** Local development uses glibc (standard Rust). The `.cargo/config.toml` configures the `mold` linker for faster local builds, but this is excluded from Docker builds via `.dockerignore`.

### .NET

The plugin uses NuGet packages from nuget.org:

```xml
<PackageReference Include="Jellyfin.Controller" Version="10.11.5" />
<PackageReference Include="Jellyfin.Model" Version="10.11.5" />
```

CI copies JavaScript files to the `Web/` directory before building:

```yaml
- name: Copy JS files to plugin Web directory
  run: |
    mkdir -p OpenWatchParty/Web
    cp ../../clients/web-plugin/*.js OpenWatchParty/Web/
```

## Troubleshooting

### CI Failures

**Rust formatting:**
```bash
cd server && cargo fmt
git add -u && git commit --amend --no-edit
```

**Clippy warnings:**
```bash
cd server && cargo clippy -- -D warnings
# Fix warnings or add #[allow(...)] with justification
```

**Docker build fails:**
```bash
# Test locally
docker build -t test ./server
```

### Pre-commit Failures

**Hook not running:**
```bash
# Reinstall hooks
pre-commit install --install-hooks
```

**Outdated hooks:**
```bash
pre-commit autoupdate
```

**Skip specific hook:**
```bash
SKIP=cargo-test git commit -m "WIP"
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
