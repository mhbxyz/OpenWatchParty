using System.Net;
using System.Net.Sockets;
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
    [InlineData("[]", "fail", "PROTOCOL_VERSION", "Session protocol is incompatible")]
    [InlineData("\"ok\"", "fail", "PROTOCOL_VERSION", "Session protocol is incompatible")]
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

    // Serves one /health response on a loopback port and runs the diagnostics
    // against it, as the configuration page's "Run diagnostics" does.
    private static async Task<DiagnosticCheck> RunAgainst(string body)
    {
        var port = FreePort();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        var serve = Task.Run(async () =>
        {
            var context = await listener.GetContextAsync();
            var bytes = Encoding.UTF8.GetBytes(body);
            context.Response.StatusCode = 200;
            context.Response.ContentType = "application/json";
            try
            {
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }
            catch (HttpListenerException)
            {
                // The client stops reading an oversized body.
            }
        });
        var configuration = new PluginConfiguration
        {
            JwtSecret = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=",
            SessionServerUrl = $"ws://127.0.0.1:{port}/ws"
        };

        var result = await new OpenWatchPartyDiagnosticsService().RunAsync(
            configuration, "12.0.0", new InjectionDiagnostics().Snapshot(), "http://localhost", CancellationToken.None);
        await serve;

        return Assert.Single(result.Checks, check => check.Id == "session_http");
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
