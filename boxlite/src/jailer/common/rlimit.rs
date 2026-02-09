//! Resource limit handling for jailer isolation.
//!
//! Applies rlimits to restrict resource usage of the jailed process.
//! Works on both Linux and macOS.
//!
//! Only the async-signal-safe `apply_limits_raw()` is used,
//! called from the `pre_exec` hook before exec().

use crate::runtime::advanced_options::ResourceLimits;
use std::io;

/// Resource type alias for cross-platform compatibility.
/// On Linux glibc, RLIMIT_* are u32; on macOS they're i32.
#[cfg(target_os = "linux")]
type RlimitResource = libc::__rlimit_resource_t;
#[cfg(not(target_os = "linux"))]
type RlimitResource = libc::c_int;

/// Get current value of a resource limit.
#[allow(dead_code, clippy::unnecessary_cast)]
pub fn get_rlimit(resource: RlimitResource) -> Result<(u64, u64), io::Error> {
    let mut rlim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };

    let result = unsafe { libc::getrlimit(resource, &mut rlim) };

    if result != 0 {
        return Err(io::Error::last_os_error());
    }

    Ok((rlim.rlim_cur as u64, rlim.rlim_max as u64))
}

/// Apply resource limits - async-signal-safe version for pre_exec.
///
/// This function is designed to be called from a `pre_exec` hook, which runs
/// after `fork()` but before `exec()`. Only async-signal-safe operations are
/// allowed in this context.
///
/// # Safety
///
/// This function only uses async-signal-safe syscalls (setrlimit).
/// Do NOT add:
/// - Logging (tracing, println)
/// - Memory allocation (Box, Vec, String)
/// - Mutex operations
///
/// # Arguments
/// * `limits` - Resource limits to apply (passed by value to avoid allocation)
///
/// # Returns
/// * `Ok(())` - Limits applied successfully
/// * `Err(errno)` - Failed to set a limit (returns raw errno)
pub fn apply_limits_raw(limits: &ResourceLimits) -> Result<(), i32> {
    if let Some(max_files) = limits.max_open_files {
        set_rlimit_raw(libc::RLIMIT_NOFILE, max_files)?;
    }

    if let Some(max_fsize) = limits.max_file_size {
        set_rlimit_raw(libc::RLIMIT_FSIZE, max_fsize)?;
    }

    if let Some(max_procs) = limits.max_processes {
        // Note: Ignore errors for NPROC on macOS (works differently)
        let _ = set_rlimit_raw(libc::RLIMIT_NPROC, max_procs);
    }

    if let Some(max_mem) = limits.max_memory {
        set_rlimit_raw(libc::RLIMIT_AS, max_mem)?;
    }

    if let Some(max_cpu) = limits.max_cpu_time {
        set_rlimit_raw(libc::RLIMIT_CPU, max_cpu)?;
    }

    Ok(())
}

/// Set a specific resource limit - async-signal-safe version.
#[inline]
fn set_rlimit_raw(resource: RlimitResource, limit: u64) -> Result<(), i32> {
    let rlim = libc::rlimit {
        rlim_cur: limit as libc::rlim_t,
        rlim_max: limit as libc::rlim_t,
    };

    let result = unsafe { libc::setrlimit(resource, &rlim) };

    if result != 0 {
        return Err(super::get_errno());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_empty_limits_raw() {
        let limits = ResourceLimits::default();
        apply_limits_raw(&limits).expect("Empty limits should succeed");
    }

    #[test]
    fn test_set_file_limit_raw() {
        // Get current limit
        let (current, _) = get_rlimit(libc::RLIMIT_NOFILE).expect("Should get limit");

        // Try to set a lower limit
        let new_limit = std::cmp::min(current, 1024);
        let limits = ResourceLimits {
            max_open_files: Some(new_limit),
            ..Default::default()
        };

        apply_limits_raw(&limits).expect("Should set file limit");

        // Verify it was set
        let (after, _) = get_rlimit(libc::RLIMIT_NOFILE).expect("Should get limit");
        assert_eq!(after, new_limit);
    }

    #[test]
    fn test_get_rlimit() {
        let (soft, hard) = get_rlimit(libc::RLIMIT_NOFILE).expect("Should get limit");
        assert!(soft <= hard, "Soft limit should be <= hard limit");
        assert!(soft > 0, "Should have some file descriptors available");
    }
}
