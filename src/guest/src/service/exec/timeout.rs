//! Timeout management.
//!
//! Two-stage termination when execution exceeds its deadline:
//! SIGTERM first (cooperative cleanup), then SIGKILL after a grace
//! period to enforce the hard deadline against workloads that ignore
//! or trap SIGTERM.

use std::sync::Arc;
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use tracing::{info, warn};

use crate::reaper::{ExitClaim, Reaper};

/// Grace period between SIGTERM and SIGKILL on exec timeout.
///
/// Short enough that sandboxed execs still see a near-deadline kill,
/// long enough that cooperative workloads can flush buffers, close
/// files, and exit cleanly. Mirrors the SIGTERM→wait→SIGKILL pattern
/// used by `ExecRegistry::shutdown_all` and `Container::shutdown`.
const TIMEOUT_GRACE: Duration = Duration::from_secs(2);

pub(super) struct TimeoutTarget {
    reaper: Arc<Reaper>,
    claim: ExitClaim,
    leader_pid: Pid,
}

impl TimeoutTarget {
    pub(super) fn new(reaper: Arc<Reaper>, claim: ExitClaim, leader_pid: Pid) -> Self {
        Self {
            reaper,
            claim,
            leader_pid,
        }
    }

    fn signal_if_live(&self, signal: Signal) -> Result<bool, Errno> {
        self.reaper
            .signal_leader_if_live(&self.claim, self.leader_pid, signal)
    }
}

/// Start timeout watcher.
///
/// After `timeout` elapses, sends SIGTERM and waits up to `TIMEOUT_GRACE`
/// for the process to exit, then escalates to SIGKILL. SIGKILL is
/// uncatchable, so a workload that installs `SIG_IGN`/handlers for
/// SIGTERM (or SIGALRM, etc.) cannot outlive its deadline.
pub(super) fn start_timeout_watcher(target: TimeoutTarget, exec_id: String, timeout: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(timeout).await;

        match target.signal_if_live(Signal::SIGTERM) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                warn!(execution_id = %exec_id, %error, "timeout SIGTERM failed");
                return;
            }
        }
        info!(
            execution_id = %exec_id,
            grace_ms = TIMEOUT_GRACE.as_millis() as u64,
            "SIGTERM on timeout; grace before SIGKILL"
        );

        tokio::time::sleep(TIMEOUT_GRACE).await;

        match target.signal_if_live(Signal::SIGKILL) {
            Ok(true) => {
                warn!(
                    execution_id = %exec_id,
                    "SIGKILL after grace expired; workload did not exit on SIGTERM"
                );
            }
            Ok(false) => info!(execution_id = %exec_id, "exited within grace after SIGTERM"),
            Err(error) => warn!(execution_id = %exec_id, %error, "timeout SIGKILL failed"),
        }
    });
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::ExitStatusExt;
    use std::sync::Arc;
    use std::time::Instant;

    use nix::sys::signal::Signal;
    use nix::unistd::Pid;

    use super::TimeoutTarget;
    use crate::reaper::{reap_fence, reap_test_guard, Reaper};

    #[tokio::test]
    async fn timeout_target_signals_its_live_leader() {
        let _test_guard = reap_test_guard().await;
        let reaper = Reaper::new_for_test();
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let leader = Pid::from_raw(child.id() as i32);
        let claim = reaper.register_claim(leader, Instant::now()).await;
        let target = TimeoutTarget::new(Arc::clone(&reaper), claim, leader);

        assert!(target
            .signal_if_live(Signal::SIGTERM)
            .expect("signal the claimed leader"));
        let status = tokio::task::spawn_blocking(move || {
            let _fence = reap_fence();
            child.wait().expect("wait for terminated child")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(status.signal(), Some(Signal::SIGTERM as i32));
    }
}
