---
title: Compatibility Matrix
parent: Operations
nav_order: 2
---

# Compatibility Matrix

This page summarizes the compatibility encoded by the repository's canonical version files.

## Official Matrix

| OpenWatchParty | Jellyfin packages | Jellyfin target ABI | Jellyfin image | File Transformation | Status |
|----------------|-------------------|---------------------|-----------------|---------------------|--------|
| `0.4.0` | `12.0.0` | `12.0.0.0` | `12.0` | `3.0.1.0` | Supported |
| `0.3.3` | `10.11.3` | `10.11.0.0` | `10.11.3` | `2.5.3.0` | Supported |
| `0.3.2` | `10.11.3` | `10.11.0.0` | `10.11.3` | `2.5.3.0` | Supported |
| `0.3.1` | `10.11.3` | `10.11.0.0` | `10.11.3` | `2.5.3.0` | Supported |
| `0.3.0` | `10.11.3` | `10.11.0.0` | `10.11.3` | `2.5.3.0` | Supported |
| `0.2.1` | `10.11.3` | `10.11.0.0` | `10.11.3` | `2.5.3.0` | Supported |
| `0.2.0` | `10.11.3` | `10.11.0.0` | `10.11.3` | `2.5.3.0` | Supported |

## Notes

- OpenWatchParty `0.4.0` targets Jellyfin 12. It is compiled against Jellyfin packages `12.0.0` and declares target ABI `12.0.0.0`.
- OpenWatchParty `0.3.3` remains the last release for the Jellyfin 10.11 line. It is compiled against Jellyfin packages `10.11.3` and declares target ABI `10.11.0.0`.
- Both lines are published from the same plugin repository manifest, so Jellyfin can offer the release that matches its own ABI.
- Development and integration testing use the Jellyfin `12.0` image.
- Automatic client injection uses File Transformation `3.0.1.0` (archive ABI `12.0.0`).
- The target ABI is the plugin compatibility contract; the image version is the environment tested by this repository.

## How to Verify Locally

1. Check Jellyfin version in **Dashboard -> Server -> General**.
2. Check installed OpenWatchParty version in **Dashboard -> Plugins -> OpenWatchParty**.
3. Compare against the matrix above.

## Related Files

- Plugin repository manifest: `docs/jellyfin-plugin-repo/manifest.json`
- Plugin project references: `src/plugins/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj`
- Build metadata output: `src/plugins/jellyfin/OpenWatchParty/dist/meta.json`
