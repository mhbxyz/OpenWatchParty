using Microsoft.Extensions.Logging;
using OpenWatchParty.Plugin.Configuration;
using OpenWatchParty.Plugin.Controllers;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

[Collection(PluginInstanceCollection.Name)]
public sealed class AuthenticationModeTests
{
    private const string ValidSecret = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=";

    [Theory]
    [InlineData("")]
    [InlineData("not-a-valid-secret")]
    public void ActiveRsaKeyIsReportedAsWorkingWhateverTheSharedSecret(string secret)
    {
        using var host = new TestPlugin();
        var store = new RsaSigningKeyStore(host.SigningKeyPath);
        store.Activate(store.GetOrCreate().Jwk.kid);
        var config = new PluginConfiguration { JwtSecret = secret };

        host.Restart(config);

        Assert.Null(OpenWatchPartyController.GetAuthenticationConfigurationError(config));
        Assert.DoesNotContain(host.Log, entry => entry.Level >= LogLevel.Warning);
        Assert.Contains(host.Log, entry => entry.Message == "[OpenWatchParty] JWT authentication is enabled with the RSA signing key.");
        var status = CreateStatus(config);
        Assert.Equal("jwt", status.AuthenticationMode);
        Assert.Equal("pass", AuthenticationCheck(status).Status);
    }

    [Fact]
    public void KeyThatIsNotActiveYetLeavesTheSharedSecretInCharge()
    {
        using var host = new TestPlugin();
        new RsaSigningKeyStore(host.SigningKeyPath).GetOrCreate();
        var config = new PluginConfiguration();

        host.Restart(config);

        Assert.Equal("JWT authentication is not configured", OpenWatchPartyController.GetAuthenticationConfigurationError(config));
        Assert.Contains(host.Log, entry => entry.Level == LogLevel.Error && entry.Message.StartsWith("[OpenWatchParty] JwtSecret is not configured.", StringComparison.Ordinal));
        Assert.Equal("insecure", CreateStatus(config).AuthenticationMode);
    }

    [Theory]
    [InlineData(ValidSecret)]
    [InlineData("")]
    public void UnreadableKeyIsLoggedAsBlockedAtStartup(string secret)
    {
        using var host = new TestPlugin();
        Directory.CreateDirectory(Path.GetDirectoryName(host.SigningKeyPath)!);
        File.WriteAllText(host.SigningKeyPath, "{ not json");
        var config = new PluginConfiguration { JwtSecret = secret };

        host.Restart(config);

        var error = Assert.Single(host.Log, entry => entry.Level == LogLevel.Error);
        Assert.Contains("RSA signing key file (keys/signing-key.json) cannot be read", error.Message, StringComparison.Ordinal);
        var status = CreateStatus(config);
        Assert.Equal("jwt", status.AuthenticationMode);
        Assert.Equal("fail", AuthenticationCheck(status).Status);
    }

    [Theory]
    [InlineData(ValidSecret, false, "jwt")]
    [InlineData("", true, "insecure")]
    public void WithoutAKeyTheModeFollowsTheSharedSecret(string secret, bool allowInsecure, string mode)
    {
        using var host = new TestPlugin();
        var config = new PluginConfiguration { JwtSecret = secret, AllowInsecureNoAuth = allowInsecure };

        Assert.Equal(mode, CreateStatus(config).AuthenticationMode);
    }

    private static DiagnosticsResponse CreateStatus(PluginConfiguration config) =>
        new OpenWatchPartyDiagnosticsService().CreateStatus(config, "12.0.0", new InjectionDiagnostics().Snapshot());

    private static DiagnosticCheck AuthenticationCheck(DiagnosticsResponse status) =>
        Assert.Single(status.Checks, check => check.Id == "authentication_configuration");
}
