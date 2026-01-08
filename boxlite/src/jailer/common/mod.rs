//! Cross-platform jailer utilities.
//!
//! These modules provide async-signal-safe operations for the `pre_exec` hook:
//! - [`fd`]: File descriptor cleanup
//! - [`rlimit`]: Resource limit management
//!
//! Note: Environment sanitization is handled by bwrap/sandbox-exec at spawn time.

pub mod fd;
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
