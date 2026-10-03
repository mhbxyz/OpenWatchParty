using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using OpenWatchParty.Plugin.Configuration;
using OpenWatchParty.Plugin.Controllers;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

/// <summary>
/// Tests for the web client settings carried by the /OpenWatchParty/Token response.
/// </summary>
public sealed class TokenResponseTests
{
    private const string ValidSecret = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=";

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InsecureResponse_CarriesHideNativeSyncPlayButton(bool hide)
    {
        var config = new PluginConfiguration
        {
            AllowInsecureNoAuth = true,
            SessionServerUrl = "wss://session.example/ws",
            HideNativeSyncPlayButton = hide
        };

        using var response = GetTokenResponse(config);

        Assert.True(response.RootElement.GetProperty("insecure_mode").GetBoolean());
        Assert.Equal(hide, response.RootElement.GetProperty("hide_native_syncplay_button").GetBoolean());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AuthenticatedResponse_CarriesHideNativeSyncPlayButton(bool hide)
    {
        var config = new PluginConfiguration
        {
            JwtSecret = ValidSecret,
            SessionServerUrl = "wss://session.example/ws",
            HideNativeSyncPlayButton = hide
        };

        using var response = GetTokenResponse(config);

        Assert.True(response.RootElement.GetProperty("auth_enabled").GetBoolean());
        Assert.Equal(hide, response.RootElement.GetProperty("hide_native_syncplay_button").GetBoolean());
    }

    [Fact]
    public void Responses_KeepNativeSyncPlayButtonByDefault()
    {
        var insecure = new PluginConfiguration
        {
            AllowInsecureNoAuth = true,
            SessionServerUrl = "wss://session.example/ws"
        };
        var authenticated = new PluginConfiguration
        {
            JwtSecret = ValidSecret,
            SessionServerUrl = "wss://session.example/ws"
        };

        using var insecureResponse = GetTokenResponse(insecure);
        using var authenticatedResponse = GetTokenResponse(authenticated);

        Assert.False(insecureResponse.RootElement.GetProperty("hide_native_syncplay_button").GetBoolean());
        Assert.False(authenticatedResponse.RootElement.GetProperty("hide_native_syncplay_button").GetBoolean());
    }

    private static JsonDocument GetTokenResponse(PluginConfiguration config)
    {
        var result = Assert.IsType<OkObjectResult>(CreateController().GetTokenForConfiguration(config));
        return JsonDocument.Parse(JsonSerializer.Serialize(result.Value));
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
