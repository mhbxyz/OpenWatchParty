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
        Assert.Equal(1, response.RootElement.GetProperty("protocol_version").GetInt32());
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
        Assert.Equal(1, response.RootElement.GetProperty("protocol_version").GetInt32());
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void Responses_CarryShowSyncNudgeButton(bool insecure, bool show)
    {
        var config = new PluginConfiguration
        {
            AllowInsecureNoAuth = insecure,
            JwtSecret = insecure ? string.Empty : ValidSecret,
            SessionServerUrl = "wss://session.example/ws",
            ShowSyncNudgeButton = show
        };

        using var response = GetTokenResponse(config);

        Assert.Equal(show, response.RootElement.GetProperty("show_sync_nudge_button").GetBoolean());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Responses_CarryTheAppearance(bool insecure)
    {
        var defaulted = new PluginConfiguration
        {
            AllowInsecureNoAuth = insecure,
            JwtSecret = insecure ? string.Empty : ValidSecret,
            SessionServerUrl = "wss://session.example/ws"
        };
        var custom = new PluginConfiguration
        {
            AllowInsecureNoAuth = insecure,
            JwtSecret = insecure ? string.Empty : ValidSecret,
            SessionServerUrl = "wss://session.example/ws",
            AppearanceOpacity = 80,
            AppearanceTextSize = 17
        };

        using var defaultResponse = GetTokenResponse(defaulted);
        using var customResponse = GetTokenResponse(custom);

        Assert.Equal(55, defaultResponse.RootElement.GetProperty("appearance_opacity").GetInt32());
        Assert.Equal(14, defaultResponse.RootElement.GetProperty("appearance_text_size").GetInt32());
        Assert.Equal(80, customResponse.RootElement.GetProperty("appearance_opacity").GetInt32());
        Assert.Equal(17, customResponse.RootElement.GetProperty("appearance_text_size").GetInt32());
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
        Assert.False(insecureResponse.RootElement.GetProperty("show_sync_nudge_button").GetBoolean());
        Assert.False(authenticatedResponse.RootElement.GetProperty("show_sync_nudge_button").GetBoolean());
    }

    [Theory]
    [InlineData(false, 120)]
    [InlineData(true, 120)]
    [InlineData(false, 3600)]
    [InlineData(true, 3600)]
    public void Responses_CarryTheConfiguredInviteTtl(bool insecure, int ttl)
    {
        var config = new PluginConfiguration
        {
            AllowInsecureNoAuth = insecure,
            JwtSecret = insecure ? string.Empty : ValidSecret,
            SessionServerUrl = "wss://session.example/ws",
            InviteTtlSeconds = ttl
        };

        using var response = GetTokenResponse(config);

        Assert.Equal(ttl, response.RootElement.GetProperty("invite_ttl_seconds").GetInt32());
    }

    [Fact]
    public void Responses_DefaultAndClampTheInviteTtl()
    {
        var defaulted = new PluginConfiguration
        {
            JwtSecret = ValidSecret,
            SessionServerUrl = "wss://session.example/ws"
        };
        var tooShort = new PluginConfiguration
        {
            JwtSecret = ValidSecret,
            SessionServerUrl = "wss://session.example/ws",
            InviteTtlSeconds = 5
        };
        var tooLong = new PluginConfiguration
        {
            JwtSecret = ValidSecret,
            SessionServerUrl = "wss://session.example/ws",
            InviteTtlSeconds = 999_999
        };

        using var defaultedResponse = GetTokenResponse(defaulted);
        using var tooShortResponse = GetTokenResponse(tooShort);
        using var tooLongResponse = GetTokenResponse(tooLong);

        Assert.Equal(3600, defaultedResponse.RootElement.GetProperty("invite_ttl_seconds").GetInt32());
        Assert.Equal(60, tooShortResponse.RootElement.GetProperty("invite_ttl_seconds").GetInt32());
        Assert.Equal(86_400, tooLongResponse.RootElement.GetProperty("invite_ttl_seconds").GetInt32());
    }

    private static JsonDocument GetTokenResponse(PluginConfiguration config)
    {
        var result = Assert.IsType<OkObjectResult>(CreateController().GetTokenForConfiguration(config));
        return JsonDocument.Parse(JsonSerializer.Serialize(result.Value));
    }

    internal static OpenWatchPartyController CreateController()
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
