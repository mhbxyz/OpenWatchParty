using System.Reflection;
using System.Runtime.Loader;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace OpenWatchParty.Plugin;

/// <summary>
/// Scheduled task that injects the OpenWatchParty client script into index.html.
/// First attempts to register with the File Transformation plugin (if installed).
/// Falls back to direct injection into the physical index.html file.
/// </summary>
public class FileTransformationIntegration : IScheduledTask
{
    private const string ClientScriptPath = "../OpenWatchParty/ClientScript";
    private const string ScriptTag = $"<script src=\"{ClientScriptPath}\" defer></script>";
    private readonly ILogger<FileTransformationIntegration> _logger;

    public string Name => "OpenWatchParty File Transformation Registration";
    public string Key => "OpenWatchPartyFileTransformation";
    public string Description => "Registers automatic script injection with the File Transformation plugin";
    public string Category => "OpenWatchParty";

    public FileTransformationIntegration(ILogger<FileTransformationIntegration> logger)
    {
        _logger = logger;
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        return new[]
        {
            new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger }
        };
    }

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        progress.Report(0);

        if (TryRegisterFileTransformation())
        {
            progress.Report(100);
            return;
        }

        // File Transformation unavailable — inject directly into the physical file
        await InjectIntoIndexHtmlFileAsync(cancellationToken).ConfigureAwait(false);

        progress.Report(100);
    }

    /// <summary>
    /// Attempts to register with the File Transformation plugin via reflection.
    /// Returns true if registration succeeded.
    /// </summary>
    private bool TryRegisterFileTransformation()
    {
        try
        {
            var ftAssembly = AssemblyLoadContext.All
                .SelectMany(ctx => ctx.Assemblies)
                .FirstOrDefault(asm => asm.FullName?.Contains("Jellyfin.Plugin.FileTransformation") ?? false);

            if (ftAssembly == null)
            {
                return false;
            }

            var pluginInterface = ftAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            if (pluginInterface == null)
            {
                _logger.LogWarning("[OpenWatchParty] File Transformation plugin found but PluginInterface type not available. "
                    + "The installed version may be incompatible.");
                return false;
            }

            var registerMethod = pluginInterface.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
            if (registerMethod == null)
            {
                _logger.LogWarning("[OpenWatchParty] File Transformation plugin found but RegisterTransformation method not available. "
                    + "The installed version may be incompatible.");
                return false;
            }

            var payload = new JObject
            {
                ["id"] = Guid.Parse(Plugin.PluginGuid),
                ["fileNamePattern"] = @"^index\.html$",
                ["callbackAssembly"] = typeof(FileTransformationIntegration).Assembly.FullName,
                ["callbackClass"] = typeof(FileTransformationIntegration).FullName,
                ["callbackMethod"] = nameof(TransformIndexHtml)
            };

            registerMethod.Invoke(null, new object?[] { payload });

            _logger.LogInformation("[OpenWatchParty] Registered index.html transformation with File Transformation plugin.");
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[OpenWatchParty] Failed to register with File Transformation plugin. "
                + "Falling back to direct index.html injection.");
            return false;
        }
    }

    /// <summary>
    /// Directly injects the script tag into the physical index.html file
    /// in Jellyfin's web directory. This is the fallback when File Transformation
    /// is unavailable (e.g., after an in-process restart on Jellyfin 10.11.6+).
    /// </summary>
    private async Task InjectIntoIndexHtmlFileAsync(CancellationToken cancellationToken)
    {
        var webDir = Environment.GetEnvironmentVariable("JELLYFIN_WEB_DIR");
        if (string.IsNullOrEmpty(webDir))
        {
            _logger.LogInformation("[OpenWatchParty] File Transformation plugin not available and JELLYFIN_WEB_DIR not set. "
                + "Script injection will not be automatic — use Custom HTML instead.");
            return;
        }

        var indexPath = Path.Combine(webDir, "index.html");
        if (!File.Exists(indexPath))
        {
            _logger.LogWarning("[OpenWatchParty] index.html not found at '{Path}'. "
                + "Script injection will not be automatic — use Custom HTML instead.", indexPath);
            return;
        }

        try
        {
            var html = await File.ReadAllTextAsync(indexPath, cancellationToken).ConfigureAwait(false);
            var modified = InjectScript(html);

            if (modified == html)
            {
                _logger.LogInformation("[OpenWatchParty] Client script already present in {Path}.", indexPath);
                return;
            }

            await File.WriteAllTextAsync(indexPath, modified, cancellationToken).ConfigureAwait(false);
            _logger.LogInformation("[OpenWatchParty] Injected client script into {Path} (direct fallback).", indexPath);
        }
        catch (UnauthorizedAccessException)
        {
            _logger.LogInformation("[OpenWatchParty] No write permission to {Path}. "
                + "Using controller-level index.html interception instead.", indexPath);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[OpenWatchParty] Failed to inject script into {Path}. "
                + "Using controller-level index.html interception instead.", indexPath);
        }
    }

    /// <summary>
    /// Core injection logic: inserts the script tag before &lt;/body&gt; or &lt;/head&gt;
    /// if the script is not already present.
    /// </summary>
    internal static string InjectScript(string contents)
    {
        if (string.IsNullOrEmpty(contents) || contents.Contains("OpenWatchParty/ClientScript", StringComparison.OrdinalIgnoreCase))
        {
            return contents ?? string.Empty;
        }

        var bodyEndIndex = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (bodyEndIndex >= 0)
        {
            return contents.Insert(bodyEndIndex, $"    {ScriptTag}\n");
        }

        var headEndIndex = contents.LastIndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        if (headEndIndex >= 0)
        {
            return contents.Insert(headEndIndex, $"    {ScriptTag}\n");
        }

        return contents;
    }

    /// <summary>
    /// Callback invoked by the File Transformation plugin to inject the
    /// OpenWatchParty script tag into index.html.
    /// </summary>
    public static string TransformIndexHtml(object payload)
    {
        var contents = payload is JObject jobj
            ? jobj["contents"]?.ToString()
                ?? jobj["Contents"]?.ToString()
                ?? jobj["content"]?.ToString()
                ?? jobj["Content"]?.ToString()
            : payload?.GetType()
                .GetProperty("contents")?
                .GetValue(payload)?
                .ToString()
                ?? payload?.GetType()
                    .GetProperty("Contents")?
                    .GetValue(payload)?
                    .ToString()
                ?? payload?.GetType()
                    .GetProperty("content")?
                    .GetValue(payload)?
                    .ToString()
                ?? payload?.GetType()
                    .GetProperty("Content")?
                .GetValue(payload)?
                .ToString();

        return InjectScript(contents ?? string.Empty);
    }
}
