---
title: File Transformation Integration
parent: Development
nav_order: 5
---

# File Transformation Integration

## Overview

This document describes how to integrate OpenWatchParty with the [jellyfin-plugin-file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to automatically inject the client script into Jellyfin's `index.html`, eliminating the manual Custom HTML configuration step.

The development environment pins File Transformation `2.5.3.0` with archive ABI `10.11.3`.

## How It Works

When Jellyfin loads OpenWatchParty, the plugin detects whether the [file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) plugin is installed. If found, it registers transformations that inject the client script automatically:

- `index.html` callback inserts `<script src="/OpenWatchParty/ClientScript" defer></script>` before `</body>`
- `home-html\..*\.chunk\.js` callback appends a guarded fallback loader for Jellyfin home chunk builds

If file-transformation is not installed, the admin can still inject the script manually via Dashboard > General > Custom HTML.

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

    if (string.IsNullOrEmpty(contents) || contents.Contains("/OpenWatchParty/ClientScript"))
    {
        return contents ?? string.Empty;
    }

    int bodyEndIndex = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
    if (bodyEndIndex >= 0)
    {
        return contents.Insert(bodyEndIndex, "<script src=\"/OpenWatchParty/ClientScript\"></script>\n");
    }

    return contents;
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

    return contents + "\n;(function(){if(window.__owpClientScriptInjected)return;window.__owpClientScriptInjected=true;var s=document.createElement('script');s.src='/OpenWatchParty/ClientScript';s.defer=true;document.head.appendChild(s);}());\n";
}
```

## Implementation Files

| File | Purpose |
|------|---------|
| `src/plugins/jellyfin/OpenWatchParty/FileTransformationIntegration.cs` | Registration & transformation callback |
| `src/plugins/jellyfin/OpenWatchParty/OpenWatchPartyPlugin.csproj` | Newtonsoft.Json dependency |
| `docs/operations/installation.md` | Installation instructions (Option A) |

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Plugin not installed | Log info, fallback to manual |
| Incompatible version | Log warning, fallback to manual |
| Exception during registration | Log debug, fallback to manual |
| Script already present | Return unchanged (idempotent) |
| Runtime callback without `</body>` in target | Log warning, fallback to chunk loader |

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
| Without file-transformation installed | Manual method works via Custom HTML |
| With file-transformation installed | Script is automatically injected |
| Custom HTML removed, file-transformation active | Plugin still works |
| File-transformation uninstalled | Graceful fallback to manual method |

## References

- [jellyfin-plugin-file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
- [jellyfin-plugin-pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) - Example integration
