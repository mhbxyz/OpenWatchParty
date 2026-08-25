using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace OpenWatchParty.Plugin.Controllers;

[ApiController]
[Route("OpenWatchParty/SigningKey")]
[Authorize(Policy = Policies.RequiresElevation)]
public sealed class SigningKeyController : ControllerBase
{
    [HttpGet]
    public ActionResult<object> Get()
    {
        var key = RsaSigningKeyStore.ForPlugin()?.GetOrCreate();
        return key == null ? StatusCode(503) : Ok(new { issuer = key.Issuer, jwk = key.Jwk, active = key.Active });
    }

    [HttpPost("Activate")]
    public ActionResult Activate([FromBody] ActivateSigningKeyRequest request)
    {
        try
        {
            RsaSigningKeyStore.ForPlugin()?.Activate(request.Kid);
            return NoContent();
        }
        catch (InvalidOperationException error)
        {
            return Conflict(new { error = error.Message });
        }
    }
}

public sealed record ActivateSigningKeyRequest(string Kid);
