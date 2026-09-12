//! Timeout management.
//!
//! Two-stage termination when execution exceeds its deadline:
//! SIGTERM first (cooperative cleanup), then SIGKILL after a grace
//! period to enforce the hard deadline against workloads that ignore
//! or trap SIGTERM.

use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use tracing::{info, warn};

use crate::service::exec::process_instance::{
    process_group_alive, signal_process_group, ProcessInstance,
};

/// Grace period between SIGTERM and SIGKILL on exec timeout.
///
/// Short enough that sandboxed execs still see a near-deadline kill,
/// long enough that cooperative workloads can flush buffers, close
/// files, and exit cleanly. Mirrors the SIGTERM→wait→SIGKILL pattern
/// used by `ExecRegistry::shutdown_all` and `Container::shutdown`.
const TIMEOUT_GRACE: Duration = Duration::from_secs(2);

/// How often a waiting watcher re-checks that its captured group still exists.
///
/// A captured pgid is only unambiguous while its group is non-empty, so the
/// watcher may not sleep straight through a window in which the group could
/// empty and the number be re-allocated. This bounds that exposure to one
/// interval instead of the whole deadline.
const GROUP_LIVENESS_POLL: Duration = Duration::from_millis(100);

pub(super) struct TimeoutTarget {
    process: Option<ProcessInstance>,
    /// The process group to bound, or None when the workload leads no group.
    group: Option<Pid>,
}

impl TimeoutTarget {
    /// Resolve the process group here, not at signal time.
    ///
    /// The caller builds this immediately after spawn, the one moment the
    /// leader is guaranteed live. A leader may exit long before its own
    /// deadline while the children it forked keep running and keep the exec's
    /// pipes open; resolving later would see that dead leader, find no group,
    /// and leave the survivors unsignalled -- the very orphan this watcher
    /// exists to prevent.
    pub(super) fn new(process: Option<ProcessInstance>) -> Self {
        let group = process.and_then(|process| process.own_process_group());
        Self { process, group }
    }

    #[cfg(test)]
    fn process_group(&self) -> Option<Pid> {
        self.group
    }

    /// Wait out `window`, reporting false if the job's group empties first.
    ///
    /// Returning false means there is nothing left to signal *and* the captured
    /// pgid must not be used again — the two are the same condition.
    async fn wait_while_job_lives(&self, window: Duration) -> bool {
        let Some(group) = self.group else {
            // Leader-only delivery re-checks identity at signal time, so there
            // is no captured group to go stale.
            tokio::time::sleep(window).await;
            return true;
        };
        let started = tokio::time::Instant::now();
        loop {
            let remaining = window.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return true;
            }
            tokio::time::sleep(GROUP_LIVENESS_POLL.min(remaining)).await;
            if !process_group_alive(group) {
                return false;
            }
        }
    }

    /// Signal the whole job: its process group when it leads one, else the
    /// captured leader alone.
    ///
    /// The group is what actually bounds the deadline. `sh -c "cmd"` may fork
    /// rather than exec, and signalling only the leader then reaps the shell
    /// while its child is reparented to init and runs on untouched. Falling
    /// back to the leader keeps executors that leave their workload in an
    /// inherited group -- with no group of its own to address -- working as
    /// before.
    fn signal_job(&self, signal: Signal) -> Result<bool, Errno> {
        match (self.group, self.process) {
            (Some(group), _) => signal_process_group(group, signal),
            (None, Some(process)) => process.signal(signal, false),
            (None, None) => Ok(false),
        }
    }
}

/// Start timeout watcher.
///
/// After `timeout` elapses, sends SIGTERM and waits up to `TIMEOUT_GRACE`
/// for the process to exit, then escalates to SIGKILL. SIGKILL is
/// uncatchable, so a workload that installs `SIG_IGN`/handlers for
/// SIGTERM (or SIGALRM, etc.) cannot outlive its deadline.
///
/// The handle is returned so a retained session can cancel the watcher instead
/// of leaving a task parked on a deadline its process already beat.
pub(super) fn start_timeout_watcher(
    target: TimeoutTarget,
    exec_id: String,
    timeout: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if !target.wait_while_job_lives(timeout).await {
            info!(execution_id = %exec_id, "job ended before its deadline");
            return;
        }

        match target.signal_job(Signal::SIGTERM) {
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

        if !target.wait_while_job_lives(TIMEOUT_GRACE).await {
            info!(execution_id = %exec_id, "exited within grace after SIGTERM");
            return;
        }

        // Escalate against the group captured at construction: by now SIGTERM
        // may have reaped the leader while a child that ignores it lives on,
        // and every leader-anchored check would refuse from here.
        match target.signal_job(Signal::SIGKILL) {
            Ok(true) => {
                warn!(
                    execution_id = %exec_id,
                    "SIGKILL after grace expired; workload did not exit on SIGTERM"
                );
            }
            Ok(false) => info!(execution_id = %exec_id, "exited within grace after SIGTERM"),
            Err(error) => warn!(execution_id = %exec_id, %error, "timeout SIGKILL failed"),
        }
    })
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::ExitStatusExt;

    use nix::sys::signal::Signal;
    use nix::unistd::Pid;

    use std::time::Duration;

    use super::{start_timeout_watcher, TimeoutTarget};
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

        // Spawned without setpgid, so it leads no group: this is the
        // leader-only fallback path.
        assert!(target.process_group().is_none());
        assert!(target
            .signal_job(Signal::SIGTERM)
            .expect("signal the matching leader"));
        let status = tokio::task::spawn_blocking(move || {
            let _fence = reap_fence();
            child.wait().expect("wait for terminated child")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(status.signal(), Some(Signal::SIGTERM as i32));
    }

    /// The watcher must let go of a captured pgid the moment its group empties.
    ///
    /// Holding it to the deadline would leave the number free to be
    /// re-allocated, and the signals below would land on an unrelated group.
    #[tokio::test]
    async fn timeout_watcher_retires_itself_when_the_group_empties() {
        use std::os::unix::process::CommandExt;

        let _test_guard = reap_test_guard().await;
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "sleep 0.2"]);
        // SAFETY: `setpgid` is async-signal-safe and this closure allocates and
        // locks nothing between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().expect("spawn group leader");
        let leader = Pid::from_raw(child.id() as i32);
        let target = TimeoutTarget::new(ProcessInstance::capture(leader));
        assert_eq!(target.process_group(), Some(leader));

        // A deadline far beyond the workload: the watcher must stop on its own.
        let watcher =
            start_timeout_watcher(target, "retire-me".to_string(), Duration::from_secs(30));

        tokio::task::spawn_blocking(move || {
            let _fence = reap_fence();
            child.wait().expect("wait for leader")
        })
        .await
        .expect("wait task must not panic");

        tokio::time::timeout(Duration::from_secs(5), watcher)
            .await
            .expect("watcher must retire once its group is empty")
            .expect("watcher task must not panic");
    }

    /// A leader that exits before its own deadline must not take the group's
    /// escape hatch with it. The pgid is captured at construction precisely so
    /// the survivors it forked are still reachable here.
    #[tokio::test]
    async fn timeout_target_still_reaches_a_group_whose_leader_already_exited() {
        use std::os::unix::process::CommandExt;

        let _test_guard = reap_test_guard().await;
        let mut command = std::process::Command::new("/bin/sh");
        // The shell forks, prints the child's PID, and exits immediately --
        // leaving a live group behind a dead leader.
        command.args(["-c", "sleep 30 & echo $!"]);
        command.stdout(std::process::Stdio::piped());
        // SAFETY: `setpgid` is async-signal-safe and this closure allocates
        // and locks nothing between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().expect("spawn group leader");
        let leader = Pid::from_raw(child.id() as i32);

        // Construct while the leader is still live, as the spawn path does.
        let target = TimeoutTarget::new(ProcessInstance::capture(leader));

        let child_pid = {
            use std::io::Read;
            // Read exactly one line: the forked `sleep` inherits stdout, so
            // waiting for EOF would wait out the whole workload.
            let mut stdout = child.stdout.take().expect("piped stdout");
            let mut buf = String::new();
            let mut byte = [0u8; 1];
            while stdout.read(&mut byte).expect("read child pid") == 1 {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0] as char);
            }
            Pid::from_raw(buf.trim().parse::<i32>().expect("child pid line"))
        };

        // Let the leader exit and be reaped before any signal is sent.
        tokio::task::spawn_blocking(move || {
            let _fence = reap_fence();
            child.wait().expect("wait for leader")
        })
        .await
        .expect("wait task must not panic");
        assert!(!ProcessInstance::capture(leader).is_some_and(|p| p.is_current()));

        assert!(target
            .signal_job(Signal::SIGKILL)
            .expect("signal the surviving group"));

        for _ in 0..50 {
            if nix::sys::signal::kill(child_pid, None).is_err() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("group member {child_pid} survived after its leader exited");
    }

    /// A group leader that forks must not leave the child behind: signalling
    /// the leader alone reaps the shell and reparents the workload to init,
    /// which is exactly how a deadline gets bypassed.
    #[tokio::test]
    async fn timeout_target_signals_the_whole_group_of_a_forking_leader() {
        use std::os::unix::process::CommandExt;

        let _test_guard = reap_test_guard().await;
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & echo $! && wait"]);
        command.stdout(std::process::Stdio::piped());
        // SAFETY: `setpgid` is async-signal-safe and this closure allocates
        // and locks nothing between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().expect("spawn group leader");

        // The shell prints the forked child's PID before waiting on it.
        let child_pid = {
            use std::io::Read;
            let mut stdout = child.stdout.take().expect("piped stdout");
            let mut buf = String::new();
            let mut byte = [0u8; 1];
            while stdout.read(&mut byte).expect("read child pid") == 1 {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0] as char);
            }
            Pid::from_raw(buf.trim().parse::<i32>().expect("child pid line"))
        };

        let leader = Pid::from_raw(child.id() as i32);
        let target = TimeoutTarget::new(ProcessInstance::capture(leader));
        let group = target.process_group().expect("leader leads its own group");
        assert_eq!(group, leader);

        assert!(target
            .signal_job(Signal::SIGKILL)
            .expect("signal the whole group"));

        let status = tokio::task::spawn_blocking(move || {
            let _fence = reap_fence();
            child.wait().expect("wait for terminated leader")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(status.signal(), Some(Signal::SIGKILL as i32));

        // The forked child must be gone too, not orphaned onto init.
        for _ in 0..50 {
            if nix::sys::signal::kill(child_pid, None).is_err() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("forked child {child_pid} survived a group SIGKILL");
    }
}
