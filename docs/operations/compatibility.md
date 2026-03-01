---
title: Compatibility Matrix
parent: Operations
nav_order: 2
---

# Compatibility Matrix

This page is the source of truth for OpenWatchParty compatibility across Jellyfin and plugin versions.

## Official Matrix

| OpenWatchParty plugin | Distribution channel | Jellyfin target ABI | Jellyfin versions | Status |
|-----------------------|----------------------|---------------------|-------------------|--------|
| `0.1.0` | Plugin repository release | `10.10.0.0` | `10.10.x` | Supported |
| `0.1.0` | Plugin repository release | `10.10.0.0` | `10.11.x` | Not officially supported |
| `1.0.0` (current branch build) | Built from source | `10.11.3.0` | `10.11.x` | Supported for self-hosted builds |

## Notes

- The currently published repository version is `0.1.0` and targets Jellyfin ABI `10.10.0.0`.
- The current source branch builds a plugin targeting Jellyfin ABI `10.11.3.0`.
- If your Jellyfin server is `10.11.x`, prefer a source build until a `10.11`-targeted release is published in the plugin repository.

## How to Verify Locally

1. Check Jellyfin version in **Dashboard -> Server -> General**.
2. Check installed OpenWatchParty version in **Dashboard -> Plugins -> OpenWatchParty**.
3. Compare against the matrix above.

## Related Files

- Plugin repository manifest: `docs/jellyfin-plugin-repo/manifest.json`
- Plugin project references: `src/plugins/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj`
- Build metadata output: `src/plugins/jellyfin/OpenWatchParty/dist/meta.json`
