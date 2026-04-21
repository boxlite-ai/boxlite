//! Watchdog for parent death detection.
//!
//! **Unix:** Implements the "pipe trick" — the parent holds the write end of a pipe,
//! the child polls the read end. When the parent dies (or drops the keepalive),
//! the kernel closes the write end, delivering POLLHUP to the child.
//!
//! This is zero-latency, tamper-proof (kernel FDs), and works across
//! PID/mount namespaces — the gold standard used by s6, containerd-shim,
//! runc, crun, and conmon.
//!
//! **Windows:** Uses a named Event object (CreateEventW) + parent process handle.
//! The parent signals the event on explicit stop(); the shim also monitors
//! the parent process handle — when the parent dies, the handle becomes signaled.
//! `WaitForMultipleObjects` watches both simultaneously.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

#[cfg(unix)]
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

/// Well-known FD for the watchdog pipe in the shim process.
/// Pre-exec dup2s the inherited pipe read end to this position.
#[cfg(unix)]
pub const PIPE_FD: i32 = 3;

#[cfg(unix)]
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

#[cfg(unix)]
/// Child-side setup data, consumed during subprocess spawn.
///
/// Carries the raw FD that must be preserved through pre_exec.
/// Dropped in the parent after spawn to close the read end
/// (child already inherited it via fork).
pub struct ChildSetup {
    pipe_read: RawFd,
}

#[cfg(unix)]
impl ChildSetup {
    /// Raw FD to preserve through pre_exec FD cleanup.
    /// Will be dup2'd to [`PIPE_FD`] by the pre_exec hook.
    pub fn raw_fd(&self) -> RawFd {
        self.pipe_read
    }
}

#[cfg(unix)]
impl Drop for ChildSetup {
    fn drop(&mut self) {
        // SAFETY: closing a valid pipe read-end FD.
        unsafe {
            libc::close(self.pipe_read);
        }
    }
}

#[cfg(unix)]
/// Create a watchdog pipe pair with `FD_CLOEXEC` set on both ends.
///
/// Returns `(keepalive, child_setup)`. The parent holds the keepalive;
/// the child setup is consumed during spawn to configure FD inheritance.
///
/// Both FDs are created with `FD_CLOEXEC` to prevent leaking to unrelated
/// child processes. The shim's pre_exec hook explicitly preserves the
/// read-end via `dup2` (which clears `CLOEXEC` on the target fd).
pub fn create() -> BoxliteResult<(Keepalive, ChildSetup)> {
    let fds = create_pipe_cloexec()?;
    Ok((
        Keepalive {
            // SAFETY: fds[1] is a valid write-end FD from pipe()/pipe2().
            _pipe_write: unsafe { OwnedFd::from_raw_fd(fds[1]) },
        },
        ChildSetup { pipe_read: fds[0] },
    ))
}

#[cfg(unix)]
/// Create a pipe with `FD_CLOEXEC` set on both ends.
///
/// Without `CLOEXEC`, the write-end can leak to unrelated child processes
/// forked between `pipe()` and the shim's `pre_exec`. Any process holding
/// the write-end prevents `POLLHUP` from firing when the parent dies,
/// orphaning the shim forever.
fn create_pipe_cloexec() -> BoxliteResult<[i32; 2]> {
    let mut fds = [0i32; 2];

    #[cfg(target_os = "linux")]
    {
        // pipe2() sets O_CLOEXEC atomically — no race window.
        // SAFETY: pipe2() writes two valid FDs into the array.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(BoxliteError::Engine(format!(
                "Failed to create watchdog pipe: {}",
                std::io::Error::last_os_error()
            )));
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        // SAFETY: pipe() writes two valid FDs into the array.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(BoxliteError::Engine(format!(
                "Failed to create watchdog pipe: {}",
                std::io::Error::last_os_error()
            )));
        }
        // macOS lacks pipe2(); set CLOEXEC via fcntl on both ends.
        for &fd in &fds {
            // SAFETY: fd is a valid FD from pipe().
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                let err = std::io::Error::last_os_error();
                // SAFETY: closing valid pipe FDs on error path.
                unsafe {
                    libc::close(fds[0]);
                    libc::close(fds[1]);
                }
                return Err(BoxliteError::Engine(format!(
                    "Failed to set CLOEXEC on watchdog pipe: {err}"
                )));
            }
        }
    }

    Ok(fds)
}

// ============================================================================
// Windows: Event-based watchdog
// ============================================================================

/// Environment variable name for the shutdown event handle value.
#[cfg(windows)]
pub const ENV_SHUTDOWN_EVENT: &str = "BOXLITE_SHUTDOWN_EVENT";

/// Environment variable name for the parent process ID.
#[cfg(windows)]
pub const ENV_PARENT_PID: &str = "BOXLITE_PARENT_PID";

#[cfg(windows)]
/// Parent-side keepalive handle (Windows).
///
/// Holds a Win32 Event handle. While this exists, the shim's watchdog thread
/// blocks on `WaitForMultipleObjects`. Calling `signal()` or dropping this
/// sets the event, which the shim detects and initiates graceful shutdown.
///
/// Defense-in-depth: even if `stop()` is never called, dropping the
/// `ShimHandler` closes this, and the shim's parent process handle
/// monitoring will detect the parent death.
pub struct Keepalive {
    event: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Keepalive {
    /// Signal the shutdown event, triggering shim graceful shutdown.
    pub fn signal(&self) {
        use windows_sys::Win32::System::Threading::SetEvent;
        unsafe {
            SetEvent(self.event);
        }
    }
}

#[cfg(windows)]
impl Drop for Keepalive {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::SetEvent;
        unsafe {
            // Signal first (in case stop() was never called), then close.
            SetEvent(self.event);
            CloseHandle(self.event);
        }
    }
}

// SAFETY: HANDLE is a raw kernel handle — safe to send between threads.
#[cfg(windows)]
unsafe impl Send for Keepalive {}
#[cfg(windows)]
unsafe impl Sync for Keepalive {}

#[cfg(windows)]
/// Child-side setup data (Windows).
///
/// Carries the numeric handle value to pass via environment variable.
/// The handle is inheritable so the child process can use it directly.
pub struct ChildSetup {
    /// Numeric handle value to pass via `BOXLITE_SHUTDOWN_EVENT` env var.
    event_handle_value: usize,
}

#[cfg(windows)]
impl ChildSetup {
    /// Get the event handle value as a string for env var passing.
    pub fn event_handle_str(&self) -> String {
        self.event_handle_value.to_string()
    }
}

#[cfg(windows)]
/// Create a Windows Event-based watchdog pair.
///
/// Creates an inheritable, manual-reset, initially non-signaled Event.
/// Returns `(keepalive, child_setup)`. The parent holds the keepalive;
/// the child setup provides the handle value to pass via environment variable.
pub fn create() -> BoxliteResult<(Keepalive, ChildSetup)> {
    use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
    use windows_sys::Win32::System::Threading::CreateEventW;

    unsafe {
        // Create manual-reset, initially non-signaled event
        // manual_reset=TRUE: once signaled, stays signaled (all waiters wake)
        // initial_state=FALSE: not signaled until SetEvent()
        let event = CreateEventW(std::ptr::null(), 1, 0, std::ptr::null());
        if event.is_null() {
            return Err(BoxliteError::Engine(format!(
                "Failed to create watchdog event: {}",
                std::io::Error::last_os_error()
            )));
        }

        // Make the handle inheritable so child process can use it
        if SetHandleInformation(event, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
            use windows_sys::Win32::Foundation::CloseHandle;
            let err = std::io::Error::last_os_error();
            CloseHandle(event);
            return Err(BoxliteError::Engine(format!(
                "Failed to set event handle as inheritable: {err}"
            )));
        }

        Ok((
            Keepalive { event },
            ChildSetup {
                event_handle_value: event as usize,
            },
        ))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn test_pipe_has_cloexec_set() {
        let fds = create_pipe_cloexec().expect("pipe creation should succeed");

        for &fd in &fds {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert!(flags >= 0, "fcntl F_GETFD should succeed");
            assert_ne!(
                flags & libc::FD_CLOEXEC,
                0,
                "fd {fd} must have FD_CLOEXEC set"
            );
        }

        // Cleanup
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }

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

    /// Regression test for orphan shim bug: without FD_CLOEXEC, a child
    /// spawned via fork+exec inherits the pipe write-end, preventing
    /// POLLHUP when the parent drops its Keepalive.
    ///
    /// This test spawns a subprocess (fork+exec), drops the Keepalive,
    /// and asserts POLLHUP fires within 100ms. With FD_CLOEXEC, the
    /// write-end is closed by the kernel during exec(). Without it,
    /// the child holds the write-end open and poll() times out.
    #[test]
    fn test_spawned_child_does_not_block_pollhup() {
        let (keepalive, child_setup) = create().expect("pipe creation should succeed");
        let read_fd = child_setup.raw_fd();

        // Spawn a child via Command (fork+exec) — simulates an unrelated
        // process inheriting FDs (like Electron/VS Code in the real bug).
        // FD_CLOEXEC closes the write-end during exec(); without it,
        // the child keeps the write-end open.
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("10")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("failed to spawn sleep");

        // Drop keepalive (closes our write-end).
        // If child also holds write-end (no CLOEXEC), POLLHUP won't fire.
        drop(keepalive);

        // Poll the read-end — should get POLLHUP within 100ms if
        // the child did NOT inherit the write-end (CLOEXEC worked).
        let mut pollfd = libc::pollfd {
            fd: read_fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ret = unsafe { libc::poll(&mut pollfd, 1, 100) };

        // Cleanup
        let _ = child.kill();
        let _ = child.wait();
        drop(child_setup);

        // Assert POLLHUP was received (not a timeout)
        assert_eq!(
            ret, 1,
            "poll should return 1 (POLLHUP), not 0 (timeout). \
            The spawned child inherited the pipe write-end because FD_CLOEXEC \
            is missing — this is the orphan shim bug."
        );
        assert_ne!(
            pollfd.revents & libc::POLLHUP,
            0,
            "should get POLLHUP — child must not hold the write-end"
        );
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn test_create_returns_valid_event() {
        let (keepalive, child_setup) = create().expect("event creation should succeed");

        // Handle value should be non-null
        assert!(!keepalive.event.is_null(), "event handle should be valid");

        // ChildSetup should have the same handle value
        let handle_str = child_setup.event_handle_str();
        let handle_val: usize = handle_str.parse().unwrap();
        assert_eq!(handle_val, keepalive.event as usize);

        drop(child_setup);
        drop(keepalive);
    }

    #[test]
    fn test_keepalive_signal_sets_event() {
        use windows_sys::Win32::System::Threading::WaitForSingleObject;

        let (keepalive, _child_setup) = create().expect("event creation should succeed");
        let event = keepalive.event;

        // Signal the event
        keepalive.signal();

        // WaitForSingleObject should return immediately (WAIT_OBJECT_0 = 0)
        let result = unsafe { WaitForSingleObject(event, 0) };
        assert_eq!(result, 0, "event should be signaled after signal()");
    }

    #[test]
    fn test_keepalive_drop_signals_event() {
        use windows_sys::Win32::Foundation::{CloseHandle, DUPLICATE_SAME_ACCESS, HANDLE};
        use windows_sys::Win32::System::Threading::{
            DuplicateHandle, GetCurrentProcess, WaitForSingleObject,
        };

        // Create a duplicate event to observe the signal after Keepalive is dropped.
        // We can't use the Keepalive's handle after drop (it's closed),
        // so we create a separate event and verify the pattern works.
        let (keepalive, _child_setup) = create().expect("event creation should succeed");
        let event_handle = keepalive.event;

        // Duplicate the handle so we can check after Keepalive drops
        let mut dup_handle: HANDLE = std::ptr::null_mut();
        unsafe {
            let ok = DuplicateHandle(
                GetCurrentProcess(),
                event_handle,
                GetCurrentProcess(),
                &mut dup_handle,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            );
            assert_ne!(ok, 0, "DuplicateHandle should succeed");
        }

        // Drop Keepalive — should signal the event before closing
        drop(keepalive);

        // Check the duplicate handle — event should be signaled
        let result = unsafe { WaitForSingleObject(dup_handle, 0) };
        assert_eq!(result, 0, "event should be signaled after Keepalive drop");

        unsafe { CloseHandle(dup_handle) };
    }

    #[test]
    fn test_event_is_inheritable() {
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};

        let (keepalive, _child_setup) = create().expect("event creation should succeed");

        let mut flags: u32 = 0;
        let ok = unsafe { GetHandleInformation(keepalive.event, &mut flags) };
        assert_ne!(ok, 0, "GetHandleInformation should succeed");
        assert_ne!(
            flags & HANDLE_FLAG_INHERIT,
            0,
            "event handle must be inheritable"
        );
    }
}
