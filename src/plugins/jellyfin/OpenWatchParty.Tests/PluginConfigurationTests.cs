using OpenWatchParty.Plugin.Configuration;
using OpenWatchParty.Plugin.Controllers;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

/// <summary>
/// Tests for PluginConfiguration validation and clamping behavior.
/// </summary>
public class PluginConfigurationTests
{
    [Fact]
    public void JwtSecret_DefaultIsEmpty()
    {
        var config = new PluginConfiguration();
        Assert.Equal(string.Empty, config.JwtSecret);
    }

    [Fact]
    public void JwtSecret_NullBecomesEmpty()
    {
        var config = new PluginConfiguration();
        config.JwtSecret = null!;
        Assert.Equal(string.Empty, config.JwtSecret);
    }

    [Fact]
    public void InsecureAuthentication_DefaultIsDisabled()
    {
        var config = new PluginConfiguration();
        Assert.False(config.AllowInsecureNoAuth);
    }

    [Fact]
    public void InsecureAuthentication_RequiresExplicitOptIn()
    {
        var config = new PluginConfiguration { AllowInsecureNoAuth = true };
        Assert.True(config.AllowInsecureNoAuth);
    }

    [Fact]
    public void TokenIssuance_IsBlockedWithoutSecretOrExplicitOptIn()
    {
        var blocked = new PluginConfiguration();
        var whitespace = new PluginConfiguration { JwtSecret = "   " };
        var insecure = new PluginConfiguration { AllowInsecureNoAuth = true };
        var weak = new PluginConfiguration { JwtSecret = "configured-secret" };
        var authenticated = new PluginConfiguration { JwtSecret = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=" };

        Assert.True(OpenWatchPartyController.IsAuthenticationConfigurationBlocked(blocked));
        Assert.True(OpenWatchPartyController.IsAuthenticationConfigurationBlocked(whitespace));
        Assert.False(OpenWatchPartyController.IsAuthenticationConfigurationBlocked(insecure));
        Assert.True(OpenWatchPartyController.IsAuthenticationConfigurationBlocked(weak));
        Assert.False(OpenWatchPartyController.IsAuthenticationConfigurationBlocked(authenticated));
    }

    [Fact]
    public void ConfigurationPage_ShowsBlockingAndInsecureStates()
    {
        var assembly = typeof(Plugin).Assembly;
        using var stream = assembly.GetManifestResourceStream("OpenWatchParty.Plugin.Web.configPage.html");
        Assert.NotNull(stream);
        using var reader = new StreamReader(stream);
        var page = reader.ReadToEnd();

        // The page builds "BLOCKED: configure a JWT secret" from its English catalog.
        Assert.Contains("blocked: 'BLOCKED: {message}'", page, StringComparison.Ordinal);
        Assert.Contains("configureSecret: 'configure a JWT secret'", page, StringComparison.Ordinal);
        Assert.Contains("configT('blocked', { message: configT('configureSecret') })", page, StringComparison.Ordinal);
        Assert.Contains("AllowInsecureNoAuth", page, StringComparison.Ordinal);
        Assert.Contains("AllowAutoDetectedSessionServer", page, StringComparison.Ordinal);
        Assert.Contains("automatically detected same-host port 3000", page, StringComparison.Ordinal);
        Assert.Contains("Base64/Base64URL generated from at least 32 random bytes", page, StringComparison.Ordinal);
        Assert.DoesNotContain("Clear to disable authentication", page, StringComparison.Ordinal);
    }

    [Fact]
    public void JwtAudience_DefaultIsOpenWatchParty()
    {
        var config = new PluginConfiguration();
        Assert.Equal("OpenWatchParty", config.JwtAudience);
    }

    [Fact]
    public void JwtIssuer_DefaultIsJellyfin()
    {
        var config = new PluginConfiguration();
        Assert.Equal("Jellyfin", config.JwtIssuer);
    }

    [Theory]
    [InlineData(60, 60)]      // Minimum valid
    [InlineData(3600, 3600)]  // Default
    [InlineData(86400, 86400)] // Maximum valid
    public void TokenTtlSeconds_ValidValuesAccepted(int input, int expected)
    {
        var config = new PluginConfiguration();
        config.TokenTtlSeconds = input;
        Assert.Equal(expected, config.TokenTtlSeconds);
    }

    [Theory]
    [InlineData(0, 60)]       // Below minimum -> clamped to 60
    [InlineData(59, 60)]      // Just below minimum -> clamped to 60
    [InlineData(-1000, 60)]   // Negative -> clamped to 60
    [InlineData(86401, 86400)] // Just above maximum -> clamped to 86400
    [InlineData(100000, 86400)] // Way above maximum -> clamped to 86400
    public void TokenTtlSeconds_ClampedToValidRange(int input, int expected)
    {
        var config = new PluginConfiguration();
        config.TokenTtlSeconds = input;
        Assert.Equal(expected, config.TokenTtlSeconds);
    }

    [Theory]
    [InlineData(60, 60)]
    [InlineData(3600, 3600)]
    [InlineData(86400, 86400)]
    public void InviteTtlSeconds_ValidValuesAccepted(int input, int expected)
    {
        var config = new PluginConfiguration();
        config.InviteTtlSeconds = input;
        Assert.Equal(expected, config.InviteTtlSeconds);
    }

    [Theory]
    [InlineData(0, 60)]
    [InlineData(-100, 60)]
    [InlineData(100000, 86400)]
    public void InviteTtlSeconds_ClampedToValidRange(int input, int expected)
    {
        var config = new PluginConfiguration();
        config.InviteTtlSeconds = input;
        Assert.Equal(expected, config.InviteTtlSeconds);
    }

    [Fact]
    public void SessionServerUrl_DefaultIsEmpty()
    {
        var config = new PluginConfiguration();
        Assert.Equal(string.Empty, config.SessionServerUrl);
        Assert.False(config.AllowAutoDetectedSessionServer);
    }

    [Fact]
    public void HideNativeSyncPlayButton_DefaultIsDisabled()
    {
        var config = new PluginConfiguration();
        Assert.False(config.HideNativeSyncPlayButton);
    }

    [Fact]
    public void ShowSyncNudgeButton_DefaultIsDisabled()
    {
        var config = new PluginConfiguration();
        Assert.False(config.ShowSyncNudgeButton);
    }

    [Fact]
    public void Appearance_DefaultsTo55PercentAnd14Px()
    {
        var config = new PluginConfiguration();
        Assert.Equal(55, config.AppearanceOpacity);
        Assert.Equal(14, config.AppearanceTextSize);
        Assert.Equal("glass", config.AppearancePreset);
    }

    [Theory]
    [InlineData("glass", "glass")]
    [InlineData("solid", "solid")]
    [InlineData("light", "light")]
    [InlineData("contrast", "contrast")]
    [InlineData("Light", "glass")]
    [InlineData("neon", "glass")]
    [InlineData("", "glass")]
    [InlineData(null, "glass")]
    public void AppearancePreset_KeepsOnlyKnownPresets(string? value, string expected)
    {
        var config = new PluginConfiguration { AppearancePreset = value! };
        Assert.Equal(expected, config.AppearancePreset);
    }

    [Theory]
    [InlineData(0, 40)]
    [InlineData(40, 40)]
    [InlineData(57, 55)]
    [InlineData(58, 60)]
    [InlineData(100, 100)]
    [InlineData(250, 100)]
    public void AppearanceOpacity_IsKeptInRangeOnItsSteps(int value, int expected)
    {
        var config = new PluginConfiguration { AppearanceOpacity = value };
        Assert.Equal(expected, config.AppearanceOpacity);
    }

    [Theory]
    [InlineData(-3, 12)]
    [InlineData(12, 12)]
    [InlineData(15, 15)]
    [InlineData(18, 18)]
    [InlineData(40, 18)]
    public void AppearanceTextSize_IsKeptInRange(int value, int expected)
    {
        var config = new PluginConfiguration { AppearanceTextSize = value };
        Assert.Equal(expected, config.AppearanceTextSize);
    }

    [Fact]
    public void ConfigurationPage_OffersNativeSyncPlayToggle()
    {
        var assembly = typeof(Plugin).Assembly;
        using var stream = assembly.GetManifestResourceStream("OpenWatchParty.Plugin.Web.configPage.html");
        Assert.NotNull(stream);
        using var reader = new StreamReader(stream);
        var page = reader.ReadToEnd();

        // Loading and saving the checkbox is covered by tests/config-page-syncplay.test.js.
        Assert.Contains("id=\"HideNativeSyncPlayButton\"", page, StringComparison.Ordinal);
        Assert.Contains("id=\"ShowSyncNudgeButton\"", page, StringComparison.Ordinal);
        Assert.Contains("id=\"AppearanceOpacity\" min=\"40\" max=\"100\" step=\"5\"", page, StringComparison.Ordinal);
        Assert.Contains("id=\"AppearanceTextSize\" min=\"12\" max=\"18\" step=\"1\"", page, StringComparison.Ordinal);
        Assert.Contains("id=\"ResetAppearanceButton\"", page, StringComparison.Ordinal);
        foreach (var preset in new[] { "glass", "solid", "light", "contrast" })
        {
            Assert.Contains($"<option value=\"{preset}\"", page, StringComparison.Ordinal);
        }
    }

}
