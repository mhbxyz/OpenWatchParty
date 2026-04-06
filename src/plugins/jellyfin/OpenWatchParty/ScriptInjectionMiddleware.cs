using System.Text;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace OpenWatchParty.Plugin;

/// <summary>
/// ASP.NET Core middleware that intercepts requests for the Jellyfin web client
/// index.html and injects the OpenWatchParty client script tag.
///
/// Registered via IStartupFilter so it runs BEFORE Jellyfin's static file
/// middleware, which would otherwise serve the unmodified index.html.
/// </summary>
public class ScriptInjectionMiddleware
{
    private readonly RequestDelegate _next;
    private static readonly Lazy<(byte[] Content, string ETag)?> _cache =
        new(LoadContent, LazyThreadSafetyMode.ExecutionAndPublication);

    public ScriptInjectionMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path.Value?.TrimEnd('/');
        if (path is "/web" or "/web/index.html")
        {
            var cached = _cache.Value;
            if (cached.HasValue)
            {
                var (content, etag) = cached.Value;

                var requestETag = context.Request.Headers.IfNoneMatch.FirstOrDefault();
                if (!string.IsNullOrEmpty(requestETag) && requestETag == etag)
                {
                    context.Response.StatusCode = 304;
                    return;
                }

                context.Response.ContentType = "text/html; charset=utf-8";
                context.Response.Headers.CacheControl = "no-cache";
                context.Response.Headers.ETag = etag;
                context.Response.ContentLength = content.Length;
                await context.Response.Body.WriteAsync(content);
                return;
            }
        }

        await _next(context);
    }

    private static (byte[] Content, string ETag)? LoadContent()
    {
        try
        {
            var webDir = Environment.GetEnvironmentVariable("JELLYFIN_WEB_DIR")
                ?? "/usr/share/jellyfin/web";
            var indexPath = Path.Combine(webDir, "index.html");
            var html = File.ReadAllText(indexPath);
            var modified = FileTransformationIntegration.InjectScript(html);

            var bytes = Encoding.UTF8.GetBytes(modified);
            var hash = System.Security.Cryptography.SHA256.HashData(bytes);
            var etag = $"\"{Convert.ToBase64String(hash)[..16]}\"";
            return (bytes, etag);
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>
/// Startup filter that registers the script injection middleware at the very
/// beginning of the pipeline, before static files middleware.
/// </summary>
public class ScriptInjectionStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseMiddleware<ScriptInjectionMiddleware>();
            next(app);
        };
    }
}

/// <summary>
/// Registers plugin services with Jellyfin's DI container.
/// This is called during ConfigureServices, before the middleware pipeline is built.
/// </summary>
public class ServiceRegistrator : MediaBrowser.Controller.Plugins.IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<IStartupFilter, ScriptInjectionStartupFilter>();
    }
}
