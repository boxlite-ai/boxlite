use nix::errno::Errno;
use nix::sys::signal::{kill, Signal};
use nix::unistd::{getpgid, Pid};

/// A process instance distinguished from a prior process that used the same
/// PID.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProcessInstance {
    pid: Pid,
    start_time: u64,
    /// The process group this PID led at capture, when it led one.
    ///
    /// Recorded here rather than re-read on demand: every later caller runs
    /// after awaits that the reaper can win, and a `/proc` lookup then reports
    /// "no group" for a process that did lead one -- silently degrading a group
    /// kill to leader-only exactly when the survivors need it.
    group: Option<Pid>,
}

impl ProcessInstance {
    /// Capture the process identity immediately after its spawn returns.
    ///
    /// Start time and process group are read together: both describe the
    /// process as it exists at this instant, and they succeed or fail as one.
    pub(crate) fn capture(pid: Pid) -> Option<Self> {
        let start_time = Self::start_time_for(pid)?;
        // Distinguish "leads someone else's group" from a failed read. Only the
        // former is a real answer; an error means the process is already gone,
        // which is a failed capture, not a no-group execution. Collapsing them
        // would make the caller's no-group diagnostic report the wrong cause.
        let group = match getpgid(Some(pid)) {
            Ok(group) if group == pid => Some(pid),
            Ok(_) => None,
            Err(_) => return None,
        };
        Some(Self {
            pid,
            start_time,
            group,
        })
    }

    /// Signal only when this PID still belongs to the process captured at spawn.
    pub(super) fn signal(&self, signal: Signal, process_group: bool) -> Result<bool, Errno> {
        if !self.is_current() {
            return Ok(false);
        }

        let target = if process_group {
            match getpgid(Some(self.pid)) {
                Ok(group) if group == self.pid => {}
                Ok(_) | Err(Errno::ESRCH) => return Ok(false),
                Err(error) => return Err(error),
            }
            Pid::from_raw(-self.pid.as_raw())
        } else {
            self.pid
        };

        match kill(target, signal) {
            Ok(()) => Ok(true),
            Err(Errno::ESRCH) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(super) fn is_current(&self) -> bool {
        Self::start_time_for(self.pid) == Some(self.start_time)
    }

    /// The process group this instance led at capture, or None when its
    /// spawner left it in an inherited group.
    ///
    /// A group outlives its leader, so a caller that escalates after the leader
    /// exits can still reach the children it left behind.
    pub(super) fn own_process_group(&self) -> Option<Pid> {
        self.group
    }

    fn start_time_for(pid: Pid) -> Option<u64> {
        procfs::process::Process::new(pid.as_raw())
            .ok()?
            .stat()
            .ok()
            .map(|stat| stat.starttime)
    }

    #[cfg(test)]
    pub(super) fn start_time(&self) -> u64 {
        self.start_time
    }

    #[cfg(test)]
    pub(super) fn with_start_time_for_test(self, start_time: u64) -> Self {
        Self { start_time, ..self }
    }
}

/// Whether `group` still has any member.
///
/// The captured pgid names our job only while this holds: once the last member
/// exits, the number is free to be re-allocated and a holder that keeps
/// signalling it would reach an unrelated group.
pub(super) fn process_group_alive(group: Pid) -> bool {
    kill(Pid::from_raw(-group.as_raw()), None).is_ok()
}

/// Signal every member of `group`, addressed by a pgid captured while its
/// leader was live.
///
/// Unlike [`ProcessInstance::signal`] this carries no start-time guard,
/// because the leader is allowed to be gone by now — reaching the children it
/// orphaned is the entire point.
///
/// The pgid is unambiguous only while the group is non-empty: the kernel keeps
/// a PID reserved as long as some process still references it as a process
/// group ID. Once the last member exits the number is free to be re-allocated,
/// and a caller still holding it would signal an unrelated group.
///
/// There is no guard against that here, and none is cheap — an empty group
/// already reports `ESRCH` without one, and a re-allocated pgid is
/// indistinguishable from the original. Callers bound the exposure by how long
/// they hold a captured pgid: `start_timeout_watcher` polls
/// [`process_group_alive`] and retires as soon as the group empties, while
/// `ExecutionState::signal_if_current` accepts the window because reaching
/// orphans requires signalling without proof of identity.
pub(super) fn signal_process_group(group: Pid, signal: Signal) -> Result<bool, Errno> {
    match kill(Pid::from_raw(-group.as_raw()), signal) {
        Ok(()) => Ok(true),
        Err(Errno::ESRCH) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::io::BufRead as _;
    use std::os::unix::process::{CommandExt as _, ExitStatusExt};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use super::ProcessInstance;
    use nix::sys::signal::Signal;
    use nix::unistd::Pid;

    struct ChildGroup {
        child: Child,
        process_group: Pid,
    }

    impl Drop for ChildGroup {
        fn drop(&mut self) {
            let _ = nix::sys::signal::kill(
                Pid::from_raw(-self.process_group.as_raw()),
                Signal::SIGKILL,
            );
            let _ = self.child.wait();
        }
    }

    fn is_gone_or_zombie(pid: Pid) -> bool {
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        };
        stat.rsplit_once(") ")
            .and_then(|(_, fields)| fields.chars().next())
            == Some('Z')
    }

    /// A pid with no process behind it captures nothing.
    ///
    /// Covers the reachable half of the failure handling: both reads fail, so
    /// `capture` reports failure rather than inventing "leads no group". The
    /// split-failure case — start time read, then the process vanishes before
    /// the group read — needs the process to disappear between two adjacent
    /// syscalls and cannot be staged deterministically; the `Err` arm exists so
    /// that case is a failed capture too, not a false no-group answer.
    #[tokio::test]
    async fn capture_of_a_dead_pid_reports_failure() {
        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("spawn short-lived child");
        let pid = Pid::from_raw(child.id() as i32);
        tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("wait for child")
        })
        .await
        .expect("wait task must not panic");

        assert!(
            ProcessInstance::capture(pid).is_none(),
            "a reaped pid must not capture as an identity"
        );
    }

    /// The captured pgid must survive the leader's `/proc` entry.
    ///
    /// Every consumer runs after awaits the reaper can win; re-reading the
    /// group then would report "no group" for a process that led one, and the
    /// survivors would silently lose their deadline.
    #[tokio::test]
    async fn captured_process_group_outlives_the_leaders_proc_entry() {
        use std::os::unix::process::CommandExt;

        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "exit 0"]);
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
        let identity = ProcessInstance::capture(leader).expect("capture while live");
        assert_eq!(identity.own_process_group(), Some(leader));

        // Reap the leader, removing its /proc entry.
        tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("wait for leader")
        })
        .await
        .expect("wait task must not panic");
        assert!(
            !identity.is_current(),
            "leader must be gone for this to mean anything"
        );

        assert_eq!(
            identity.own_process_group(),
            Some(leader),
            "the captured group must not depend on the leader still existing"
        );
    }

    #[tokio::test]
    async fn process_group_signal_refuses_a_non_leader() {
        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = Pid::from_raw(child.id() as i32);
        let identity = ProcessInstance::capture(pid).expect("read child identity");

        assert_ne!(nix::unistd::getpgid(Some(pid)).unwrap(), pid);
        assert!(!identity
            .signal(Signal::SIGTERM, true)
            .expect("non-leader group signal must be rejected"));
        assert!(child.try_wait().expect("check child status").is_none());

        child.kill().expect("kill test child");
        let status = tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("wait for test child")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(status.signal(), Some(Signal::SIGKILL as i32));
    }

    #[tokio::test]
    async fn process_group_signal_reaches_a_background_descendant() {
        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("trap '' HUP TERM; sleep 30 & echo $!; wait")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: `setsid` is async-signal-safe and this closure performs no
        // allocation or locking between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut group = ChildGroup {
            child: command.spawn().expect("spawn process group"),
            process_group: Pid::from_raw(0),
        };
        let leader = Pid::from_raw(group.child.id() as i32);
        group.process_group = leader;
        assert_eq!(nix::unistd::getpgid(Some(leader)).unwrap(), leader);

        let stdout = group.child.stdout.take().expect("shell stdout");
        let mut line = String::new();
        std::io::BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read descendant pid");
        let descendant = Pid::from_raw(line.trim().parse::<i32>().expect("parse pid"));
        assert_eq!(nix::unistd::getpgid(Some(descendant)).unwrap(), leader);

        let identity = ProcessInstance::capture(leader).expect("read leader identity");
        assert!(identity
            .signal(Signal::SIGTERM, true)
            .expect("signal matching process group"));
        std::thread::sleep(Duration::from_millis(25));
        assert!(group.child.try_wait().unwrap().is_none());

        assert!(identity
            .signal(Signal::SIGKILL, true)
            .expect("force signal matching process group"));
        let status = group.child.wait().expect("wait group leader");
        assert_eq!(status.signal(), Some(Signal::SIGKILL as i32));

        let deadline = Instant::now() + Duration::from_secs(2);
        while !is_gone_or_zombie(descendant) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            is_gone_or_zombie(descendant),
            "background descendant survived process-group SIGKILL"
        );
    }
}
