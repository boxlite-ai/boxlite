//! File descriptor cleanup for jailer isolation.
//!
//! Closes inherited file descriptors to prevent information leakage.
//! This ensures the jailed process cannot access file descriptors
//! inherited from the parent (which might include credentials, sockets, etc.).
//!
//! Only the async-signal-safe `close_inherited_fds_raw()` is used,
//! called from the `pre_exec` hook before exec().
//!
//! ## Strategy (in order of preference)
//!
//! 1. **Linux 5.9+**: `close_range(first_fd, ~0U, 0)` — O(1), kernel closes all.
//! 2. **Linux < 5.9**: Enumerate `/proc/self/fd` via raw `getdents64` syscall
//!    (no memory allocation) and close only open FDs. Falls back to brute-force
//!    with a dynamic upper bound queried via raw `prlimit64` syscall.
//! 3. **macOS**: Brute-force close with dynamic upper bound from
//!    `getrlimit(RLIMIT_NOFILE)`.

/// Safe cap for brute-force FD closure (2^20), matches Linux /proc/sys/fs/nr_open.
/// Used when the rlimit query fails or returns an excessively large value.
const MAX_FD_CAP: i32 = 1_048_576;

/// Convert rlimit soft/hard values to a capped i32 upper bound for FD iteration.
///
/// Uses `max(soft, hard)` to cover FDs opened before a soft limit decrease.
/// Caps excessively large values (including RLIM_INFINITY) to [`MAX_FD_CAP`].
/// Async-signal-safe: pure arithmetic, no allocation.
fn rlimit_to_max_fd(soft: u64, hard: u64) -> i32 {
    let limit = soft.max(hard);
    if limit > 0 && limit <= i32::MAX as u64 {
        limit as i32
    } else {
        // limit is 0, RLIM_INFINITY, or exceeds i32::MAX
        MAX_FD_CAP
    }
}

/// Query the upper bound for open FDs. Async-signal-safe.
///
/// On Linux, uses a raw `prlimit64` syscall to avoid libc wrappers that may
/// not be async-signal-safe in all implementations. On other platforms, uses
/// `getrlimit` which is async-signal-safe per POSIX.
///
/// Returns `max(soft, hard)` from `RLIMIT_NOFILE`, capped to [`MAX_FD_CAP`].
/// Using the max of both limits covers the case where a process opens
/// high-numbered FDs then lowers its soft limit before fork.
fn get_max_fd() -> i32 {
    #[cfg(target_os = "linux")]
    {
        let mut rlim = libc::rlimit64 {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: Raw syscall — bypasses libc wrappers for async-signal-safety.
        // pid=0 means current process, new_limit=NULL means read-only query.
        let result = unsafe {
            libc::syscall(
                libc::SYS_prlimit64,
                0 as libc::pid_t,
                libc::RLIMIT_NOFILE,
                core::ptr::null::<libc::rlimit64>(),
                &mut rlim as *mut libc::rlimit64,
            )
        };
        if result == 0 {
            rlimit_to_max_fd(rlim.rlim_cur, rlim.rlim_max)
        } else {
            MAX_FD_CAP
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        let mut rlim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: getrlimit is async-signal-safe per POSIX. rlim is a valid stack-allocated struct.
        let result = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) };
        if result == 0 {
            rlimit_to_max_fd(rlim.rlim_cur, rlim.rlim_max)
        } else {
            MAX_FD_CAP
        }
    }
}

/// Close open FDs by enumerating `/proc/self/fd` with raw `getdents64`.
/// Async-signal-safe: uses only stack buffers and raw syscalls.
///
/// Returns `true` if `/proc/self/fd` was successfully enumerated,
/// `false` if it's unavailable or an error occurred (e.g., mount namespace
/// without /proc, or `getdents64` failure).
#[cfg(target_os = "linux")]
fn close_fds_via_proc(first_fd: i32) -> bool {
    // Open /proc/self/fd with a raw syscall (no libc wrapper)
    let proc_path = b"/proc/self/fd\0";
    // SAFETY: syscall(SYS_openat, ...) invokes the kernel directly,
    // appropriate for pre_exec async-signal-safe use.
    let dir_fd = unsafe {
        libc::syscall(
            libc::SYS_openat,
            libc::AT_FDCWD,
            proc_path.as_ptr().cast::<libc::c_char>(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            0,
        ) as i32
    };
    if dir_fd < 0 {
        return false;
    }

    // Stack buffer for getdents64 — 1024 bytes handles ~40 entries per call,
    // sufficient for typical processes without heap allocation.
    let mut buf = [0u8; 1024];

    let mut success = true;

    loop {
        let nread = unsafe {
            libc::syscall(
                libc::SYS_getdents64,
                dir_fd,
                buf.as_mut_ptr(),
                buf.len() as libc::c_uint,
            )
        };

        if nread == 0 {
            // End of directory — all entries have been read successfully.
            break;
        }

        if nread < 0 {
            // SAFETY: errno is thread-local and may be read immediately after
            // the failing syscall to determine whether to retry or fall back.
            let errno = unsafe { *libc::__errno_location() };
            if errno == libc::EINTR {
                continue;
            }
            // Non-retriable error: signal failure so the brute-force fallback runs.
            success = false;
            break;
        }

        let mut offset = 0usize;
        while offset < nread as usize {
            // SAFETY: getdents64 returns packed linux_dirent64 structs.
            // d_reclen is at byte offset 16. Use read_unaligned because the
            // buffer is a byte array and the u16 field may not be 2-byte aligned.
            let d_reclen =
                unsafe { buf.as_ptr().add(offset + 16).cast::<u16>().read_unaligned() } as usize;

            if d_reclen == 0 || offset + d_reclen > nread as usize {
                break;
            }

            // d_name starts at offset 19 in linux_dirent64
            let name_ptr = unsafe { buf.as_ptr().add(offset + 19) };

            // Parse FD number from d_name (decimal string, null-terminated).
            // Async-signal-safe: no allocation, just pointer arithmetic.
            let fd = parse_fd_from_name(name_ptr);

            if let Some(fd) = fd
                && fd >= first_fd
                && fd != dir_fd
            {
                // SAFETY: close() is async-signal-safe. Closing an already-closed FD is harmless.
                unsafe { libc::close(fd) };
            }

            offset += d_reclen;
        }
    }

    // SAFETY: close() is async-signal-safe. dir_fd was opened by us above.
    unsafe { libc::close(dir_fd) };
    success
}

/// Parse a decimal FD number from a null-terminated C string pointer.
/// Returns `None` for non-numeric entries (e.g., "." and "..").
/// Async-signal-safe: no allocation, pure arithmetic.
///
/// # Safety
///
/// `ptr` must point to a valid, null-terminated byte string in readable memory.
/// Called only from `close_fds_via_proc` with pointers into the `getdents64` buffer,
/// which the kernel guarantees to contain null-terminated `d_name` fields.
#[cfg(target_os = "linux")]
fn parse_fd_from_name(ptr: *const u8) -> Option<i32> {
    let mut fd: i32 = 0;
    let mut i = 0usize;
    loop {
        // SAFETY: ptr is guaranteed by the caller to point to a null-terminated string.
        // We stop reading at the null terminator (byte == 0).
        let byte = unsafe { *ptr.add(i) };
        if byte == 0 {
            break;
        }
        if !byte.is_ascii_digit() {
            return None;
        }
        fd = fd.checked_mul(10)?.checked_add((byte - b'0') as i32)?;
        i += 1;
    }
    if i == 0 {
        return None;
    }
    Some(fd)
}

/// Brute-force close all FDs from `first_fd` to `get_max_fd()`. Async-signal-safe.
///
/// Last-resort fallback when `close_range` and `/proc/self/fd` are unavailable.
fn brute_force_close_fds(first_fd: i32) {
    let max_fd = get_max_fd();
    for fd in first_fd..max_fd {
        // SAFETY: close() is async-signal-safe. Closing a non-open FD returns EBADF (ignored).
        unsafe { libc::close(fd) };
    }
}

/// Close all FDs from `first_fd` onwards. Async-signal-safe.
///
/// This function is designed to be called from a `pre_exec` hook, which runs
/// after `fork()` but before `exec()`. Only async-signal-safe operations are
/// allowed in this context.
///
/// # Safety
///
/// This function only uses async-signal-safe syscalls (close, syscall,
/// prlimit64/getrlimit, openat, getdents64).
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
        // Strategy 1: close_range syscall (Linux 5.9+, most efficient — O(1))
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

        // Strategy 2: Enumerate /proc/self/fd via raw getdents64 (no allocation).
        // Closes only open FDs — efficient even with high ulimit -n.
        if close_fds_via_proc(first_fd) {
            return Ok(());
        }

        // Strategy 3: Brute-force close with dynamic limit from prlimit64.
        // Used when both close_range and /proc are unavailable (e.g., old kernel
        // in a mount namespace without /proc).
        brute_force_close_fds(first_fd);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: brute-force close with dynamic limit from getrlimit.
        // Handles systems where ulimit -n exceeds the previous hardcoded 4096.
        brute_force_close_fds(first_fd);
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

    /// Create a high-numbered FD (above the old hardcoded 1024/4096 limits)
    /// and verify that `close_inherited_fds_raw` closes it.
    fn child_close_high_numbered_fd() -> i32 {
        // Raise the soft FD limit so we can dup2 to a high FD number.
        // Some systems default to ulimit -n 1024, which would prevent dup2 to FD 2000.
        let new_limit = libc::rlimit {
            rlim_cur: 4096,
            rlim_max: 4096,
        };
        // SAFETY: setrlimit is async-signal-safe. Raising soft limit within hard limit is allowed.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &new_limit) } != 0 {
            // Can't raise limit (hard limit too low) — skip test gracefully
            return 0;
        }

        // dup2 stdout to a high FD number that exceeds the old hardcoded limits.
        // Use 2000 on all platforms — above old Linux limit (1024) and reasonable.
        let high_fd: i32 = 2000;
        let result = unsafe { libc::dup2(STDOUT_FD, high_fd) };
        if result != high_fd {
            // dup2 failed — unexpected after raising ulimit
            return 1;
        }

        // Verify the high FD is open
        if unsafe { libc::fcntl(high_fd, libc::F_GETFD) } < 0 {
            return 2;
        }

        // Close all inherited FDs
        if close_inherited_fds_raw().is_err() {
            return 3;
        }

        // The high FD should now be closed
        if unsafe { libc::fcntl(high_fd, libc::F_GETFD) } != -1 {
            return 4;
        }
        0
    }

    #[test]
    fn test_close_high_numbered_fd() {
        run_in_child("test_close_high_numbered_fd", child_close_high_numbered_fd);
    }

    #[test]
    fn test_get_max_fd_returns_positive() {
        let max = get_max_fd();
        assert!(
            max > 0,
            "get_max_fd should return positive value, got {}",
            max
        );
        assert!(
            max >= 256,
            "get_max_fd should return at least 256, got {}",
            max
        );
    }

    #[test]
    fn test_rlimit_to_max_fd() {
        // Normal soft limit
        assert_eq!(rlimit_to_max_fd(1024, 4096), 4096);

        // Soft > hard (unusual but handled)
        assert_eq!(rlimit_to_max_fd(8192, 1024), 8192);

        // Exact i32::MAX
        assert_eq!(rlimit_to_max_fd(i32::MAX as u64, 0), i32::MAX);

        // Exceeds i32::MAX — capped
        assert_eq!(rlimit_to_max_fd(i32::MAX as u64 + 1, 0), MAX_FD_CAP);

        // RLIM_INFINITY (u64::MAX) — capped
        assert_eq!(rlimit_to_max_fd(u64::MAX, u64::MAX), MAX_FD_CAP);

        // Both zero — capped
        assert_eq!(rlimit_to_max_fd(0, 0), MAX_FD_CAP);

        // Soft zero, hard nonzero — uses hard
        assert_eq!(rlimit_to_max_fd(0, 2048), 2048);
    }

    /// Verify brute-force fallback closes FDs correctly.
    /// This exercises the code path used when `close_fds_via_proc` returns `false`
    /// (e.g., when `getdents64` fails or `/proc` is unavailable).
    fn child_brute_force_fallback_closes_fds() -> i32 {
        // Create test FDs
        let fd_a = unsafe { libc::dup(STDOUT_FD) };
        let fd_b = unsafe { libc::dup(STDOUT_FD) };
        if fd_a < 3 || fd_b <= fd_a {
            return 1;
        }

        // Call brute_force_close_fds directly — this is the fallback path
        // exercised when getdents64 fails (nread < 0).
        brute_force_close_fds(fd_a);

        // Both FDs should be closed
        if unsafe { libc::fcntl(fd_a, libc::F_GETFD) } != -1 {
            return 2;
        }
        if unsafe { libc::fcntl(fd_b, libc::F_GETFD) } != -1 {
            return 3;
        }
        0
    }

    #[test]
    fn test_brute_force_fallback_closes_fds() {
        run_in_child(
            "test_brute_force_fallback_closes_fds",
            child_brute_force_fallback_closes_fds,
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_parse_fd_from_name() {
        // Valid numeric names
        assert_eq!(parse_fd_from_name(b"0\0".as_ptr()), Some(0));
        assert_eq!(parse_fd_from_name(b"3\0".as_ptr()), Some(3));
        assert_eq!(parse_fd_from_name(b"42\0".as_ptr()), Some(42));
        assert_eq!(parse_fd_from_name(b"1024\0".as_ptr()), Some(1024));
        assert_eq!(parse_fd_from_name(b"65535\0".as_ptr()), Some(65535));

        // Non-numeric names (. and ..)
        assert_eq!(parse_fd_from_name(b".\0".as_ptr()), None);
        assert_eq!(parse_fd_from_name(b"..\0".as_ptr()), None);

        // Empty name
        assert_eq!(parse_fd_from_name(b"\0".as_ptr()), None);

        // Overflow: i32::MAX (2147483647) should succeed
        assert_eq!(parse_fd_from_name(b"2147483647\0".as_ptr()), Some(i32::MAX));

        // Overflow: i32::MAX + 1 (2147483648) should return None (checked_add overflow)
        assert_eq!(parse_fd_from_name(b"2147483648\0".as_ptr()), None);

        // Overflow: very large number should return None
        assert_eq!(parse_fd_from_name(b"99999999999\0".as_ptr()), None);
    }
}
