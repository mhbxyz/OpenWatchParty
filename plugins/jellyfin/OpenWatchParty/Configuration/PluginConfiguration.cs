using MediaBrowser.Model.Plugins;

namespace OpenWatchParty.Plugin.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    private string _jwtSecret = string.Empty;
    private int _tokenTtlSeconds = 3600;
    private int _inviteTtlSeconds = 3600;

    /// <summary>
    /// Gets or sets the JWT secret. If empty, authentication is disabled.
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
    public string SessionServerUrl { get; set; } = string.Empty;
}
