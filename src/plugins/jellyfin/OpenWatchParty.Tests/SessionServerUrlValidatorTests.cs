using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using OpenWatchParty.Plugin.Configuration;
using OpenWatchParty.Plugin.Controllers;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class SessionServerUrlValidatorTests
{
    [Theory]
    [InlineData(null, "")]
    [InlineData("", "")]
    [InlineData("   ", "")]
    [InlineData("ws://localhost:3000/ws", "ws://localhost:3000/ws")]
    [InlineData(" WSS://Party.Example.com:443/rooms/main ", "wss://party.example.com/rooms/main")]
    [InlineData("wss://[2001:db8::1]:8443/session", "wss://[2001:db8::1]:8443/session")]
    [InlineData("ws://example.test/deep/session/path", "ws://example.test/deep/session/path")]
    public void ValidValuesAreNormalized(string? value, string expected)
    {
        var valid = SessionServerUrlValidator.TryNormalize(value, out var normalized, out var error);

        Assert.True(valid);
        Assert.Null(error);
        Assert.Equal(expected, normalized);
    }

    [Theory]
    [InlineData("not a URL")]
    [InlineData("/ws")]
    [InlineData("http://example.test/ws")]
    [InlineData("https://example.test/ws")]
    [InlineData("ws:///ws")]
    [InlineData("wss://user:secret@example.test/ws")]
    [InlineData("wss://example.test/ws?")]
    [InlineData("wss://example.test/ws?token=secret")]
    [InlineData("wss://example.test/ws#")]
    [InlineData("wss://example.test/ws#fragment")]
    public void InvalidValuesAreRejected(string value)
    {
        var valid = SessionServerUrlValidator.TryNormalize(value, out var normalized, out var error);

        Assert.False(valid);
        Assert.Equal(string.Empty, normalized);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void TokenEndpointBlocksInvalidConfiguration()
    {
        var controller = CreateController();
        var config = new PluginConfiguration
        {
            AllowInsecureNoAuth = true,
            SessionServerUrl = "https://session.example/ws"
        };

        var result = Assert.IsType<ObjectResult>(controller.GetTokenForConfiguration(config));
        var json = JsonSerializer.Serialize(result.Value);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
        Assert.Contains("\"configuration_error\":true", json, StringComparison.Ordinal);
    }

    [Fact]
    public void TokenEndpointReturnsNormalizedConfiguration()
    {
        var controller = CreateController();
        var config = new PluginConfiguration
        {
            AllowInsecureNoAuth = true,
            SessionServerUrl = " WSS://SESSION.EXAMPLE:443/deep/ws "
        };

        var result = Assert.IsType<OkObjectResult>(controller.GetTokenForConfiguration(config));
        var json = JsonSerializer.Serialize(result.Value);

        Assert.Contains("\"session_server_url\":\"wss://session.example/deep/ws\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public void TokenEndpointRequiresExplicitAutoDetectionOptIn()
    {
        var controller = CreateController();
        var blocked = new PluginConfiguration { AllowInsecureNoAuth = true };
        var allowed = new PluginConfiguration
        {
            AllowInsecureNoAuth = true,
            AllowAutoDetectedSessionServer = true
        };

        var blockedResult = Assert.IsType<ObjectResult>(controller.GetTokenForConfiguration(blocked));
        var allowedResult = Assert.IsType<OkObjectResult>(controller.GetTokenForConfiguration(allowed));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, blockedResult.StatusCode);
        Assert.Contains("\"session_server_url\":\"\"", JsonSerializer.Serialize(allowedResult.Value), StringComparison.Ordinal);
    }

    private static OpenWatchPartyController CreateController()
    {
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(new[]
            {
                new Claim(ClaimTypes.NameIdentifier, Guid.NewGuid().ToString()),
                new Claim(ClaimTypes.Name, "Test User")
            }, "Test"))
        };
        return new OpenWatchPartyController(NullLogger<OpenWatchPartyController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = context }
        };
    }
}
