using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using OpenWatchParty.Plugin.Configuration;

namespace OpenWatchParty.Plugin.Controllers;

/// <summary>
/// Controller for OpenWatchParty plugin endpoints.
/// Provides client script serving and JWT token generation for watch party sessions.
/// </summary>
[ApiController]
[Route("OpenWatchParty")]
public class OpenWatchPartyController : ControllerBase
{
    private readonly ILogger<OpenWatchPartyController> _logger;

    // Rate limiting: max 30 tokens per minute per user (allows for reconnections)
    private const int MaxTokensPerMinute = 30;
    private static readonly ConcurrentDictionary<string, (int Count, DateTime ResetTime)> TokenRateLimits = new();
    private static DateTime _lastRateLimitCleanup = DateTime.UtcNow;
    private static readonly TimeSpan RateLimitCleanupInterval = TimeSpan.FromMinutes(5);

    // Cache for embedded script content using Lazy<T> for thread-safe initialization (fixes audit 4.5.1)
    private static readonly Lazy<(string Content, string ETag)> _scriptCache = new(LoadScriptFromResource, LazyThreadSafetyMode.ExecutionAndPublication);

    // P-CS02 fix: Cache JWT signing credentials and handler to avoid repeated allocations
    private static SigningCredentials? _cachedSigningCredentials;
    private static string? _cachedJwtSecret;
    private static readonly JwtSecurityTokenHandler _tokenHandler = new();

    /// <summary>
    /// Initializes a new instance of the controller with logging support.
    /// </summary>
    /// <param name="logger">The logger instance for this controller.</param>
    public OpenWatchPartyController(ILogger<OpenWatchPartyController> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Loads the client script from embedded resources (thread-safe, called once via Lazy).
    /// </summary>
    private static (string Content, string ETag) LoadScriptFromResource()
    {
        var assembly = typeof(OpenWatchPartyController).Assembly;
        var resourceName = "OpenWatchParty.Plugin.Web.plugin.js";
        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null)
        {
            throw new InvalidOperationException($"Embedded resource '{resourceName}' not found");
        }
        using var reader = new StreamReader(stream);
        var content = reader.ReadToEnd();
        var hash = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(content));
        var etag = $"\"{Convert.ToBase64String(hash)[..16]}\"";
        return (content, etag);
    }

    /// <summary>
    /// Returns the OpenWatchParty client JavaScript.
    /// Supports ETag caching for efficient client-side caching.
    /// </summary>
    /// <returns>The JavaScript client script.</returns>
    [HttpGet("ClientScript")]
    [Produces("text/javascript")]
    public ActionResult GetClientScript()
    {
        // Get cached script (thread-safe via Lazy<T>)
        var (content, etag) = _scriptCache.Value;

        // Check If-None-Match header for cache validation
        var requestETag = Request.Headers["If-None-Match"].FirstOrDefault();
        if (!string.IsNullOrEmpty(requestETag) && requestETag == etag)
        {
            return StatusCode(304); // Not Modified
        }

        // Set cache headers
        Response.Headers["Cache-Control"] = "public, max-age=3600";
        Response.Headers["ETag"] = etag;

        return Content(content, "text/javascript");
    }

    /// <summary>
    /// Returns plugin information including the plugin ID.
    /// Useful for configuration pages to dynamically get the plugin GUID.
    /// </summary>
    /// <returns>Plugin info including ID, name, and version.</returns>
    [HttpGet("Info")]
    [Produces("application/json")]
    public ActionResult GetPluginInfo()
    {
        return Ok(new
        {
            id = Plugin.PluginGuid,
            name = Plugin.Instance?.Name ?? "OpenWatchParty",
            version = Plugin.PluginVersion
        });
    }

    /// <summary>
    /// Cleans up expired entries from the rate limit dictionary (P-CS01 fix).
    /// Called periodically to prevent memory leak from accumulating stale entries.
    /// </summary>
    private static void CleanupExpiredRateLimits()
    {
        var now = DateTime.UtcNow;
        if (now - _lastRateLimitCleanup < RateLimitCleanupInterval)
        {
            return;
        }

        _lastRateLimitCleanup = now;

        // Remove all expired entries
        var expiredKeys = TokenRateLimits
            .Where(kvp => now > kvp.Value.ResetTime)
            .Select(kvp => kvp.Key)
            .ToList();

        foreach (var key in expiredKeys)
        {
            TokenRateLimits.TryRemove(key, out _);
        }
    }

    /// <summary>
    /// Generates a JWT token for the authenticated user to connect to the session server.
    /// Rate limited to 10 tokens per minute per user.
    /// </summary>
    /// <returns>Token response containing the JWT or indication that auth is disabled.</returns>
    /// <response code="200">Returns the token or auth disabled response.</response>
    /// <response code="401">User identity not found in claims.</response>
    /// <response code="429">Rate limit exceeded.</response>
    /// <response code="500">Plugin not configured.</response>
    [HttpGet("Token")]
    [Authorize]
    [Produces("application/json")]
    public ActionResult GetToken()
    {
        // P-CS01 fix: Periodically clean up expired rate limit entries to prevent memory leak
        CleanupExpiredRateLimits();

        var config = Plugin.Instance?.Configuration;
        if (config == null)
        {
            return StatusCode(500, new { error = "Plugin not configured" });
        }

        // Get user info from the authenticated context
        var userId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value
                  ?? User.FindFirst("Jellyfin-UserId")?.Value;
        var userName = User.FindFirst(ClaimTypes.Name)?.Value
                    ?? User.Identity?.Name;

        // Validate user claims are present
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(new { error = "User identity not found in claims" });
        }
        if (string.IsNullOrEmpty(userName))
        {
            userName = "User";  // Fallback for display name only
        }

        // Rate limiting check
        var now = DateTime.UtcNow;
        var limit = TokenRateLimits.GetOrAdd(userId, _ => (0, now.AddMinutes(1)));
        if (now >= limit.ResetTime)
        {
            limit = (1, now.AddMinutes(1));
            TokenRateLimits[userId] = limit;
        }
        else if (limit.Count >= MaxTokensPerMinute)
        {
            _logger.LogWarning("Token rate limit exceeded for user {UserId}", userId);
            return StatusCode(429, new { error = "Rate limit exceeded. Try again later." });
        }
        else
        {
            TokenRateLimits[userId] = (limit.Count + 1, limit.ResetTime);
        }

        // Quality settings to include in response
        var qualitySettings = new {
            default_max_bitrate = config.DefaultMaxBitrate,
            prefer_direct_play = config.PreferDirectPlay,
            allow_host_quality_control = config.AllowHostQualityControl
        };

        // Check if JWT is configured
        if (string.IsNullOrEmpty(config.JwtSecret))
        {
            // Return a special response indicating auth is disabled
            return Ok(new {
                token = (string?)null,
                auth_enabled = false,
                user_id = userId,
                user_name = userName,
                quality = qualitySettings
            });
        }

        var token = GenerateJwtToken(userId, userName, config);
        _logger.LogDebug("Generated token for user {UserName} ({UserId})", userName, userId);

        return Ok(new {
            token,
            auth_enabled = true,
            expires_in = config.TokenTtlSeconds,
            user_id = userId,
            user_name = userName,
            quality = qualitySettings
        });
    }

    /// <summary>
    /// Gets or creates cached signing credentials (P-CS02 fix).
    /// Credentials are cached and reused until the JWT secret changes.
    /// </summary>
    private static SigningCredentials GetSigningCredentials(string jwtSecret)
    {
        if (_cachedSigningCredentials != null && _cachedJwtSecret == jwtSecret)
        {
            return _cachedSigningCredentials;
        }

        var securityKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret));
        _cachedSigningCredentials = new SigningCredentials(securityKey, SecurityAlgorithms.HmacSha256);
        _cachedJwtSecret = jwtSecret;
        return _cachedSigningCredentials;
    }

    private static string GenerateJwtToken(string userId, string userName, PluginConfiguration config)
    {
        // P-CS02 fix: Use cached signing credentials instead of creating new ones each time
        var credentials = GetSigningCredentials(config.JwtSecret);

        var claims = new[]
        {
            new Claim(JwtRegisteredClaimNames.Sub, userId),
            new Claim(JwtRegisteredClaimNames.Name, userName),
            new Claim(JwtRegisteredClaimNames.Aud, config.JwtAudience),
            new Claim(JwtRegisteredClaimNames.Iss, config.JwtIssuer),
            new Claim(JwtRegisteredClaimNames.Iat, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
        };

        var token = new JwtSecurityToken(
            issuer: config.JwtIssuer,
            audience: config.JwtAudience,
            claims: claims,
            expires: DateTime.UtcNow.AddSeconds(config.TokenTtlSeconds),
            signingCredentials: credentials
        );

        // P-CS02 fix: Use cached token handler instead of creating new one each time
        return _tokenHandler.WriteToken(token);
    }
}
