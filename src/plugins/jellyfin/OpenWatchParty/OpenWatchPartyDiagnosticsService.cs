using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
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
    // A session server's /health is a few hundred bytes.
    private const int HealthResponseMaxBytes = 64 * 1024;
    private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(5);
    private const string ConnectionFailed = "Connection failed for the configured session destination";

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
            using var client = new HttpClient(handler)
            {
                Timeout = CheckTimeout,
                MaxResponseContentBufferSize = HealthResponseMaxBytes,
            };
            var stopwatch = Stopwatch.StartNew();
            using var response = await client.GetAsync(health, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                checks.Add(Fail("session_http", $"Session server returned HTTP {(int)response.StatusCode}", "SESSION_HTTP"));
            }
            else if (ReadHealth(body) is var (sessionVersion, protocol))
            {
                checks.Add(protocol == 1
                    ? new DiagnosticCheck("session_http", "pass", $"Session {sessionVersion ?? "unknown"}, protocol {protocol}", null, stopwatch.ElapsedMilliseconds)
                    : new DiagnosticCheck("session_http", "fail", "Session protocol is incompatible", "PROTOCOL_VERSION", stopwatch.ElapsedMilliseconds));
            }
            else
            {
                // Behind a proxy that routes only /ws (and /invite) to the
                // session server, /health on that host belongs to another
                // application, Jellyfin itself in the documented setup. The
                // WebSocket the clients use tells whether the session server
                // answers there.
                checks.Add(await ProbeWebSocketAsync(websocket, cancellationToken).ConfigureAwait(false));
            }
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException or UriFormatException)
        {
            checks.Add(Fail("session_http", Redact(error.Message), "SESSION_UNREACHABLE"));
        }
        return Build(configuration, jellyfinVersion, injection, checks);
    }

    // A session server's /health is a JSON object with a protocol version; an
    // unusable version reads as protocol 0. Any other body comes from another
    // application and reads as null.
    private static (string? Version, int Protocol)? ReadHealth(string body)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(body);
        }
        catch (JsonException)
        {
            return null;
        }
        using var parsed = document;
        var root = parsed.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("protocol_version", out _)) return null;
        var version = root.TryGetProperty("version", out var versionValue) && versionValue.ValueKind == JsonValueKind.String
            ? versionValue.GetString()
            : null;
        var protocol = root.TryGetProperty("protocol_version", out var protocolValue)
            && protocolValue.ValueKind == JsonValueKind.Number
            && protocolValue.TryGetInt32(out var number)
            ? number
            : 0;
        return (version, protocol);
    }

    // Connects as a client would, without an Origin header (the server accepts
    // non-browser clients), and expects the server's first message,
    // client_hello.
    private static async Task<DiagnosticCheck> ProbeWebSocketAsync(Uri websocket, CancellationToken cancellationToken)
    {
        using var socket = new ClientWebSocket();
        socket.Options.CollectHttpResponseDetails = true;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(CheckTimeout);
        var stopwatch = Stopwatch.StartNew();
        try
        {
            await socket.ConnectAsync(websocket, timeout.Token).ConfigureAwait(false);
            var buffer = new byte[4096];
            var received = await socket.ReceiveAsync(buffer, timeout.Token).ConfigureAwait(false);
            var hello = received.MessageType == WebSocketMessageType.Text && IsClientHello(buffer.AsMemory(0, received.Count));
            var elapsed = stopwatch.ElapsedMilliseconds;
            try
            {
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is WebSocketException or OperationCanceledException)
            {
                // Leaving without the closing handshake is harmless here.
            }
            return hello
                ? new DiagnosticCheck("session_http", "pass", "Session server answers on the WebSocket; /health belongs to another service", null, elapsed)
                : Fail("session_http", "The session destination is not an OpenWatchParty session server", "SESSION_NOT_OWP");
        }
        catch (WebSocketException) when (socket.HttpStatusCode is not 0 and not HttpStatusCode.SwitchingProtocols)
        {
            return Fail("session_http", $"WebSocket handshake returned HTTP {(int)socket.HttpStatusCode}", "SESSION_WEBSOCKET");
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException or HttpRequestException)
        {
            return Fail("session_http", ConnectionFailed, "SESSION_UNREACHABLE");
        }
    }

    private static bool IsClientHello(ReadOnlyMemory<byte> message)
    {
        try
        {
            using var document = JsonDocument.Parse(message);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("type", out var type)
                && type.ValueKind == JsonValueKind.String
                && type.GetString() == "client_hello";
        }
        catch (JsonException)
        {
            return false;
        }
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
            return ConnectionFailed;
        }
        return message.Length <= 300 ? message : message[..300];
    }

    private static DiagnosticCheck Pass(string id, string summary) => new(id, "pass", summary);
    private static DiagnosticCheck Fail(string id, string summary, string code) => new(id, "fail", summary, code);
}
