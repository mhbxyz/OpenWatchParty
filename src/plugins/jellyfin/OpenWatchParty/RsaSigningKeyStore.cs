using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;

namespace OpenWatchParty.Plugin;

public sealed record PublicRsaJwk(string kty, string n, string e, string kid);
public sealed record SigningKeyInfo(string Issuer, PublicRsaJwk Jwk, bool Active);

internal sealed class RsaSigningKeyStore
{
    private sealed record StoredKey(int Version, string Issuer, string Kid, string PrivateKeyPem, bool Active);
    private readonly string _path;
    private readonly object _lock = new();

    internal RsaSigningKeyStore(string path) => _path = path;

    internal static RsaSigningKeyStore? ForPlugin() => Plugin.Instance == null
        ? null
        : new RsaSigningKeyStore(Path.Combine(Plugin.Instance.DataFolderPath, "keys", "signing-key.json"));

    internal SigningKeyInfo GetOrCreate()
    {
        lock (_lock)
        {
            var stored = Load() ?? Create();
            using var rsa = RSA.Create();
            rsa.ImportFromPem(stored.PrivateKeyPem);
            return new SigningKeyInfo(stored.Issuer, ToJwk(rsa, stored.Kid), stored.Active);
        }
    }

    internal void Activate(string kid)
    {
        lock (_lock)
        {
            var stored = Load() ?? throw new InvalidOperationException("Signing key has not been generated");
            if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(stored.Kid), Encoding.ASCII.GetBytes(kid)))
            {
                throw new InvalidOperationException("Signing key id does not match");
            }
            Save(stored with { Active = true });
        }
    }

    internal bool TryLoadActive(out string issuer, out string kid, out RSA? rsa)
    {
        lock (_lock)
        {
            var stored = Load();
            if (stored?.Active != true)
            {
                issuer = string.Empty;
                kid = string.Empty;
                rsa = null;
                return false;
            }
            rsa = RSA.Create();
            rsa.ImportFromPem(stored.PrivateKeyPem);
            issuer = stored.Issuer;
            kid = stored.Kid;
            return true;
        }
    }

    internal bool IsActive
    {
        get { lock (_lock) return Load()?.Active == true; }
    }

    private StoredKey? Load() => !File.Exists(_path)
        ? null
        : JsonSerializer.Deserialize<StoredKey>(File.ReadAllBytes(_path));

    private StoredKey Create()
    {
        using var rsa = RSA.Create(3072);
        var issuer = $"urn:openwatchparty:jellyfin:{Guid.NewGuid():D}";
        var kid = Thumbprint(rsa);
        var stored = new StoredKey(1, issuer, kid, rsa.ExportPkcs8PrivateKeyPem(), false);
        Save(stored);
        return stored;
    }

    private void Save(StoredKey stored)
    {
        var directory = Path.GetDirectoryName(_path)!;
        Directory.CreateDirectory(directory);
        var temporary = _path + ".tmp";
        File.WriteAllBytes(temporary, JsonSerializer.SerializeToUtf8Bytes(stored));
        using (var stream = new FileStream(temporary, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            stream.Flush(true);
        }
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(temporary, _path, true);
    }

    private static PublicRsaJwk ToJwk(RSA rsa, string kid)
    {
        var parameters = rsa.ExportParameters(false);
        return new PublicRsaJwk("RSA", Base64UrlEncoder.Encode(parameters.Modulus), Base64UrlEncoder.Encode(parameters.Exponent), kid);
    }

    private static string Thumbprint(RSA rsa)
    {
        var parameters = rsa.ExportParameters(false);
        var canonical = $"{{\"e\":\"{Base64UrlEncoder.Encode(parameters.Exponent)}\",\"kty\":\"RSA\",\"n\":\"{Base64UrlEncoder.Encode(parameters.Modulus)}\"}}";
        return Base64UrlEncoder.Encode(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }
}
