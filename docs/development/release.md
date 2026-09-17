---
title: Release
parent: Development
nav_order: 4
---

# Release Process

## Versioning

OpenWatchParty uses [Semantic Versioning](https://semver.org/):

```
MAJOR.MINOR.PATCH
```

- **MAJOR**: Breaking changes
- **MINOR**: New features (backwards compatible)
- **PATCH**: Bug fixes (backwards compatible)

### Automated bump

Run `just bump 0.5.0` (or `infra/scripts/bump-version.sh 0.5.0`) to rewrite every mirror of the product version from `version.json` in one shot, adding `--dry-run` to preview the files that would change without writing them. Finish with `infra/scripts/verify-versions.sh`, which fails if any mirror still disagrees.

## Release Checklist

### Pre-Release

- [ ] All tests pass
- [ ] Documentation updated
- [ ] CHANGELOG updated
- [ ] Version numbers updated
- [ ] Manual testing completed

### Version Locations

Update version in:

1. **Rust (`Cargo.toml`)**:
   ```toml
   [package]
   version = "0.2.0"
   ```

2. **C# Plugin (`.csproj`)**:
   ```xml
   <Version>0.2.0</Version>
   ```

3. **Plugin metadata (`Plugin.cs`)** if applicable

### CHANGELOG Format

```markdown
# Changelog

## [0.2.0] - 2024-01-15

### Added
- New feature description

### Changed
- Change description

### Fixed
- Bug fix description

### Security
- Security fix description

## [0.1.0] - 2024-01-01

Initial release.
```

## Build Process

### Build All Components

```bash
just build
```

### Build Individually

```bash
# Rust session server
cd src/server
cargo build --release

# C# plugin
cd src/plugins/jellyfin/OpenWatchParty
dotnet build -c Release
```

### Build Artifacts

| Component | Output Location |
|-----------|-----------------|
| Session Server | `src/server/target/release/session-server` |
| Plugin DLL | `src/plugins/jellyfin/OpenWatchParty/bin/Release/net9.0/OpenWatchParty.dll` |

## Release Steps

### 1. Create Release Branch

```bash
git checkout main
git pull origin main
git checkout -b release/v0.2.0
```

### 2. Update Versions

Update all version numbers as listed above.

### 3. Update CHANGELOG

### 4. Commit Changes

```bash
git add -A
git commit -m "Release v0.2.0"
```

### 5. Create Tag

```bash
git tag -a v0.2.0 -m "Version 0.2.0"
```

### 6. Push Release

```bash
git push origin release/v0.2.0
git push origin v0.2.0
```

### 7. Create GitHub Release

Using the GitHub CLI (recommended):

```bash
gh release create v0.2.0 --title "v0.2.0"
```

Or via GitHub UI:

1. Go to GitHub > Releases > New Release
2. Select tag `v0.2.0`
3. Title: `v0.2.0`
4. Description: Copy from CHANGELOG
5. Click **Publish release**

The workflow will automatically:
- Build and push Docker images to GHCR
- Build and attach the Jellyfin plugin zip

### 8. Merge to Main

```bash
git checkout main
git merge release/v0.2.0
git push origin main
```

### 9. Clean Up

```bash
git branch -d release/v0.2.0
```

## Docker Images

Docker images are automatically built and pushed to GitHub Container Registry (GHCR).

### Available Tags

| Tag | Description | Updated |
|-----|-------------|---------|
| `latest` | Latest stable release | On release |
| `vX.Y.Z` | Specific version (e.g., `v0.1.0`) | On release |
| `vX.Y` | Minor version (e.g., `v0.1`) | On release |
| `beta` | Latest development build | On push to main |

### Pull Images

```bash
# Latest stable
docker pull ghcr.io/mhbxyz/owp-session-server:latest

# Specific version
docker pull ghcr.io/mhbxyz/owp-session-server:v0.1.0

# Development
docker pull ghcr.io/mhbxyz/owp-session-server:beta
```

### Build Locally (optional)

```bash
docker build -t owp-session-server:local ./src/server
```

## Automated Releases

Releases are fully automated via GitHub Actions (`.github/workflows/publish.yml`).

### What Happens on Release

When you create a GitHub Release:

1. **Docker Image**: Built for amd64 and arm64, pushed to GHCR with version + `latest` tags
2. **Jellyfin Plugin**: Built, zipped, and attached to the release
3. **Plugin Repository**: `manifest.json` updated with new version and deployed to GitHub Pages

### What Happens on Push to Main

When server code changes (`src/server/**`) are pushed to `main`:

1. **Docker Image**: Built and pushed with `beta` tag
2. Allows testers to always have the latest development version

### Plugin Distribution

Users can install the plugin in two ways:

#### Via Jellyfin UI (Recommended)

1. Go to Dashboard > Plugins > Repositories
2. Add: `https://mhbxyz.github.io/OpenWatchParty/jellyfin-plugin-repo/manifest.json`
3. Go to Catalog > Find "OpenWatchParty" > Install
4. Restart Jellyfin

#### Via Direct Download

1. Go to [Releases](https://github.com/mhbxyz/OpenWatchParty/releases)
2. Download `OpenWatchParty-vX.Y.Z.zip`
3. Extract to Jellyfin plugins folder
4. Restart Jellyfin

## Hotfix Process

For critical bug fixes:

1. Branch from the release tag:
   ```bash
   git checkout -b hotfix/v0.2.1 v0.2.0
   ```

2. Apply fix and commit

3. Update patch version

4. Follow normal release process with new tag `v0.2.1`

5. Merge fix back to main:
   ```bash
   git checkout main
   git merge hotfix/v0.2.1
   ```

## Deprecation Policy

- Announce deprecations in release notes
- Maintain for at least one minor version
- Provide migration guide when removing features

## Rollback Process

If a release has critical issues:

1. **Immediate**: Advise users to use previous version
2. **GitHub**: Mark release as pre-release or delete
3. **Fix**: Create hotfix release
4. **Communicate**: Update issue/discussion with status

## Release Communication

### Channels

- GitHub Releases (primary)
- GitHub Discussions (announcements)
- Jellyfin forums (if applicable)

### Template

```markdown
## What's New

Brief summary of changes.

## Highlights

- Feature 1
- Feature 2

## Breaking Changes

List any breaking changes and migration steps.

## Installation

See [Installation Guide](docs/operations/installation.md).

## Upgrading

See [Upgrade Procedure](docs/operations/deployment.md#upgrade-procedure).

## Changelog

```

## Next Steps

- [Contributing](contributing.md) - How to contribute
- [Testing](testing.md) - Testing before release
- [Deployment](../operations/deployment.md) - Production deployment
