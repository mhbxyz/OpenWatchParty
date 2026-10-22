---
title: "Compatibility Matrix"
---

<span id="compatibility-matrix" class="legacy-anchor"></span>

This page summarizes the compatibility encoded by the repository's canonical version files.

## Official Matrix

| OpenWatchParty | Jellyfin packages | Jellyfin target ABI | Jellyfin image | File Transformation | Status |
|----------------|-------------------|---------------------|-----------------|---------------------|--------|
| `0.7.0` | `12.0.0` | `12.0.0.0` | `12.1` | `3.0.1.0` | Supported |
| `0.3.4` | `10.11.3` | `10.11.0.0` | `10.11.3` | `2.5.3.0` | Supported |

This matrix lists the current recommended plugin release for each Jellyfin line; it is not the complete support policy. The project also supports plugin `0.4.x` on Jellyfin 12 as stated in the [root security policy](https://github.com/mhbxyz/OpenWatchParty/blob/main/SECURITY.md#supported-versions). A release omitted from this recommendation matrix is not thereby unsupported.

## Notes

- OpenWatchParty `0.7.0` is the current release for Jellyfin 12. Its plugin targets ABI `12.0.0.0`; the repository builds and tests against Jellyfin `12.1`. The target ABI is a compatibility declaration, not a guarantee for every Jellyfin 12 release.
- OpenWatchParty `0.3.4` is the current release for the Jellyfin 10.11 line. It targets ABI `10.11.0.0` and is built against packages `10.11.3`.
- The shared manifest contains multiple historical plugin packages. Their presence or matching target ABI does not establish current support for an older release or Jellyfin line; use the current release listed above for that line.
- Development and integration testing use the Jellyfin `12.1` image for the 0.7 line.
- Automatic client injection in 0.7 uses File Transformation `3.0.1.0` (archive ABI `12.0.0`). Native injection is preferred; see [installation](/operations/installation/#client-injection-compatibility-fallbacks) for fallbacks.
- The target ABI is the plugin compatibility declaration; the image version is the environment tested by this repository. WebSocket protocol version `1` is separate from the Jellyfin plugin ABI. Session server and `owpctl` source builds require Rust `1.88` or newer.

## How to Verify Locally

1. Check Jellyfin version in **Dashboard -> Server -> General**.
2. Check installed OpenWatchParty version in **Dashboard -> Plugins -> OpenWatchParty**.
3. Compare against the matrix above.

## Related Files

- Plugin repository manifest: `docs/public/jellyfin-plugin-repo/manifest.json`
- Plugin project references: `src/plugins/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj`
- Build metadata output: `src/plugins/jellyfin/OpenWatchParty/dist/meta.json`
