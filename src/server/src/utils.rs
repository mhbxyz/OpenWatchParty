use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::Instant;

/// Returns the current time in milliseconds since UNIX epoch.
/// Uses saturating arithmetic to handle clock drift gracefully (fixes L01).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default() // Returns Duration::ZERO if clock went backwards
        .as_millis() as u64
}

/// Returns monotonic elapsed time without panicking if a supplied instant is in the future.
pub fn elapsed_saturating(now: Instant, earlier: Instant) -> Duration {
    now.checked_duration_since(earlier).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_now_ms_returns_reasonable_value() {
        let ts = now_ms();
        // Should be after 2020-01-01 (1577836800000 ms)
        assert!(ts > 1577836800000, "Timestamp should be after 2020");
        // Should be before 2100-01-01 (4102444800000 ms)
        assert!(ts < 4102444800000, "Timestamp should be before 2100");
    }

    #[test]
    fn elapsed_saturates_when_instants_are_reversed() {
        let now = Instant::now();
        let future = now + Duration::from_secs(1);
        assert_eq!(elapsed_saturating(now, future), Duration::ZERO);
        assert_eq!(elapsed_saturating(future, now), Duration::from_secs(1));
    }
}
