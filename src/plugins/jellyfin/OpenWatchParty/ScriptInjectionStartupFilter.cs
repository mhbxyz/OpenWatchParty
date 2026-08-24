using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace OpenWatchParty.Plugin;

/// <summary>
/// Adds script injection before Jellyfin's static file and compression middleware.
/// </summary>
public sealed class ScriptInjectionStartupFilter : IStartupFilter
{
    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseMiddleware<ScriptInjectionMiddleware>();
            next(app);
        };
    }
}
