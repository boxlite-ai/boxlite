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
//!         ├── io.max            # Disk I/O rate limits, one line per host block device
//!         └── cgroup.procs      # Add process here
//! ```

use super::common;
use super::error::JailerError;
use crate::runtime::advanced_options::ResourceLimits;
use crate::runtime::id::BoxID;
use crate::runtime::options::DiskIoLimits;
use std::collections::BTreeSet;
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

/// One `io.max` line: a host block device and the limits applied to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IoMax {
    pub major: u32,
    pub minor: u32,
    pub limits: DiskIoLimits,
}

impl IoMax {
    /// Render the `io.max` line. Unset dimensions are written as `max`
    /// explicitly so a rewrite clears any earlier value for that device.
    pub fn to_line(&self) -> String {
        fn field(value: Option<u64>) -> String {
            value.map_or_else(|| "max".to_string(), |v| v.to_string())
        }
        format!(
            "{}:{} rbps={} wbps={} riops={} wiops={}",
            self.major,
            self.minor,
            field(self.limits.read_bps),
            field(self.limits.write_bps),
            field(self.limits.read_iops),
            field(self.limits.write_iops),
        )
    }
}

/// Resolve the host block device (major, minor) backing `path`.
///
/// `io.max` is keyed by device number, and a file's `st_dev` is the device of
/// the filesystem it lives on. Filesystems that report an anonymous device
/// (major 0: btrfs, overlayfs, tmpfs) cannot be throttled this way, so that is
/// an error rather than a silent no-op. A partition's number is mapped to its
/// whole disk: the io controller only accepts whole-disk devices (partitions
/// fail with ENODEV), and throttling is per request queue, which a disk and its
/// partitions share.
#[cfg(target_os = "linux")]
fn block_device_of(path: &Path) -> Result<(u32, u32), JailerError> {
    use std::os::unix::fs::MetadataExt;

    let dev = fs::metadata(path)
        .map_err(|e| {
            JailerError::Cgroup(format!(
                "Failed to stat disk image {} for io.max: {}",
                path.display(),
                e
            ))
        })?
        .dev();
    let (major, minor) = (libc::major(dev), libc::minor(dev));
    if major == 0 {
        return Err(JailerError::Cgroup(format!(
            "Disk image {} is on a filesystem without a host block device (anonymous \
             device 0:{}), so disk io limits cannot be applied. Keep the boxlite home \
             on a filesystem backed by a block device (ext4/xfs on a disk, partition, \
             or dm volume).",
            path.display(),
            minor
        )));
    }
    Ok(whole_disk_of(Path::new("/sys"), (major, minor)))
}

/// Map a partition's device number to its whole disk via sysfs; anything that
/// is not a partition (whole disks, dm/loop volumes, unknown devices) is
/// returned unchanged.
///
/// `/sys/dev/block/MAJ:MIN` is a symlink into the disk's tree
/// (`.../sda/sda1`); a partition carries a `partition` file, and the disk's
/// own number is in the parent directory's `dev`.
fn whole_disk_of(sysfs: &Path, (major, minor): (u32, u32)) -> (u32, u32) {
    let entry = sysfs.join("dev/block").join(format!("{major}:{minor}"));
    if !entry.join("partition").exists() {
        return (major, minor);
    }
    let parent_dev = match fs::read_to_string(entry.join("../dev")) {
        Ok(s) => s,
        Err(_) => return (major, minor),
    };
    let mut parts = parent_dev.trim().splitn(2, ':');
    match (
        parts.next().and_then(|s| s.parse().ok()),
        parts.next().and_then(|s| s.parse().ok()),
    ) {
        (Some(parent_major), Some(parent_minor)) => (parent_major, parent_minor),
        _ => (major, minor),
    }
}

/// Build the `io.max` entries for `limits` covering every device the given
/// disk images live on. Images sharing a device collapse to one entry; each
/// device gets the full limit.
#[cfg(target_os = "linux")]
pub fn io_max_entries(
    limits: &DiskIoLimits,
    disk_images: &[PathBuf],
) -> Result<Vec<IoMax>, JailerError> {
    let mut devices = BTreeSet::new();
    for image in disk_images {
        devices.insert(block_device_of(image)?);
    }
    Ok(devices
        .into_iter()
        .map(|(major, minor)| IoMax {
            major,
            minor,
            limits: limits.clone(),
        })
        .collect())
}

/// Whether the `io` controller can be enabled for box cgroups.
///
/// Reads `cgroup.controllers` at the base this process may create cgroups
/// under. Root sees every controller; a rootless user only sees what systemd
/// delegated to `user@<uid>.service`, which by default is `cpu memory pids`
/// without `io`.
pub fn io_controller_available() -> bool {
    fs::read_to_string(get_cgroup_base().join("cgroup.controllers"))
        .map(|s| controllers_include_io(&s))
        .unwrap_or(false)
}

/// Parse a `cgroup.controllers` listing for the `io` controller.
fn controllers_include_io(controllers: &str) -> bool {
    controllers.split_whitespace().any(|c| c == "io")
}

/// Operator instructions for making the `io` controller available where it
/// is not delegated. Rootless: delegate it to the user's systemd service.
pub fn io_delegation_hint() -> String {
    if is_root() {
        return "the io controller is missing from /sys/fs/cgroup/cgroup.controllers; \
                check the kernel's cgroup v2 configuration"
            .to_string();
    }
    let uid = current_uid();
    format!(
        "delegate the io controller to your user session (as root):\n  \
         systemctl edit user@{uid}.service   # add under [Service]: Delegate=cpu cpuset io memory pids\n  \
         systemctl daemon-reload && loginctl terminate-user {uid}   # then log in again"
    )
}

#[cfg(target_os = "linux")]
fn current_uid() -> u32 {
    unsafe { libc::getuid() }
}

#[cfg(not(target_os = "linux"))]
fn current_uid() -> u32 {
    0
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

/// Kill every process in a box's cgroup via cgroup v2 `cgroup.kill`.
///
/// Reaps the box's *entire* process tree atomically — the outer bwrap launcher,
/// the inner pid-namespace bwrap, the shim, and the VM — regardless of
/// pid-namespace or process-group structure. A single-pid `SIGKILL` of the
/// recorded pid only hits the outer bwrap; a detached box's inner tree survives
/// it, since #851 stopped applying `--die-with-parent` to detached boxes. The
/// whole tree lives in the box's cgroup, so killing the cgroup by id reaps it
/// even after `state.pid` has been cleared.
///
/// Best-effort and idempotent: a no-op if the cgroup is gone, already empty, or
/// `cgroup.kill` is unavailable (kernel < 5.14 / cgroup v1 / no jailer). Returns
/// `true` if the kill file was written.
///
/// Takes a [`BoxID`] rather than a raw `&str` on purpose: this writes to a path
/// derived from the id, so it must be a safe single path component. `BoxID`'s
/// constructor ([`BoxID::parse`]/mint) is the one choke point that guarantees
/// that — its charset (`[A-Za-z0-9_-]`) excludes `/`, `\`, and `.`, so `..`/`.`
/// and path separators are unrepresentable. The type carries the guarantee, so
/// no per-call traversal check is needed (or could drift) here.
///
/// `pub(super)` on purpose: this is the cgroup *mechanism*, reached only through
/// the jailer's [`super::reap_box`] facade. Layers above the jailer (box,
/// runtime) reap by box semantics and never name cgroups.
pub(super) fn kill_cgroup(box_id: &BoxID) -> bool {
    let kill_file = cgroup_path(box_id.as_str()).join("cgroup.kill");
    std::fs::write(&kill_file, "1").is_ok()
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

/// Apply disk I/O limits to a box cgroup created by [`setup_cgroup`].
///
/// Kept separate from the other limits so a failure here (no `io` controller,
/// a device the kernel refuses) leaves memory/cpu/pids in place and surfaces
/// as a disk-io-specific warning instead of "continuing without cgroup limits".
///
/// Enables `io` down the chain on demand: at the base (systemd enables only
/// the controllers it delegates; a rootless user owns that file once `io` is
/// delegated) and on the boxlite parent, which may predate io limits. Enabling
/// an already-enabled controller is a no-op.
pub fn apply_io_max(box_id: &str, entries: &[IoMax]) -> Result<(), JailerError> {
    let cgroup_base = get_cgroup_base();
    let boxlite_cgroup = cgroup_base.join(BOXLITE_CGROUP);
    let box_cgroup = boxlite_cgroup.join(box_id);

    write_file(&cgroup_base.join("cgroup.subtree_control"), "+io")?;
    write_file(&boxlite_cgroup.join("cgroup.subtree_control"), "+io")?;

    // One line per device; the kernel keeps lines keyed by device.
    for entry in entries {
        write_file(&box_cgroup.join("io.max"), &entry.to_line())?;
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
    fn kill_cgroup_absent_is_noop() {
        // No cgroup exists for this id, so `cgroup.kill` can't be written:
        // kill_cgroup must report `false` and not panic. This locks the
        // best-effort/idempotent contract relied on by the no-jailer and
        // macOS-seatbelt paths (where there is no box cgroup to kill).
        let box_id = BoxID::parse("nonexistentbox000000000000").expect("valid id");
        assert!(
            !kill_cgroup(&box_id),
            "kill_cgroup must be a no-op (false) when the box has no cgroup"
        );
    }

    // Note: there is no `kill_cgroup_rejects_non_component_box_ids` test anymore.
    // The path-traversal guard moved into the type: `kill_cgroup` takes a
    // `BoxID`, and `BoxID::parse` already rejects `/`, `\`, `.`, `..`, and empty
    // ids (see `id::tests::test_parse_rejects_unsafe_characters`). A non-component
    // id is now unrepresentable at this call site, not merely rejected at runtime.

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

    #[test]
    fn io_max_line_writes_every_dimension_with_max_for_unset() {
        let entry = IoMax {
            major: 8,
            minor: 48,
            limits: DiskIoLimits {
                read_bps: Some(50 * 1024 * 1024),
                write_bps: Some(20 * 1024 * 1024),
                read_iops: Some(2000),
                write_iops: Some(1000),
            },
        };
        assert_eq!(
            entry.to_line(),
            "8:48 rbps=52428800 wbps=20971520 riops=2000 wiops=1000"
        );

        let write_only = IoMax {
            major: 8,
            minor: 48,
            limits: DiskIoLimits {
                write_bps: Some(4 * 1024 * 1024),
                ..Default::default()
            },
        };
        assert_eq!(
            write_only.to_line(),
            "8:48 rbps=max wbps=4194304 riops=max wiops=max"
        );
    }

    #[test]
    fn controllers_listing_detects_io() {
        // What systemd delegates to a user session by default.
        assert!(!controllers_include_io("cpu memory pids"));
        // What root sees on a stock cgroup v2 host.
        assert!(controllers_include_io(
            "cpuset cpu io memory hugetlb pids rdma"
        ));
        // Whole-word: `iommu`-style prefixes must not match.
        assert!(!controllers_include_io("cpu iox memory"));
        assert!(!controllers_include_io(""));
    }

    #[test]
    fn io_max_entries_dedupe_images_on_one_device() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("disk.qcow2");
        let b = dir.path().join("guest-rootfs.qcow2");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();

        let limits = DiskIoLimits {
            read_iops: Some(500),
            ..Default::default()
        };
        match io_max_entries(&limits, &[a.clone(), b]) {
            Ok(entries) => {
                assert_eq!(entries.len(), 1, "two images on one device → one line");
                assert_eq!(entries[0].limits, limits);
                let (major, minor) = block_device_of(&a).unwrap();
                assert_eq!((entries[0].major, entries[0].minor), (major, minor));
                assert_ne!(major, 0);
            }
            Err(JailerError::Cgroup(msg)) => {
                // tmpdir on tmpfs/overlay: the anonymous-device refusal must name
                // the file and the cause instead of throttling nothing.
                assert!(msg.contains("anonymous"), "unexpected error: {msg}");
                assert!(msg.contains("disk.qcow2"), "unexpected error: {msg}");
            }
            Err(other) => panic!("unexpected error: {other}"),
        }
    }

    /// The io controller rejects partition numbers (ENODEV), so a partition
    /// must resolve to its disk; whole disks and unknown devices pass through.
    #[test]
    fn whole_disk_of_maps_a_partition_to_its_disk() {
        let sysfs = tempfile::tempdir().unwrap();
        let root = sysfs.path();
        // /sys/block/sda/{dev}, /sys/block/sda/sda1/{dev,partition}
        std::fs::create_dir_all(root.join("block/sda/sda1")).unwrap();
        std::fs::write(root.join("block/sda/dev"), "8:0\n").unwrap();
        std::fs::write(root.join("block/sda/sda1/dev"), "8:1\n").unwrap();
        std::fs::write(root.join("block/sda/sda1/partition"), "1\n").unwrap();
        // /sys/block/dm-0/dev (a whole device, no partition file)
        std::fs::create_dir_all(root.join("block/dm-0")).unwrap();
        std::fs::write(root.join("block/dm-0/dev"), "253:0\n").unwrap();
        // /sys/dev/block/MAJ:MIN -> ../../block/...
        std::fs::create_dir_all(root.join("dev/block")).unwrap();
        std::os::unix::fs::symlink("../../block/sda/sda1", root.join("dev/block/8:1")).unwrap();
        std::os::unix::fs::symlink("../../block/sda", root.join("dev/block/8:0")).unwrap();
        std::os::unix::fs::symlink("../../block/dm-0", root.join("dev/block/253:0")).unwrap();

        assert_eq!(whole_disk_of(root, (8, 1)), (8, 0), "partition → its disk");
        assert_eq!(whole_disk_of(root, (8, 0)), (8, 0), "whole disk unchanged");
        assert_eq!(
            whole_disk_of(root, (253, 0)),
            (253, 0),
            "dm volume unchanged"
        );
        assert_eq!(
            whole_disk_of(root, (7, 9)),
            (7, 9),
            "unknown device unchanged"
        );
    }

    #[test]
    fn io_max_entries_reject_missing_image() {
        let limits = DiskIoLimits {
            read_bps: Some(1),
            ..Default::default()
        };
        let err = io_max_entries(&limits, &[PathBuf::from("/nonexistent/disk.qcow2")]).unwrap_err();
        assert!(err.to_string().contains("/nonexistent/disk.qcow2"));
    }

    #[test]
    fn io_delegation_hint_names_the_fix() {
        let hint = io_delegation_hint();
        if is_root() {
            assert!(hint.contains("cgroup.controllers"));
        } else {
            assert!(hint.contains("Delegate="));
            assert!(hint.contains(&format!("user@{}.service", current_uid())));
        }
    }
}
