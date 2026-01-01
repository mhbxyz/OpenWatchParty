using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using OpenSyncParty.Plugin.Configuration;
using OpenSyncParty.Plugin.Managers;

namespace OpenSyncParty.Plugin;

public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static Plugin? Instance { get; private set; }
    public RoomManager RoomManager { get; } = new();

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public override string Name => "OpenSyncParty";

    public override Guid Id => new("0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d");
    
    // Developer: https://github.com/mhbxyz
    // Repository: https://github.com/mhbxyz/OpenSyncParty

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "OpenSyncParty",
                EmbeddedResourcePath = GetType().Namespace + ".Web.configPage.html"
            }
        };
    }
}
