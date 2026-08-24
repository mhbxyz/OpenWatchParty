using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class JwtSecretValidatorTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("short-but-varied-123!")]
    [InlineData("abababababababababababababababababababab")]
    [InlineData("abcdefghijklmnopqrstuvwxyzABCDEF")]
    [InlineData("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr")]
    [InlineData("your-32-character-secret-key-here")]
    [InlineData("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=")]
    [InlineData(" B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=")]
    [InlineData("B0vL    hmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=")]
    [InlineData("98WPRKE6UmMf3yz96/mQPgkiEnDw4mIo1BPYNUA45rQ")]
    [InlineData("d1wVY4zF4kyG84jG/NshZg0ypQTurZv-7+jzya6ZF70=")]
    public void WeakSecretsAreRejected(string? secret)
    {
        Assert.False(JwtSecretValidator.TryValidate(secret, out var error));
        Assert.NotEmpty(error);
    }

    [Theory]
    [InlineData("B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=")]
    [InlineData("B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow")]
    [InlineData("98WPRKE6UmMf3yz96/mQPgkiEnDw4mIo1BPYNUA45rQ=")]
    [InlineData("98WPRKE6UmMf3yz96_mQPgkiEnDw4mIo1BPYNUA45rQ")]
    public void StrongBase64SecretsAreAccepted(string secret)
    {
        Assert.True(JwtSecretValidator.TryValidate(secret, out var error), error);
    }
}
