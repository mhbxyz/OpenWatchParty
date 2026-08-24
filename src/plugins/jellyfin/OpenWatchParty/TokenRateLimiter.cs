using System.Collections.Concurrent;

namespace OpenWatchParty.Plugin;

internal sealed class TokenRateLimiter
{
    private sealed record Window(int Count, long ResetTimestamp);

    private readonly ConcurrentDictionary<string, Window> _windows = new(StringComparer.Ordinal);
    private readonly int _limit;
    private readonly TimeProvider _timeProvider;
    private readonly long _windowTicks;

    internal TokenRateLimiter(int limit, TimeSpan windowDuration, TimeProvider? timeProvider = null)
    {
        _limit = limit;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _windowTicks = checked((long)(windowDuration.TotalSeconds * _timeProvider.TimestampFrequency));
    }

    internal bool TryAcquire(string userId) => TryAcquireAt(userId, _timeProvider.GetTimestamp());

    internal bool TryAcquireAt(string userId, long now)
    {
        while (true)
        {
            var current = _windows.GetOrAdd(userId, _ => new Window(0, checked(now + _windowTicks)));
            Window next;
            if (now >= current.ResetTimestamp)
            {
                next = new Window(1, checked(now + _windowTicks));
            }
            else
            {
                if (current.Count >= _limit)
                {
                    return false;
                }
                next = current with { Count = current.Count + 1 };
            }

            if (_windows.TryUpdate(userId, next, current))
            {
                return true;
            }
        }
    }

    internal int CleanupExpired() => CleanupExpiredAt(_timeProvider.GetTimestamp());

    internal int CleanupExpiredAt(long now)
    {
        var removed = 0;
        foreach (var entry in _windows)
        {
            if (now >= entry.Value.ResetTimestamp
                && ((ICollection<KeyValuePair<string, Window>>)_windows).Remove(entry))
            {
                removed++;
            }
        }
        return removed;
    }

    internal int EntryCount => _windows.Count;
    internal long WindowTicks => _windowTicks;
}
