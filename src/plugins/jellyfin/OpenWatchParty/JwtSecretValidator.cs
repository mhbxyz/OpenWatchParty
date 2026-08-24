using System.Text;

namespace OpenWatchParty.Plugin;

internal static class JwtSecretValidator
{
    internal const int MinimumLength = 32;
    internal const double MinimumEntropyBits = 80;

    internal static bool TryValidate(string? secret, out string error)
    {
        if (string.IsNullOrWhiteSpace(secret))
        {
            error = "JWT secret is required";
            return false;
        }
        if (secret.Any(char.IsWhiteSpace))
        {
            error = "JWT secret must not contain whitespace";
            return false;
        }

        var symbols = secret.EnumerateRunes().ToArray();
        if (symbols.Length < MinimumLength)
        {
            error = $"JWT secret must contain at least {MinimumLength} Unicode characters";
            return false;
        }

        if (!TryDecode(secret, out var decoded) || decoded.Length < 32)
        {
            error = "JWT secret must be Base64 or Base64URL encoded and represent at least 32 random bytes";
            return false;
        }

        var frequencies = new Dictionary<byte, int>();
        foreach (var symbol in decoded)
        {
            frequencies[symbol] = frequencies.GetValueOrDefault(symbol) + 1;
        }
        var entropyPerSymbol = frequencies.Values.Sum(count =>
        {
            var probability = (double)count / decoded.Length;
            return -probability * Math.Log2(probability);
        });
        var entropyBits = entropyPerSymbol * decoded.Length;
        if (entropyBits < MinimumEntropyBits)
        {
            error = $"JWT secret has {entropyBits:F1} bits of estimated diversity; at least {MinimumEntropyBits:F0} bits are required";
            return false;
        }
        if (HasObviousSequence(Encoding.ASCII.GetBytes(secret)) || HasObviousSequence(decoded))
        {
            error = "JWT secret contains an obvious sequential pattern";
            return false;
        }

        error = string.Empty;
        return true;
    }

    private static bool TryDecode(string secret, out byte[] decoded)
    {
        var hasStandardSymbols = secret.Contains('+') || secret.Contains('/');
        var hasUrlSafeSymbols = secret.Contains('-') || secret.Contains('_');
        if (hasStandardSymbols && hasUrlSafeSymbols)
        {
            decoded = Array.Empty<byte>();
            return false;
        }

        var normalized = hasUrlSafeSymbols
            ? secret.Replace('-', '+').Replace('_', '/')
            : secret;
        var remainder = normalized.Length % 4;
        if (remainder == 1 || (hasStandardSymbols && remainder != 0))
        {
            decoded = Array.Empty<byte>();
            return false;
        }
        if (remainder > 0)
        {
            normalized = normalized.PadRight(normalized.Length + (4 - remainder), '=');
        }

        try
        {
            decoded = Convert.FromBase64String(normalized);
            return true;
        }
        catch (FormatException)
        {
            decoded = Array.Empty<byte>();
            return false;
        }
    }

    private static bool HasObviousSequence(byte[] decoded)
    {
        for (var index = 0; index <= decoded.Length - 4; index++)
        {
            var ascending = true;
            var descending = true;
            for (var offset = 1; offset < 4; offset++)
            {
                ascending &= decoded[index + offset] == decoded[index + offset - 1] + 1;
                descending &= decoded[index + offset - 1] == decoded[index + offset] + 1;
            }
            if (ascending || descending)
            {
                return true;
            }
        }

        return false;
    }
}
