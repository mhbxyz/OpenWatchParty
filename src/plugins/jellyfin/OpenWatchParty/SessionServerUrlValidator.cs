namespace OpenWatchParty.Plugin;

internal static class SessionServerUrlValidator
{
    internal static bool TryNormalize(string? value, out string normalizedUrl, out string? error)
    {
        normalizedUrl = string.Empty;
        error = null;
        var candidate = value?.Trim() ?? string.Empty;
        if (candidate.Length == 0)
        {
            return true;
        }

        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeWs && uri.Scheme != Uri.UriSchemeWss)
            || string.IsNullOrEmpty(uri.Host))
        {
            error = "Session server URL must be an absolute ws:// or wss:// URL with a host";
            return false;
        }

        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            error = "Session server URL must not contain credentials";
            return false;
        }

        if (candidate.Contains('?') || candidate.Contains('#'))
        {
            error = "Session server URL must not contain a query string or fragment";
            return false;
        }

        normalizedUrl = uri.AbsoluteUri;
        return true;
    }
}
