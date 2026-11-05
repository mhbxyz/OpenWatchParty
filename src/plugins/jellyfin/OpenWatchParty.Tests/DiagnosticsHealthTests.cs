using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using OpenWatchParty.Plugin.Configuration;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class DiagnosticsHealthTests
{
    [Theory]
    [InlineData("{\"status\":\"ok\",\"version\":\"0.8.0\",\"protocol_version\":1}", "pass", null, "Session 0.8.0, protocol 1")]
    [InlineData("{\"version\":1,\"protocol_version\":1}", "pass", null, "Session unknown, protocol 1")]
    [InlineData("{\"version\":\"0.8.0\",\"protocol_version\":\"1\"}", "fail", "PROTOCOL_VERSION", "Session protocol is incompatible")]
    [InlineData("{\"version\":\"0.8.0\",\"protocol_version\":3000000000}", "fail", "PROTOCOL_VERSION", "Session protocol is incompatible")]
    public async Task HealthBodyOfAnyShapeIsReportedAsACheck(string body, string status, string? code, string summary)
    {
        var check = await RunAgainst(body);

        Assert.Equal(status, check.Status);
        Assert.Equal(code, check.Code);
        Assert.Equal(summary, check.Summary);
    }

    [Fact]
    public async Task OversizedHealthBodyIsReportedAsUnreachable()
    {
        var check = await RunAgainst("{\"version\":\"" + new string('x', 70 * 1024) + "\",\"protocol_version\":1}");

        Assert.Equal("fail", check.Status);
        Assert.Equal("SESSION_UNREACHABLE", check.Code);
    }

    // Behind a proxy that sends only /ws to the session server, /health on the
    // same host belongs to another application (Jellyfin answers "Healthy").
    // The WebSocket the clients use tells whether the session server answers.
    [Theory]
    [InlineData("Healthy")]
    [InlineData("[]")]
    [InlineData("\"ok\"")]
    [InlineData("{\"status\":\"ok\"}")]
    public async Task ForeignHealthIsCheckedOnTheWebSocket(string body)
    {
        var check = await RunAgainst(body, SendText("{\"type\":\"client_hello\",\"client\":\"c\",\"payload\":{\"client_id\":\"c\"},\"ts\":1,\"server_ts\":1}"));

        Assert.Equal("pass", check.Status);
        Assert.Null(check.Code);
        Assert.Equal("Session server answers on the WebSocket; /health belongs to another service", check.Summary);
        Assert.NotNull(check.DurationMs);
    }

    [Fact]
    public async Task ForeignHealthAndARefusedWebSocketReportTheHandshake()
    {
        var check = await RunAgainst("Healthy", context =>
        {
            context.Response.StatusCode = 403;
            context.Response.Close();
            return Task.CompletedTask;
        });

        Assert.Equal("fail", check.Status);
        Assert.Equal("SESSION_WEBSOCKET", check.Code);
        Assert.Equal("WebSocket handshake returned HTTP 403", check.Summary);
    }

    [Fact]
    public async Task ForeignHealthAndAnotherWebSocketServerAreNotASessionServer()
    {
        var check = await RunAgainst("Healthy", SendText("{\"type\":\"welcome\"}"));

        Assert.Equal("fail", check.Status);
        Assert.Equal("SESSION_NOT_OWP", check.Code);
        Assert.Equal("The session destination is not an OpenWatchParty session server", check.Summary);
    }

    // A WebSocket that sends one text message and waits for the client to close.
    private static Func<HttpListenerContext, Task> SendText(string message) => async context =>
    {
        var accepted = await context.AcceptWebSocketAsync(null);
        var socket = accepted.WebSocket;
        await socket.SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, true, CancellationToken.None);
        try
        {
            await socket.ReceiveAsync(new byte[256], CancellationToken.None);
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
        }
        catch (WebSocketException)
        {
            // The client may leave without a closing handshake.
        }
    };

    // Serves /health (and /ws when given) on a loopback port and runs the
    // diagnostics against it, as the configuration page's "Run diagnostics" does.
    private static async Task<DiagnosticCheck> RunAgainst(string body, Func<HttpListenerContext, Task>? webSocket = null)
    {
        var port = FreePort();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        var handlers = new List<Task>();
        var serve = Task.Run(async () =>
        {
            while (listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await listener.GetContextAsync();
                }
                catch (Exception error) when (error is HttpListenerException or ObjectDisposedException)
                {
                    return;
                }
                handlers.Add(context.Request.Url?.AbsolutePath == "/ws" && webSocket != null
                    ? webSocket(context)
                    : ServeHealth(context, body));
            }
        });
        var configuration = new PluginConfiguration
        {
            JwtSecret = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=",
            SessionServerUrl = $"ws://127.0.0.1:{port}/ws"
        };

        var result = await new OpenWatchPartyDiagnosticsService().RunAsync(
            configuration, "12.0.0", new InjectionDiagnostics().Snapshot(), "http://localhost", CancellationToken.None);
        await Task.WhenAll(handlers.ToArray());
        listener.Stop();
        await serve;

        return Assert.Single(result.Checks, check => check.Id == "session_http");
    }

    private static async Task ServeHealth(HttpListenerContext context, string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        context.Response.StatusCode = 200;
        context.Response.ContentType = body.StartsWith('{') || body.StartsWith('[') || body.StartsWith('"') ? "application/json" : "text/plain";
        try
        {
            await context.Response.OutputStream.WriteAsync(bytes);
            context.Response.Close();
        }
        catch (HttpListenerException)
        {
            // The client stops reading an oversized body.
        }
    }

    private static int FreePort()
    {
        var socket = new TcpListener(IPAddress.Loopback, 0);
        socket.Start();
        var port = ((IPEndPoint)socket.LocalEndpoint).Port;
        socket.Stop();
        return port;
    }
}
