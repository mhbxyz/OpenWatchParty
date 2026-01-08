# Release Process

## Versioning

OpenWatchParty uses [Semantic Versioning](https://semver.org/):

```
MAJOR.MINOR.PATCH
```

- **MAJOR**: Breaking changes
- **MINOR**: New features (backwards compatible)
- **PATCH**: Bug fixes (backwards compatible)

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
make build
```

### Build Individually

```bash
# Rust session server
cd session-server-rust
cargo build --release

# C# plugin
cd plugins/jellyfin/OpenWatchParty
dotnet build -c Release
```

### Build Artifacts

| Component | Output Location |
|-----------|-----------------|
| Session Server | `session-server-rust/target/release/session-server` |
| Plugin DLL | `plugins/jellyfin/OpenWatchParty/bin/Release/net9.0/OpenWatchParty.dll` |

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

Add release notes to CHANGELOG.md.

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

1. Go to GitHub > Releases > New Release
2. Select tag `v0.2.0`
3. Title: `v0.2.0`
4. Description: Copy from CHANGELOG
5. Attach binaries:
   - `OpenWatchParty.dll`
   - `session-server` (Linux binary)
   - `session-server.exe` (Windows binary, if available)
6. Publish release

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

### Build Images

```bash
# Session server
docker build -t openwatchparty-session-server:0.2.0 ./session-server-rust

# Tag as latest
docker tag openwatchparty-session-server:0.2.0 openwatchparty-session-server:latest
```

### Push to Registry (if using)

```bash
docker push registry.example.com/openwatchparty-session-server:0.2.0
docker push registry.example.com/openwatchparty-session-server:latest
```

## Automated Releases (Planned)

### GitHub Actions Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Build
        run: cargo build --release
        working-directory: session-server-rust

      - name: Upload artifact
        uses: actions/upload-artifact@v3
        with:
          name: session-server-linux
          path: session-server-rust/target/release/session-server

  build-plugin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-dotnet@v3
        with:
          dotnet-version: '9.0'

      - name: Build
        run: dotnet build -c Release
        working-directory: plugins/jellyfin/OpenWatchParty

      - name: Upload artifact
        uses: actions/upload-artifact@v3
        with:
          name: plugin
          path: plugins/jellyfin/OpenWatchParty/bin/Release/net9.0/OpenWatchParty.dll

  release:
    needs: [build-rust, build-plugin]
    runs-on: ubuntu-latest
    steps:
      - name: Download artifacts
        uses: actions/download-artifact@v3

      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            session-server-linux/session-server
            plugin/OpenWatchParty.dll
```

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

Full changelog in CHANGELOG.md.
```

## Next Steps

- [Contributing](contributing.md) - How to contribute
- [Testing](testing.md) - Testing before release
- [Deployment](../operations/deployment.md) - Production deployment
