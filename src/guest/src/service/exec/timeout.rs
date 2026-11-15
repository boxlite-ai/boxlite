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
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::service::exec::process_instance::{ProcessGroup, ProcessInstance};

/// Grace period between SIGTERM and SIGKILL on exec timeout.
///
/// Short enough that sandboxed execs still see a near-deadline kill,
/// long enough that cooperative workloads can flush buffers, close
/// files, and exit cleanly. Mirrors the SIGTERM→wait→SIGKILL pattern
/// used by `ExecRegistry::shutdown_all` and `Container::shutdown`.
const TIMEOUT_GRACE: Duration = Duration::from_secs(2);
const GROUP_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(super) struct TimeoutTarget {
    process: Option<ProcessInstance>,
    group: Option<ProcessGroup>,
}

impl TimeoutTarget {
    pub(super) fn from_spawn(
        process: Option<ProcessInstance>,
        group: Option<ProcessGroup>,
    ) -> Self {
        Self { process, group }
    }

    #[cfg(test)]
    fn new(process: Option<ProcessInstance>) -> Self {
        let group = process.and_then(|process| process.capture_group_for_test());
        Self::from_spawn(process, group)
    }

    fn signal_if_live(&self, signal: Signal) -> Result<bool, Errno> {
        if let Some(group) = &self.group {
            match group.signal(signal as i32) {
                // Older custom kernels lack process-group pidfd signaling.
                Err(Errno::EINVAL | Errno::ENOSYS) => {}
                result => return result,
            }
        }
        match self.process {
            Some(process) => process.signal(signal, false),
            None => Ok(false),
        }
    }
}

pub(super) struct TimeoutTask {
    target: Arc<TimeoutTarget>,
    task: tokio::task::JoinHandle<()>,
    detached: oneshot::Sender<()>,
}

impl TimeoutTask {
    #[cfg(test)]
    pub(super) fn without_group_for_test(task: tokio::task::JoinHandle<()>) -> Self {
        Self {
            target: Arc::new(TimeoutTarget::from_spawn(None, None)),
            task,
            detached: oneshot::channel().0,
        }
    }

    pub(super) async fn finish(self) {
        if self
            .target
            .group
            .as_ref()
            .is_some_and(ProcessGroup::has_members)
        {
            // Dropping the handle detaches the watcher. Its deadline still
            // applies to this group even if the leader or execution state is gone.
            let _ = self.detached.send(());
            return;
        }
        self.task.abort();
        let _ = self.task.await;
    }
}

/// Start timeout watcher.
///
/// After `timeout` elapses, sends SIGTERM and waits up to `TIMEOUT_GRACE`
/// for the process to exit, then escalates to SIGKILL. SIGKILL is
/// uncatchable, so a workload that installs `SIG_IGN`/handlers for
/// SIGTERM (or SIGALRM, etc.) cannot outlive its deadline.
///
/// Terminal executions cancel their watcher once its original group is empty.
pub(super) fn start_timeout_watcher(
    target: TimeoutTarget,
    exec_id: String,
    timeout: Duration,
) -> TimeoutTask {
    let target = Arc::new(target);
    let task_target = Arc::clone(&target);
    let (detached, wait_for_detach) = oneshot::channel();
    let task = tokio::spawn(async move {
        let deadline = enforce_timeout(&task_target, &exec_id, timeout);
        if let Some(group) = &task_target.group {
            tokio::select! {
                _ = deadline => {}
                _ = wait_for_group_exit(group, wait_for_detach) => {}
            }
        } else {
            deadline.await;
        }
    });
    TimeoutTask {
        target,
        task,
        detached,
    }
}

async fn wait_for_group_exit(group: &ProcessGroup, detached: oneshot::Receiver<()>) {
    // Active executions are reaped normally. Only poll after the state that
    // owned the watcher has gone away and descendants may still be alive.
    let _ = detached.await;
    while group.has_members() {
        tokio::time::sleep(GROUP_EXIT_POLL_INTERVAL).await;
    }
}

async fn enforce_timeout(target: &TimeoutTarget, exec_id: &str, timeout: Duration) {
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
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::ExitStatusExt;

    use nix::sys::signal::Signal;
    use nix::unistd::Pid;

    use super::TimeoutTarget;
    use crate::reaper::{reap_fence, reap_test_guard};
    use crate::service::exec::process_instance::ProcessInstance;

    #[tokio::test]
    async fn timeout_target_signals_its_live_leader() {
        let _test_guard = reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let leader = Pid::from_raw(child.id() as i32);
        let target = TimeoutTarget::new(ProcessInstance::capture(leader));

        assert!(target
            .signal_if_live(Signal::SIGTERM)
            .expect("signal the matching leader"));
        let status = tokio::task::spawn_blocking(move || {
            let _fence = reap_fence();
            child.wait().expect("wait for terminated child")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(status.signal(), Some(Signal::SIGTERM as i32));
    }
}

#[cfg(test)]
#[path = "tests/timeout_group.rs"]
mod group_tests;
