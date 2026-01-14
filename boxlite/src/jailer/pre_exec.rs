//! Pre-execution hook for process isolation.
//!
//! This module provides the pre-execution hook that runs after `fork()` but
//! before the new program starts in the child process.
//!
//! # What it does
//!
//! 1. **Close inherited FDs** - Prevents information leakage
//! 2. **Apply rlimits** - Resource limits (max files, memory, CPU time, etc.)
//! 3. **Add to cgroup** - Linux only, for cgroup resource limits
//! 4. **Write PID file** - Single source of truth for process tracking
//!
//! # Safety
//!
//! The hook runs in a very restricted context:
//! - Only async-signal-safe syscalls are allowed
//! - No memory allocation (no Box, Vec, String)
//! - No mutex operations
//! - No logging (tracing, println)
//!
//! See the [`common`](crate::jailer::common) module for async-signal-safe utilities.

use crate::jailer::common;
use crate::jailer::config::ResourceLimits;
use std::process::Command;

/// Add pre-execution hook for process isolation (async-signal-safe).
///
/// Runs after fork() but before the new program starts in the child process.
/// Applies: FD cleanup, rlimits, cgroup membership (Linux), PID file writing.
///
/// # Arguments
///
/// * `cmd` - The Command to add the hook to
/// * `resource_limits` - Resource limits to apply
/// * `cgroup_procs_path` - Path to cgroup.procs file (Linux only, pre-computed)
/// * `pid_file_path` - Path to PID file (pre-computed CString for async-signal-safety)
///
/// # Safety
///
/// This function uses `unsafe` to set the hook. The hook itself
/// only uses async-signal-safe operations:
/// - `close()` / `close_range()` syscalls
/// - `setrlimit()` syscall
/// - `open()` / `write()` / `close()` syscalls (for cgroup and PID file)
/// - `getpid()` syscall
///
/// **Do NOT add any of the following to the hook:**
/// - Logging (tracing, println, eprintln)
/// - Memory allocation (Box, Vec, String creation)
/// - Mutex operations
/// - Most Rust standard library functions
///
/// # Example
///
/// ```ignore
/// use std::process::Command;
/// use boxlite::jailer::pre_execution::add_hook;
///
/// let mut cmd = Command::new("/path/to/binary");
/// let limits = ResourceLimits::default();
///
/// add_hook(&mut cmd, limits, None, None);
///
/// cmd.spawn()?;
/// ```
pub fn add_pre_exec_hook(
    cmd: &mut Command,
    resource_limits: ResourceLimits,
    #[allow(unused_variables)] cgroup_procs_path: Option<std::ffi::CString>,
    pid_file_path: Option<std::ffi::CString>,
) {
    use std::os::unix::process::CommandExt;

    // SAFETY: The hook only uses async-signal-safe syscalls.
    // See module documentation for details.
    unsafe {
        cmd.pre_exec(move || {
            // 1. Close inherited file descriptors
            // This prevents information leakage through inherited FDs
            common::fd::close_inherited_fds_raw().map_err(std::io::Error::from_raw_os_error)?;

            // 2. Apply resource limits (rlimits)
            // This is enforced by the kernel
            common::rlimit::apply_limits_raw(&resource_limits)
                .map_err(std::io::Error::from_raw_os_error)?;

            // 3. Add self to cgroup (Linux only)
            // This ensures the process is subject to cgroup resource limits
            #[cfg(target_os = "linux")]
            if let Some(ref path) = cgroup_procs_path {
                // Ignore cgroup errors - the box can still run without cgroup limits
                let _ = crate::jailer::cgroup::add_self_to_cgroup_raw(path);
            }

            // 4. Write PID file (single source of truth for process tracking)
            // This must happen after fork() - child has its own PID now
            if let Some(ref path) = pid_file_path {
                common::pid::write_pid_file_raw(path).map_err(std::io::Error::from_raw_os_error)?;
            }

            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_hook_compiles() {
        // Just verify the function compiles with various argument types
        let mut cmd = Command::new("/bin/echo");
        let limits = ResourceLimits::default();

        add_pre_exec_hook(&mut cmd, limits, None, None);

        // We can't actually test the hook without forking
        // Integration tests should verify the actual behavior
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_add_hook_with_cgroup_path() {
        use std::ffi::CString;

        let mut cmd = Command::new("/bin/echo");
        let limits = ResourceLimits::default();
        let cgroup_path = CString::new("/sys/fs/cgroup/boxlite/test/cgroup.procs").ok();

        add_pre_exec_hook(&mut cmd, limits, cgroup_path, None);
    }

    #[test]
    fn test_add_hook_with_pid_file() {
        use std::ffi::CString;

        let mut cmd = Command::new("/bin/echo");
        let limits = ResourceLimits::default();
        let pid_file = CString::new("/tmp/test.pid").ok();

        add_pre_exec_hook(&mut cmd, limits, None, pid_file);
    }
}
