---
title: "Plugin Updates and Rollback"
---

<span id="plugin-updates-and-rollback" class="legacy-anchor"></span>

OpenWatchParty's release metadata currently keeps automatic plugin updates
disabled. Official listing is still pending; the
[self-hosted repository](/operations/installation/#1-install-the-jellyfin-plugin)
and manual ZIP installation remain available.

The session-server update is separate from the Jellyfin plugin update. Version
`0.7.0` fixes [GHSA-fjpr-3g28-27r9](https://github.com/mhbxyz/OpenWatchParty/security/advisories/GHSA-fjpr-3g28-27r9), which affects session-server versions `>=0.1.0,<0.7.0`. Upgrade the server image to `0.7.0` or newer even if you must keep an older plugin compatible with Jellyfin 10.11; updating only the plugin does not fix the server. The WebSocket protocol remains version `1`.

## How Jellyfin Finds Updates

Jellyfin compares an installed plugin's GUID/version/ABI with versions in its
configured repositories. `autoUpdate` belongs to the installed plugin's
`meta.json`; it is **not** a catalog `manifest.json` property. Jellyfin 12.2
[skips automatic updates for a local opt-out](https://github.com/jellyfin/jellyfin/blob/v12.2/Emby.Server.Implementations/Updates/InstallationManager.cs)
and [preserves packaged local metadata during installation](https://github.com/jellyfin/jellyfin/blob/v12.2/Emby.Server.Implementations/Plugins/PluginManager.cs).

After the project enables the release flag, new packages can participate in
Jellyfin's scheduled plugin-update task. A plugin update still needs a Jellyfin
restart to load the new assembly. The session-server container is a separate
component and is not updated by Jellyfin; check the compatibility matrix before
changing either component.

Older/manual/preview installations with `autoUpdate: false` do not become
automatic just because a later release sets it to true. Keep previews opted
out. For an administrator who chooses to opt in, stop Jellyfin, back up the
plugin folder and configuration, and change only the `autoUpdate` boolean in
the installed OpenWatchParty `meta.json` to `true`, then restart. Alternatively,
explicitly install a stable package whose metadata enables updates. Do not
change the GUID, version or ABI to trick the updater into accepting a package.

## Verify an Update on a Disposable Instance

Before enabling the release flag, test an isolated Jellyfin instance with its
own configuration/plugins, empty media library and a test repository. Never
use production credentials or its configuration volume for this check.

1. Install an older compatible **stable** OpenWatchParty package. Confirm its
   version in Dashboard > Plugins and record the injected
   `/OpenWatchParty/ClientScript?v=<hash>` URL. Save a copy of its plugin folder
   and `plugins/configurations/OpenWatchPartyPlugin.xml` (use the actual
   configuration filename shown on that instance).
2. With the old local manifest opted out, configure a test catalog containing
   a newer compatible version with the same GUID and the exact ZIP checksum.
   Run Jellyfin's scheduled plugin-update task and confirm nothing is updated.
3. Explicitly enable the old package's local auto-update flag on this test
   instance, restart, and run the scheduled plugin-update task. Confirm the
   new package is installed and Jellyfin requests a restart. Check that the
   newly packaged metadata carries the intended update policy.
4. Restart Jellyfin. Confirm the new plugin loads and its configuration is
   preserved. When the bundled client content changed, confirm the injected
   `ClientScript?v=` hash changed and the current loader/modules are served.
   The hash follows content, so a version-only bump need not change it.
5. Restore the old package/configuration using the rollback steps below and
   confirm the old version/hash loads again.

For the final official-publication check, repeat with the **actual** official
repository and released packages. A test catalog proves update behavior; it
does not prove that Jellyfin has accepted or published the plugin.

## Roll Back

1. Stop Jellyfin and keep a backup of the current OpenWatchParty plugin folder
   and configuration. Use the plugin folder reported by your installation;
   paths vary between Docker and native installs.
2. Move the newer OpenWatchParty version directory out of the scanned plugins
   folder into a backup directory. Restore the saved older plugin directory
   with its original `meta.json` and complete assembly/dependency files.
3. Keep or restore a configuration known to work with that version. Set the
   restored plugin's local `autoUpdate` to `false` so the scheduled task does
   not immediately reinstall the newer package.
4. Restart Jellyfin and check the plugin version and client hash. Verify a
   room can be created/joined against a compatible session-server version.

Do not restore an old assembly over a running process, leave a newer version
active alongside the rollback, or remove unrelated plugins. Keep the normal
[manual install instructions](/operations/installation/#manual-installation)
and release checksums available as a recovery path.

For a downloaded plugin ZIP, fetch its `.sha256` file from the same release
and verify it before extracting. Release workflows also publish Sigstore
bundles, build attestations and SBOMs; verify these when your deployment
process requires provenance checks. For the session server, pin the version
and OCI digest shown in the current [deployment example](/operations/deployment/#docker-compose-deployment).
