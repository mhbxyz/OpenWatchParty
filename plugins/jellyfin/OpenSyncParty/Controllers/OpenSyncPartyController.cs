using Microsoft.AspNetCore.Mvc;

namespace OpenSyncParty.Plugin.Controllers;

[ApiController]
[Route("OpenSyncParty")]
public class OpenSyncPartyController : ControllerBase
{
    [HttpGet("ClientScript")]
    [Produces("text/javascript")]
    public ActionResult GetClientScript()
    {
        var assembly = typeof(OpenSyncPartyController).Assembly;
        var resourceName = "OpenSyncParty.Plugin.Web.plugin.js";
        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null) return NotFound();
        using var reader = new StreamReader(stream);
        
        // Inject server URL from config if needed, or default to localhost:3000 for dev
        var script = reader.ReadToEnd();
        // In a real plugin we might want to template the WS URL here
        
        return Content(script, "text/javascript");
    }
}
