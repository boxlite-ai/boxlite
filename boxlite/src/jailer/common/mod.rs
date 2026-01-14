//! Cross-platform jailer utilities.
//!
//! These modules provide:
//! - [`fd`]: File descriptor cleanup (async-signal-safe for pre_exec)
//! - [`rlimit`]: Resource limit management (async-signal-safe for pre_exec)
//! - [`pid`]: PID file writing (async-signal-safe for pre_exec)
//! - [`fs`]: Filesystem utilities (copy-if-newer, etc.)
//!
//! Note: Environment sanitization is handled by bwrap/sandbox-exec at spawn time.

pub mod fd;
pub mod fs;
pub mod pid;
pub mod rlimit;

/// Get errno in an async-signal-safe way.
///
/// Shared across modules that need errno access in pre_exec context.
#[inline]
pub(crate) fn get_errno() -> i32 {
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error()
    }

    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location()
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        libc::ENOSYS
    }
}
