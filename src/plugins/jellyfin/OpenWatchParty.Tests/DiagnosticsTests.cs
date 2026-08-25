using System.Text.Json;
using OpenWatchParty.Plugin.Configuration;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class DiagnosticsTests
{
    [Fact]
    public void InjectionCountersAreThreadSafeAndSnapshotOnlyMetadata()
    {
        var diagnostics = new InjectionDiagnostics();
        Parallel.For(0, 100, _ => diagnostics.RecordIndexObserved());
        Parallel.For(0, 40, _ => diagnostics.RecordNativeInjection());

        var snapshot = diagnostics.Snapshot();

        Assert.Equal(100, snapshot.IndexResponsesObserved);
        Assert.Equal(40, snapshot.NativeInjectionsPerformed);
        Assert.NotNull(snapshot.LastNativeInjectionUtc);
    }

    [Fact]
    public void StatusIsReadyForValidConfigurationAndNeverContainsSecretOrHost()
    {
        const string secret = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=";
        var configuration = new PluginConfiguration
        {
            JwtSecret = secret,
            SessionServerUrl = "wss://private.example/ws"
        };
        var injection = new InjectionDiagnostics();
        injection.RecordIndexObserved();
        injection.RecordNativeInjection();

        var result = new OpenWatchPartyDiagnosticsService().CreateStatus(
            configuration,
            "10.11.3",
            injection.Snapshot());
        var json = JsonSerializer.Serialize(result);

        Assert.Equal("ready", result.OverallStatus);
        Assert.DoesNotContain(secret, json, StringComparison.Ordinal);
        Assert.DoesNotContain("private.example", json, StringComparison.Ordinal);
        Assert.Equal("10.11.0.0", result.JellyfinTargetAbi);
        Assert.Equal(1, result.ProtocolVersion);
    }

    [Fact]
    public void InvalidConfigurationIsBlocked()
    {
        var result = new OpenWatchPartyDiagnosticsService().CreateStatus(
            new PluginConfiguration(),
            "10.11.3",
            new InjectionDiagnostics().Snapshot());

        Assert.Equal("blocked", result.OverallStatus);
        Assert.Contains(result.Checks, check => check.Id == "authentication_configuration" && check.Status == "fail");
    }
}
