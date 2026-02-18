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
use crate::runtime::advanced_options::ResourceLimits;
use std::os::fd::RawFd;
use std::process::Command;

/// Add pre-execution hook for process isolation (async-signal-safe).
///
/// Runs after fork() but before the new program starts in the child process.
/// Applies: FD preservation (dup2), FD cleanup, rlimits, cgroup membership (Linux),
/// PID file writing.
///
/// # Arguments
///
/// * `cmd` - The Command to add the hook to
/// * `resource_limits` - Resource limits to apply
/// * `cgroup_procs_path` - Path to cgroup.procs file (Linux only, pre-computed)
/// * `pid_file_path` - Path to PID file (pre-computed CString for async-signal-safety)
/// * `preserved_fds` - FDs to preserve: each `(source, target)` is dup2'd before cleanup.
///   After dup2, all FDs above the highest target are closed.
///   Pass empty vec for default behavior (close all FDs >= 3).
///
/// # Safety
///
/// This function uses `unsafe` to set the hook. The hook itself
/// only uses async-signal-safe operations:
/// - `dup2()` / `close()` / `close_range()` syscalls
/// - `setrlimit()` syscall
/// - `open()` / `write()` / `close()` syscalls (for cgroup and PID file)
/// - `getpid()` syscall
///
/// **Do NOT add any of the following to the hook:**
/// - Logging (tracing, println, eprintln)
/// - Memory allocation (Box, Vec, String creation)
/// - Mutex operations
/// - Most Rust standard library functions
pub fn add_pre_exec_hook(
    cmd: &mut Command,
    resource_limits: ResourceLimits,
    #[allow(unused_variables)] cgroup_procs_path: Option<std::ffi::CString>,
    pid_file_path: Option<std::ffi::CString>,
    preserved_fds: Vec<(RawFd, i32)>,
) {
    use std::os::unix::process::CommandExt;

    // SAFETY: The hook only uses async-signal-safe syscalls.
    // See module documentation for details.
    unsafe {
        cmd.pre_exec(move || {
            // 1. FD preservation + cleanup
            // If preserved_fds is non-empty, dup2 each (source -> target),
            // then close everything above the highest target.
            // Otherwise, close all FDs >= 3 (default behavior).
            if !preserved_fds.is_empty() {
                for &(source, target) in &preserved_fds {
                    if source != target {
                        libc::dup2(source, target);
                    }
                }
                let first_close = preserved_fds.iter().map(|(_, t)| *t).max().unwrap() + 1;
                common::fd::close_fds_from(first_close)
                    .map_err(std::io::Error::from_raw_os_error)?;
            } else {
                common::fd::close_inherited_fds_raw().map_err(std::io::Error::from_raw_os_error)?;
            }

            // 2. Apply resource limits (rlimits)
            common::rlimit::apply_limits_raw(&resource_limits)
                .map_err(std::io::Error::from_raw_os_error)?;

            // 3. Add self to cgroup (Linux only)
            #[cfg(target_os = "linux")]
            if let Some(ref path) = cgroup_procs_path {
                let _ = crate::jailer::cgroup::add_self_to_cgroup_raw(path);
            }

            // 4. Write PID file
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
        let mut cmd = Command::new("/bin/echo");
        let limits = ResourceLimits::default();

        add_pre_exec_hook(&mut cmd, limits, None, None, vec![]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_add_hook_with_cgroup_path() {
        use std::ffi::CString;

        let mut cmd = Command::new("/bin/echo");
        let limits = ResourceLimits::default();
        let cgroup_path = CString::new("/sys/fs/cgroup/boxlite/test/cgroup.procs").ok();

        add_pre_exec_hook(&mut cmd, limits, cgroup_path, None, vec![]);
    }

    #[test]
    fn test_add_hook_with_pid_file() {
        use std::ffi::CString;

        let mut cmd = Command::new("/bin/echo");
        let limits = ResourceLimits::default();
        let pid_file = CString::new("/tmp/test.pid").ok();

        add_pre_exec_hook(&mut cmd, limits, None, pid_file, vec![]);
    }

    #[test]
    fn test_add_hook_with_preserved_fds() {
        let mut cmd = Command::new("/bin/echo");
        let limits = ResourceLimits::default();

        // Simulate preserving fd 5 → target fd 3
        add_pre_exec_hook(&mut cmd, limits, None, None, vec![(5, 3)]);
    }
}
