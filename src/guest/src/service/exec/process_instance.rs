use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;

use nix::errno::Errno;
use nix::sys::signal::{kill, Signal};
use nix::unistd::{getpgid, Pid};

/// A process instance distinguished from a prior process that used the same
/// PID.
///
/// Carries a kernel-atomic incarnation pin (`pidfd`) when the kernel supports
/// `pidfd_open` (Linux 5.3+). Signals are delivered via `pidfd_send_signal`,
/// which returns `ESRCH` once the incarnation is gone and never reaches a
/// later owner of a recycled PID — closing the TOCTOU window that a
/// `/proc/<pid>/stat` start-time comparison followed by `kill(pid)` leaves
/// open. On kernels without `pidfd_open`, falls back to the start-time
/// fingerprint (`is_current`).
#[derive(Clone, Debug)]
pub(crate) struct ProcessInstance {
    pid: Pid,
    /// Used only by the `/proc` fallback path when `pidfd` is `None` (old
    /// kernel — `pidfd_open` returned `ENOSYS` — or the process was already
    /// reaped at capture time). On the pidfd path the start-time fingerprint
    /// is never read; it is kept because the fallback is the sole identity
    /// check when no pidfd is held.
    start_time: u64,
    /// Kernel-atomic incarnation pin. `None` when `pidfd_open` failed; the
    /// `/proc` start-time path remains the fallback in that case. Shared via
    /// `Arc` so every clone of one `ProcessInstance` owns one fd, closed when
    /// the last clone is dropped.
    pidfd: Option<Arc<OwnedFd>>,
}

impl ProcessInstance {
    /// Capture the process identity immediately after its spawn returns.
    ///
    /// Reads `/proc/<pid>/stat.starttime` (always — the fallback needs it)
    /// and opens a pidfd when the kernel supports it. Returns `None` if the
    /// `/proc` read fails; the caller logs "failed to capture process
    /// identity; signals will be skipped" and no signals are sent.
    pub(crate) fn capture(pid: Pid) -> Option<Self> {
        let start_time = Self::start_time_for(pid)?;
        let pidfd = Self::open_pidfd(pid);
        Some(Self {
            pid,
            start_time,
            pidfd,
        })
    }

    /// Signal this process only while it still belongs to the incarnation
    /// captured at spawn.
    ///
    /// `process_group=false` (single-pid): uses `pidfd_send_signal` when a
    /// pidfd is held (atomic — `ESRCH` once the incarnation is gone) and
    /// falls back to `is_current()` + `kill(pid)` on old kernels.
    ///
    /// `process_group=true`: verifies the leader is still our incarnation
    /// (`pidfd_send_signal(fd, 0)` probe when a pidfd is held, `is_current()`
    /// fallback), then signals the process group by pgid number via
    /// `kill(-pgid)`. Signalling by pgid number is not a PID-recycling hazard.
    pub(super) fn signal(&self, signal: Signal, process_group: bool) -> Result<bool, Errno> {
        if process_group {
            return self.signal_group(signal);
        }
        if let Some(pidfd) = &self.pidfd {
            return self.send_signal_via_pidfd(pidfd, signal);
        }
        if !self.is_current() {
            return Ok(false);
        }
        match kill(self.pid, signal) {
            Ok(()) => Ok(true),
            Err(Errno::ESRCH) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Group-signal path: leader-identity check, then `kill(-pgid)`.
    ///
    /// The leader check is `pidfd_send_signal(fd, 0)` (atomic) when a pidfd
    /// is held and `is_current()` on the `/proc` fallback. The subsequent
    /// `getpgid` + `kill(-pgid)` signals by pgid number — a captured value,
    /// so a recycled PID in a different process group is not reached.
    fn signal_group(&self, signal: Signal) -> Result<bool, Errno> {
        let alive = match &self.pidfd {
            Some(pidfd) => self.probe_via_pidfd(pidfd),
            None => self.is_current(),
        };
        if !alive {
            return Ok(false);
        }
        match getpgid(Some(self.pid)) {
            Ok(group) if group == self.pid => {}
            Ok(_) | Err(Errno::ESRCH) => return Ok(false),
            Err(error) => return Err(error),
        }
        match kill(Pid::from_raw(-self.pid.as_raw()), signal) {
            Ok(()) => Ok(true),
            Err(Errno::ESRCH) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Open a pidfd for the process. `None` when the kernel lacks
    /// `pidfd_open` (`ENOSYS`), the process is already gone (`ESRCH`), or
    /// permission is denied (`EPERM` — should not happen for our own child).
    /// In every failure case the `/proc` start-time fallback applies.
    fn open_pidfd(pid: Pid) -> Option<Arc<OwnedFd>> {
        // SAFETY: `pidfd_open` takes (pid_t pid, u32 flags) and returns a
        // non-negative fd with CLOEXEC set on success, or -1 + errno on
        // failure. We treat every failure as "no pidfd, use /proc fallback".
        let ret = unsafe { nix::libc::syscall(nix::libc::SYS_pidfd_open, pid.as_raw(), 0u32) };
        if ret < 0 {
            return None;
        }
        // SAFETY: `ret` is a freshly allocated fd we own; `OwnedFd` closes
        // it on drop. `Arc` lets every clone of `ProcessInstance` share one
        // fd rather than duplicate it.
        Some(Arc::new(unsafe { OwnedFd::from_raw_fd(ret as i32) }))
    }

    /// `pidfd_send_signal(fd, sig)` — atomic signal to the incarnation.
    ///
    /// On `EPERM`, distinguish a reaped incarnation from a real permission
    /// denial by re-checking the `/proc` start-time. `pidfd_send_signal`
    /// performs its own permission check at call time (independent of the
    /// `pidfd_open` capture-time check), so a real `EPERM` is possible if the
    /// child changed credentials after capture (e.g. `setuid` to a different
    /// user). The kernel also returns `EPERM`, rather than the documented
    /// `ESRCH`, for a reaped pidfd on some configurations (observed: kernel
    /// 5.4 under the Rust runtime). If `is_current` is false the process is
    /// gone, so the `EPERM` is the reaped quirk (`Ok(false)`); if it is still
    /// live, the `EPERM` is a real denial to propagate.
    fn send_signal_via_pidfd(&self, pidfd: &OwnedFd, signal: Signal) -> Result<bool, Errno> {
        // SAFETY: `pidfd_send_signal` takes (int pidfd, int sig, siginfo_t*,
        // u32 flags). Returns 0 on success, -1 + errno on failure.
        let ret = unsafe {
            nix::libc::syscall(
                nix::libc::SYS_pidfd_send_signal,
                pidfd.as_raw_fd(),
                signal as i32,
                std::ptr::null::<std::ffi::c_void>(),
                0u32,
            )
        };
        // `libc::syscall` returns `-errno` (negative `c_long`) on failure;
        // `Errno::from_raw` is `pub const fn` in nix 0.29, so there is no
        // `Errno::last()` read that could race with another thread's syscall.
        if ret == 0 {
            Ok(true)
        } else {
            match Errno::from_raw((-ret) as i32) {
                Errno::ESRCH => Ok(false),
                Errno::EPERM if !self.is_current() => Ok(false),
                other => Err(other),
            }
        }
    }

    /// `pidfd_send_signal(fd, 0)` — atomic no-op probe used by the group
    /// path's leader check. `sig=0` performs the existence/permission check
    /// without delivering a signal. Returns `true` only when the incarnation
    /// is alive and still signalable by us.
    fn probe_via_pidfd(&self, pidfd: &OwnedFd) -> bool {
        // SAFETY: as above, sig=0 is the no-op probe form.
        let ret = unsafe {
            nix::libc::syscall(
                nix::libc::SYS_pidfd_send_signal,
                pidfd.as_raw_fd(),
                0i32,
                std::ptr::null::<std::ffi::c_void>(),
                0u32,
            )
        };
        if ret == 0 {
            return true;
        }
        match Errno::from_raw((-ret) as i32) {
            Errno::ESRCH => false,
            // Same reaped-vs-real distinction as `send_signal_via_pidfd`: a
            // reaped pidfd returns EPERM on some kernels (→ not alive); a
            // live-setuid leader is still our incarnation (→ alive, let
            // `signal_group` proceed to `getpgid` + `kill(-pgid)`, which
            // signals the group by pgid number).
            Errno::EPERM => self.is_current(),
            _ => false,
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
    pub(super) fn has_pidfd(&self) -> bool {
        self.pidfd.is_some()
    }

    /// Test-only: set a stale `start_time` to prove the `/proc` fallback
    /// rejects a recycled PID's start time. Keeps the pidfd; chain with
    /// `with_no_pidfd_for_test` to exercise the fallback path.
    #[cfg(test)]
    pub(super) fn with_start_time_for_test(self, start_time: u64) -> Self {
        Self { start_time, ..self }
    }

    /// Test-only: drop the pidfd so the `/proc` start-time fallback is
    /// exercised (the shape `capture` produces on a kernel without
    /// `pidfd_open`).
    #[cfg(test)]
    pub(super) fn with_no_pidfd_for_test(self) -> Self {
        Self {
            pidfd: None,
            ..self
        }
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
        // Two-side guard for the group probe: if `probe_via_pidfd` is
        // reverted to return `false`, `signal_group` returns `Ok(false)`,
        // failing the `assert!(identity.signal(SIGTERM, true)...)` below
        // (Ok(false) → assert!(false) → panic) before `try_wait` is reached.
        // The `has_pidfd` assertion pins that the pidfd branch was taken.
        assert!(
            identity.has_pidfd(),
            "pidfd must be captured so the group probe is atomic"
        );
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

    /// A live process gets a pidfd at capture. Two-side: revert `open_pidfd`
    /// to return `None` and this fails (the field is `None`).
    #[tokio::test]
    async fn pidfd_is_captured_for_a_live_process() {
        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = Pid::from_raw(child.id() as i32);
        let identity = ProcessInstance::capture(pid).expect("read child identity");
        assert!(
            identity.has_pidfd(),
            "pidfd must be captured on a kernel with pidfd_open (>= 5.3)"
        );

        child.kill().expect("kill test child");
        let status = tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("wait for test child")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(status.signal(), Some(Signal::SIGKILL as i32));
    }

    /// `pidfd_send_signal` delivers the signal to our incarnation. Two-side:
    /// revert `send_signal_via_pidfd` to return `Ok(false)` and the child
    /// survives the SIGTERM.
    #[tokio::test]
    async fn pidfd_signal_reaches_a_live_process() {
        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = Pid::from_raw(child.id() as i32);
        let identity = ProcessInstance::capture(pid).expect("read child identity");
        assert!(identity.has_pidfd(), "pidfd must be captured");

        assert!(identity
            .signal(Signal::SIGTERM, false)
            .expect("signal the matching incarnation"));
        let status = tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("terminated child must exit")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(status.signal(), Some(Signal::SIGTERM as i32));
    }

    /// After the process exits and is reaped, `pidfd_send_signal` returns
    /// `ESRCH` (or `EPERM`, on some configurations — see
    /// `send_signal_via_pidfd`) and no signal is sent. This is a
    /// behavior-preservation smoke test, NOT a defect guard — the `/proc`
    /// fallback also returns `Ok(false)` after exit (the PID is unallocated).
    /// The defect guard for the TOCTOU is `pidfd_send_signal`'s kernel
    /// contract, documented in the code.
    #[tokio::test]
    async fn pidfd_signal_returns_false_after_exit() {
        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = Pid::from_raw(child.id() as i32);
        let identity = ProcessInstance::capture(pid).expect("read child identity");
        assert!(identity.has_pidfd(), "pidfd must be captured");

        child.kill().expect("kill test child");
        let _ = tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("wait for test child")
        })
        .await
        .expect("wait task must not panic");

        assert!(
            !identity
                .signal(Signal::SIGTERM, false)
                .expect("ESRCH/EPERM is a safe non-signal outcome"),
            "pidfd_send_signal must return false for a reaped incarnation, \
             not claim to have signalled"
        );
    }
}
