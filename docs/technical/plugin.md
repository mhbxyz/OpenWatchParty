# Jellyfin Plugin (C#)

## Overview

The OpenWatchParty plugin integrates with Jellyfin's plugin architecture to serve the client JavaScript and provide configuration management.

## Project Structure

```
plugins/jellyfin/OpenWatchParty/
├── Plugin.cs                     # Plugin entry point
├── OpenWatchParty.csproj         # Project file
├── Controllers/
│   └── OpenWatchPartyController.cs  # REST API endpoints
├── Configuration/
│   └── PluginConfiguration.cs    # Configuration model
└── Web/
    ├── configPage.html           # Admin configuration page
    └── plugin.js                 # Client JavaScript bundle
```

## Plugin.cs

### Description
The plugin entry point. Implements `BasePlugin<PluginConfiguration>` and `IHasWebPages`.

### Key Elements

```csharp
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    // Singleton instance - standard Jellyfin plugin pattern
    public static Plugin? Instance { get; private set; }

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;

        // Log JWT configuration status
        if (string.IsNullOrEmpty(Configuration.JwtSecret))
        {
            _logger.LogWarning("[OpenWatchParty] JwtSecret not configured. Authentication DISABLED.");
        }
    }

    public override string Name => "OpenWatchParty";
    public override Guid Id => new("0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d");

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "OpenWatchParty",
                EmbeddedResourcePath = GetType().Namespace + ".Web.configPage.html"
            }
        };
    }
}
```

### Singleton Pattern

The `Instance` static property follows Jellyfin's standard plugin pattern. It's set once during plugin initialization and provides access to the plugin configuration from controllers.

## OpenWatchPartyController.cs

### Description
ASP.NET Core controller providing REST API endpoints.

### Endpoints

#### `GET /OpenWatchParty/ClientScript`

Serves the client JavaScript bundle with caching support.

```csharp
[HttpGet("ClientScript")]
[Produces("text/javascript")]
public async Task<ActionResult> GetClientScript()
{
    // ETag validation for cache
    var requestETag = Request.Headers["If-None-Match"].FirstOrDefault();
    if (!string.IsNullOrEmpty(requestETag) && requestETag == _cachedScriptETag)
    {
        return StatusCode(304); // Not Modified
    }

    // Load from embedded resource (cached after first load)
    if (_cachedScript == null)
    {
        var assembly = typeof(OpenWatchPartyController).Assembly;
        var resourceName = "OpenWatchParty.Plugin.Web.plugin.js";
        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null) return NotFound();
        using var reader = new StreamReader(stream);
        _cachedScript = await reader.ReadToEndAsync();
        _cachedScriptETag = $"\"{ComputeETag(_cachedScript)}\"";
    }

    // Set cache headers
    Response.Headers["Cache-Control"] = "public, max-age=3600";
    Response.Headers["ETag"] = _cachedScriptETag;

    return Content(_cachedScript, "text/javascript");
}
```

**Features:**
- Embedded resource loading
- ETag-based cache validation
- HTTP 304 Not Modified support
- 1-hour cache lifetime

#### `GET /OpenWatchParty/Token`

Generates JWT tokens for authenticated users.

```csharp
[HttpGet("Token")]
[Authorize]
[Produces("application/json")]
public ActionResult GetToken()
{
    // Get user from authenticated context
    var userId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    var userName = User.FindFirst(ClaimTypes.Name)?.Value;

    // Validate claims
    if (string.IsNullOrEmpty(userId))
    {
        return Unauthorized(new { error = "User identity not found" });
    }

    // Rate limiting: 10 tokens per minute per user
    if (!CheckRateLimit(userId))
    {
        return StatusCode(429, new { error = "Rate limit exceeded" });
    }

    // Check if JWT is configured
    if (string.IsNullOrEmpty(config.JwtSecret))
    {
        return Ok(new {
            token = (string?)null,
            auth_enabled = false,
            user_id = userId,
            user_name = userName
        });
    }

    var token = GenerateJwtToken(userId, userName, config);

    return Ok(new {
        token,
        auth_enabled = true,
        expires_in = config.TokenTtlSeconds,
        user_id = userId,
        user_name = userName
    });
}
```

**Features:**
- Jellyfin authentication required
- Rate limiting (10 tokens/minute/user)
- JWT token generation
- Graceful handling when JWT not configured

### JWT Token Generation

```csharp
private static string GenerateJwtToken(string userId, string userName, PluginConfiguration config)
{
    var securityKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(config.JwtSecret));
    var credentials = new SigningCredentials(securityKey, SecurityAlgorithms.HmacSha256);

    var claims = new[]
    {
        new Claim(JwtRegisteredClaimNames.Sub, userId),
        new Claim(JwtRegisteredClaimNames.Name, userName),
        new Claim(JwtRegisteredClaimNames.Aud, config.JwtAudience),
        new Claim(JwtRegisteredClaimNames.Iss, config.JwtIssuer),
        new Claim(JwtRegisteredClaimNames.Iat, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString()),
    };

    var token = new JwtSecurityToken(
        issuer: config.JwtIssuer,
        audience: config.JwtAudience,
        claims: claims,
        expires: DateTime.UtcNow.AddSeconds(config.TokenTtlSeconds),
        signingCredentials: credentials
    );

    return new JwtSecurityTokenHandler().WriteToken(token);
}
```

## PluginConfiguration.cs

### Description
Configuration model with validation.

```csharp
public class PluginConfiguration : BasePluginConfiguration
{
    private string _jwtSecret = string.Empty;
    private int _tokenTtlSeconds = 3600;
    private int _inviteTtlSeconds = 3600;

    /// <summary>
    /// JWT secret. If empty, authentication is disabled.
    /// Set a value (min 32 chars) to enable authentication.
    /// </summary>
    public string JwtSecret
    {
        get => _jwtSecret;
        set => _jwtSecret = value ?? string.Empty;
    }

    /// <summary>
    /// JWT audience claim. Defaults to "OpenWatchParty".
    /// </summary>
    public string JwtAudience { get; set; } = "OpenWatchParty";

    /// <summary>
    /// JWT issuer claim. Defaults to "Jellyfin".
    /// </summary>
    public string JwtIssuer { get; set; } = "Jellyfin";

    /// <summary>
    /// Token TTL in seconds. Clamped between 60 and 86400.
    /// </summary>
    public int TokenTtlSeconds
    {
        get => _tokenTtlSeconds;
        set => _tokenTtlSeconds = Math.Clamp(value, 60, 86400);
    }

    /// <summary>
    /// Invite TTL in seconds. Clamped between 60 and 86400.
    /// </summary>
    public int InviteTtlSeconds
    {
        get => _inviteTtlSeconds;
        set => _inviteTtlSeconds = Math.Clamp(value, 60, 86400);
    }

    /// <summary>
    /// WebSocket server URL. If empty, uses default (same host, port 3000).
    /// </summary>
    public string SessionServerUrl { get; set; } = string.Empty;
}
```

**Validation:**
- TTL values are clamped to valid range (1 minute to 24 hours)
- Null JWT secret is converted to empty string

## configPage.html

### Description
Admin configuration page rendered in Jellyfin dashboard.

### Features

- **JWT Secret** - Password input field (never exposed in GET response)
- **JWT Audience** - Configurable audience claim
- **JWT Issuer** - Configurable issuer claim
- **Save button** - Persists configuration

### Security Considerations

- JWT secret is never sent back to the client
- Password field prevents shoulder surfing
- Only admins can access the plugin configuration page

## Embedded Resources

The project file configures embedded resources:

```xml
<ItemGroup>
  <EmbeddedResource Include="Web\configPage.html" />
  <EmbeddedResource Include="Web\plugin.js" />
</ItemGroup>
```

Resources are accessed via:
```csharp
assembly.GetManifestResourceStream("OpenWatchParty.Plugin.Web.plugin.js");
```

## Dependencies

```xml
<ItemGroup>
  <PackageReference Include="Jellyfin.Controller" Version="10.9.0" />
  <PackageReference Include="System.IdentityModel.Tokens.Jwt" Version="7.0.0" />
</ItemGroup>
```

## Building

```bash
# Build with dotnet
dotnet build

# Or use make (from project root)
make build-plugin
```

The built DLL and dependencies are placed in `bin/Debug/net9.0/`.
