//! Process validation utilities for PID checking and verification.

use std::time::Duration;

// ============================================================================
// PROCESS MONITOR - Wait for process exit with exit code capture
// ============================================================================

/// Exit status from process monitoring.
///
/// Distinguishes between cases where we can capture the exit code vs. cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessExit {
    /// Process exited, we captured the exit code.
    ///
    /// This happens when we're the parent process (spawned the child)
    /// and `waitpid()` successfully reaped the process.
    Code(i32),

    /// Process is dead but exit code is unavailable.
    ///
    /// This happens in "attached" mode when we reconnect to an existing
    /// process. Unix only allows the parent to `waitpid()` its children,
    /// so we get `ECHILD` and fall back to `kill(pid, 0)` to detect death.
    Unknown,
}

/// Monitors a process for exit, handling both owned and attached cases.
///
/// # Unix Parent/Child Constraint
///
/// Only the parent process can `waitpid()` on a child. When we "attach"
/// to an existing process (e.g., reconnect after detach), we're not the
/// parent, so `waitpid()` returns `ECHILD`. In that case, we fall back
/// to `kill(pid, 0)` to detect process death, but cannot get the exit code.
///
/// # Example
///
/// ```ignore
/// let monitor = ProcessMonitor::new(pid);
///
/// // Non-blocking check
/// if let Some(exit) = monitor.try_wait() {
///     match exit {
///         ProcessExit::Code(code) => println!("Exited with code {}", code),
///         ProcessExit::Unknown => println!("Process died, code unknown"),
///     }
/// }
///
/// // Async wait until exit
/// let exit = monitor.wait_for_exit().await;
/// ```
pub struct ProcessMonitor {
    pid: u32,
}

impl ProcessMonitor {
    /// Create a new process monitor for the given PID.
    pub fn new(pid: u32) -> Self {
        Self { pid }
    }

    /// Get the monitored process ID.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Check if the process is still alive.
    pub fn is_alive(&self) -> bool {
        is_process_alive(self.pid)
    }

    /// Try to reap the process and get exit code (non-blocking).
    ///
    /// # Returns
    ///
    /// - `Some(ProcessExit::Code(n))` - Process exited, we got the code
    /// - `Some(ProcessExit::Unknown)` - Process dead, but we're not parent (ECHILD)
    /// - `None` - Process still running
    pub fn try_wait(&self) -> Option<ProcessExit> {
        let mut status: i32 = 0;
        let result = unsafe { libc::waitpid(self.pid as i32, &mut status, libc::WNOHANG) };

        if result > 0 {
            // We reaped it, decode the status
            Some(ProcessExit::Code(decode_wait_status(status)))
        } else if result < 0 && !self.is_alive() {
            // ECHILD (not our child) but process is dead
            Some(ProcessExit::Unknown)
        } else {
            // Still running (result == 0) or error but still alive
            None
        }
    }

    /// Async poll until the process exits.
    ///
    /// Polls every 500ms until the process terminates.
    pub async fn wait_for_exit(&self) -> ProcessExit {
        let poll_interval = Duration::from_millis(500);
        loop {
            if let Some(exit) = self.try_wait() {
                return exit;
            }
            tokio::time::sleep(poll_interval).await;
        }
    }
}

/// Decode waitpid status into exit code using Unix conventions.
///
/// - Normal exit: returns `WEXITSTATUS` (0-255)
/// - Signal termination: returns `128 + signal_number` (Unix convention)
/// - Other: returns -1
fn decode_wait_status(status: i32) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status) // Unix convention
    } else {
        -1 // Unknown
    }
}

/// Kill a process with SIGKILL.
///
/// # Returns
/// * `true` - Process was killed or doesn't exist
/// * `false` - Failed to kill (permission denied)
pub fn kill_process(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, libc::SIGKILL) == 0 || !is_process_alive(pid) }
}

/// Read a foreign process's start-time fingerprint for PID-reuse detection.
///
/// Parent-side counterpart of [`crate::jailer::common::pid::write_pid_file_raw`],
/// which captures the same value in the child. Recovery compares the
/// value stored in `shim.pid` against this reading; a mismatch reliably
/// signals PID reuse.
///
/// # Units (platform-specific, never cross-compared)
/// * **Linux**: clock ticks since boot (field 22 of `/proc/PID/stat`).
/// * **macOS**: epoch microseconds (`pbi_start_tvsec * 1e6 + pbi_start_tvusec`).
///
/// # Returns
/// * `Some(t)` — start-time captured.
/// * `None` — process does not exist or platform read failed (treat as Mismatch).
pub fn process_start_time(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        process_start_time_linux(pid)
    }

    #[cfg(target_os = "macos")]
    {
        process_start_time_macos(pid)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(target_os = "linux")]
fn process_start_time_linux(pid: u32) -> Option<u64> {
    // `/proc/PID/stat` format:  PID (COMM) STATE PPID ... STARTTIME(22) ...
    // COMM is the only parenthesized field — split on the last `)` to skip
    // past names containing spaces or close-parens.
    let raw = std::fs::read(format!("/proc/{}/stat", pid)).ok()?;
    let after_comm_pos = raw.iter().rposition(|&b| b == b')')?;
    let tail = &raw[after_comm_pos + 1..];
    // After the closing `)` and one space, fields are space-separated.
    // STARTTIME is field 22 of the full line; in `tail` it is field 20
    // (fields 1 and 2 — pid and comm — are already consumed).
    let tail_str = std::str::from_utf8(tail).ok()?;
    tail_str.split_whitespace().nth(19)?.parse::<u64>().ok()
}

#[cfg(target_os = "macos")]
fn process_start_time_macos(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let expected_size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let bytes = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected_size,
        )
    };
    if bytes != expected_size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// Check if a process with the given PID exists.
///
/// Uses `libc::kill(pid, 0)` which sends a null signal to check existence.
/// A zombie/defunct process is treated as not alive.
///
/// # Returns
/// * `true` - Process exists
/// * `false` - Process does not exist or permission denied
pub fn is_process_alive(pid: u32) -> bool {
    if unsafe { libc::kill(pid as i32, 0) } != 0 {
        return false;
    }

    !is_process_zombie(pid)
}

fn is_process_zombie(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        is_process_zombie_linux(pid)
    }

    #[cfg(target_os = "macos")]
    {
        is_process_zombie_macos(pid)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

#[cfg(target_os = "linux")]
fn is_process_zombie_linux(pid: u32) -> bool {
    let status_path = format!("/proc/{pid}/status");
    let Ok(status) = std::fs::read_to_string(status_path) else {
        return false;
    };

    status.lines().find_map(|line| {
        line.strip_prefix("State:")
            .and_then(|state| state.trim_start().chars().next())
    }) == Some('Z')
}

#[cfg(target_os = "macos")]
fn is_process_zombie_macos(pid: u32) -> bool {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let expected_size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;

    let bytes = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected_size,
        )
    };

    if bytes != expected_size {
        if bytes != 0 {
            return false;
        }

        // On macOS, PROC_PIDTBSDINFO may return 0 for zombies.
        // Distinguish that from live processes by checking whether
        // the executable path is still queryable.
        let mut path_buf = [0 as libc::c_char; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let path_len = unsafe {
            libc::proc_pidpath(
                pid as i32,
                path_buf.as_mut_ptr().cast(),
                path_buf.len() as u32,
            )
        };

        return path_len == 0;
    }

    let info = unsafe { info.assume_init() };
    info.pbi_status == libc::SZOMB
}

// ============================================================================
// Bounded reap: wait for `pid` to exit (with deadline) then waitpid
// ============================================================================
//
// Used by the rm-force / health-check / attached-stop force paths to
// replace the WNOHANG-poll-sleep loops that were scattered across
// `box_impl.rs`, `rt_impl.rs`, and `shim.rs`. Implemented on top of
// pidfd (Linux 5.3+) so:
//   - the wait is *bounded* (deadline) without a polling sleep loop,
//   - the wait is *interruptible* in both sync (poll(2)) and async
//     (tokio AsyncFd) contexts without spawn_blocking thread leaks,
//   - shim wedge (D state, uninterruptible sleep) returns
//     `TimedOut` cleanly instead of hanging forever or burning a
//     blocking-pool slot.
//
// On `pidfd_open` failure (PID not our child, not found, pre-5.3
// kernel) the helpers fall back to a single WNOHANG attempt — never
// to a sleep loop, so the worst case is "reaper missed it once."

#[derive(Debug, PartialEq, Eq)]
pub enum ReapOutcome {
    /// `waitpid` returned the exited child; PID slot freed.
    Reaped,
    /// `waitpid` returned -1 (ECHILD or similar). Common in attached
    /// mode where the shim is owned by a different process.
    NotOurChild,
    /// Deadline elapsed; PID still alive (or in an uninterruptible
    /// state the caller can't escape).
    TimedOut,
}

/// One-shot non-blocking `waitpid(pid, _, WNOHANG)`. Fallback for the
/// `pidfd_open` failure path — never invoked from the normal flow.
fn reap_once(pid: u32) -> ReapOutcome {
    let mut status: i32 = 0;
    // SAFETY: documented C ABI; pid fits libc::pid_t.
    let r = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
    if r > 0 {
        ReapOutcome::Reaped
    } else if r < 0 {
        ReapOutcome::NotOurChild
    } else {
        ReapOutcome::TimedOut
    }
}

/// Best-effort open a pidfd for `pid`. Returns the raw fd on success,
/// or -1 on any failure (including non-Linux targets where pidfd_open
/// is not a thing — callers fall back to the WNOHANG reap_once path).
#[cfg(target_os = "linux")]
fn try_pidfd_open(pid: u32) -> i32 {
    // pidfd_open is Linux 5.3+; libc 0.2 doesn't always have the
    // wrapper, so go through SYS_pidfd_open directly.
    let r = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0_u32) };
    if r < 0 { -1 } else { r as i32 }
}

#[cfg(not(target_os = "linux"))]
fn try_pidfd_open(_pid: u32) -> i32 {
    -1
}

/// Block until `pid` exits, then waitpid. Returns within
/// `deadline_ms` even if the pid never exits.
pub fn reap_pid_blocking(pid: u32, deadline_ms: u64) -> ReapOutcome {
    let pidfd = try_pidfd_open(pid);
    if pidfd < 0 {
        return reap_once(pid);
    }
    let mut pollfd = libc::pollfd {
        fd: pidfd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: pollfd is a valid pointer to a single entry; nfds = 1.
    let r = unsafe { libc::poll(&mut pollfd, 1, deadline_ms as libc::c_int) };
    unsafe { libc::close(pidfd) };
    if r > 0 {
        let mut status: i32 = 0;
        // SAFETY: pidfd was readable → target PID has exited; calling
        // waitpid here is non-blocking even with `WNOHANG` cleared.
        // Crucially, `pidfd_open` will *also* succeed for PIDs that
        // are not our children, in which case `waitpid` returns
        // -1/ECHILD instead of reaping — we must NOT report `Reaped`
        // in that case, because the runtime then frees state (PID
        // file, DB record) for a shim it never owned. Coderabbitai
        // review on #613 flagged this; the man-page citation is in
        // the thread for archaeology.
        let w = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, 0) };
        if w > 0 {
            ReapOutcome::Reaped
        } else {
            // -1 → ECHILD (not our child) or another error. Either
            // way: we did NOT reap. NotOurChild is the safer label
            // because the runtime then routes through the inline
            // SIGKILL+wait fallback rather than declaring success.
            ReapOutcome::NotOurChild
        }
    } else if r == 0 {
        ReapOutcome::TimedOut
    } else {
        ReapOutcome::NotOurChild
    }
}

/// Async counterpart. Drops cleanly on timeout — no `spawn_blocking`
/// thread leak.
pub async fn reap_pid_async(pid: u32, deadline_ms: u64) -> ReapOutcome {
    use std::os::fd::FromRawFd;

    let pidfd = try_pidfd_open(pid);
    if pidfd < 0 {
        return reap_once(pid);
    }
    // SAFETY: pidfd is a fresh fd from the kernel; OwnedFd takes
    // ownership so Drop closes it whether or not AsyncFd succeeds.
    let owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(pidfd) };
    let async_fd =
        match tokio::io::unix::AsyncFd::with_interest(owned, tokio::io::Interest::READABLE) {
            Ok(f) => f,
            Err(_) => return reap_once(pid),
        };
    match tokio::time::timeout(
        std::time::Duration::from_millis(deadline_ms),
        async_fd.readable(),
    )
    .await
    {
        Ok(Ok(_guard)) => {
            // Same gotcha as `reap_pid_blocking`: pidfd_open succeeds
            // for non-child PIDs, and `waitpid(non_child_pid, ..., 0)`
            // returns -1/ECHILD instead of reaping. Report NotOurChild
            // in that case so the caller routes through its inline
            // fallback rather than declaring success.
            let mut status: i32 = 0;
            let w = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, 0) };
            if w > 0 {
                ReapOutcome::Reaped
            } else {
                ReapOutcome::NotOurChild
            }
        }
        _ => ReapOutcome::TimedOut,
    }
    // async_fd Drop closes the pidfd.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_process_alive_current() {
        // Current process should always be alive
        let current_pid = std::process::id();
        assert!(is_process_alive(current_pid));
    }

    #[test]
    fn test_is_process_alive_invalid() {
        // Use very high PIDs unlikely to exist
        // Note: u32::MAX becomes -1 when cast to i32, which has special meaning in kill()
        // Note: PID 0 might exist on some systems (kernel/scheduler)
        assert!(!is_process_alive(999999999));
        assert!(!is_process_alive(888888888));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn test_is_process_alive_false_for_zombie() {
        use std::time::{Duration, Instant};

        struct PidReaper {
            pid: libc::pid_t,
        }

        impl Drop for PidReaper {
            fn drop(&mut self) {
                let mut status = 0;
                let _ = unsafe { libc::waitpid(self.pid, &mut status, 0) };
            }
        }

        let child_pid = unsafe { libc::fork() };
        assert!(child_pid >= 0, "fork() failed");
        if child_pid == 0 {
            unsafe { libc::_exit(0) };
        }

        let _reaper = PidReaper { pid: child_pid };
        let child_pid = child_pid as u32;

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let raw_exists = unsafe { libc::kill(child_pid as i32, 0) == 0 };

            if !raw_exists {
                // Some environments auto-reap exited children immediately.
                // In that case there is no zombie window to assert against.
                return;
            }

            if !is_process_alive(child_pid) {
                return;
            }

            std::thread::sleep(Duration::from_millis(10));
        }

        panic!("Exited child remained reported as alive while still existing");
    }

    // ========================================================================
    // ProcessMonitor tests
    // ========================================================================

    #[test]
    fn test_decode_wait_status_normal_exit() {
        // Simulate WIFEXITED with exit code 0
        // On Unix, exit status is stored in bits 8-15
        let status = 0 << 8; // exit(0)
        assert_eq!(decode_wait_status(status), 0);

        let status = 1 << 8; // exit(1)
        assert_eq!(decode_wait_status(status), 1);

        let status = 42 << 8; // exit(42)
        assert_eq!(decode_wait_status(status), 42);
    }

    #[test]
    fn test_decode_wait_status_signal() {
        // Simulate WIFSIGNALED with signal
        // On Unix, signal is stored in bits 0-6, with bit 7 = core dump
        let sigterm = libc::SIGTERM; // 15
        assert_eq!(decode_wait_status(sigterm), 128 + sigterm);

        let sigkill = libc::SIGKILL; // 9
        assert_eq!(decode_wait_status(sigkill), 128 + sigkill);

        let sigabrt = libc::SIGABRT; // 6
        assert_eq!(decode_wait_status(sigabrt), 128 + sigabrt);
    }

    #[test]
    fn test_process_monitor_current_process() {
        let monitor = ProcessMonitor::new(std::process::id());

        // Current process is alive
        assert!(monitor.is_alive());

        // try_wait should return None (still running)
        assert!(monitor.try_wait().is_none());
    }

    #[test]
    fn test_process_monitor_invalid_pid() {
        let monitor = ProcessMonitor::new(999999999);

        // Invalid PID is not alive
        assert!(!monitor.is_alive());

        // try_wait should return Unknown (not our child, but dead)
        assert_eq!(monitor.try_wait(), Some(ProcessExit::Unknown));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    #[allow(clippy::zombie_processes)] // ProcessMonitor::try_wait() calls waitpid() internally
    fn test_process_monitor_child_exit() {
        use std::process::Command;

        // Spawn a child process that exits immediately with code 42
        let child = Command::new("sh")
            .arg("-c")
            .arg("exit 42")
            .spawn()
            .expect("Failed to spawn child");

        let monitor = ProcessMonitor::new(child.id());

        // Wait for the child to exit (blocking in test is OK)
        std::thread::sleep(std::time::Duration::from_millis(100));

        // ProcessMonitor::try_wait() calls waitpid() which reaps the child
        match monitor.try_wait() {
            Some(ProcessExit::Code(code)) => assert_eq!(code, 42),
            other => panic!("Expected ProcessExit::Code(42), got {:?}", other),
        }
    }

    #[test]
    fn test_process_exit_equality() {
        assert_eq!(ProcessExit::Code(0), ProcessExit::Code(0));
        assert_eq!(ProcessExit::Code(1), ProcessExit::Code(1));
        assert_eq!(ProcessExit::Unknown, ProcessExit::Unknown);

        assert_ne!(ProcessExit::Code(0), ProcessExit::Code(1));
        assert_ne!(ProcessExit::Code(0), ProcessExit::Unknown);
    }
}
