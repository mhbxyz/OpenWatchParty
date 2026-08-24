using MediaBrowser.Model.Plugins;

namespace OpenWatchParty.Plugin.Configuration;

/// <summary>
/// Configuration for the OpenWatchParty plugin.
/// Provides settings for JWT authentication and session server connection.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    private string _jwtSecret = string.Empty;
    private int _tokenTtlSeconds = 3600;
    private int _inviteTtlSeconds = 3600;

    /// <summary>
    /// Gets or sets the JWT secret. A value is required unless insecure development mode is explicit.
    /// </summary>
    /// <remarks>
    /// For security, the secret should be at least 32 characters with high entropy.
    /// Use a cryptographically random string for production deployments.
    /// </remarks>
    public string JwtSecret
    {
        get => _jwtSecret;
        set => _jwtSecret = value ?? string.Empty;
    }

    /// <summary>
    /// Gets or sets a value indicating whether unauthenticated development is explicitly allowed.
    /// This must remain disabled in production.
    /// </summary>
    public bool AllowInsecureNoAuth { get; set; }

    /// <summary>
    /// JWT audience claim. Defaults to "OpenWatchParty".
    /// </summary>
    public string JwtAudience { get; set; } = "OpenWatchParty";

    /// <summary>
    /// JWT issuer claim. Defaults to "Jellyfin".
    /// </summary>
    public string JwtIssuer { get; set; } = "Jellyfin";

    /// <summary>
    /// Token TTL in seconds. Must be between 60 and 86400 (1 min to 24 hours).
    /// </summary>
    public int TokenTtlSeconds
    {
        get => _tokenTtlSeconds;
        set => _tokenTtlSeconds = Math.Clamp(value, 60, 86400);
    }

    /// <summary>
    /// Invite TTL in seconds. Must be between 60 and 86400 (1 min to 24 hours).
    /// </summary>
    public int InviteTtlSeconds
    {
        get => _inviteTtlSeconds;
        set => _inviteTtlSeconds = Math.Clamp(value, 60, 86400);
    }

    /// <summary>
    /// The WebSocket server URL. If empty, uses the default (same host, port 3000).
    /// </summary>
    /// <example>ws://localhost:3000/ws or wss://party.example.com/ws</example>
    public string SessionServerUrl { get; set; } = string.Empty;

}
