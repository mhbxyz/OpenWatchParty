using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;
using Moq;
using OpenWatchParty.Plugin.Configuration;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

// Plugin.Instance is static, and the other tests run in parallel without one,
// so the tests that create a plugin run on their own, after them.
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class PluginInstanceCollection
{
    public const string Name = "Plugin instance";
}

/// <summary>
/// A plugin instance whose data folder lives in a temporary directory.
/// </summary>
internal sealed class TestPlugin : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"owp-plugin-{Guid.NewGuid():N}");

    public TestPlugin(PluginConfiguration? configuration = null)
    {
        Start(configuration);
    }

    public Plugin Plugin { get; private set; } = null!;

    /// <summary>What the plugin logged when it was created.</summary>
    public List<(LogLevel Level, string Message)> Log { get; } = new();

    public string SigningKeyPath => Path.Combine(Plugin.DataFolderPath, "keys", "signing-key.json");

    /// <summary>Creates the plugin again on the same folders, as when Jellyfin restarts.</summary>
    public void Restart(PluginConfiguration? configuration = null)
    {
        Log.Clear();
        Start(configuration);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    private void Start(PluginConfiguration? configuration)
    {
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(p => p.PluginsPath).Returns(Path.Combine(_root, "plugins"));
        paths.SetupGet(p => p.PluginConfigurationsPath).Returns(Path.Combine(_root, "configurations"));
        var serializer = new Mock<IXmlSerializer>();
        serializer.Setup(s => s.DeserializeFromFile(It.IsAny<Type>(), It.IsAny<string>()))
            .Returns(configuration ?? new PluginConfiguration());
        Plugin = new Plugin(paths.Object, serializer.Object, new ListLogger(Log));
    }

    private sealed class ListLogger(List<(LogLevel Level, string Message)> entries) : ILogger<Plugin>
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => entries.Add((logLevel, formatter(state, exception)));
    }
}
