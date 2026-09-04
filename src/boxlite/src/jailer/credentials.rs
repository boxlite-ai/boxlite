//! User namespace credential probing.
//!
//! Direct port of Chrome's `sandbox/linux/services/credentials.cc`.
//! See: <https://chromium.googlesource.com/chromium/src/sandbox/+/refs/heads/main/linux/services/credentials.cc>
//!
//! Chrome probes user namespace support by actually forking with `CLONE_NEWUSER`
//! and checking if the child can set up uid/gid maps. This is more reliable
//! than checking sysctl files because it tests the actual kernel code path.

use std::fmt;

/// How a `clone(CLONE_NEWUSER)` probe failed.
///
/// The probe either rolls up the child's failing-syscall errno via
/// `WEXITSTATUS`, or it never got that far (signal-killed or kernel
/// returned a status `waitpid` doesn't describe). We model the latter
/// two as their own variants so they don't get smuggled inside a real
/// errno value — earlier versions used `EINTR` as a "child was killed"
/// sentinel, which collides with `EINTR`'s established "retry-the-syscall"
/// semantics and produced misleading log lines downstream.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProbeFailure {
    /// Child exited with a non-zero errno encoded in its exit code.
    Errno(i32),
    /// Child was terminated by a signal (SIGKILL, SIGSEGV, ...). Not
    /// expected in normal operation; surface so the caller can choose
    /// to retry or report.
    ChildKilled,
    /// `waitpid` returned a status that is neither `WIFEXITED` nor
    /// `WIFSIGNALED` (e.g. stopped/continued from a misuse of flags).
    BadStatus,
}

impl fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Errno(e) => write!(f, "errno {} ({})", e, std::io::Error::from_raw_os_error(*e)),
            Self::ChildKilled => f.write_str("probe child terminated by signal"),
            Self::BadStatus => f.write_str("unrecognized waitpid status"),
        }
    }
}

/// Port of Chrome's `CheckCloneNewUserErrno()`.
///
/// Validates that `clone(CLONE_NEWUSER)` failed with an expected errno.
///
/// Chrome's comment: "EPERM can happen if already in a chroot. EUSERS if
/// too many nested namespaces are used. EINVAL for kernels that don't
/// support the feature. ENOSPC can occur when the system has reached its
/// maximum configured number of user namespaces."
///
/// `EACCES` was added on top of Chrome's set: Linux 6.7+ ships an
/// AppArmor `userns_create` LSM hook (default-on in Ubuntu 23.10+) that
/// denies unprivileged user-namespace creation with `EACCES` rather than
/// `EPERM`. Without it, every probe on those hosts logs at `error` level
/// even though the case is well-understood.
///
/// Returns the errno for diagnosis. Logs unexpected errors.
pub(crate) fn check_clone_new_user_errno(error: i32) -> i32 {
    match error {
        libc::EPERM | libc::EUSERS | libc::EINVAL | libc::ENOSPC | libc::EACCES => {
            // Expected errors — Chrome's original set plus EACCES for the
            // AppArmor userns_create denial path.
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

/// Log a [`ProbeFailure`] at the appropriate level and return it unchanged.
///
/// Mirrors [`check_clone_new_user_errno`]'s expected/unexpected split for the
/// `Errno` variant, and routes the non-errno variants to their own log
/// messages so a future reader of the logs can tell `clone(...)` failed
/// outright from the probe child dying mid-flight.
pub(crate) fn log_probe_failure(failure: ProbeFailure) -> ProbeFailure {
    match &failure {
        ProbeFailure::Errno(error) => {
            check_clone_new_user_errno(*error);
        }
        ProbeFailure::ChildKilled => {
            tracing::warn!(
                "clone(CLONE_NEWUSER) probe child terminated by signal; \
                 treating as probe failure (no retry)"
            );
        }
        ProbeFailure::BadStatus => {
            tracing::error!(
                "clone(CLONE_NEWUSER) probe returned an unrecognized waitpid \
                 status; this should not happen with waitpid(.., .., 0)"
            );
        }
    }
    failure
}

/// Port of Chrome's `Credentials::CanCreateProcessInNewUserNS()`.
///
/// Probes whether the current process can create a child in a new user
/// namespace. Forks with `CLONE_NEWUSER | SIGCHLD`, and in the child:
/// 1. Writes uid/gid maps (Chrome's `SetGidAndUidMaps`)
/// 2. Calls `unshare(CLONE_NEWUSER)` again (tests nested userns)
///
/// Returns `Ok(())` if user namespaces work, `Err(ProbeFailure)` describing
/// the specific failure for diagnosis. The child encodes its failing
/// syscall's errno into its exit code so the parent can surface the real
/// cause (e.g., `EACCES` from AppArmor's `userns_create` denial, not just
/// a generic `EPERM`). Non-errno failure modes (child killed by signal,
/// kernel returned an unrecognized status) get their own variants so
/// they're not smuggled inside a misleading errno value.
///
/// # Safety
///
/// Uses raw `clone` syscall and `waitpid`. The child process only uses
/// async-signal-safe operations (open/write/close/unshare/_exit).
pub(crate) fn can_create_process_in_new_user_ns() -> Result<(), ProbeFailure> {
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
            return Err(log_probe_failure(ProbeFailure::Errno(errno)));
        }

        if pid == 0 {
            // Child process — Chrome's child logic:
            // 1. SetGidAndUidMaps(gid, uid)
            // 2. DropAllCapabilities() — skipped, not needed for probe
            // 3. unshare(CLONE_NEWUSER) again

            // Write /proc/self/setgroups -> "deny" (required before gid_map)
            if write_proc_file("/proc/self/setgroups\0", b"deny").is_err() {
                child_exit_with_errno();
            }

            // Write /proc/self/gid_map
            let mut gid_buf = [0u8; 32];
            let gid_len = format_id_map(&mut gid_buf, gid, gid);
            if write_proc_file("/proc/self/gid_map\0", &gid_buf[..gid_len]).is_err() {
                child_exit_with_errno();
            }

            // Write /proc/self/uid_map
            let mut uid_buf = [0u8; 32];
            let uid_len = format_id_map(&mut uid_buf, uid, uid);
            if write_proc_file("/proc/self/uid_map\0", &uid_buf[..uid_len]).is_err() {
                child_exit_with_errno();
            }

            // Chrome: sys_unshare(CLONE_NEWUSER) — test nested user namespace
            if libc::unshare(libc::CLONE_NEWUSER) != 0 {
                child_exit_with_errno();
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
                return Err(log_probe_failure(ProbeFailure::Errno(
                    *libc::__errno_location(),
                )));
            }
        }

        decode_probe_status(status).map_err(log_probe_failure)
    }
}

/// Read errno and `_exit` with it as the exit code, conveying the failing
/// syscall's cause to the parent via `WEXITSTATUS`.
///
/// Standard Linux errnos all fit in `[1, 255]`. Anything outside that range
/// (including the POSIX-violating errno == 0) is reported as 255 so the
/// parent still sees a nonzero exit code (= failure) rather than a false
/// success.
///
/// # Safety
///
/// Must be called from the child after fork. Reads thread-local errno.
/// Both `*__errno_location()` and `_exit` are async-signal-safe.
#[inline]
unsafe fn child_exit_with_errno() -> ! {
    let errno = unsafe { *libc::__errno_location() };
    let code = if (1..=255).contains(&errno) {
        errno
    } else {
        255
    };
    unsafe { libc::_exit(code) }
}

/// Decode the child's `waitpid` status into a `Result<(), ProbeFailure>`.
///
/// The child uses [`child_exit_with_errno`] to encode its failing syscall's
/// errno into the exit code. A clean exit (`_exit(0)`) means the probe
/// succeeded; a non-zero exit becomes [`ProbeFailure::Errno`]. A signal-
/// terminated child surfaces as [`ProbeFailure::ChildKilled`] (not an
/// errno), and a status `waitpid` doesn't classify becomes
/// [`ProbeFailure::BadStatus`]. Using dedicated variants here avoids
/// reusing a real errno (previously `EINTR`) as a sentinel, which
/// collides with `EINTR`'s established retry semantics.
fn decode_probe_status(status: libc::c_int) -> Result<(), ProbeFailure> {
    if libc::WIFEXITED(status) {
        let code = libc::WEXITSTATUS(status);
        if code == 0 {
            Ok(())
        } else {
            Err(ProbeFailure::Errno(code))
        }
    } else if libc::WIFSIGNALED(status) {
        Err(ProbeFailure::ChildKilled)
    } else {
        Err(ProbeFailure::BadStatus)
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
/// Returns `Err(())` without exposing the errno through the return value
/// — the caller reads it from thread-local `errno` (via
/// [`child_exit_with_errno`]). To make that path robust, we save the
/// `write` errno across the `close(fd)` cleanup and restore it before
/// returning: POSIX promises `close` leaves errno untouched on success,
/// but the "save errno across cleanup" idiom keeps this correct if a
/// future change inserts another syscall between the failing `write`
/// and the caller's errno read, or if `close` itself ever returns an
/// error on this fd.
///
/// # Safety
///
/// Only uses async-signal-safe syscalls: open, write, close, and the
/// `__errno_location` read/store. The `path` must be a null-terminated
/// string (e.g., "/proc/self/uid_map\0").
unsafe fn write_proc_file(path: &str, content: &[u8]) -> Result<(), ()> {
    // Path must be null-terminated for libc::open
    // SAFETY: path is a null-terminated string literal, content is a valid slice.
    // All four syscalls (open, write, close, __errno_location) are
    // async-signal-safe.
    unsafe {
        let fd = libc::open(
            path.as_ptr() as *const libc::c_char,
            libc::O_WRONLY | libc::O_CLOEXEC,
        );
        if fd < 0 {
            // errno already set by open(); leave it for the caller.
            return Err(());
        }
        let written = libc::write(fd, content.as_ptr() as *const libc::c_void, content.len());
        // Snapshot the write errno before close() so a future change
        // that lets close clobber it (or any inserted syscall) can't
        // hide the real failure from the caller.
        let saved_errno = if written < 0 {
            *libc::__errno_location()
        } else {
            0
        };
        libc::close(fd);
        if written < 0 {
            *libc::__errno_location() = saved_errno;
            Err(())
        } else {
            Ok(())
        }
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
        // EACCES is expected on Ubuntu 23.10+ where AppArmor's
        // userns_create hook denies unprivileged user namespaces.
        assert_eq!(check_clone_new_user_errno(libc::EACCES), libc::EACCES);
    }

    #[test]
    fn test_check_clone_new_user_errno_unexpected() {
        // Unexpected errnos should also be returned (just logged differently)
        assert_eq!(check_clone_new_user_errno(libc::EIO), libc::EIO);
    }

    #[test]
    fn test_can_create_process_in_new_user_ns() {
        // This is a real probe — result depends on the system. On failure
        // the variant must be one of the documented cases. The test acts as
        // a canary: a novel errno should panic so a maintainer reviews it
        // and adds the new case explicitly (don't broaden silently).
        //
        // EACCES was added on top of Chrome's 2014 set after AppArmor's
        // userns_create LSM hook (Linux 6.7+, Ubuntu 23.10+) became the
        // default mechanism for blocking unprivileged userns creation.
        let result = can_create_process_in_new_user_ns();
        match result {
            Ok(()) => {
                // User namespaces are available
            }
            Err(ProbeFailure::Errno(errno)) => {
                assert!(
                    errno == libc::EPERM
                        || errno == libc::EUSERS
                        || errno == libc::EINVAL
                        || errno == libc::ENOSPC
                        || errno == libc::EACCES,
                    "Unexpected errno: {} ({})",
                    errno,
                    std::io::Error::from_raw_os_error(errno)
                );
            }
            Err(other) => {
                panic!("Unexpected probe failure: {other:?}");
            }
        }
    }

    /// Construct a synthetic `wait` status that satisfies `WIFEXITED` with
    /// the given exit code. Matches the encoding `WEXITSTATUS` decodes:
    /// `((status >> 8) & 0xff)`.
    fn make_exited_status(code: libc::c_int) -> libc::c_int {
        (code & 0xff) << 8
    }

    #[test]
    fn test_decode_probe_status_success() {
        // _exit(0) → status low byte = 0, high byte = 0 → WEXITSTATUS == 0
        assert_eq!(decode_probe_status(make_exited_status(0)), Ok(()));
    }

    #[test]
    fn test_decode_probe_status_propagates_eperm() {
        // Child encoded EPERM via _exit(EPERM); parent must surface EPERM.
        assert_eq!(
            decode_probe_status(make_exited_status(libc::EPERM)),
            Err(ProbeFailure::Errno(libc::EPERM))
        );
    }

    #[test]
    fn test_decode_probe_status_propagates_eacces() {
        // Regression: before this fix, the parent threw the child's errno
        // away and always returned EPERM. On hosts with AppArmor's
        // userns_create restriction active (Ubuntu 23.10+ with kernel
        // 6.7+), the child fails with EACCES in nested userns / capability
        // checks — that EACCES must now propagate through to the caller
        // instead of being silently rewritten to EPERM.
        assert_eq!(
            decode_probe_status(make_exited_status(libc::EACCES)),
            Err(ProbeFailure::Errno(libc::EACCES))
        );
    }

    #[test]
    fn test_decode_probe_status_signaled_returns_child_killed() {
        // WIFSIGNALED: low 7 bits hold the signal, e.g., SIGKILL = 9.
        // The probe child shouldn't be signaled in normal operation; we
        // surface ChildKilled (a dedicated variant, not a borrowed errno)
        // so callers can tell "child died" apart from "syscall returned X"
        // without colliding with EINTR's retry semantics.
        let status: libc::c_int = libc::SIGKILL;
        assert!(libc::WIFSIGNALED(status));
        assert!(!libc::WIFEXITED(status));
        assert_eq!(decode_probe_status(status), Err(ProbeFailure::ChildKilled));
    }
}
