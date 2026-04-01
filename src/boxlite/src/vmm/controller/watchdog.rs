//! Watchdog pipe for parent death detection.
//!
//! Implements the "pipe trick" — the parent holds the write end of a pipe,
//! the child polls the read end. When the parent dies (or drops the keepalive),
//! the kernel closes the write end, delivering POLLHUP to the child.
//!
//! This is zero-latency, tamper-proof (kernel FDs), and works across
//! PID/mount namespaces — the gold standard used by s6, containerd-shim,
//! runc, crun, and conmon.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

/// Well-known FD for the watchdog pipe in the shim process.
/// Pre-exec dup2s the inherited pipe read end to this position.
pub const PIPE_FD: i32 = 3;

/// Parent-side keepalive handle.
///
/// While this exists, the shim's watchdog thread blocks on poll().
/// Dropping this closes the pipe write end, delivering POLLHUP to the shim,
/// which triggers graceful shutdown.
///
/// Defense-in-depth: even if `stop()` is never called, dropping the
/// `ShimHandler` closes this, triggering shim cleanup automatically.
pub struct Keepalive {
    _pipe_write: OwnedFd,
}

/// Child-side setup data, consumed during subprocess spawn.
///
/// Carries the raw FD that must be preserved through pre_exec.
/// Dropped in the parent after spawn to close the read end
/// (child already inherited it via fork).
pub struct ChildSetup {
    pipe_read: RawFd,
}

impl ChildSetup {
    /// Raw FD to preserve through pre_exec FD cleanup.
    /// Will be dup2'd to [`PIPE_FD`] by the pre_exec hook.
    pub fn raw_fd(&self) -> RawFd {
        self.pipe_read
    }
}

impl Drop for ChildSetup {
    fn drop(&mut self) {
        // SAFETY: closing a valid pipe read-end FD.
        unsafe {
            libc::close(self.pipe_read);
        }
    }
}

/// Create a watchdog pipe pair.
///
/// Returns `(keepalive, child_setup)`. The parent holds the keepalive;
/// the child setup is consumed during spawn to configure FD inheritance.
pub fn create() -> BoxliteResult<(Keepalive, ChildSetup)> {
    let mut fds = [0i32; 2];
    // SAFETY: pipe() writes two valid FDs into the array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(BoxliteError::Engine(format!(
            "Failed to create watchdog pipe: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok((
        Keepalive {
            // SAFETY: fds[1] is a valid write-end FD from pipe().
            _pipe_write: unsafe { OwnedFd::from_raw_fd(fds[1]) },
        },
        ChildSetup { pipe_read: fds[0] },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_returns_valid_fds() {
        let (keepalive, child_setup) = create().expect("pipe creation should succeed");
        let read_fd = child_setup.raw_fd();

        // Both FDs should be valid (>= 0)
        assert!(read_fd >= 0, "read fd should be valid");

        // Verify read_fd is open via fcntl
        let result = unsafe { libc::fcntl(read_fd, libc::F_GETFD) };
        assert!(result >= 0, "read fd should be open");

        drop(child_setup);
        drop(keepalive);
    }

    #[test]
    fn test_child_setup_raw_fd() {
        let (_keepalive, child_setup) = create().expect("pipe creation should succeed");
        let fd = child_setup.raw_fd();
        assert!(fd >= 3, "pipe fd should be >= 3 (not stdin/stdout/stderr)");
        drop(child_setup);
    }

    #[test]
    fn test_child_setup_drop_closes_read_end() {
        let (_keepalive, child_setup) = create().expect("pipe creation should succeed");
        let read_fd = child_setup.raw_fd();

        // FD should be open
        assert!(unsafe { libc::fcntl(read_fd, libc::F_GETFD) } >= 0);

        // Drop closes the read end
        drop(child_setup);

        // FD should be closed (fcntl returns -1 with EBADF)
        assert_eq!(unsafe { libc::fcntl(read_fd, libc::F_GETFD) }, -1);
    }

    #[test]
    fn test_keepalive_drop_closes_write_end_triggers_pollhup() {
        let (keepalive, child_setup) = create().expect("pipe creation should succeed");
        let read_fd = child_setup.raw_fd();

        // Drop keepalive — closes write end
        drop(keepalive);

        // Poll read_fd — should get POLLHUP immediately.
        // Use POLLIN in events for macOS compatibility (macOS poll() may not
        // wake on POLLHUP alone when events mask is empty).
        let mut pollfd = libc::pollfd {
            fd: read_fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ret = unsafe { libc::poll(&mut pollfd, 1, 100) }; // 100ms timeout
        assert_eq!(ret, 1, "poll should return 1 (one fd ready)");
        assert_ne!(
            pollfd.revents & libc::POLLHUP,
            0,
            "should get POLLHUP when write end is closed"
        );

        drop(child_setup);
    }
}
