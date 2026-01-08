using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;
using OpenWatchParty.Plugin.Configuration;

namespace OpenWatchParty.Plugin.Controllers;

[ApiController]
[Route("OpenWatchParty")]
public class OpenWatchPartyController : ControllerBase
{
    // Rate limiting: max 10 tokens per minute per user
    private const int MaxTokensPerMinute = 10;
    private static readonly ConcurrentDictionary<string, (int Count, DateTime ResetTime)> TokenRateLimits = new();

    // Cache for embedded script content (read once at startup)
    private static string? _cachedScript;
    private static string? _cachedScriptETag;

    [HttpGet("ClientScript")]
    [Produces("text/javascript")]
    public async Task<ActionResult> GetClientScript()
    {
        // Check If-None-Match header for cache validation
        var requestETag = Request.Headers["If-None-Match"].FirstOrDefault();
        if (!string.IsNullOrEmpty(requestETag) && requestETag == _cachedScriptETag)
        {
            return StatusCode(304); // Not Modified
        }

        // Load script from embedded resource (cached after first load)
        if (_cachedScript == null)
        {
            var assembly = typeof(OpenWatchPartyController).Assembly;
            var resourceName = "OpenWatchParty.Plugin.Web.plugin.js";
            using var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null) return NotFound();
            using var reader = new StreamReader(stream);
            _cachedScript = await reader.ReadToEndAsync();
            _cachedScriptETag = $"\"{Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(_cachedScript)))[..16]}\"";
        }

        // Set cache headers
        Response.Headers["Cache-Control"] = "public, max-age=3600";
        Response.Headers["ETag"] = _cachedScriptETag;

        return Content(_cachedScript, "text/javascript");
    }

    [HttpGet("Token")]
    [Authorize]
    [Produces("application/json")]
    public ActionResult GetToken()
    {
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
            return StatusCode(429, new { error = "Rate limit exceeded. Try again later." });
        }
        else
        {
            TokenRateLimits[userId] = (limit.Count + 1, limit.ResetTime);
        }

        // Check if JWT is configured
        if (string.IsNullOrEmpty(config.JwtSecret))
        {
            // Return a special response indicating auth is disabled
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
            new Claim(JwtRegisteredClaimNames.Iat, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64),
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
}
