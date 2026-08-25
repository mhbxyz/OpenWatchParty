namespace OpenWatchParty.Plugin;

/// <summary>Thread-safe counters for client injection diagnostics.</summary>
public sealed class InjectionDiagnostics
{
    private long _indexResponsesObserved;
    private long _nativeInjectionsPerformed;
    private long _lastNativeInjectionUnixMs;

    public void RecordIndexObserved() => Interlocked.Increment(ref _indexResponsesObserved);

    public void RecordNativeInjection()
    {
        Interlocked.Increment(ref _nativeInjectionsPerformed);
        Interlocked.Exchange(
            ref _lastNativeInjectionUnixMs,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public InjectionSnapshot Snapshot() => new(
        Interlocked.Read(ref _indexResponsesObserved),
        Interlocked.Read(ref _nativeInjectionsPerformed),
        FromUnixMilliseconds(Interlocked.Read(ref _lastNativeInjectionUnixMs)));

    private static DateTimeOffset? FromUnixMilliseconds(long value) =>
        value == 0 ? null : DateTimeOffset.FromUnixTimeMilliseconds(value);
}

public sealed record InjectionSnapshot(
    long IndexResponsesObserved,
    long NativeInjectionsPerformed,
    DateTimeOffset? LastNativeInjectionUtc);
