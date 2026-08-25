using MediaBrowser.Common.Api;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OpenWatchParty.Plugin.Configuration;

namespace OpenWatchParty.Plugin.Controllers;

[ApiController]
[Route("OpenWatchParty/Diagnostics")]
[Authorize(Policy = Policies.RequiresElevation)]
public sealed class OpenWatchPartyDiagnosticsController : ControllerBase
{
    private readonly IServerApplicationHost _applicationHost;
    private readonly OpenWatchPartyDiagnosticsService _diagnostics;
    private readonly InjectionDiagnostics _injection;

    public OpenWatchPartyDiagnosticsController(
        IServerApplicationHost applicationHost,
        OpenWatchPartyDiagnosticsService diagnostics,
        InjectionDiagnostics injection)
    {
        _applicationHost = applicationHost;
        _diagnostics = diagnostics;
        _injection = injection;
    }

    [HttpGet("Status")]
    public ActionResult<DiagnosticsResponse> Status()
    {
        var configuration = Plugin.Instance?.Configuration;
        if (configuration == null)
        {
            return StatusCode(503);
        }
        return Ok(_diagnostics.CreateStatus(
            configuration,
            _applicationHost.ApplicationVersionString,
            _injection.Snapshot()));
    }

    [HttpPost("Run")]
    public async Task<ActionResult<DiagnosticsResponse>> Run(CancellationToken cancellationToken)
    {
        var configuration = Plugin.Instance?.Configuration;
        if (configuration == null)
        {
            return StatusCode(503);
        }
        var origin = $"{Request.Scheme}://{Request.Host}";
        return Ok(await _diagnostics.RunAsync(
            configuration,
            _applicationHost.ApplicationVersionString,
            _injection.Snapshot(),
            origin,
            cancellationToken).ConfigureAwait(false));
    }
}
