using System.Diagnostics;
using System.Text.Json;
using OpenWatchParty.Plugin.Configuration;

namespace OpenWatchParty.Plugin;

public sealed record DiagnosticCheck(
    string Id,
    string Status,
    string Summary,
    string? Code = null,
    long? DurationMs = null);

public sealed record DiagnosticsResponse(
    string OverallStatus,
    string PluginVersion,
    string JellyfinVersion,
    string JellyfinTargetAbi,
    int ProtocolVersion,
    string AuthenticationMode,
    string SessionDestinationMode,
    InjectionSnapshot Injection,
    IReadOnlyList<DiagnosticCheck> Checks);

/// <summary>Builds redacted diagnostics without serializing plugin configuration.</summary>
public sealed class OpenWatchPartyDiagnosticsService
{
    public DiagnosticsResponse CreateStatus(
        PluginConfiguration configuration,
        string jellyfinVersion,
        InjectionSnapshot injection)
    {
        var checks = new List<DiagnosticCheck>();
        var authError = OpenWatchParty.Plugin.Controllers.OpenWatchPartyController
            .GetAuthenticationConfigurationError(configuration);
        checks.Add(authError == null
            ? Pass("authentication_configuration", "Authentication configuration is valid")
            : Fail("authentication_configuration", authError, "AUTH_CONFIGURATION"));

        var urlValid = SessionServerUrlValidator.TryNormalize(
            configuration.SessionServerUrl,
            out var normalized,
            out var urlError);
        if (urlValid && (normalized.Length > 0 || configuration.AllowAutoDetectedSessionServer))
        {
            checks.Add(Pass("session_destination", normalized.Length == 0
                ? "Same-host auto-detection is explicitly trusted"
                : "Explicit WebSocket destination is valid"));
        }
        else
        {
            checks.Add(Fail("session_destination", !string.IsNullOrEmpty(urlError)
                ? urlError
                : "Session destination is not configured", "SESSION_DESTINATION"));
        }

        checks.Add(injection.NativeInjectionsPerformed > 0
            ? Pass("native_injection", "Native client injection has been observed")
            : new DiagnosticCheck(
                "native_injection",
                "warning",
                "Native injection has not been observed since Jellyfin started"));

        return Build(configuration, jellyfinVersion, injection, checks);
    }

    public async Task<DiagnosticsResponse> RunAsync(
        PluginConfiguration configuration,
        string jellyfinVersion,
        InjectionSnapshot injection,
        string requestOrigin,
        CancellationToken cancellationToken)
    {
        var status = CreateStatus(configuration, jellyfinVersion, injection);
        var checks = status.Checks.ToList();
        try
        {
            var websocket = ResolveWebSocketUrl(configuration, requestOrigin);
            var health = ToHealthUrl(websocket);
            using var handler = new HttpClientHandler { AllowAutoRedirect = false };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
            var stopwatch = Stopwatch.StartNew();
            using var response = await client.GetAsync(health, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                checks.Add(Fail("session_http", $"Session server returned HTTP {(int)response.StatusCode}", "SESSION_HTTP"));
            }
            else
            {
                using var document = JsonDocument.Parse(body);
                var root = document.RootElement;
                var sessionVersion = root.TryGetProperty("version", out var version) ? version.GetString() : null;
                var protocol = root.TryGetProperty("protocol_version", out var protocolValue)
                    ? protocolValue.GetInt32()
                    : 0;
                checks.Add(protocol == 1
                    ? new DiagnosticCheck("session_http", "pass", $"Session {sessionVersion ?? "unknown"}, protocol {protocol}", null, stopwatch.ElapsedMilliseconds)
                    : new DiagnosticCheck("session_http", "fail", "Session protocol is incompatible", "PROTOCOL_VERSION", stopwatch.ElapsedMilliseconds));
            }
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException or UriFormatException)
        {
            checks.Add(Fail("session_http", Redact(error.Message), "SESSION_UNREACHABLE"));
        }
        return Build(configuration, jellyfinVersion, injection, checks);
    }

    private static DiagnosticsResponse Build(
        PluginConfiguration configuration,
        string jellyfinVersion,
        InjectionSnapshot injection,
        IReadOnlyList<DiagnosticCheck> checks)
    {
        var overall = checks.Any(check => check.Status == "fail")
            ? "blocked"
            : checks.Any(check => check.Status == "warning") ? "degraded" : "ready";
        return new DiagnosticsResponse(
            overall,
            Plugin.PluginVersion,
            jellyfinVersion,
            Plugin.TargetAbi,
            1,
            string.IsNullOrWhiteSpace(configuration.JwtSecret) ? "insecure" : "jwt",
            string.IsNullOrWhiteSpace(configuration.SessionServerUrl) ? "automatic" : "explicit",
            injection,
            checks);
    }

    private static Uri ResolveWebSocketUrl(PluginConfiguration configuration, string requestOrigin)
    {
        if (!string.IsNullOrWhiteSpace(configuration.SessionServerUrl))
        {
            return new Uri(configuration.SessionServerUrl);
        }
        var origin = new Uri(requestOrigin);
        return new UriBuilder(origin.Scheme == "https" ? "wss" : "ws", origin.Host, 3000, "/ws").Uri;
    }

    private static Uri ToHealthUrl(Uri websocket)
    {
        var builder = new UriBuilder(websocket) {
            Scheme = websocket.Scheme == "wss" ? "https" : "http",
            Port = websocket.Port,
            Query = string.Empty,
            Fragment = string.Empty,
        };
        builder.Path = builder.Path.EndsWith("/ws", StringComparison.Ordinal)
            ? builder.Path[..^2] + "health"
            : "/health";
        return builder.Uri;
    }

    private static string Redact(string message)
    {
        if (Uri.TryCreate(message, UriKind.Absolute, out _))
        {
            return "Connection failed for the configured session destination";
        }
        return message.Length <= 300 ? message : message[..300];
    }

    private static DiagnosticCheck Pass(string id, string summary) => new(id, "pass", summary);
    private static DiagnosticCheck Fail(string id, string summary, string code) => new(id, "fail", summary, code);
}
