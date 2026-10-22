---
title: "Guided Setup with owpctl"
---

<span id="guided-setup-with-owpctl" class="legacy-anchor"></span>

`owpctl` installs, configures, diagnoses, upgrades and removes OpenWatchParty. It manages its own hardened Compose project and adopts your existing Jellyfin without rewriting its deployment files.

## Download

| Platform | Asset |
|----------|-------|
| Linux x86_64 | `owpctl-linux-x86_64` |
| Linux arm64 | `owpctl-linux-aarch64` |
| macOS (Apple silicon) | `owpctl-macos-aarch64` |
| macOS (Intel) | `owpctl-macos-x86_64` |
| Windows x86_64 | `owpctl-windows-x86_64.exe` |

```bash
# Linux x86_64 example
curl -fLO https://github.com/mhbxyz/OpenWatchParty/releases/latest/download/owpctl-linux-x86_64
curl -fLO https://github.com/mhbxyz/OpenWatchParty/releases/latest/download/owpctl-linux-x86_64.sha256
sha256sum -c owpctl-linux-x86_64.sha256
chmod +x owpctl-linux-x86_64
sudo install -m 0755 owpctl-linux-x86_64 /usr/local/bin/owpctl
```

On macOS, verify with `shasum -a 256 -c`. Release assets also contain Sigstore and provenance bundles for independent verification.

## Graphical Setup

```bash
owpctl setup --web
```

This uses user scope and requires Docker access for that user. For system
scope, use `sudo owpctl --scope system setup --web` and open the one-time URL
printed in the terminal if it does not launch a browser. The
[illustrated walkthrough](/product/first-watch-party/#path-b-existing-jellyfin)
shows where to create a temporary Jellyfin API key, what to enter in the
assistant and how to verify the result.

The command opens a one-time URL bound to `127.0.0.1`. **Preview plan** parses
the Jellyfin URL and lists the planned operations without installing anything;
it does not test connectivity or validate the administrator token. A token is
not required for the preview. **Install** validates Docker and Jellyfin,
installs or upgrades the plugin, configures authentication, deploys the signed
session-server image and verifies health before stopping the assistant.

Open the printed URL once and keep the page open. Reloading it or opening it
again returns **Invalid or consumed setup token**. If this happens before
installation, stop the setup command and rerun it for a fresh session.
The web assistant stops after installation or 30 minutes. It does not write
the supplied administrator API token to its configuration files. Close the
page and revoke the temporary API key in Jellyfin after setup and diagnostics.

`install`, `upgrade` and `configure` write only the plugin settings owpctl manages: the JWT secret, audience and issuer, the token and invite lifetimes, and the session server URL, and it turns off unauthenticated access and the auto-detected session server. Every other plugin setting, such as hiding Jellyfin's SyncPlay button, keeps the value it had before the update. A setting the new plugin version no longer has, or now stores with a different type, takes that version's default.

## Remote Browser Access

When `owpctl setup --web` runs over SSH, its loopback URL belongs to the
remote machine, not your computer. Keep that setup process running and create
an SSH local forward in another terminal on your computer. For example, if
the printed URL uses port `43123`:

```bash
ssh -N -L 127.0.0.1:43123:127.0.0.1:43123 user@jellyfin-host
```

Replace the host and both port numbers with your server and the printed port.
Use the same local and remote port so the assistant's origin check still
matches. Open the original one-time URL in your local browser, then keep that
page and the SSH forward open until setup finishes. Do not publish the setup
port or share the URL/token. Alternatively, use headless setup below.

## Headless Setup

Create the configuration:

```bash
sudo owpctl --scope system setup \
  --non-interactive \
  --jellyfin-url https://jellyfin.example.com
```

Store a temporary Jellyfin admin API token in a protected file, review the plan, then install:

```bash
sudo install -m 0600 /dev/null /run/owp-jellyfin-token
sudo sh -c 'read -r token; printf %s "$token" > /run/owp-jellyfin-token'
sudo owpctl --scope system install --dry-run --api-token-file /run/owp-jellyfin-token
sudo owpctl --scope system install --yes --api-token-file /run/owp-jellyfin-token
sudo rm -f /run/owp-jellyfin-token
```

## Diagnostics

Every `owpctl` command prints a human-readable summary by default. Passing `--json` switches the output to machine-readable JSON for scripting and automation.

```bash
owpctl status
owpctl doctor --api-token-file /run/owp-jellyfin-token
owpctl doctor --json --api-token-file /run/owp-jellyfin-token
owpctl doctor --bundle /tmp/owp-support.json --api-token-file /run/owp-jellyfin-token
```

`doctor` verifies Docker, Jellyfin, plugin metadata, session health, JWT issuance and an authenticated WebSocket ping/pong. It never prints the token or JWT. `--bundle` writes a redacted support file (the report, the desired configuration and the installation state, with the secret fingerprint removed) that can be shared when asking for help.

## Maintenance

```bash
owpctl upgrade --dry-run --api-token-file /run/owp-jellyfin-token
owpctl upgrade --yes --api-token-file /run/owp-jellyfin-token
owpctl backup
owpctl logs                  # follow the session server logs
owpctl logs --tail 200 --no-follow
owpctl configure --set session.log-level=debug --api-token-file /run/owp-jellyfin-token
owpctl configure --rotate-jwt-secret --yes --api-token-file /run/owp-jellyfin-token
owpctl uninstall --yes --keep-config --api-token-file /run/owp-jellyfin-token
```

`install`, `upgrade` and `configure` retain plugin settings that owpctl does not
manage. Upgrade compatibility is conservative: fractions cannot replace an
integer setting, and changed arrays or objects retain the installed plugin's
value because its JSON does not expose the .NET schema. An invalid configuration
root aborts without posting a replacement. Configuration debug output redacts
all values, including unknown future secrets.

## Asymmetric Pairing

`owpctl setup` defaults to hybrid mode, which accepts shared-secret HS256 tokens and trusted RS256 tokens. Pairing registers the plugin public RSA key in the session-server trust store, activates RS256 issuance, then restarts the managed server in asymmetric mode without injecting the shared secret.

```bash
sudo owpctl --scope system pair \
  --jellyfin-url https://jellyfin.example.com \
  --api-token-file /run/owp-jellyfin-token \
  --trust-store /var/lib/openwatchparty/trust-store.json
```

List or revoke trusted keys:

```bash
sudo owpctl --scope system trust --store /var/lib/openwatchparty/trust-store.json list
sudo owpctl --scope system trust --store /var/lib/openwatchparty/trust-store.json revoke --kid KEY_ID
```

The RSA private key remains in Jellyfin's plugin data directory with owner-only permissions. The session server stores public keys only. `pair` reads or creates the plugin's current signing key and is safe to repeat; it does not rotate that key. Revoking a trusted key rejects later authentication attempts using tokens signed by it. Already-authenticated WebSocket sessions are not immediately disconnected by a trust-store edit; their existing expiry and reconnect rules still apply. There is no automated signing-key rotation command, so plan key replacement and pairing before revoking the active key.

## Managed Files

System scope:

```text
/etc/openwatchparty/owpctl.toml
/etc/openwatchparty/secrets.env
/var/lib/openwatchparty/state.json
/var/lib/openwatchparty/compose.yaml
/var/lib/openwatchparty/trust-store.json
/var/lib/openwatchparty/backups/
```

`uninstall` removes only resources marked as owned in `state.json`. Jellyfin itself and unrelated plugin repositories are never removed.
