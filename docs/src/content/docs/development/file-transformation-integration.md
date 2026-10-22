---
title: "File Transformation Integration"
---

<span id="file-transformation-integration" class="legacy-anchor"></span>

## Overview

This document describes how to integrate OpenWatchParty with the [jellyfin-plugin-file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to automatically inject the client script into Jellyfin's `index.html`, eliminating the manual Custom HTML configuration step.

The development environment pins File Transformation `3.0.1.0` with archive ABI `12.0.0`. File Transformation 3.0.1.0 publishes one archive per Jellyfin ABI: use `Release-12.0.0.zip` for Jellyfin 12.

## How It Works

When Jellyfin loads OpenWatchParty, the plugin detects whether the [file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) plugin is installed. If found, it registers transformations that inject the client script automatically:

- `index.html` callback inserts `<script src="../OpenWatchParty/ClientScript?v=<hash>" defer></script>` before `</body>`
- `home-html\..*\.chunk\.js` callback appends a guarded fallback loader for Jellyfin home chunk builds, with the same URL

`<hash>` is a content hash of the embedded client files. The loader forwards it to every module URL, so browsers reuse their cached client files until the client code changes. A script tag added by hand without `v` keeps the previous behaviour: the loader is cached for an hour and the modules are requested again on every page load.

The plugin also has native Jellyfin response middleware that injects the client script into `index.html`. File Transformation is an optional integration for the same injection, including its home-chunk fallback. If both mechanisms are unavailable, an administrator can use Dashboard > General > Custom HTML as a manual fallback.

## File-Transformation API

### Registration Payloads

```csharp
var payload = new {
    id = new Guid(Plugin.PluginGuid),
    fileNamePattern = @"^index\.html$",
    callbackAssembly = typeof(FileTransformationIntegration).Assembly.FullName,
    callbackClass = typeof(FileTransformationIntegration).FullName,
    callbackMethod = nameof(TransformIndexHtml)
};

var fallbackPayload = new {
    id = new Guid(Plugin.PluginGuid),
    fileNamePattern = @"home-html\..*\.chunk\.js",
    callbackAssembly = typeof(FileTransformationIntegration).Assembly.FullName,
    callbackClass = typeof(FileTransformationIntegration).FullName,
    callbackMethod = nameof(TransformHomeChunkScript)
};
```

### Registration via Reflection

Jellyfin loads plugins in separate `AssemblyLoadContext`, so direct type references are impossible. Use reflection:

```csharp
Assembly? ftAssembly = AssemblyLoadContext.All
    .SelectMany(ctx => ctx.Assemblies)
    .FirstOrDefault(asm => asm.FullName?.Contains(".FileTransformation") ?? false);

if (ftAssembly != null)
{
    Type? pluginInterface = ftAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
    MethodInfo? registerMethod = pluginInterface?.GetMethod("RegisterTransformation");
    registerMethod?.Invoke(null, new object?[] { payload });
    registerMethod?.Invoke(null, new object?[] { fallbackPayload });
}
```

### Callback Signature

```csharp
public static string TransformIndexHtml(object payload)
{
    string? contents = payload?.GetType()
        .GetProperty("contents")?
        .GetValue(payload)?
        .ToString();

    return ClientScriptInjection.InjectIntoHtml(contents);
}

public static string TransformHomeChunkScript(object payload)
{
    string? contents = payload?.GetType()
        .GetProperty("contents")?
        .GetValue(payload)?
        .ToString();

    if (string.IsNullOrEmpty(contents) || contents.Contains("__owpClientScriptInjected"))
    {
        return contents ?? string.Empty;
    }

    return contents + "\n;(function(){if(window.__owpClientScriptInjected||(window.OpenWatchParty&&window.OpenWatchParty.__loaded))return;window.__owpClientScriptInjected=true;var s=document.createElement('script');s.src='" + ClientScriptInjection.ScriptUrl + "';s.defer=true;document.head.appendChild(s);}());\n";
}
```

`ClientScriptInjection.InjectIntoHtml` adds the same versioned script tag used by the middleware. `ClientScriptInjection.ScriptUrl` appends the content hash, which the loader forwards to module URLs for cache invalidation.

## Implementation Files

| File | Purpose |
|------|---------|
| `src/plugins/jellyfin/OpenWatchParty/FileTransformationIntegration.cs` | Registration & transformation callback |
| `src/plugins/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj` | Newtonsoft.Json dependency |
| `docs/src/content/docs/operations/installation.md` | Installation instructions (Option A) |

## Error Handling

| Scenario | Behavior |
|----------|----------|
| File Transformation plugin not installed | Log info; native response middleware remains active |
| Incompatible version | Log warning; native response middleware remains active |
| Exception during registration | Log warning; native response middleware remains active |
| Script already present | Return unchanged (idempotent) |
| Runtime callback without `</body>` in the index payload | Log warning; no index transformation is made |

## Runtime Diagnostics

When diagnosing "registered but not injected" issues, verify both registration and callback execution in Jellyfin logs:

- Registration logs:
  - `Registered File Transformation pattern 'index.html' -> callback 'TransformIndexHtml'`
  - `Registered File Transformation pattern 'home-html\..*\.chunk\.js' -> callback 'TransformHomeChunkScript'`
- Runtime callback logs:
  - `TransformIndexHtml invoked for file ...`
  - `TransformHomeChunkScript invoked for file ...`
  - `Could not inject ... '</body>' tag not found` (index payload not HTML)

Also verify endpoint availability:

```bash
curl -I http://localhost:8096/OpenWatchParty/ClientScript
```

Expected: `200 OK` and `Content-Type: text/javascript`.

## Testing

Verify the following scenarios:

| Scenario | Expected Behavior |
|----------|-------------------|
| Without file-transformation installed | Native middleware injects the client script |
| With file-transformation installed | Script is automatically injected |
| Custom HTML removed, file-transformation active | Plugin still works |
| File-transformation uninstalled | Graceful fallback to manual method |

## References

- [jellyfin-plugin-file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
- [jellyfin-plugin-pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) - Example integration
