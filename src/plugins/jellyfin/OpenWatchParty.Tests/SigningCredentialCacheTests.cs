using System.IdentityModel.Tokens.Jwt;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using OpenWatchParty.Plugin.Configuration;
using OpenWatchParty.Plugin.Controllers;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class SigningCredentialCacheTests
{
    [Fact]
    public async Task ParallelSecretRotationAlwaysSignsWithRequestedSecret()
    {
        const string secretA = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=";
        const string secretB = "98WPRKE6UmMf3yz96/mQPgkiEnDw4mIo1BPYNUA45rQ=";
        var requests = Enumerable.Range(0, 200)
            .Select(index => Task.Run(() =>
            {
                var secret = index % 2 == 0 ? secretA : secretB;
                var config = new PluginConfiguration
                {
                    JwtSecret = secret,
                    JwtAudience = "OpenWatchParty",
                    JwtIssuer = "Jellyfin",
                    TokenTtlSeconds = 3600
                };
                return (Token: OpenWatchPartyController.GenerateJwtToken("user", "User", config), Secret: secret);
            }));

        var tokens = await Task.WhenAll(requests);

        foreach (var (token, secret) in tokens)
        {
            var parameters = new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)),
                ValidateIssuer = true,
                ValidIssuer = "Jellyfin",
                ValidateAudience = true,
                ValidAudience = "OpenWatchParty",
                ValidateLifetime = true,
                ClockSkew = TimeSpan.Zero
            };
            var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
            var principal = handler.ValidateToken(token, parameters, out _);
            Assert.Equal("user", principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value);
        }
    }
}
