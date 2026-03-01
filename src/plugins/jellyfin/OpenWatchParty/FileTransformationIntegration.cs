using System.Reflection;
using System.Runtime.Loader;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace OpenWatchParty.Plugin;

/// <summary>
/// Scheduled task that registers an index.html transformation with the
/// jellyfin-plugin-file-transformation plugin (if installed) to automatically
/// inject the OpenWatchParty client script.
/// </summary>
public class FileTransformationIntegration : IScheduledTask
{
    private const string ClientScriptPath = "/OpenWatchParty/ClientScript";
    private const string IndexPattern = "index.html";
    private const string HomeChunkPattern = @"home-html\..*\.chunk\.js";
    private const string HomeChunkInjectionGuard = "__owpClientScriptInjected";
    private const string HomeChunkInjectionSnippet = "\n;(function(){if(window.__owpClientScriptInjected)return;window.__owpClientScriptInjected=true;var s=document.createElement('script');s.src='/OpenWatchParty/ClientScript';s.defer=true;document.head.appendChild(s);}());\n";

    private readonly ILogger<FileTransformationIntegration> _logger;
    private static ILogger<FileTransformationIntegration>? s_logger;

    public string Name => "OpenWatchParty File Transformation Registration";
    public string Key => "OpenWatchPartyFileTransformation";
    public string Description => "Registers automatic script injection with the File Transformation plugin";
    public string Category => "OpenWatchParty";

    public FileTransformationIntegration(ILogger<FileTransformationIntegration> logger)
    {
        _logger = logger;
        s_logger = logger;
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        return new[]
        {
            new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger }
        };
    }

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        progress.Report(0);

        try
        {
            var ftAssembly = AssemblyLoadContext.All
                .SelectMany(ctx => ctx.Assemblies)
                .FirstOrDefault(asm => asm.FullName?.Contains("Jellyfin.Plugin.FileTransformation") ?? false);

            if (ftAssembly == null)
            {
                _logger.LogInformation("[OpenWatchParty] File Transformation plugin not found. "
                    + "Script injection will not be automatic — use Custom HTML instead.");
                progress.Report(100);
                return Task.CompletedTask;
            }

            var pluginInterface = ftAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            if (pluginInterface == null)
            {
                _logger.LogWarning("[OpenWatchParty] File Transformation plugin found but PluginInterface type not available. "
                    + "The installed version may be incompatible.");
                progress.Report(100);
                return Task.CompletedTask;
            }

            var registerMethod = pluginInterface.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
            if (registerMethod == null)
            {
                _logger.LogWarning("[OpenWatchParty] File Transformation plugin found but RegisterTransformation method not available. "
                    + "The installed version may be incompatible.");
                progress.Report(100);
                return Task.CompletedTask;
            }

            RegisterTransformation(registerMethod, IndexPattern, nameof(TransformIndexHtml));
            RegisterTransformation(registerMethod, HomeChunkPattern, nameof(TransformHomeChunkScript));

            _logger.LogInformation("[OpenWatchParty] Registered automatic client script injection transformations for index and home chunk files.");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[OpenWatchParty] Failed to register with File Transformation plugin. "
                + "Script injection will not be automatic — use Custom HTML instead.");
        }

        progress.Report(100);
        return Task.CompletedTask;
    }

    private void RegisterTransformation(MethodInfo registerMethod, string fileNamePattern, string callbackMethod)
    {
        var payload = new JObject
        {
            ["id"] = Plugin.PluginGuid,
            ["fileNamePattern"] = fileNamePattern,
            ["callbackAssembly"] = typeof(FileTransformationIntegration).Assembly.FullName,
            ["callbackClass"] = typeof(FileTransformationIntegration).FullName,
            ["callbackMethod"] = callbackMethod
        };

        registerMethod.Invoke(null, new object?[] { payload });

        _logger.LogInformation("[OpenWatchParty] Registered File Transformation pattern '{Pattern}' -> callback '{CallbackMethod}'.", fileNamePattern, callbackMethod);
    }

    /// <summary>
    /// Callback invoked by the File Transformation plugin to inject the
    /// OpenWatchParty script tag into index.html.
    /// </summary>
    public static string TransformIndexHtml(object payload)
    {
        var (contents, fileName) = GetPayloadData(payload);

        s_logger?.LogDebug("[OpenWatchParty] TransformIndexHtml invoked for file '{FileName}'.", fileName ?? "unknown");

        if (string.IsNullOrEmpty(contents) || contents.Contains(ClientScriptPath, StringComparison.Ordinal))
        {
            return contents ?? string.Empty;
        }

        var bodyEndIndex = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (bodyEndIndex >= 0)
        {
            s_logger?.LogDebug("[OpenWatchParty] Injected client script tag into index payload for file '{FileName}'.", fileName ?? "unknown");
            return contents.Insert(bodyEndIndex, "    <script src=\"/OpenWatchParty/ClientScript\" defer></script>\n");
        }

        s_logger?.LogWarning("[OpenWatchParty] Could not inject into file '{FileName}': '</body>' tag not found.", fileName ?? "unknown");

        return contents;
    }

    /// <summary>
    /// Callback invoked by the File Transformation plugin to inject a fallback
    /// loader into Jellyfin home chunk scripts.
    /// </summary>
    public static string TransformHomeChunkScript(object payload)
    {
        var (contents, fileName) = GetPayloadData(payload);

        s_logger?.LogDebug("[OpenWatchParty] TransformHomeChunkScript invoked for file '{FileName}'.", fileName ?? "unknown");

        if (string.IsNullOrEmpty(contents)
            || contents.Contains(ClientScriptPath, StringComparison.Ordinal)
            || contents.Contains(HomeChunkInjectionGuard, StringComparison.Ordinal))
        {
            return contents ?? string.Empty;
        }

        s_logger?.LogDebug("[OpenWatchParty] Appending fallback client script loader for file '{FileName}'.", fileName ?? "unknown");
        return contents + HomeChunkInjectionSnippet;
    }

    private static (string? Contents, string? FileName) GetPayloadData(object payload)
    {
        if (payload is JObject jobj)
        {
            return (jobj["contents"]?.ToString(), jobj["fileName"]?.ToString());
        }

        var payloadType = payload?.GetType();
        var contents = payloadType?
            .GetProperty("contents")?
            .GetValue(payload)?
            .ToString();
        var fileName = payloadType?
            .GetProperty("fileName")?
            .GetValue(payload)?
            .ToString();

        return (contents, fileName);
    }
}
