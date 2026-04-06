using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public class FileTransformationIntegrationTests
{
    private const string ScriptTag = "<script src=\"../OpenWatchParty/ClientScript\" defer></script>";

    private class FakePayload
    {
        public string? contents { get; set; }
    }

    private static object MakePayload(string? contents) => new FakePayload { contents = contents };

    // -- InjectScript (core logic, used by both FT callback and direct file injection) --

    [Fact]
    public void InjectScript_InjectsBeforeBodyClose()
    {
        var html = "<html><head></head><body><h1>Jellyfin</h1></body></html>";
        var result = FileTransformationIntegration.InjectScript(html);

        Assert.Contains(ScriptTag, result);
        Assert.True(result.IndexOf(ScriptTag) < result.LastIndexOf("</body>"));
    }

    [Fact]
    public void InjectScript_InjectsBeforeHeadClose_WhenNoBody()
    {
        var html = "<html><head><title>Jellyfin</title></head><div>no body tag</div></html>";
        var result = FileTransformationIntegration.InjectScript(html);

        Assert.Contains(ScriptTag, result);
        Assert.True(result.IndexOf(ScriptTag) < result.LastIndexOf("</head>"));
    }

    [Fact]
    public void InjectScript_SkipsInjection_WhenAlreadyPresent()
    {
        var html = $"<html><body>{ScriptTag}</body></html>";
        var result = FileTransformationIntegration.InjectScript(html);

        Assert.Equal(html, result);
    }

    [Fact]
    public void InjectScript_SkipsInjection_WhenAbsolutePathPresent()
    {
        var html = "<html><body><script src=\"/OpenWatchParty/ClientScript\"></script></body></html>";
        var result = FileTransformationIntegration.InjectScript(html);

        Assert.Equal(html, result);
    }

    [Fact]
    public void InjectScript_ReturnsEmpty_WhenNull()
    {
        var result = FileTransformationIntegration.InjectScript(null!);
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void InjectScript_ReturnsEmpty_WhenEmpty()
    {
        var result = FileTransformationIntegration.InjectScript(string.Empty);
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void InjectScript_ReturnsUnchanged_WhenNoBodyOrHead()
    {
        var html = "<html><div>no head or body</div></html>";
        var result = FileTransformationIntegration.InjectScript(html);

        Assert.Equal(html, result);
    }

    // -- TransformIndexHtml (FT callback, extracts contents from payload) --

    [Fact]
    public void TransformIndexHtml_InjectsScript_WhenNotPresent()
    {
        var html = "<html><head></head><body><h1>Jellyfin</h1></body></html>";
        var result = FileTransformationIntegration.TransformIndexHtml(MakePayload(html));

        Assert.Contains(ScriptTag, result);
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
}
