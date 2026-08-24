namespace OpenWatchParty.Plugin;

internal static class ClientScriptInjection
{
    internal const string Marker = "OpenWatchParty/ClientScript";
    internal const string ScriptPath = "../OpenWatchParty/ClientScript";
    internal const string ScriptTag = "<script src=\"../OpenWatchParty/ClientScript\" defer></script>";

    internal static string InjectIntoHtml(string? contents)
    {
        if (string.IsNullOrEmpty(contents)
            || contents.Contains(Marker, StringComparison.OrdinalIgnoreCase))
        {
            return contents ?? string.Empty;
        }

        var bodyEndIndex = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return bodyEndIndex < 0
            ? contents
            : contents.Insert(bodyEndIndex, $"    {ScriptTag}\n");
    }
}
