use nix::errno::Errno;
use nix::sys::signal::{kill, Signal};
use nix::unistd::{getpgid, Pid};

/// A process identity that distinguishes a PID's current owner from a prior
/// process that used the same number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProcessIdentity {
    pid: Pid,
    start_time: u64,
}

impl ProcessIdentity {
    /// Capture the process start time immediately after its spawn returns.
    pub(crate) fn capture(pid: Pid) -> Option<Self> {
        Self::start_time_for(pid).map(|start_time| Self { pid, start_time })
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

#[cfg(test)]
mod tests {
    use std::io::BufRead as _;
    use std::os::unix::process::{CommandExt as _, ExitStatusExt};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use super::ProcessIdentity;
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

    #[tokio::test]
    async fn process_group_signal_refuses_a_non_leader() {
        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = Pid::from_raw(child.id() as i32);
        let identity = ProcessIdentity::capture(pid).expect("read child identity");

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

        let identity = ProcessIdentity::capture(leader).expect("read leader identity");
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
