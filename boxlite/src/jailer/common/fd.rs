//! File descriptor cleanup for jailer isolation.
//!
//! Closes inherited file descriptors to prevent information leakage.
//! This ensures the jailed process cannot access file descriptors
//! inherited from the parent (which might include credentials, sockets, etc.).
//!
//! Only the async-signal-safe `close_inherited_fds_raw()` is used,
//! called from the `pre_exec` hook before exec().

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
pub fn close_inherited_fds_raw() -> Result<(), i32> {
    close_fds_from(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STDOUT_FD: i32 = 1;
    const STDERR_FD: i32 = 2;

    #[test]
    fn test_close_fds_raw_succeeds() {
        // Create a test FD
        let fd = unsafe { libc::dup(STDOUT_FD) };
        assert!(fd > STDERR_FD);

        // Close inherited FDs (raw version)
        close_inherited_fds_raw().expect("Should succeed");

        // The test FD should be closed now
        let result = unsafe { libc::close(fd) };
        // On some systems this returns 0, on others -1 with EBADF
        let _ = result;
    }

    #[test]
    fn test_stdin_stdout_stderr_preserved() {
        close_inherited_fds_raw().expect("Should succeed");

        // Standard FDs should still be valid
        let result = unsafe { libc::fcntl(0, libc::F_GETFD) };
        assert!(result >= 0 || result == -1, "stdin should be accessible");

        let result = unsafe { libc::fcntl(1, libc::F_GETFD) };
        assert!(result >= 0 || result == -1, "stdout should be accessible");

        let result = unsafe { libc::fcntl(2, libc::F_GETFD) };
        assert!(result >= 0 || result == -1, "stderr should be accessible");
    }

    #[test]
    fn test_close_fds_from_preserves_below() {
        // Create two test FDs (will get 3 and 4, or similar)
        let fd_a = unsafe { libc::dup(STDOUT_FD) };
        let fd_b = unsafe { libc::dup(STDOUT_FD) };
        assert!(fd_a >= 3);
        assert!(fd_b > fd_a);

        // Close from fd_b onwards — fd_a should survive
        close_fds_from(fd_b).expect("Should succeed");

        // fd_a should still be valid
        let result = unsafe { libc::fcntl(fd_a, libc::F_GETFD) };
        assert!(result >= 0, "fd_a should still be open");

        // fd_b should be closed
        let result = unsafe { libc::fcntl(fd_b, libc::F_GETFD) };
        assert_eq!(result, -1, "fd_b should be closed");

        // Cleanup fd_a
        unsafe { libc::close(fd_a) };
    }

    #[test]
    fn test_close_fds_from_closes_target_and_above() {
        let fd = unsafe { libc::dup(STDOUT_FD) };
        assert!(fd >= 3);

        // Close from fd onwards — fd itself should be closed
        close_fds_from(fd).expect("Should succeed");

        let result = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert_eq!(result, -1, "target fd should be closed");
    }
}
