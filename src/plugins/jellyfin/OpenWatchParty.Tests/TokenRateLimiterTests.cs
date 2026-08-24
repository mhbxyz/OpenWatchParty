using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class TokenRateLimiterTests
{
    [Fact]
    public void SequentialRequestsStopExactlyAtLimit()
    {
        var limiter = new TokenRateLimiter(30, TimeSpan.FromMinutes(1));
        const long now = 0;

        Assert.All(Enumerable.Range(0, 30), _ => Assert.True(limiter.TryAcquireAt("user", now)));
        Assert.False(limiter.TryAcquireAt("user", now));
    }

    [Fact]
    public async Task ParallelBurstNeverExceedsLimit()
    {
        var limiter = new TokenRateLimiter(30, TimeSpan.FromMinutes(1));
        const long now = 0;
        var attempts = Enumerable.Range(0, 200)
            .Select(_ => Task.Run(() => limiter.TryAcquireAt("user", now)));

        var results = await Task.WhenAll(attempts);

        Assert.Equal(30, results.Count(accepted => accepted));
    }

    [Fact]
    public void WindowResetAndUsersAreIndependent()
    {
        var limiter = new TokenRateLimiter(2, TimeSpan.FromMinutes(1));
        const long now = 0;

        Assert.True(limiter.TryAcquireAt("alice", now));
        Assert.True(limiter.TryAcquireAt("alice", now));
        Assert.False(limiter.TryAcquireAt("alice", now));
        Assert.True(limiter.TryAcquireAt("bob", now));
        Assert.True(limiter.TryAcquireAt("alice", limiter.WindowTicks));
    }

    [Fact]
    public void CleanupRemovesOnlyExpiredSnapshots()
    {
        var limiter = new TokenRateLimiter(2, TimeSpan.FromMinutes(1));
        const long now = 0;
        limiter.TryAcquireAt("expired", now);
        limiter.TryAcquireAt("active", limiter.WindowTicks / 2);

        Assert.Equal(1, limiter.CleanupExpiredAt(limiter.WindowTicks));
        Assert.Equal(1, limiter.EntryCount);
        Assert.True(limiter.TryAcquireAt("active", limiter.WindowTicks));
    }
}
