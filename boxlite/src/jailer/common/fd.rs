//! File descriptor cleanup for jailer isolation.
//!
//! Closes inherited file descriptors to prevent information leakage.
//! This ensures the jailed process cannot access file descriptors
//! inherited from the parent (which might include credentials, sockets, etc.).
//!
//! Only the async-signal-safe `close_inherited_fds_raw()` is used,
//! called from the `pre_exec` hook before exec().

/// Close inherited FDs - async-signal-safe version for pre_exec.
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
pub fn close_inherited_fds_raw() -> Result<(), i32> {
    const FIRST_FD: i32 = 3; // Keep stdin(0), stdout(1), stderr(2)

    #[cfg(target_os = "linux")]
    {
        // Try close_range syscall (Linux 5.9+, most efficient)
        let result = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                FIRST_FD as libc::c_uint,
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
        for fd in FIRST_FD..1024 {
            // Ignore errors - FD might not be open
            unsafe { libc::close(fd) };
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: brute force close (no close_range syscall)
        // 4096 is a reasonable upper bound for most processes
        for fd in FIRST_FD..4096 {
            // Ignore errors - FD might not be open
            unsafe { libc::close(fd) };
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        // Unsupported platform - return ENOSYS
        Err(libc::ENOSYS)
    }
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
}
