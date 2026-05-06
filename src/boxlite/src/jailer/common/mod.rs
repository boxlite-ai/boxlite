//! Cross-platform jailer utilities.
//!
//! These modules provide:
//! - [`fd`]: File descriptor cleanup (async-signal-safe for pre_exec) [Unix]
//! - [`rlimit`]: Resource limit management (async-signal-safe for pre_exec) [Unix]
//! - [`pid`]: PID file writing (async-signal-safe for pre_exec) [Unix]
//! - [`fs`]: Filesystem utilities (copy-if-newer, etc.) [cross-platform]
//!
//! Note: Environment sanitization is handled by bwrap/sandbox-exec at spawn time.

#[cfg(unix)]
pub mod fd;
pub mod fs;
#[cfg(unix)]
pub mod pid;
#[cfg(unix)]
pub mod rlimit;

/// Get errno in an async-signal-safe way.
///
/// Shared across modules that need errno access in pre_exec context.
#[cfg(unix)]
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
}
