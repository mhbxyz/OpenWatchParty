using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace OpenWatchParty.Plugin;

/// <summary>
/// Registers OpenWatchParty services during every Jellyfin host construction.
/// </summary>
public sealed class ServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.TryAddSingleton<InjectionDiagnostics>();
        serviceCollection.TryAddSingleton<OpenWatchPartyDiagnosticsService>();
        serviceCollection.TryAddEnumerable(
            ServiceDescriptor.Singleton<IStartupFilter, ScriptInjectionStartupFilter>());
    }
}
