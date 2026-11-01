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
    private int _appearanceOpacity = 55;
    private int _appearanceTextSize = 14;
    private string _appearancePreset = "glass";

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
    /// Gets or sets the absolute session WebSocket URL. An empty value enables automatic discovery.
    /// Only ws/wss URLs with a host and without credentials, query strings, or fragments are valid.
    /// </summary>
    /// <example>ws://localhost:3000/ws or wss://party.example.com/ws</example>
    public string SessionServerUrl { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets a value indicating whether same-host port 3000 auto-detection is explicitly trusted.
    /// </summary>
    public bool AllowAutoDetectedSessionServer { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether Jellyfin Web hides its built-in SyncPlay button.
    /// Disabled by default; the Watch Party controls are not affected.
    /// </summary>
    public bool HideNativeSyncPlayButton { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether guests get the sync adjustment button in the room bar.
    /// Disabled by default; it only moves the guest's own video, never the room's playback.
    /// </summary>
    public bool ShowSyncNudgeButton { get; set; }

    /// <summary>
    /// Gets or sets the opacity, in percent, of the room bar, its drop-downs, the lobby panel and the
    /// toasts over the player. Between 40 and 100 in steps of 5; 55 by default.
    /// </summary>
    public int AppearanceOpacity
    {
        get => _appearanceOpacity;
        set => _appearanceOpacity = Math.Clamp(
            (int)Math.Round(value / 5.0, MidpointRounding.AwayFromZero) * 5, 40, 100);
    }

    /// <summary>
    /// Gets or sets the base text size, in pixels, of the same elements; their icons and spacing
    /// scale with it. Between 12 and 18; 14 by default.
    /// </summary>
    public int AppearanceTextSize
    {
        get => _appearanceTextSize;
        set => _appearanceTextSize = Math.Clamp(value, 12, 18);
    }

    /// <summary>
    /// Gets or sets the color preset of the same elements: "glass" (the default), "solid", "light"
    /// or "contrast". Any other value is "glass".
    /// </summary>
    public string AppearancePreset
    {
        get => _appearancePreset;
        set => _appearancePreset = value is "glass" or "solid" or "light" or "contrast" ? value : "glass";
    }
}
