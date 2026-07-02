//! Host wall-clock helpers.

use std::time::{SystemTime, UNIX_EPOCH};

/// Host `CLOCK_REALTIME` as Unix epoch nanoseconds.
pub fn host_realtime_nanos() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}
