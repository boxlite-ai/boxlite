//! Time helpers similar to containerd's boundTime/latestTime.

use std::time::{Duration, SystemTime};

const MIN_TIME: SystemTime = SystemTime::UNIX_EPOCH;
// 64-bit timespec upper bound; conservative clamp
const MAX_NANOS: u64 = i64::MAX as u64;

pub fn bound_time(t: SystemTime) -> SystemTime {
    let nanos = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos() as u64;
    if nanos > MAX_NANOS { MIN_TIME } else { t }
}

pub fn latest_time(a: SystemTime, b: SystemTime) -> SystemTime {
    if a > b { a } else { b }
}
