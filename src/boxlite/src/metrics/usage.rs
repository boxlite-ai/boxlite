//! Billing usage metering — platform-neutral pure logic.
//!
//! The OS-specific part (reading the actual cgroup files via syscalls) lives in
//! `jailer::cgroup` and is Linux-only. This module holds the *pure* parsing and
//! accumulation logic with no OS dependency, so it is unit-testable on any
//! platform (including the macOS dev host, where `jailer::cgroup` is gated out).

/// Error parsing a value out of a cgroup stat file's text.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UsageParseError {
    /// The requested field was not present in the stat text.
    FieldNotFound(&'static str),
    /// The field was present but its value was not a valid `u64`.
    InvalidNumber(String),
}

/// Parse the `usage_usec` field from the contents of a cgroup v2 `cpu.stat`
/// file.
///
/// `cpu.stat` is a multi-line `"key value"` table. `usage_usec` is a monotonic
/// counter of total CPU time (microseconds) consumed by the cgroup. Billing
/// CPU-seconds are computed from the *delta* of this counter between two reads,
/// so the sampling interval does not affect accuracy.
///
/// ```text
/// usage_usec 12345678
/// user_usec 10000000
/// system_usec 2345678
/// nr_periods 0
/// ```
#[allow(dead_code)] // wired into jailer::cgroup::read_usage() in a later step
pub(crate) fn parse_cpu_usage_usec(cpu_stat: &str) -> Result<u64, UsageParseError> {
    for line in cpu_stat.lines() {
        // Trailing space pins the exact field, so `user_usec` / `system_usec`
        // (which share a suffix) never match.
        if let Some(value) = line.strip_prefix("usage_usec ") {
            let value = value.trim();
            return value
                .parse::<u64>()
                .map_err(|_| UsageParseError::InvalidNumber(value.to_string()));
        }
    }
    Err(UsageParseError::FieldNotFound("usage_usec"))
}

/// Parse the contents of a cgroup v2 `memory.current` file (a single integer:
/// current memory usage in bytes).
#[allow(dead_code)] // wired into jailer::cgroup::read_usage() in a later step
pub(crate) fn parse_memory_current(memory_current: &str) -> Result<u64, UsageParseError> {
    let trimmed = memory_current.trim();
    trimmed
        .parse::<u64>()
        .map_err(|_| UsageParseError::InvalidNumber(trimmed.to_string()))
}

/// A finished snapshot of one box's *actual* resource consumption over a usage
/// period, derived from cgroup samples. Feeds the over-commit / COGS view; the
/// billable `alloc` quantities are derived separately in the control-plane from
/// the box spec + lifecycle events.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ActualUsage {
    /// CPU-seconds actually consumed (cgroup `usage_usec` delta / 1e6).
    pub actual_cpu_seconds: f64,
    /// Mean resident memory across samples, bytes (0 if no samples).
    pub actual_rss_avg_bytes: u64,
    /// Peak resident memory across samples, bytes (0 if no samples).
    pub actual_rss_peak_bytes: u64,
    /// Number of cgroup samples folded into this period.
    pub sample_count: u32,
}

/// In-memory accumulator for one box's *current* usage period (actual side).
///
/// Opened with the cgroup `usage_usec` baseline at period start; each 1s
/// heartbeat folds a cgroup sample in; `snapshot()` produces an [`ActualUsage`]
/// at flush (state change / hourly rollover / stop). CPU-seconds use the
/// monotonic counter delta, so the sampling interval does not affect accuracy.
#[allow(dead_code)] // wired into box_impl heartbeat in a later step
pub(crate) struct ActualUsageAccumulator {
    cpu_usec_baseline: u64,
    cpu_usec_latest: u64,
    rss_byte_sum: u128,
    rss_byte_peak: u64,
    sample_count: u32,
}

#[allow(dead_code)] // wired into box_impl heartbeat in a later step
impl ActualUsageAccumulator {
    /// Open an accumulator at period start with the current `usage_usec` value.
    pub(crate) fn new(cpu_usec_baseline: u64) -> Self {
        Self {
            cpu_usec_baseline,
            cpu_usec_latest: cpu_usec_baseline,
            rss_byte_sum: 0,
            rss_byte_peak: 0,
            sample_count: 0,
        }
    }

    /// Fold one cgroup sample (from `read_usage`) into the period.
    pub(crate) fn record_sample(&mut self, cpu_usage_usec: u64, memory_current: u64) {
        // usage_usec is monotonic; keep the latest so snapshot() can delta it.
        self.cpu_usec_latest = cpu_usage_usec;
        self.rss_byte_sum += memory_current as u128;
        if memory_current > self.rss_byte_peak {
            self.rss_byte_peak = memory_current;
        }
        self.sample_count += 1;
    }

    /// Produce the period snapshot at flush time.
    pub(crate) fn snapshot(&self) -> ActualUsage {
        // saturating_sub guards against a cgroup reset (counter going backwards).
        let cpu_delta_usec = self.cpu_usec_latest.saturating_sub(self.cpu_usec_baseline);
        let actual_rss_avg_bytes = if self.sample_count == 0 {
            0
        } else {
            (self.rss_byte_sum / self.sample_count as u128) as u64
        };
        ActualUsage {
            actual_cpu_seconds: cpu_delta_usec as f64 / 1_000_000.0,
            actual_rss_avg_bytes,
            actual_rss_peak_bytes: self.rss_byte_peak,
            sample_count: self.sample_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_memory_current_bytes() {
        assert_eq!(parse_memory_current("209715200\n").unwrap(), 209_715_200);
    }

    #[test]
    fn parse_memory_current_errors_on_garbage() {
        assert!(parse_memory_current("not-a-number\n").is_err());
    }

    #[test]
    fn accumulator_computes_cpu_seconds_from_delta() {
        // Baseline 1.0s of CPU already counted; latest sample at 3.0s → 2.0s used.
        let mut acc = ActualUsageAccumulator::new(1_000_000);
        acc.record_sample(2_000_000, 2 * 1024 * 1024 * 1024); // 2 GiB
        acc.record_sample(3_000_000, 4 * 1024 * 1024 * 1024); // 4 GiB
        let snap = acc.snapshot();
        assert_eq!(snap.actual_cpu_seconds, 2.0);
        assert_eq!(snap.actual_rss_avg_bytes, 3 * 1024 * 1024 * 1024); // mean of 2,4 GiB
        assert_eq!(snap.actual_rss_peak_bytes, 4 * 1024 * 1024 * 1024);
        assert_eq!(snap.sample_count, 2);
    }

    #[test]
    fn accumulator_snapshot_with_no_samples_is_zeroed() {
        // A period that opened but never sampled (e.g. instantly flushed) must
        // not divide by zero.
        let acc = ActualUsageAccumulator::new(5_000_000);
        let snap = acc.snapshot();
        assert_eq!(snap.actual_cpu_seconds, 0.0);
        assert_eq!(snap.actual_rss_avg_bytes, 0);
        assert_eq!(snap.actual_rss_peak_bytes, 0);
        assert_eq!(snap.sample_count, 0);
    }

    #[test]
    fn parses_usage_usec_from_cpu_stat() {
        // Realistic cgroup v2 cpu.stat: usage_usec is not the first line, and
        // sibling fields (user_usec / system_usec) share a similar shape.
        let cpu_stat = "\
usage_usec 12345678
user_usec 10000000
system_usec 2345678
nr_periods 0
nr_throttled 0
throttled_usec 0
";
        assert_eq!(parse_cpu_usage_usec(cpu_stat).unwrap(), 12_345_678);
    }

    #[test]
    fn parse_cpu_usage_usec_errors_when_field_missing() {
        let cpu_stat = "user_usec 10000000\nsystem_usec 2345678\n";
        assert!(parse_cpu_usage_usec(cpu_stat).is_err());
    }
}
