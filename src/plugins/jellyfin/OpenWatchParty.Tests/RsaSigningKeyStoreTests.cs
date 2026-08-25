using System.IdentityModel.Tokens.Jwt;
using System.Security.Cryptography;
using Microsoft.IdentityModel.Tokens;
using OpenWatchParty.Plugin.Controllers;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class RsaSigningKeyStoreTests
{
    [Fact]
    public void ConcurrentStoreInstancesReuseOneKey()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"owp-rsa-race-{Guid.NewGuid():N}");
        var path = Path.Combine(directory, "signing-key.json");
        try
        {
            var keys = ParallelEnumerable.Range(0, 16)
                .Select(_ => new RsaSigningKeyStore(path).GetOrCreate().Jwk.kid)
                .ToArray();
            Assert.Single(keys.Distinct(StringComparer.Ordinal));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void KeyPersistsActivatesAndSignsVerifiableRs256Tokens()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"owp-rsa-{Guid.NewGuid():N}");
        var path = Path.Combine(directory, "signing-key.json");
        try
        {
            var store = new RsaSigningKeyStore(path);
            var first = store.GetOrCreate();
            var second = new RsaSigningKeyStore(path).GetOrCreate();
            Assert.Equal(first.Issuer, second.Issuer);
            Assert.Equal(first.Jwk.kid, second.Jwk.kid);
            Assert.False(first.Active);

            store.Activate(first.Jwk.kid);
            Assert.True(store.TryLoadActive(out var issuer, out var kid, out var rsa));
            Assert.NotNull(rsa);
            using (rsa)
            {
                var token = OpenWatchPartyController.BuildToken(
                    "user", "User", issuer, "OpenWatchParty", 3600,
                    new SigningCredentials(new RsaSecurityKey(rsa!) { KeyId = kid }, SecurityAlgorithms.RsaSha256),
                    kid);
                using var publicRsa = RSA.Create();
                publicRsa.ImportParameters(rsa!.ExportParameters(false));
                var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
                var principal = handler.ValidateToken(token, new TokenValidationParameters
                {
                    ValidateIssuerSigningKey = true,
                    IssuerSigningKey = new RsaSecurityKey(publicRsa),
                    ValidateIssuer = true,
                    ValidIssuer = issuer,
                    ValidateAudience = true,
                    ValidAudience = "OpenWatchParty",
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.Zero,
                    ValidAlgorithms = [SecurityAlgorithms.RsaSha256]
                }, out var validated);
                Assert.Equal("RS256", ((JwtSecurityToken)validated).Header.Alg);
                Assert.Equal(kid, ((JwtSecurityToken)validated).Header.Kid);
                Assert.Equal("user", principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value);
            }
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(
                    UnixFileMode.UserRead | UnixFileMode.UserWrite,
                    File.GetUnixFileMode(path));
            }
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }
}
