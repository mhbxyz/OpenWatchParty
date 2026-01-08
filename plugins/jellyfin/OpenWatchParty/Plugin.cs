using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;
using OpenWatchParty.Plugin.Configuration;

namespace OpenWatchParty.Plugin;

public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Singleton instance - standard Jellyfin plugin pattern.
    /// Thread-safe: set once during plugin initialization by Jellyfin's plugin loader.
    /// </summary>
    public static Plugin? Instance { get; private set; }
    private readonly ILogger<Plugin> _logger;

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _logger = logger;

        if (string.IsNullOrEmpty(Configuration.JwtSecret))
        {
            _logger.LogWarning("[OpenWatchParty] JwtSecret is not configured. Authentication is DISABLED. " +
                "Set a JwtSecret (min 32 characters) in the plugin configuration to enable authentication.");
        }
        else if (Configuration.JwtSecret.Length < 32)
        {
            _logger.LogWarning("[OpenWatchParty] JwtSecret is too short ({Length} chars). " +
                "Use at least 32 characters for secure authentication.", Configuration.JwtSecret.Length);
        }
        else
        {
            _logger.LogInformation("[OpenWatchParty] JWT authentication is enabled.");
        }
    }

    public override string Name => "OpenWatchParty";

    public override Guid Id => new("0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d");
    
    // Developer: https://github.com/mhbxyz
    // Repository: https://github.com/mhbxyz/OpenWatchParty

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
