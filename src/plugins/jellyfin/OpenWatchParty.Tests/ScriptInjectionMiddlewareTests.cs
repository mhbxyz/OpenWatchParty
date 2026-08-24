using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class ScriptInjectionMiddlewareTests
{
    [Fact]
    public void HtmlInjectionIsIdempotentAndRequiresBodyEnd()
    {
        var html = "<html><body><h1>Jellyfin</h1></body></html>";
        var injected = ClientScriptInjection.InjectIntoHtml(html);

        Assert.Contains(ClientScriptInjection.ScriptTag, injected, StringComparison.Ordinal);
        Assert.Equal(injected, ClientScriptInjection.InjectIntoHtml(injected));
        Assert.Equal("<html><head></head></html>", ClientScriptInjection.InjectIntoHtml("<html><head></head></html>"));
        Assert.Equal(string.Empty, ClientScriptInjection.InjectIntoHtml(null));
    }

    [Theory]
    [InlineData("/web")]
    [InlineData("/web/")]
    [InlineData("/web/index.html")]
    public async Task RootIndexResponsesAreInjected(string path)
    {
        var result = await InvokeAsync(path, string.Empty);

        Assert.Contains(ClientScriptInjection.ScriptTag, result.Body, StringComparison.Ordinal);
        Assert.Null(result.Context.Response.ContentLength);
        Assert.Equal("no-cache", result.Context.Response.Headers.CacheControl);
        Assert.False(result.Context.Response.Headers.ContainsKey("ETag"));
        Assert.False(result.Context.Response.Headers.ContainsKey("Last-Modified"));
        Assert.False(result.Context.Response.Headers.ContainsKey("Accept-Ranges"));
    }

    [Fact]
    public async Task BasePathIndexResponseIsInjected()
    {
        var result = await InvokeAsync("/jellyfin/web/index.html", "/jellyfin");

        Assert.Contains(ClientScriptInjection.ScriptTag, result.Body, StringComparison.Ordinal);
        var resolved = new Uri(new Uri("https://example.test/jellyfin/web/index.html"), ClientScriptInjection.ScriptPath);
        Assert.Equal("https://example.test/jellyfin/OpenWatchParty/ClientScript", resolved.AbsoluteUri);
    }

    [Fact]
    public async Task NonIndexAndMismatchedBasePathsAreUnchanged()
    {
        var other = await InvokeAsync("/api/index.html", string.Empty);
        var wrongBase = await InvokeAsync("/other/web/index.html", "/jellyfin");

        Assert.DoesNotContain(ClientScriptInjection.Marker, other.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(ClientScriptInjection.Marker, wrongBase.Body, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("application/json", 200, null)]
    [InlineData("text/html", 404, null)]
    [InlineData("text/html", 200, "gzip")]
    public async Task IneligibleResponsesAreUnchanged(string contentType, int statusCode, string? contentEncoding)
    {
        var result = await InvokeAsync(
            "/web/index.html",
            string.Empty,
            contentType,
            statusCode,
            contentEncoding);

        Assert.DoesNotContain(ClientScriptInjection.Marker, result.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RequestHeadersAreHiddenDownstreamAndRestored()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/web/index.html";
        context.Request.Headers.AcceptEncoding = "gzip";
        context.Request.Headers.IfNoneMatch = "\"old\"";
        context.Request.Headers.IfModifiedSince = "Mon, 01 Jan 2024 00:00:00 GMT";
        context.Response.Body = new MemoryStream();
        var downstreamSawConditionalHeaders = false;
        RequestDelegate next = async ctx =>
        {
            downstreamSawConditionalHeaders = ctx.Request.Headers.ContainsKey("Accept-Encoding")
                || ctx.Request.Headers.ContainsKey("If-None-Match")
                || ctx.Request.Headers.ContainsKey("If-Modified-Since");
            ctx.Response.StatusCode = StatusCodes.Status200OK;
            ctx.Response.ContentType = "text/html; charset=utf-8";
            await ctx.Response.WriteAsync("<html><body></body></html>");
        };
        var middleware = new ScriptInjectionMiddleware(
            next,
            string.Empty,
            NullLogger<ScriptInjectionMiddleware>.Instance);

        await middleware.InvokeAsync(context);

        Assert.False(downstreamSawConditionalHeaders);
        Assert.Equal("gzip", context.Request.Headers.AcceptEncoding);
        Assert.Equal("\"old\"", context.Request.Headers.IfNoneMatch);
        Assert.Equal("Mon, 01 Jan 2024 00:00:00 GMT", context.Request.Headers.IfModifiedSince);
    }

    [Fact]
    public async Task SplitBodyWritesAreInjectedAndRestartsRemainIndependent()
    {
        var first = await InvokeAsync("/web/index.html", string.Empty, splitBody: true);
        var second = await InvokeAsync("/jellyfin/web/index.html", "/jellyfin", splitBody: true);

        Assert.Contains(ClientScriptInjection.ScriptTag, first.Body, StringComparison.Ordinal);
        Assert.Contains(ClientScriptInjection.ScriptTag, second.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OversizedIndexResponseIsPassedThroughWithoutInjection()
    {
        var body = "<html><body>" + new string('x', (4 * 1024 * 1024) + 1) + "</body></html>";

        var result = await InvokeAsync("/web/index.html", string.Empty, body: body);

        Assert.Equal(body, result.Body);
        Assert.DoesNotContain(ClientScriptInjection.Marker, result.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void ServiceRegistrationIsIdempotent()
    {
        var services = new ServiceCollection();
        var registrator = new ServiceRegistrator();

        registrator.RegisterServices(services, null!);
        registrator.RegisterServices(services, null!);

        var registrations = services.Where(descriptor =>
            descriptor.ServiceType == typeof(IStartupFilter)
            && descriptor.ImplementationType == typeof(ScriptInjectionStartupFilter));
        Assert.Single(registrations);
    }

    private static async Task<(DefaultHttpContext Context, string Body)> InvokeAsync(
        string path,
        string baseUrl,
        string contentType = "text/html; charset=utf-8",
        int statusCode = StatusCodes.Status200OK,
        string? contentEncoding = null,
        bool splitBody = false,
        string? body = null)
    {
        var html = body ?? "<html><head></head><body><h1>Jellyfin</h1></body></html>";
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = path;
        var output = new MemoryStream();
        context.Response.Body = output;

        RequestDelegate next = async ctx =>
        {
            ctx.Response.StatusCode = statusCode;
            ctx.Response.ContentType = contentType;
            ctx.Response.ContentLength = Encoding.UTF8.GetByteCount(html);
            ctx.Response.Headers.ETag = "\"jellyfin-index\"";
            ctx.Response.Headers.LastModified = "Mon, 01 Jan 2024 00:00:00 GMT";
            ctx.Response.Headers.AcceptRanges = "bytes";
            if (contentEncoding != null)
            {
                ctx.Response.Headers.ContentEncoding = contentEncoding;
            }

            var bytes = Encoding.UTF8.GetBytes(html);
            if (splitBody)
            {
                var split = bytes.Length - 4;
                await ctx.Response.Body.WriteAsync(bytes.AsMemory(0, split));
                await ctx.Response.Body.WriteAsync(bytes.AsMemory(split));
            }
            else
            {
                await ctx.Response.Body.WriteAsync(bytes);
            }
        };

        var middleware = new ScriptInjectionMiddleware(
            next,
            baseUrl,
            NullLogger<ScriptInjectionMiddleware>.Instance);
        await middleware.InvokeAsync(context);
        output.Position = 0;
        using var reader = new StreamReader(output, Encoding.UTF8, leaveOpen: true);
        return (context, await reader.ReadToEndAsync());
    }
}
