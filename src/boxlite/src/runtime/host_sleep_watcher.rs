//! Detect host sleep/resume and synchronize guest clocks.
//!
//! When the host suspends, guest vCPUs stop but host wall clock continues.
//! Comparing successive samples of wall clock vs monotonic clock reveals the
//! gap on the first tick after wake.

use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime};

use tokio_util::sync::CancellationToken;

use crate::runtime::rt_impl::{RuntimeImpl, SharedRuntimeImpl};

/// Minimum host sleep duration we care about (ignore jitter / NTP micro-adjustments).
const MIN_SLEEP_DETECTION: Duration = Duration::from_secs(5);

/// Poll interval between sleep checks.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Start a background thread that watches for host sleep and syncs running boxes.
pub fn spawn(runtime: SharedRuntimeImpl, shutdown_token: CancellationToken) {
    let runtime = Arc::downgrade(&runtime);
    if let Err(e) = std::thread::Builder::new()
        .name("boxlite-host-sleep-watcher".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::error!(error = %e, "Failed to start host sleep watcher runtime");
                    return;
                }
            };
            rt.block_on(host_sleep_watcher_loop(runtime, shutdown_token));
        })
    {
        tracing::error!(error = %e, "Failed to spawn host sleep watcher thread");
    }
}

async fn host_sleep_watcher_loop(runtime: Weak<RuntimeImpl>, shutdown_token: CancellationToken) {
    let mut sample = SleepSample::capture();
    tracing::debug!(
        poll_secs = POLL_INTERVAL.as_secs(),
        "Host sleep watcher started"
    );

    loop {
        tokio::select! {
            _ = shutdown_token.cancelled() => {
                tracing::debug!("Host sleep watcher stopped");
                break;
            }
            _ = tokio::time::sleep(POLL_INTERVAL) => {
                let next = SleepSample::capture();
                if let Some(slept_for) = sample.detect_sleep(&next) {
                    tracing::info!(
                        slept_for_secs = slept_for.as_secs(),
                        "Host sleep/resume detected; syncing guest clocks"
                    );
                    if let Some(runtime) = runtime.upgrade() {
                        runtime.sync_running_box_clocks("host_wake").await;
                    }
                }
                sample = next;
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct SleepSample {
    wall: SystemTime,
    mono: Instant,
}

impl SleepSample {
    fn capture() -> Self {
        Self {
            wall: SystemTime::now(),
            mono: Instant::now(),
        }
    }

    fn detect_sleep(&self, next: &Self) -> Option<Duration> {
        let wall_delta = next.wall.duration_since(self.wall).ok()?;
        let mono_delta = next.mono.duration_since(self.mono);
        detect_host_sleep(wall_delta, mono_delta)
    }
}

/// Returns approximate host sleep duration when wall clock outran monotonic time.
pub(crate) fn detect_host_sleep(wall_delta: Duration, mono_delta: Duration) -> Option<Duration> {
    if wall_delta <= mono_delta {
        return None;
    }
    let slept_for = wall_delta.saturating_sub(mono_delta);
    if slept_for >= MIN_SLEEP_DETECTION {
        Some(slept_for)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_sleep_when_wall_runs_ahead_of_mono() {
        let slept = detect_host_sleep(
            Duration::from_secs(3600),
            Duration::from_millis(100),
        )
        .expect("sleep detected");
        assert!(slept >= Duration::from_secs(3599));
        assert!(slept <= Duration::from_secs(3600));
    }

    #[test]
    fn ignores_sub_threshold_drift() {
        assert!(detect_host_sleep(
            Duration::from_secs(3),
            Duration::from_millis(100),
        )
        .is_none());
    }

    #[test]
    fn ignores_normal_elapsed_time() {
        assert!(detect_host_sleep(
            Duration::from_secs(30),
            Duration::from_secs(30),
        )
        .is_none());
    }
}
