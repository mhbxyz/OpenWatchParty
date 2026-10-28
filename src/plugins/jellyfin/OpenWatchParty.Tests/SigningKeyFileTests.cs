using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using OpenWatchParty.Plugin.Configuration;
using OpenWatchParty.Plugin.Controllers;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

[Collection(PluginInstanceCollection.Name)]
public sealed class SigningKeyFileTests
{
    private const string ValidSecret = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=";
    private const string UnreadableKey = "The RSA signing key file (keys/signing-key.json) cannot be read; restore it or remove it";

    [Theory]
    [InlineData("{ not json")]
    [InlineData("")]
    [InlineData("[]")]
    public void UnreadableKeyFileBlocksIssuanceWithAClearError(string content)
    {
        using var host = new TestPlugin();
        Directory.CreateDirectory(Path.GetDirectoryName(host.SigningKeyPath)!);
        File.WriteAllText(host.SigningKeyPath, content);
        // A valid shared secret does not take over: the session server may only trust the key.
        var config = new PluginConfiguration { JwtSecret = ValidSecret, SessionServerUrl = "wss://session.example/ws" };

        Assert.Equal(UnreadableKey, OpenWatchPartyController.GetAuthenticationConfigurationError(config));

        var status = new OpenWatchPartyDiagnosticsService().CreateStatus(config, "12.0.0", new InjectionDiagnostics().Snapshot());
        var check = Assert.Single(status.Checks, check => check.Id == "authentication_configuration");
        Assert.Equal("fail", check.Status);
        Assert.Equal(UnreadableKey, check.Summary);

        var result = Assert.IsType<ObjectResult>(TokenResponseTests.CreateController().GetTokenForConfiguration(config));
        Assert.Equal(503, result.StatusCode);
        using var body = JsonDocument.Parse(JsonSerializer.Serialize(result.Value));
        Assert.Equal(UnreadableKey, body.RootElement.GetProperty("error").GetString());
        Assert.True(body.RootElement.GetProperty("configuration_error").GetBoolean());
    }

    [Fact]
    public void MissingKeyFileLeavesTheSharedSecretInCharge()
    {
        using var host = new TestPlugin();
        var config = new PluginConfiguration { JwtSecret = ValidSecret };

        Assert.False(File.Exists(host.SigningKeyPath));
        Assert.Null(OpenWatchPartyController.GetAuthenticationConfigurationError(config));
    }
}
