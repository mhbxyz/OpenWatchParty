---
title: Guided Setup and owpctl
parent: Operations
nav_order: 1
---

# Guided Setup with owpctl

`owpctl` installs, configures, diagnoses, upgrades and removes OpenWatchParty. It manages its own hardened Compose project and adopts your existing Jellyfin without rewriting its deployment files.

## Download

```bash
curl -fLO https://github.com/mhbxyz/OpenWatchParty/releases/latest/download/owpctl-linux-x86_64
curl -fLO https://github.com/mhbxyz/OpenWatchParty/releases/latest/download/owpctl-linux-x86_64.sha256
sha256sum -c owpctl-linux-x86_64.sha256
chmod +x owpctl-linux-x86_64
sudo install -m 0755 owpctl-linux-x86_64 /usr/local/bin/owpctl
```

Release assets also contain Sigstore and provenance bundles for independent verification.

## Graphical Setup

```bash
owpctl --scope system setup --web
```

The command opens a one-time URL bound to `127.0.0.1`. The browser assistant:

1. connects to your existing Jellyfin;
2. previews every operation;
3. installs or upgrades the plugin;
4. deploys the signed session-server image;
5. configures authentication on both sides;
6. verifies health before stopping itself.

The Jellyfin administrator token is held in memory and deleted immediately after setup. The web assistant stops after installation or 30 minutes.

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

```bash
owpctl status
owpctl doctor --api-token-file /run/owp-jellyfin-token
owpctl doctor --json --api-token-file /run/owp-jellyfin-token
```

`doctor` verifies Docker, Jellyfin, plugin metadata, session health, JWT issuance and an authenticated WebSocket ping/pong. It never prints the token or JWT.

## Maintenance

```bash
owpctl upgrade --dry-run --api-token-file /run/owp-jellyfin-token
owpctl upgrade --yes --api-token-file /run/owp-jellyfin-token
owpctl backup
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
