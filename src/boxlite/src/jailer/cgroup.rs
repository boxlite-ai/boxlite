//! Cgroup v2 setup for resource limiting.
//!
//! This module sets up cgroup v2 limits for the boxlite-shim process.
//! Cgroups are used to limit CPU, memory, and process count.
//!
//! ## Why Cgroups?
//!
//! - Prevent DoS attacks (fork bomb, memory exhaustion)
//! - Fair resource sharing between boxes
//! - Enforced by kernel, can't be bypassed from userspace
//!
//! ## Rootless Support
//!
//! This module supports both root and rootless operation:
//! - **Root**: Creates cgroups in `/sys/fs/cgroup/boxlite/`
//! - **Rootless**: Creates cgroups in the user's systemd service scope:
//!   `/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/boxlite/`
//!
//! ## Cgroup v2 Structure
//!
//! ```text
//! {cgroup_base}/              # /sys/fs/cgroup (root) or user service path (rootless)
//! └── boxlite/
//!     └── {box_id}/
//!         ├── cpu.max           # CPU limit
//!         ├── cpu.weight        # CPU shares
//!         ├── memory.max        # Memory limit
//!         ├── memory.high       # Memory throttle threshold
//!         ├── pids.max          # Max processes
//!         └── cgroup.procs      # Add process here
//! ```

use super::common;
use super::error::JailerError;
use crate::runtime::advanced_options::ResourceLimits;
use std::fs;
use std::path::{Path, PathBuf};

/// Base path for cgroup v2 filesystem.
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// BoxLite cgroup name.
const BOXLITE_CGROUP: &str = "boxlite";

// ============================================================================
// Rootless Cgroup Support
// ============================================================================

/// Check if the current process is running as root.
#[cfg(target_os = "linux")]
fn is_root() -> bool {
    unsafe { libc::getuid() == 0 }
}

#[cfg(not(target_os = "linux"))]
fn is_root() -> bool {
    false
}

/// Get the user's systemd cgroup base path for rootless operation.
///
/// On systemd systems, users can create cgroups under their user service:
/// `/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/`
#[cfg(target_os = "linux")]
fn get_user_cgroup_base() -> Option<PathBuf> {
    let uid = unsafe { libc::getuid() };
    let path = PathBuf::from(format!(
        "/sys/fs/cgroup/user.slice/user-{}.slice/user@{}.service",
        uid, uid
    ));
    if path.exists() {
        Some(path)
    } else {
        // Fallback: try to find any writable cgroup path from /proc/self/cgroup
        None
    }
}

#[cfg(not(target_os = "linux"))]
fn get_user_cgroup_base() -> Option<PathBuf> {
    None
}

/// Get the cgroup base path for the current user.
///
/// - Root: returns `/sys/fs/cgroup`
/// - Non-root (systemd): returns `/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service`
/// - Non-root (no systemd): falls back to `/sys/fs/cgroup` (will likely fail)
fn get_cgroup_base() -> PathBuf {
    if is_root() {
        PathBuf::from(CGROUP_ROOT)
    } else {
        get_user_cgroup_base().unwrap_or_else(|| PathBuf::from(CGROUP_ROOT))
    }
}

/// Configuration for cgroup resource limits.
#[derive(Debug, Clone, Default)]
pub struct CgroupConfig {
    /// Memory limit in bytes (memory.max).
    pub memory_max: Option<u64>,

    /// Memory high threshold in bytes (memory.high).
    /// Processes exceeding this are throttled.
    pub memory_high: Option<u64>,

    /// CPU weight (1-10000, default 100).
    /// Higher = more CPU time relative to other cgroups.
    pub cpu_weight: Option<u32>,

    /// CPU max in format "quota period" (e.g., "100000 100000" = 100%).
    /// First number is max microseconds per period.
    pub cpu_max: Option<(u64, u64)>,

    /// Maximum number of processes (pids.max).
    pub pids_max: Option<u64>,
}

/// Check if cgroup v2 is available and unified hierarchy is used.
pub fn is_cgroup_v2_available() -> bool {
    // Check if cgroup2 is mounted
    let cgroup_root = Path::new(CGROUP_ROOT);
    if !cgroup_root.exists() {
        return false;
    }

    // Check for cgroup.controllers (cgroup v2 indicator)
    let controllers = cgroup_root.join("cgroup.controllers");
    controllers.exists()
}

/// Get the path to a box's cgroup directory.
///
/// The base path depends on whether running as root or regular user:
/// - Root: `/sys/fs/cgroup/boxlite/{box_id}`
/// - User: `/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/boxlite/{box_id}`
pub fn cgroup_path(box_id: &str) -> PathBuf {
    get_cgroup_base().join(BOXLITE_CGROUP).join(box_id)
}

/// Setup cgroup for a box.
///
/// Creates the cgroup directory and configures resource limits.
/// Must be called BEFORE spawning the process.
///
/// # Errors
///
/// Returns [`JailerError::Cgroup`] if:
/// - Cgroup v2 is not available on the system
/// - Failed to create the boxlite parent cgroup directory
/// - Failed to create the box-specific cgroup directory
/// - Failed to write resource limit configuration files
pub fn setup_cgroup(box_id: &str, config: &CgroupConfig) -> Result<PathBuf, JailerError> {
    if !is_cgroup_v2_available() {
        tracing::warn!("Cgroup v2 not available, skipping cgroup setup");
        return Err(JailerError::Cgroup("Cgroup v2 not available".to_string()));
    }

    let cgroup_base = get_cgroup_base();
    let boxlite_cgroup = cgroup_base.join(BOXLITE_CGROUP);
    let box_cgroup = boxlite_cgroup.join(box_id);

    tracing::debug!(
        cgroup_base = %cgroup_base.display(),
        is_root = is_root(),
        "Using cgroup base path"
    );

    // Create boxlite parent cgroup if needed
    if !boxlite_cgroup.exists() {
        fs::create_dir(&boxlite_cgroup).map_err(|e| {
            JailerError::Cgroup(format!(
                "Failed to create boxlite cgroup at {}: {}",
                boxlite_cgroup.display(),
                e
            ))
        })?;

        // Enable controllers in parent
        enable_controllers(&boxlite_cgroup)?;
    }

    // Create box cgroup
    if !box_cgroup.exists() {
        fs::create_dir(&box_cgroup).map_err(|e| {
            JailerError::Cgroup(format!(
                "Failed to create box cgroup at {}: {}",
                box_cgroup.display(),
                e
            ))
        })?;
    }

    // Apply limits
    apply_limits(&box_cgroup, config)?;

    tracing::debug!(
        box_id = %box_id,
        path = %box_cgroup.display(),
        "Cgroup created"
    );

    Ok(box_cgroup)
}

/// Enable controllers for child cgroups.
fn enable_controllers(cgroup_path: &Path) -> Result<(), JailerError> {
    let subtree_control = cgroup_path.join("cgroup.subtree_control");

    // Enable cpu, memory, and pids controllers
    write_file(&subtree_control, "+cpu +memory +pids")?;

    Ok(())
}

/// Apply resource limits to a cgroup.
fn apply_limits(cgroup_path: &Path, config: &CgroupConfig) -> Result<(), JailerError> {
    // Memory limit
    if let Some(memory_max) = config.memory_max {
        write_file(&cgroup_path.join("memory.max"), &memory_max.to_string())?;
    }

    // Memory high (throttle threshold)
    if let Some(memory_high) = config.memory_high {
        write_file(&cgroup_path.join("memory.high"), &memory_high.to_string())?;
    }

    // CPU weight
    if let Some(cpu_weight) = config.cpu_weight {
        write_file(&cgroup_path.join("cpu.weight"), &cpu_weight.to_string())?;
    }

    // CPU max (quota period)
    if let Some((quota, period)) = config.cpu_max {
        write_file(
            &cgroup_path.join("cpu.max"),
            &format!("{} {}", quota, period),
        )?;
    }

    // Pids max
    if let Some(pids_max) = config.pids_max {
        write_file(&cgroup_path.join("pids.max"), &pids_max.to_string())?;
    }

    Ok(())
}

/// Add a process to a cgroup.
///
/// Call this after spawning the process.
#[allow(dead_code)]
pub fn add_process(box_id: &str, pid: u32) -> Result<(), JailerError> {
    let cgroup_path = cgroup_path(box_id);
    let procs_file = cgroup_path.join("cgroup.procs");

    write_file(&procs_file, &pid.to_string())?;

    tracing::debug!(
        box_id = %box_id,
        pid = pid,
        "Process added to cgroup"
    );

    Ok(())
}

/// Remove a cgroup.
///
/// The cgroup must be empty (no processes) before removal.
#[allow(dead_code)]
pub fn remove_cgroup(box_id: &str) -> Result<(), JailerError> {
    let cgroup_path = cgroup_path(box_id);

    if cgroup_path.exists() {
        fs::remove_dir(&cgroup_path).map_err(|e| {
            JailerError::Cgroup(format!(
                "Failed to remove cgroup at {}: {}",
                cgroup_path.display(),
                e
            ))
        })?;

        tracing::debug!(
            box_id = %box_id,
            "Cgroup removed"
        );
    }

    Ok(())
}

/// Helper to write to a cgroup file.
fn write_file(path: &Path, content: &str) -> Result<(), JailerError> {
    fs::write(path, content)
        .map_err(|e| JailerError::Cgroup(format!("Failed to write to {}: {}", path.display(), e)))
}

/// Convert ResourceLimits to CgroupConfig.
impl From<&ResourceLimits> for CgroupConfig {
    fn from(limits: &ResourceLimits) -> Self {
        Self {
            memory_max: limits.max_memory,
            memory_high: limits.max_memory.map(|m| m * 9 / 10), // 90% of max
            cpu_weight: None,                                   // Could add to ResourceLimits
            cpu_max: limits.max_cpu_time.map(|t| {
                // Convert seconds to quota/period
                // 1 CPU = 100000/100000
                (t * 1_000_000, 1_000_000)
            }),
            pids_max: limits.max_processes,
        }
    }
}

// ============================================================================
// Async-Signal-Safe Cgroup (for pre_exec)
// ============================================================================

/// Add current process to cgroup - async-signal-safe version for pre_exec.
///
/// This function is designed to be called from a `pre_exec` hook, which runs
/// after `fork()` but before `exec()`. Only async-signal-safe operations are
/// allowed in this context.
///
/// # Safety
///
/// This function only uses async-signal-safe syscalls (open, write, close, getpid).
/// Do NOT add:
/// - Logging (tracing, println)
/// - Memory allocation (Box, Vec, String)
/// - Mutex operations
///
/// # Arguments
/// * `cgroup_procs_path` - Pre-computed path to cgroup.procs file (as null-terminated C string)
///
/// # Returns
/// * `Ok(())` - Process added to cgroup
/// * `Err(errno)` - Failed to add process
#[cfg(target_os = "linux")]
pub fn add_self_to_cgroup_raw(cgroup_procs_path: &std::ffi::CStr) -> Result<(), i32> {
    // Get current PID
    let pid = unsafe { libc::getpid() };

    // Format PID as string (async-signal-safe: stack buffer, no allocation)
    let mut pid_buf = [0u8; 16];
    let pid_len = {
        // Manual formatting to avoid write! which might allocate
        let mut n = pid as u32;
        let mut len = 0;
        let mut temp = [0u8; 16];

        // Convert number to string (reverse order)
        if n == 0 {
            temp[0] = b'0';
            len = 1;
        } else {
            while n > 0 {
                temp[len] = b'0' + (n % 10) as u8;
                n /= 10;
                len += 1;
            }
        }

        // Reverse into pid_buf
        for i in 0..len {
            pid_buf[i] = temp[len - 1 - i];
        }
        pid_buf[len] = b'\n';
        len + 1
    };

    // Open cgroup.procs file
    let fd = unsafe { libc::open(cgroup_procs_path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC) };

    if fd < 0 {
        return Err(common::get_errno());
    }

    // Write PID to file
    let result = unsafe { libc::write(fd, pid_buf.as_ptr() as *const libc::c_void, pid_len) };

    // Close file
    unsafe { libc::close(fd) };

    if result < 0 {
        return Err(common::get_errno());
    }

    Ok(())
}

/// Build the cgroup.procs path for a box.
///
/// Returns a CString that can be passed to `add_self_to_cgroup_raw`.
/// This should be called in the parent process before spawning.
#[cfg(target_os = "linux")]
pub fn build_cgroup_procs_path(box_id: &str) -> Option<std::ffi::CString> {
    if !is_cgroup_v2_available() {
        return None;
    }

    let path = cgroup_path(box_id).join("cgroup.procs");
    std::ffi::CString::new(path.to_string_lossy().as_bytes()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cgroup_path() {
        let path = cgroup_path("test-box-123");
        // Path depends on whether running as root or regular user
        let expected_base = get_cgroup_base();
        let expected = expected_base.join("boxlite").join("test-box-123");
        assert_eq!(path, expected);
        // Verify the path ends with the expected suffix
        assert!(path.ends_with("boxlite/test-box-123"));
    }

    #[test]
    fn test_cgroup_v2_detection() {
        let available = is_cgroup_v2_available();
        println!("Cgroup v2 available: {}", available);
    }

    #[test]
    fn test_cgroup_config_from_limits() {
        let limits = ResourceLimits {
            max_memory: Some(1024 * 1024 * 1024), // 1GB
            max_processes: Some(100),
            max_cpu_time: Some(60), // 60 seconds
            ..Default::default()
        };

        let config = CgroupConfig::from(&limits);

        assert_eq!(config.memory_max, Some(1024 * 1024 * 1024));
        assert_eq!(config.pids_max, Some(100));
        assert!(config.cpu_max.is_some());
    }
}
