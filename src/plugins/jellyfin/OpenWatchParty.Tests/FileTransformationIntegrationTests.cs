using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public class FileTransformationIntegrationTests
{
    private const string ScriptTag = "<script src=\"/OpenWatchParty/ClientScript\" defer></script>";
    private const string FallbackLoaderGuard = "__owpClientScriptInjected";

    private class FakePayload
    {
        public string? contents { get; set; }
        public string? fileName { get; set; }
    }

    private static object MakePayload(string? contents, string? fileName = null) => new FakePayload { contents = contents, fileName = fileName };

    [Fact]
    public void TransformIndexHtml_InjectsScript_WhenNotPresent()
    {
        var html = "<html><head></head><body><h1>Jellyfin</h1></body></html>";
        var result = FileTransformationIntegration.TransformIndexHtml(MakePayload(html));

        Assert.Contains(ScriptTag, result);
        Assert.Contains("</body>", result);
        Assert.True(result.IndexOf(ScriptTag) < result.LastIndexOf("</body>"));
    }

    [Fact]
    public void TransformIndexHtml_SkipsInjection_WhenAlreadyPresent()
    {
        var html = $"<html><body>{ScriptTag}</body></html>";
        var result = FileTransformationIntegration.TransformIndexHtml(MakePayload(html));

        Assert.Equal(html, result);
    }

    [Fact]
    public void TransformIndexHtml_ReturnsEmpty_WhenContentIsNull()
    {
        var result = FileTransformationIntegration.TransformIndexHtml(MakePayload(null));

        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void TransformHomeChunkScript_AppendsFallbackLoader_WhenNotPresent()
    {
        var js = "(()=>{console.log('home chunk');})();";
        var result = FileTransformationIntegration.TransformHomeChunkScript(MakePayload(js, "home-html.a1b2.chunk.js"));

        Assert.Contains(FallbackLoaderGuard, result);
        Assert.Contains("/OpenWatchParty/ClientScript", result);
        Assert.StartsWith(js, result, StringComparison.Ordinal);
    }

    [Fact]
    public void TransformHomeChunkScript_Skips_WhenGuardAlreadyPresent()
    {
        var js = "(()=>{window.__owpClientScriptInjected=true;})();";
        var result = FileTransformationIntegration.TransformHomeChunkScript(MakePayload(js, "home-html.a1b2.chunk.js"));

        Assert.Equal(js, result);
    }

    [Fact]
    public void TransformHomeChunkScript_ReturnsEmpty_WhenContentIsNull()
    {
        var result = FileTransformationIntegration.TransformHomeChunkScript(MakePayload(null, "home-html.a1b2.chunk.js"));

        Assert.Equal(string.Empty, result);
    }
}
