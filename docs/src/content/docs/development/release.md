---
title: "Release Process"
---

<span id="release-process" class="legacy-anchor"></span>

Releases are versioned from `version.json`. The repository scripts verify the mirrored versions, package the Jellyfin plugin, and validate release inputs. GitHub Actions builds and publishes the server image and release artifacts.

## Prepare a release

1. Update the changelog and documentation, complete the checks in [Testing](/development/testing/), and open a focused release PR.
2. In the release branch, run `just bump X.Y.Z` (for example, `just bump 0.8.0`), inspect the files it changes, and run `infra/scripts/verify-versions.sh`. Commit and merge the version update to `main`.
3. From the merged release commit, create and push the matching annotated tag, such as `v0.8.0`, then publish a GitHub Release for that tag. The `publish.yml` workflow verifies the tag against `version.json`.
4. Wait for the workflow's image build and release assets to finish. Confirm the release is available on GitHub and the versioned image is available in GHCR. Verify the downloaded artifacts as described below before advising users to install or upgrade.
5. Update the production image digest manually, after the image has been published, as described in **Production image pin**. The release workflow does not update `infra/docker/prod/docker-compose.yml`.

For a new version, the release branch update can be prepared with:

```bash
VERSION=0.8.0
git switch -c "release/v$VERSION"
just bump "$VERSION"
infra/scripts/verify-versions.sh
git diff --check
git add -u
git commit -m "Release v$VERSION"
git push -u origin "release/v$VERSION"
```

Open and merge the release PR before tagging the merged commit on `main`:

```bash
git switch main
git pull --ff-only origin main
git tag -a "v$VERSION" -m "Version $VERSION"
git push origin "v$VERSION"
gh release create "v$VERSION" --title "v$VERSION" --notes-file release-notes.md
```

Replace `release-notes.md` with the reviewed notes for that release. Creating a GitHub Release publishes it and triggers the workflow; do not create it until the tagged commit is on `main`.

For example, the source tag `v0.7.0` contains a production Compose file that still referenced `ghcr.io/mhbxyz/owp-session-server:0.6.0@sha256:d4b425ef7915ab2c40a0195c49d02297571806f1987535e6a7360b6b84289ed3`. That stale Compose reference does not describe the published `0.7.0` registry image: its source attestation identifies the correct 0.7 source commit `82f5658`, and the image reports server version 0.7. The bounded 92-byte pong check also passed against that image. Main commit `6f60744` later corrected the production Compose reference to `ghcr.io/mhbxyz/owp-session-server:0.7.0@sha256:8e925305e4fc750ad08c1bf50318ea4fa45996c6130a63486cbaf4a9d4b41c20`. Keep these two facts separate: the release image was correct, while the immutable source tag retained an older Compose pin.

## Automated publication

Publishing a GitHub Release builds a multi-platform (`linux/amd64`, `linux/arm64`) session-server image and pushes version, major/minor, and `latest` tags. The workflow builds the plugin archive and cross-platform `owpctl` binaries, generates SPDX and CycloneDX SBOMs, creates Sigstore signatures and GitHub provenance attestations, verifies them, and attaches the release assets. It also updates the Jellyfin plugin repository manifest on `main` after publication.

Pushes to `main` that change server or image build inputs publish the `beta` image. This development image is separate from a versioned release.

The verified 0.7 release image is available as `ghcr.io/mhbxyz/owp-session-server:0.7.0`; its source attestation identifies commit `82f5658`. The project version tag in Compose and the digest pin must both match the built release image.

## Production image pin

After the release workflow reports a successful image build and the image is available in GHCR, resolve its digest from the workflow output or registry. The current maintainer must update `infra/docker/prod/docker-compose.yml` to pair the release version tag with that exact registry digest, for example:

```yaml
image: ghcr.io/mhbxyz/owp-session-server:0.8.0@sha256:<digest-from-the-successful-release-build>
```

Commit the Compose pin update, then run `infra/scripts/verify-pins.sh` and review the pinned digest against the successful release build. For the 0.7 source after the follow-up update, the reference is `ghcr.io/mhbxyz/owp-session-server:0.7.0@sha256:8e925305e4fc750ad08c1bf50318ea4fa45996c6130a63486cbaf4a9d4b41c20`. Production Compose keeps JWT authentication required (`ALLOW_INSECURE_NO_AUTH=false`); coordinate server and plugin JWT configuration as described in [deployment](/operations/deployment/) and [configuration](/operations/configuration/).

## Artifact verification

The release includes checksum files for the plugin ZIP and `owpctl` binaries, plus Sigstore bundles and provenance files for those artifacts and the session-server image. The image is identified by its registry digest rather than a downloadable checksum file; release SBOMs describe the shipped components. Confirm the GitHub Release and versioned GHCR image are available first, then verify checksums, signatures, and attestations before advising users to upgrade. For example, after installing Cosign and GitHub CLI, download the release assets and confirm they are published:

```bash
gh release view vX.Y.Z --repo mhbxyz/OpenWatchParty
gh release download vX.Y.Z --repo mhbxyz/OpenWatchParty --dir artifacts
(cd artifacts && sha256sum --check OpenWatchParty-vX.Y.Z.zip.sha256)

cosign verify-blob \
  --bundle artifacts/OpenWatchParty-vX.Y.Z.zip.sigstore.json \
  --certificate-identity 'https://github.com/mhbxyz/OpenWatchParty/.github/workflows/publish.yml@refs/tags/vX.Y.Z' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  artifacts/OpenWatchParty-vX.Y.Z.zip
gh attestation verify artifacts/OpenWatchParty-vX.Y.Z.zip \
  --repo mhbxyz/OpenWatchParty \
  --bundle artifacts/OpenWatchParty-vX.Y.Z.zip.provenance.jsonl \
  --cert-identity 'https://github.com/mhbxyz/OpenWatchParty/.github/workflows/publish.yml@refs/tags/vX.Y.Z'
```

Use the exact asset names, release tag and certificate identity from the release. Verify the image too, using the image digest and the release's `owp-session-server.sigstore.json` and `owp-session-server.provenance.jsonl` assets:

```bash
cosign verify \
  --certificate-identity 'https://github.com/mhbxyz/OpenWatchParty/.github/workflows/publish.yml@refs/tags/vX.Y.Z' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mhbxyz/owp-session-server@sha256:<release-digest>
gh attestation verify oci://ghcr.io/mhbxyz/owp-session-server@sha256:<release-digest> \
  --repo mhbxyz/OpenWatchParty \
  --bundle artifacts/owp-session-server.provenance.jsonl \
  --cert-identity 'https://github.com/mhbxyz/OpenWatchParty/.github/workflows/publish.yml@refs/tags/vX.Y.Z'
```

The workflow performs these checks during publication; maintainers should independently verify the published assets and image before announcing availability. Inspect the attached SBOMs if dependency inventory is needed.

## Plugin update readiness

`version.json` controls the packaged `meta.json` field `jellyfinPluginAutoUpdate`. It remains `false` unless the project has agreed on official Jellyfin publication and verified the upgrade path in the [plugin update guide](/operations/plugin-updates/). This local metadata field is separate from the self-hosted `manifest.json`; manual installation and the self-hosted repository remain supported.

Before enabling automatic updates, confirm the official catalog entry uses the same plugin GUID, compatible ABI, correct release URL and checksum, and complete client assets. Then set the flag in a reviewed release commit, package and validate it, and run disposable upgrade and rollback checks. Do not change installed manifests during plugin startup or overwrite an administrator's opt-out.

## Version and packaging checks

`just bump X.Y.Z` updates mirrored product-version values from `version.json`; it does not create a release or update the production image digest. `infra/scripts/verify-versions.sh` checks version mirrors and an optional release tag. `just release` runs workflow-permission, pin, secret-scan, and pre-commit checks before packaging the plugin. `just test release` runs the release-script and contract regression checks. Use `infra/scripts/package-plugin.sh` to build and validate the plugin archive locally; it requires Docker, the pinned SDK container, and `zip`.

The package script uses the repository's pinned .NET SDK 10.0.401 container, targets Jellyfin package version `12.0.0` / ABI `12.0.0.0`, embeds client assets, and writes `dist/OpenWatchParty-vX.Y.Z.zip`. The published workflow also builds `owpctl` for Linux, macOS, and Windows with Rust 1.88.0.

## Release tags and artifacts

The publish workflow creates the GHCR tags `X.Y.Z`, `X.Y`, and `latest` for a release; a `main` push that changes image inputs publishes `beta`. The versioned, digest-pinned Compose reference belongs in the production configuration. The 0.7 production image reference after the follow-up update is `ghcr.io/mhbxyz/owp-session-server:0.7.0@sha256:8e925305e4fc750ad08c1bf50318ea4fa45996c6130a63486cbaf4a9d4b41c20`.

The plugin archive is `dist/OpenWatchParty-vX.Y.Z.zip` when built locally. CI publishes the plugin archive, platform-specific `owpctl` binaries, image/plugin/binary SBOMs, SHA-256 checksums for the plugin and binaries, Cosign signature bundles, and provenance bundles. Use the release download and verification commands above before pointing users to an artifact.

## Hotfix Process

For a critical fix, branch from the currently supported release commit, apply the fix and regression coverage, and increment the patch version through `just bump X.Y.Z`. Merge the reviewed fix/version change to the intended release source commit, then follow the normal tag and publication sequence. Merge the fix back to `main` if the hotfix was prepared on a separate support branch. Update production Compose only after the new image has been published, and verify the new pin.

## Rollback Process

For a production server rollback, restore the last known good version and digest in `infra/docker/prod/docker-compose.yml`, then run `infra/scripts/verify-pins.sh` and deploy that verified configuration. For a plugin rollback, retrieve the previous release archive and verify its checksum, signature, and provenance before installing it. Record the affected release and rollback status in the GitHub Release notes and relevant support issue before advising users.

For user installation and upgrades, see [Installation](/operations/installation/) and [Deployment](/operations/deployment/).
