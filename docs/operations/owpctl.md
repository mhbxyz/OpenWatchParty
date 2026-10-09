---
title: Guided Setup and owpctl
parent: Operations
nav_order: 1
---

# Guided Setup with owpctl

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
[illustrated walkthrough]({{ '/product/first-watch-party/#path-b-existing-jellyfin' | relative_url }})
shows where to create a temporary Jellyfin API key, what to enter in the
assistant and how to verify the result.

The command opens a one-time URL bound to `127.0.0.1`. The browser assistant:

1. connects to your existing Jellyfin;
2. previews every operation;
3. installs or upgrades the plugin;
4. deploys the signed session-server image;
5. configures authentication on both sides;
6. verifies health before stopping itself.

The Jellyfin administrator token is held in memory and deleted immediately after setup. The web assistant stops after installation or 30 minutes.

`install`, `upgrade` and `configure` write only the plugin settings owpctl manages: the JWT secret, audience and issuer, the token and invite lifetimes, and the session server URL, and it turns off unauthenticated access and the auto-detected session server. Every other plugin setting, such as hiding Jellyfin's SyncPlay button, keeps the value it had before the update. A setting the new plugin version no longer has, or now stores with a different type, takes that version's default.

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
owpctl configure --set session.log-level=debug
owpctl configure --rotate-jwt-secret --yes --api-token-file /run/owp-jellyfin-token
owpctl uninstall --yes --keep-config
```

## Asymmetric Pairing

New installations start in hybrid mode so existing HS256 sessions are not interrupted. Pairing registers only the plugin public RSA key in the session-server trust store, activates RS256 issuance, then restarts the managed server in asymmetric mode without injecting the shared secret.

```bash
owpctl pair \
  --jellyfin-url https://jellyfin.example.com \
  --api-token-file /run/owp-jellyfin-token \
  --trust-store /var/lib/openwatchparty/trust-store.json
```

List or revoke trusted keys:

```bash
owpctl trust --store /var/lib/openwatchparty/trust-store.json list
owpctl trust --store /var/lib/openwatchparty/trust-store.json revoke --kid KEY_ID
```

The RSA private key remains in Jellyfin's plugin data directory with owner-only permissions. The session server stores public keys only.

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
