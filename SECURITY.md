# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.7.x (Jellyfin 12) | Yes |
| 0.4.x (Jellyfin 12) | Yes |
| 0.3.4 (Jellyfin 10.11) | Yes |
| 0.3.3 and older | No |

## Session-server security upgrade

[GHSA-fjpr-3g28-27r9](https://github.com/mhbxyz/OpenWatchParty/security/advisories/GHSA-fjpr-3g28-27r9) affects every session-server release `>=0.1.0,<0.7.0`; session-server `0.7.0` contains the published fix. Upgrade the session server to `0.7.0` or newer independently of the Jellyfin plugin version. For example, an installation that must keep plugin `0.3.4` for Jellyfin 10.11 still needs to upgrade its session server. This upgrade guidance does not change the supported-version policy above or assert backports to earlier server releases. See the [operations security guide](docs/src/content/docs/operations/security.md#published-session-server-advisory) for details.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub Private Vulnerability Reporting](https://github.com/mhbxyz/OpenWatchParty/security/advisories/new). Include affected versions, reproduction steps, impact, and any proposed mitigation. Avoid including real credentials, tokens, media, or personal data.

You should receive an acknowledgement within 3 business days and an initial assessment within 7 business days. Confirmed issues are coordinated privately until a fix and advisory are ready. Disclosure timing depends on severity and deployment impact.

## Scope

Reports may cover the Rust session server, Jellyfin plugin, browser client, release artifacts, container images, CI/CD workflows, and dependency supply chain.

## Technical Documentation

The threat model (assets, actors, trust boundaries, STRIDE analysis) and the inventory of abuse limits (message and frame size, rate-limit windows, command cooldown, connection caps, authentication timeout, token rate limiting, name and chat length limits, proxy trust) are documented in [`docs/src/content/docs/operations/security.md`](docs/src/content/docs/operations/security.md).
