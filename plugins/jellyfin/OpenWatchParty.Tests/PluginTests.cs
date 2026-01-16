using Xunit;

namespace OpenWatchParty.Plugin.Tests;

/// <summary>
/// Tests for the Plugin class constants and static members.
/// </summary>
public class PluginTests
{
    [Fact]
    public void PluginGuid_IsValidGuid()
    {
        Assert.True(Guid.TryParse(Plugin.PluginGuid, out _), "PluginGuid should be a valid GUID");
    }

    [Fact]
    public void PluginGuid_HasExpectedValue()
    {
        // This test ensures the GUID doesn't accidentally change
        Assert.Equal("0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d", Plugin.PluginGuid);
    }

    [Fact]
    public void PluginGuid_MatchesExpectedFormat()
    {
        // GUID should be lowercase and in standard format
        var guid = new Guid(Plugin.PluginGuid);
        Assert.Equal(Plugin.PluginGuid, guid.ToString());
    }

    [Fact]
    public void PluginVersion_IsNotEmpty()
    {
        Assert.False(string.IsNullOrEmpty(Plugin.PluginVersion), "PluginVersion should not be empty");
    }

    [Fact]
    public void PluginVersion_HasValidFormat()
    {
        // Version should be in X.Y.Z format
        var parts = Plugin.PluginVersion.Split('.');
        Assert.True(parts.Length >= 2, "Version should have at least major.minor parts");
        Assert.All(parts, part => Assert.True(int.TryParse(part, out _), $"Version part '{part}' should be numeric"));
    }
}
