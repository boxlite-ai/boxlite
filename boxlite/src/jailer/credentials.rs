//! User namespace credential probing.
//!
//! Direct port of Chrome's `sandbox/linux/services/credentials.cc`.
//! See: <https://chromium.googlesource.com/chromium/src/sandbox/+/refs/heads/main/linux/services/credentials.cc>
//!
//! Chrome probes user namespace support by actually forking with `CLONE_NEWUSER`
//! and checking if the child can set up uid/gid maps. This is more reliable
//! than checking sysctl files because it tests the actual kernel code path.

/// Port of Chrome's `CheckCloneNewUserErrno()`.
///
/// Validates that `clone(CLONE_NEWUSER)` failed with an expected errno.
///
/// Chrome's comment: "EPERM can happen if already in a chroot. EUSERS if
/// too many nested namespaces are used. EINVAL for kernels that don't
/// support the feature. ENOSPC can occur when the system has reached its
/// maximum configured number of user namespaces."
///
/// Returns the errno for diagnosis. Logs unexpected errors.
pub(crate) fn check_clone_new_user_errno(error: i32) -> i32 {
    match error {
        libc::EPERM | libc::EUSERS | libc::EINVAL | libc::ENOSPC => {
            // Expected errors — same set Chrome checks
            tracing::debug!(
                errno = error,
                message = %std::io::Error::from_raw_os_error(error),
                "clone(CLONE_NEWUSER) failed with expected errno"
            );
        }
        _ => {
            // Chrome PCHECK crashes here; we log error instead (we're a library)
            tracing::error!(
                errno = error,
                message = %std::io::Error::from_raw_os_error(error),
                "clone(CLONE_NEWUSER) failed with UNEXPECTED errno"
            );
        }
    }
    error
}

/// Port of Chrome's `Credentials::CanCreateProcessInNewUserNS()`.
///
/// Probes whether the current process can create a child in a new user
/// namespace. Forks with `CLONE_NEWUSER | SIGCHLD`, and in the child:
/// 1. Writes uid/gid maps (Chrome's `SetGidAndUidMaps`)
/// 2. Calls `unshare(CLONE_NEWUSER)` again (tests nested userns)
///
/// Returns `Ok(())` if user namespaces work, `Err(errno)` with the
/// specific failure code for diagnosis.
///
/// # Safety
///
/// Uses raw `clone` syscall and `waitpid`. The child process only uses
/// async-signal-safe operations (open/write/close/unshare/_exit).
pub(crate) fn can_create_process_in_new_user_ns() -> Result<(), i32> {
    // SAFETY: Uses clone(CLONE_NEWUSER | SIGCHLD) to fork a child process.
    // Child only performs async-signal-safe operations before _exit().
    // Parent waits for child with EINTR retry loop.
    unsafe {
        // Chrome: GetRESIds(&uid, &gid)
        let uid = libc::getuid();
        let gid = libc::getgid();

        // Chrome: base::ForkWithFlags(CLONE_NEWUSER | SIGCHLD, ...)
        let pid = libc::syscall(
            libc::SYS_clone,
            libc::CLONE_NEWUSER | libc::SIGCHLD,
            std::ptr::null::<libc::c_void>(), // stack
            std::ptr::null::<libc::c_void>(), // parent_tid
            std::ptr::null::<libc::c_void>(), // child_tid
            0i64,                             // tls
        ) as libc::pid_t;

        if pid == -1 {
            let errno = *libc::__errno_location();
            return Err(check_clone_new_user_errno(errno));
        }

        if pid == 0 {
            // Child process — Chrome's child logic:
            // 1. SetGidAndUidMaps(gid, uid)
            // 2. DropAllCapabilities() — skipped, not needed for probe
            // 3. unshare(CLONE_NEWUSER) again

            // Write /proc/self/setgroups -> "deny" (required before gid_map)
            if write_proc_file("/proc/self/setgroups\0", b"deny").is_err() {
                libc::_exit(1);
            }

            // Write /proc/self/gid_map
            let mut gid_buf = [0u8; 32];
            let gid_len = format_id_map(&mut gid_buf, gid, gid);
            if write_proc_file("/proc/self/gid_map\0", &gid_buf[..gid_len]).is_err() {
                libc::_exit(1);
            }

            // Write /proc/self/uid_map
            let mut uid_buf = [0u8; 32];
            let uid_len = format_id_map(&mut uid_buf, uid, uid);
            if write_proc_file("/proc/self/uid_map\0", &uid_buf[..uid_len]).is_err() {
                libc::_exit(1);
            }

            // Chrome: sys_unshare(CLONE_NEWUSER) — test nested user namespace
            if libc::unshare(libc::CLONE_NEWUSER) != 0 {
                libc::_exit(1);
            }

            libc::_exit(0);
        }

        // Parent: wait for child — Chrome: HANDLE_EINTR(waitpid(...))
        let mut status: libc::c_int = -1;
        loop {
            let r = libc::waitpid(pid, &mut status, 0);
            if r == pid {
                break;
            }
            if r == -1 && *libc::__errno_location() != libc::EINTR {
                return Err(*libc::__errno_location());
            }
        }

        if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 {
            Ok(())
        } else {
            // Child failed — treat as permission error
            Err(libc::EPERM)
        }
    }
}

/// Format a uid/gid map entry ("inside_id outside_id 1\n") into a stack buffer.
///
/// Async-signal-safe: no heap allocation, no format!().
/// Returns the number of bytes written.
fn format_id_map(buf: &mut [u8; 32], inside_id: libc::uid_t, outside_id: libc::uid_t) -> usize {
    let mut pos = 0;
    pos += write_u32_to_buf(&mut buf[pos..], inside_id);
    buf[pos] = b' ';
    pos += 1;
    pos += write_u32_to_buf(&mut buf[pos..], outside_id);
    buf[pos] = b' ';
    pos += 1;
    buf[pos] = b'1';
    pos += 1;
    buf[pos] = b'\n';
    pos += 1;
    pos
}

/// Write a u32 as decimal ASCII into a buffer. Returns bytes written.
fn write_u32_to_buf(buf: &mut [u8], mut n: u32) -> usize {
    if n == 0 {
        buf[0] = b'0';
        return 1;
    }

    // Write digits in reverse order into a temp buffer
    let mut temp = [0u8; 10]; // u32 max is 4294967295 (10 digits)
    let mut len = 0;
    while n > 0 {
        temp[len] = b'0' + (n % 10) as u8;
        n /= 10;
        len += 1;
    }

    // Reverse into output buffer
    for i in 0..len {
        buf[i] = temp[len - 1 - i];
    }
    len
}

/// Async-signal-safe write to a /proc file (for use in child after fork).
///
/// Chrome uses `NamespaceUtils::WriteToIdMapFile()` for this.
///
/// # Safety
///
/// Only uses async-signal-safe syscalls: open, write, close.
/// The `path` must be a null-terminated string (e.g., "/proc/self/uid_map\0").
unsafe fn write_proc_file(path: &str, content: &[u8]) -> Result<(), ()> {
    // Path must be null-terminated for libc::open
    // SAFETY: path is a null-terminated string literal, content is a valid slice.
    // All three syscalls (open, write, close) are async-signal-safe.
    unsafe {
        let fd = libc::open(
            path.as_ptr() as *const libc::c_char,
            libc::O_WRONLY | libc::O_CLOEXEC,
        );
        if fd < 0 {
            return Err(());
        }
        let written = libc::write(fd, content.as_ptr() as *const libc::c_void, content.len());
        libc::close(fd);
        if written < 0 { Err(()) } else { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_id_map() {
        let mut buf = [0u8; 32];
        let len = format_id_map(&mut buf, 1000, 1000);
        assert_eq!(&buf[..len], b"1000 1000 1\n");
    }

    #[test]
    fn test_format_id_map_zero() {
        let mut buf = [0u8; 32];
        let len = format_id_map(&mut buf, 0, 0);
        assert_eq!(&buf[..len], b"0 0 1\n");
    }

    #[test]
    fn test_write_u32_to_buf() {
        let mut buf = [0u8; 16];
        let len = write_u32_to_buf(&mut buf, 12345);
        assert_eq!(&buf[..len], b"12345");
    }

    #[test]
    fn test_write_u32_to_buf_zero() {
        let mut buf = [0u8; 16];
        let len = write_u32_to_buf(&mut buf, 0);
        assert_eq!(&buf[..len], b"0");
    }

    #[test]
    fn test_check_clone_new_user_errno_expected() {
        // Expected errnos should be returned as-is
        assert_eq!(check_clone_new_user_errno(libc::EPERM), libc::EPERM);
        assert_eq!(check_clone_new_user_errno(libc::EUSERS), libc::EUSERS);
        assert_eq!(check_clone_new_user_errno(libc::EINVAL), libc::EINVAL);
        assert_eq!(check_clone_new_user_errno(libc::ENOSPC), libc::ENOSPC);
    }

    #[test]
    fn test_check_clone_new_user_errno_unexpected() {
        // Unexpected errnos should also be returned (just logged differently)
        assert_eq!(check_clone_new_user_errno(libc::EACCES), libc::EACCES);
    }

    #[test]
    fn test_can_create_process_in_new_user_ns() {
        // This is a real probe — result depends on the system
        let result = can_create_process_in_new_user_ns();
        match result {
            Ok(()) => {
                // User namespaces are available
            }
            Err(errno) => {
                // Should be one of Chrome's expected errnos
                assert!(
                    errno == libc::EPERM
                        || errno == libc::EUSERS
                        || errno == libc::EINVAL
                        || errno == libc::ENOSPC,
                    "Unexpected errno: {} ({})",
                    errno,
                    std::io::Error::from_raw_os_error(errno)
                );
            }
        }
    }
}
