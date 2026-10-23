---
title: Plugin
parent: Technical
nav_order: 5
---

# Jellyfin Plugin (C#)

## Overview

The plugin targets Jellyfin 12 ABI `12.0.0.0` and runs on .NET 10 (`net10.0`). It exposes the JavaScript loader and allow-listed client modules, issues per-user session tokens, serves the administrator configuration page, and provides diagnostics. The target ABI and Jellyfin package version are set in `src/plugins/jellyfin/Directory.Build.props`; the project target framework is set in `OpenWatchPartyPlugin.csproj`.

## Project Structure

```
src/plugins/jellyfin/OpenWatchParty/
├── Plugin.cs
├── OpenWatchPartyPlugin.csproj
├── Configuration/PluginConfiguration.cs
├── Controllers/
│   ├── OpenWatchPartyController.cs
│   ├── OpenWatchPartyDiagnosticsController.cs
│   └── SigningKeyController.cs
├── OpenWatchPartyDiagnosticsService.cs
├── InjectionDiagnostics.cs
├── JwtSecretValidator.cs
├── SessionServerUrlValidator.cs
└── Web/configPage.html
```

The client modules live in `src/clients/jellyfin-web`; MSBuild embeds those JavaScript files as resources. The plugin loader (`plugin.js`) loads the allow-listed modules from `/OpenWatchParty/Client/{path}` in dependency waves. `/OpenWatchParty/ClientScript` serves the loader, not a concatenated client bundle.

## Plugin entry point and configuration

`Plugin` derives from `BasePlugin<PluginConfiguration>` and implements `IHasWebPages`. It exposes the plugin GUID and runtime version and registers `Web.configPage.html`. On initialization it logs whether JWT authentication is configured, whether explicit insecure development mode is enabled, or why token issuance is blocked.

`PluginConfiguration` includes:

| Setting | Default | Contract |
|---------|---------|----------|
| `JwtSecret` | empty | Required for shared-secret JWT signing unless an activated RSA signing key is used or explicit insecure mode is enabled. A configured secret must pass the Base64/Base64URL, length, entropy and sequence checks in `JwtSecretValidator`. |
| `AllowInsecureNoAuth` | `false` | Explicitly allows local development without a JWT. It is ignored when a valid secret or active RSA signer is present. |
| `JwtAudience`, `JwtIssuer` | `OpenWatchParty`, `Jellyfin` | Claims for the shared-secret token. |
| `TokenTtlSeconds`, `InviteTtlSeconds` | `3600` each | Clamped to 60–86400 seconds. |
| `SessionServerUrl` | empty | Optional absolute `ws://` or `wss://` destination. URL validation rejects a missing host, credentials, query or fragment. |
| `AllowAutoDetectedSessionServer` | `false` | Must be enabled to permit same-host port-3000 discovery when `SessionServerUrl` is empty; otherwise token issuance returns HTTP 503. |
| `HideNativeSyncPlayButton` | `false` | Controls whether Jellyfin's built-in SyncPlay header controls are hidden in the web client. |
| `ShowSyncNudgeButton` | `false` | Enables the guest-only local sync adjustment control. |
| `AppearanceOpacity`, `AppearanceTextSize` | `55`, `14` | Opacity is clamped and rounded to 40–100 by 5; text size is clamped to 12–18 px. These values style the room bar, its menus, lobby panel, up-next strip and toasts. |

The admin page reads and saves these fields through Jellyfin's standard plugin configuration API. Its configuration read includes `JwtSecret` so the page can populate the password field; that API response is not a redaction boundary. The dedicated diagnostics responses do not serialize the configuration or secret. The signing key endpoint is separate from `PluginConfiguration`: its private key is kept in the plugin data folder, and the public JWK and activation state are exposed only to administrators.

## HTTP endpoints

### Client assets

- `GET /OpenWatchParty/ClientScript` returns the small loader script. Its ETag supports conditional requests. `v` determines caching: the current content hash receives one-year immutable caching, any other supplied value receives `no-store`, and a request without `v` receives one-hour public caching.
- `GET /OpenWatchParty/Client/{path}` serves only paths in `AllowedClientModules`. It uses the same versioned cache policy and per-asset ETag behavior. Unknown modules return 404 and invalid paths return 400.

The allow-list contains the 40 modules loaded by `plugin.js`; test files and arbitrary embedded resources are not routable through this endpoint.

### Session token

`GET /OpenWatchParty/Token` requires Jellyfin authentication and a user ID claim. It returns the session WebSocket URL, protocol version 1, appearance and SyncPlay settings, invite TTL, and either a JWT or an explicit insecure-mode response. Shared-secret tokens use HS256; an activated plugin-managed RSA key uses RS256. A JWT includes `sub`, `name`, `aud`, `iss`, `iat`, `exp` and a unique `jti`; issuer and audience are serialized as strings.

The endpoint rejects invalid session URLs and unapproved automatic discovery with HTTP 503 before returning a token. JWT issuance is limited to 30 requests per user in a fixed one-minute window. The no-token insecure response is returned before that limiter is acquired. See [REST API]({{ '/technical/api/' | relative_url }}#get-openwatchpartytoken) for response shapes and status codes.

### Diagnostics and signing keys

`GET /OpenWatchParty/Diagnostics/Status` returns redacted configuration, injection and version checks to an administrator. `POST /OpenWatchParty/Diagnostics/Run` adds a session-server health request with a five-second timeout. Checks report authentication configuration, session destination, observed native injection, HTTP reachability and protocol compatibility; they do not serialize the plugin configuration or secret.

`GET /OpenWatchParty/SigningKey` creates or returns the plugin's RSA public JWK and whether it is active. `POST /OpenWatchParty/SigningKey/Activate` activates the key matching the supplied `kid`; these routes require administrator elevation.

## Session destination and token configuration

When an explicit session URL is supplied, the plugin accepts only an absolute WebSocket URL with a host and no credentials, query or fragment. When the URL is empty and automatic discovery is enabled, the token response uses the request host with port `3000` and maps HTTP to `ws`, HTTPS to `wss`, at `/ws`. Both token generation and diagnostics use this same destination rule.

The shared JWT secret must be Base64 or Base64URL encoded, represent at least 32 random bytes, and satisfy the minimum estimated entropy check. If a valid secret is configured while `AllowInsecureNoAuth` is true, JWT mode takes precedence. The server validates JWT expiry without clock leeway and disconnects an authenticated WebSocket when the token expires.

## Build inputs

- Target framework: `net10.0`
- Jellyfin packages: `12.0.0`
- Jellyfin target ABI: `12.0.0.0`
- JWT libraries: `System.IdentityModel.Tokens.Jwt` and `Microsoft.IdentityModel.Tokens`, version `6.35.0`

Build the plugin from the repository root with `just build plugin`; the project output uses the `net10.0` target directory. Rust server MSRV is documented separately in [Server]({{ '/technical/server/' | relative_url }}).
