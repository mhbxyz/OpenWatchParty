using System.Text;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;

namespace OpenWatchParty.Plugin;

/// <summary>
/// Injects the OpenWatchParty loader into Jellyfin's generated index response.
/// </summary>
public sealed class ScriptInjectionMiddleware
{
    private const long MaxIndexSize = 4 * 1024 * 1024;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private readonly RequestDelegate _next;
    private readonly string _baseUrl;
    private readonly ILogger<ScriptInjectionMiddleware> _logger;
    private readonly InjectionDiagnostics _diagnostics;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjectionMiddleware"/> class.
    /// </summary>
    public ScriptInjectionMiddleware(
        RequestDelegate next,
        IServerConfigurationManager configurationManager,
        ILogger<ScriptInjectionMiddleware> logger,
        InjectionDiagnostics diagnostics)
        : this(next, configurationManager.GetNetworkConfiguration().BaseUrl, logger, diagnostics)
    {
    }

    internal ScriptInjectionMiddleware(
        RequestDelegate next,
        string? baseUrl,
        ILogger<ScriptInjectionMiddleware> logger,
        InjectionDiagnostics? diagnostics = null)
    {
        _next = next;
        _baseUrl = NormalizeBaseUrl(baseUrl);
        _logger = logger;
        _diagnostics = diagnostics ?? new InjectionDiagnostics();
    }

    /// <summary>
    /// Processes an HTTP request.
    /// </summary>
    public async Task InvokeAsync(HttpContext context)
    {
        if (!IsIndexRequest(context.Request, _baseUrl))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        var originalBody = context.Response.Body;
        _diagnostics.RecordIndexObserved();
        var temporaryPath = Path.Combine(Path.GetTempPath(), $"owp-index-{Guid.NewGuid():N}.tmp");
        await using var bufferedBody = new FileStream(
            temporaryPath,
            FileMode.CreateNew,
            FileAccess.ReadWrite,
            FileShare.None,
            16 * 1024,
            FileOptions.Asynchronous | FileOptions.DeleteOnClose | FileOptions.SequentialScan);
        var savedHeaders = RemoveRequestHeaders(
            context.Request.Headers,
            "Accept-Encoding",
            "If-None-Match",
            "If-Modified-Since");

        try
        {
            context.Response.Body = bufferedBody;
            context.Response.OnStarting(static state =>
            {
                var response = (HttpResponse)state;
                if (IsTransformableResponse(response))
                {
                    PrepareTransformedResponseHeaders(response);
                }

                return Task.CompletedTask;
            }, context.Response);
            await _next(context).ConfigureAwait(false);
            context.Response.Body = originalBody;

            bufferedBody.Position = 0;
            if (IsTransformableResponse(context.Response) && bufferedBody.Length <= MaxIndexSize)
            {
                var originalBytes = new byte[checked((int)bufferedBody.Length)];
                await bufferedBody.ReadExactlyAsync(originalBytes, context.RequestAborted).ConfigureAwait(false);
                var outputBytes = TryInject(context.Response, originalBytes);
                if (!ReferenceEquals(outputBytes, originalBytes))
                {
                    _diagnostics.RecordNativeInjection();
                }
                await originalBody.WriteAsync(outputBytes, context.RequestAborted).ConfigureAwait(false);
            }
            else
            {
                await bufferedBody.CopyToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
            }
        }
        finally
        {
            context.Response.Body = originalBody;
            RestoreRequestHeaders(context.Request.Headers, savedHeaders);
        }
    }

    internal static bool IsIndexRequest(HttpRequest request, string? baseUrl)
    {
        if (!HttpMethods.IsGet(request.Method))
        {
            return false;
        }

        var prefix = NormalizeBaseUrl(baseUrl);
        var path = request.Path.Value ?? string.Empty;
        return string.Equals(path, prefix + "/web", StringComparison.OrdinalIgnoreCase)
            || string.Equals(path, prefix + "/web/", StringComparison.OrdinalIgnoreCase)
            || string.Equals(path, prefix + "/web/index.html", StringComparison.OrdinalIgnoreCase);
    }

    private byte[] TryInject(HttpResponse response, byte[] originalBytes)
    {
        try
        {
            var original = StrictUtf8.GetString(originalBytes);
            var transformed = ClientScriptInjection.InjectIntoHtml(original);
            if (string.Equals(original, transformed, StringComparison.Ordinal))
            {
                return originalBytes;
            }

            var transformedBytes = StrictUtf8.GetBytes(transformed);
            if (!response.HasStarted)
            {
                PrepareTransformedResponseHeaders(response);
            }
            _logger.LogDebug("Injected OpenWatchParty client loader into Jellyfin index response");
            return transformedBytes;
        }
        catch (DecoderFallbackException ex)
        {
            _logger.LogWarning(ex, "Jellyfin index response was not valid UTF-8; skipping script injection");
            return originalBytes;
        }
    }

    private static bool IsTransformableResponse(HttpResponse response)
    {
        return response.StatusCode == StatusCodes.Status200OK
            && response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) == true
            && !response.Headers.ContainsKey("Content-Encoding")
            && !response.Headers.ContainsKey("Content-Range");
    }

    private static void PrepareTransformedResponseHeaders(HttpResponse response)
    {
        response.ContentLength = null;
        response.Headers.Remove("ETag");
        response.Headers.Remove("Last-Modified");
        response.Headers.Remove("Content-MD5");
        response.Headers.Remove("Accept-Ranges");
        response.Headers.CacheControl = "no-cache";
    }

    private static string NormalizeBaseUrl(string? baseUrl)
    {
        if (string.IsNullOrWhiteSpace(baseUrl) || baseUrl == "/")
        {
            return string.Empty;
        }

        var normalized = baseUrl.Trim();
        if (!normalized.StartsWith("/", StringComparison.Ordinal))
        {
            normalized = "/" + normalized;
        }

        return normalized.TrimEnd('/');
    }

    private static Dictionary<string, (bool WasPresent, StringValues Value)> RemoveRequestHeaders(
        IHeaderDictionary headers,
        params string[] names)
    {
        var saved = new Dictionary<string, (bool WasPresent, StringValues Value)>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in names)
        {
            var wasPresent = headers.TryGetValue(name, out var value);
            saved[name] = (wasPresent, value);
            headers.Remove(name);
        }

        return saved;
    }

    private static void RestoreRequestHeaders(
        IHeaderDictionary headers,
        IReadOnlyDictionary<string, (bool WasPresent, StringValues Value)> saved)
    {
        foreach (var (name, state) in saved)
        {
            if (state.WasPresent)
            {
                headers[name] = state.Value;
            }
            else
            {
                headers.Remove(name);
            }
        }
    }
}
