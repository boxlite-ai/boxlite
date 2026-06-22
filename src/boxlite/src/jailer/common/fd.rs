//! File descriptor cleanup for jailer isolation.
//!
//! Closes inherited file descriptors to prevent information leakage.
//! This ensures the jailed process cannot access file descriptors
//! inherited from the parent (which might include credentials, sockets, etc.).
//!
//! The pre_exec path uses close-on-exec marking so Rust's own spawn
//! error-reporting pipe remains usable until exec.

const FALLBACK_MAX_FD: i32 = 1_048_576;

/// Close all FDs from `first_fd` onwards. Async-signal-safe.
///
/// This function is designed to be called from a `pre_exec` hook, which runs
/// after `fork()` but before `exec()`. Only async-signal-safe operations are
/// allowed in this context.
///
/// # Safety
///
/// This function only uses async-signal-safe syscalls (close, syscall).
/// Do NOT add:
/// - Logging (tracing, println)
/// - Memory allocation (Box, Vec, String)
/// - Mutex operations
/// - Most Rust stdlib functions
///
/// # Returns
///
/// * `Ok(())` - FDs closed successfully
/// * `Err(errno)` - Failed (returns raw errno for io::Error conversion)
#[allow(dead_code)]
pub fn close_fds_from(first_fd: i32) -> Result<(), i32> {
    #[cfg(target_os = "linux")]
    {
        // Try close_range syscall (Linux 5.9+, most efficient)
        let result = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                first_fd as libc::c_uint,
                libc::c_uint::MAX,
                0 as libc::c_uint,
            )
        };
        if result == 0 {
            return Ok(());
        }

        // Fallback: brute force close
        // Note: We can't use /proc/self/fd here because:
        // 1. read_dir allocates memory (not async-signal-safe)
        // 2. We might be in a mount namespace where /proc isn't mounted
        for fd in first_fd..1024 {
            // Ignore errors - FD might not be open
            unsafe { libc::close(fd) };
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: brute force close (no close_range syscall)
        // 4096 is a reasonable upper bound for most processes
        for fd in first_fd..4096 {
            // Ignore errors - FD might not be open
            unsafe { libc::close(fd) };
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        // Unsupported platform - return ENOSYS
        let _ = first_fd;
        Err(libc::ENOSYS)
    }
}

/// Close inherited FDs (3+). Delegates to [`close_fds_from`].
///
/// Keeps stdin(0), stdout(1), stderr(2) open. Closes everything from FD 3 onwards.
#[allow(dead_code)]
pub fn close_inherited_fds_raw() -> Result<(), i32> {
    close_fds_from(3)
}

/// Mark all FDs from `first_fd` onwards as close-on-exec. Async-signal-safe.
///
/// This is the safer operation inside `Command::pre_exec`: Rust's process
/// launcher owns an internal error-reporting pipe above fd 2, and closing it
/// before `exec` turns later pre_exec/exec failures into a child-side runtime
/// abort instead of a normal `spawn()` error.
pub fn cloexec_fds_from(first_fd: i32) -> Result<(), i32> {
    #[cfg(target_os = "linux")]
    {
        let result = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                first_fd as libc::c_uint,
                libc::c_uint::MAX,
                libc::CLOSE_RANGE_CLOEXEC as libc::c_uint,
            )
        };
        if result == 0 {
            return Ok(());
        }
    }

    for fd in first_fd..max_fd_limit() {
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    Ok(())
}

fn max_fd_limit() -> i32 {
    let mut limits = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };

    let rc = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) };
    if rc != 0 || limits.rlim_cur == libc::RLIM_INFINITY {
        return FALLBACK_MAX_FD;
    }

    i32::try_from(limits.rlim_cur)
        .ok()
        .filter(|limit| *limit > 0)
        .unwrap_or(FALLBACK_MAX_FD)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STDOUT_FD: i32 = 1;
    const STDERR_FD: i32 = 2;

    fn run_in_child(test_name: &str, f: fn() -> i32) {
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork failed for {}", test_name);

        if pid == 0 {
            let code = f();
            unsafe { libc::_exit(code) };
        }

        let mut status = 0;
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        assert_eq!(waited, pid, "waitpid failed for {}", test_name);
        assert!(
            libc::WIFEXITED(status),
            "{} child did not exit normally (status={})",
            test_name,
            status
        );
        assert_eq!(
            libc::WEXITSTATUS(status),
            0,
            "{} child failed (status={})",
            test_name,
            status
        );
    }

    fn child_close_fds_raw_succeeds() -> i32 {
        // Create a test FD
        let fd = unsafe { libc::dup(STDOUT_FD) };
        if fd <= STDERR_FD {
            return 1;
        }

        // Close inherited FDs (raw version)
        if close_inherited_fds_raw().is_err() {
            return 2;
        }

        // The test FD should be closed now
        let result = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if result != -1 {
            return 3;
        }
        0
    }

    #[test]
    fn test_close_fds_raw_succeeds() {
        run_in_child("test_close_fds_raw_succeeds", child_close_fds_raw_succeeds);
    }

    fn child_stdin_stdout_stderr_preserved() -> i32 {
        if close_inherited_fds_raw().is_err() {
            return 1;
        }

        // Standard FDs should still be valid
        if unsafe { libc::fcntl(0, libc::F_GETFD) } < 0 {
            return 2;
        }
        if unsafe { libc::fcntl(1, libc::F_GETFD) } < 0 {
            return 3;
        }
        if unsafe { libc::fcntl(2, libc::F_GETFD) } < 0 {
            return 4;
        }
        0
    }

    #[test]
    fn test_stdin_stdout_stderr_preserved() {
        run_in_child(
            "test_stdin_stdout_stderr_preserved",
            child_stdin_stdout_stderr_preserved,
        );
    }

    fn child_close_fds_from_preserves_below() -> i32 {
        // Create two test FDs (will get 3 and 4, or similar)
        let fd_a = unsafe { libc::dup(STDOUT_FD) };
        let fd_b = unsafe { libc::dup(STDOUT_FD) };
        if fd_a < 3 {
            return 1;
        }
        if fd_b <= fd_a {
            return 2;
        }

        // Close from fd_b onwards — fd_a should survive
        if close_fds_from(fd_b).is_err() {
            return 3;
        }

        // fd_a should still be valid
        let result = unsafe { libc::fcntl(fd_a, libc::F_GETFD) };
        if result < 0 {
            return 4;
        }

        // fd_b should be closed
        let result = unsafe { libc::fcntl(fd_b, libc::F_GETFD) };
        if result != -1 {
            return 5;
        }

        // Cleanup fd_a
        unsafe { libc::close(fd_a) };
        0
    }

    #[test]
    fn test_close_fds_from_preserves_below() {
        run_in_child(
            "test_close_fds_from_preserves_below",
            child_close_fds_from_preserves_below,
        );
    }

    fn child_close_fds_from_closes_target_and_above() -> i32 {
        let fd = unsafe { libc::dup(STDOUT_FD) };
        if fd < 3 {
            return 1;
        }

        // Close from fd onwards — fd itself should be closed
        if close_fds_from(fd).is_err() {
            return 2;
        }

        let result = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if result != -1 {
            return 3;
        }
        0
    }

    #[test]
    fn test_close_fds_from_closes_target_and_above() {
        run_in_child(
            "test_close_fds_from_closes_target_and_above",
            child_close_fds_from_closes_target_and_above,
        );
    }

    fn child_cloexec_fds_from_marks_target_and_above() -> i32 {
        let fd = unsafe { libc::dup(STDOUT_FD) };
        if fd < 3 {
            return 1;
        }

        if cloexec_fds_from(fd).is_err() {
            return 2;
        }

        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            return 3;
        }
        if flags & libc::FD_CLOEXEC == 0 {
            return 4;
        }

        unsafe { libc::close(fd) };
        0
    }

    #[test]
    fn test_cloexec_fds_from_marks_target_and_above() {
        run_in_child(
            "test_cloexec_fds_from_marks_target_and_above",
            child_cloexec_fds_from_marks_target_and_above,
        );
    }
}
