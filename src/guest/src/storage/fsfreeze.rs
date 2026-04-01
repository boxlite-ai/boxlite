//! Filesystem freeze/thaw via FIFREEZE/FITHAW ioctls.
//!
//! Implements the guest side of the quiesce/thaw protocol, equivalent to
//! QEMU guest-agent's `guest-fsfreeze-freeze` / `guest-fsfreeze-thaw`.
//!
//! FIFREEZE atomically flushes dirty pages and blocks new writes.
//! FITHAW unblocks writes on a previously frozen filesystem.

use std::fs::File;
use std::io;
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;

use nix::libc;
use tracing::{debug, info, warn};

// Linux ioctl constants for filesystem freeze/thaw.
// Defined in include/uapi/linux/fs.h:
//   #define FIFREEZE  _IOWR('X', 119, int)  = 0xC0045877
//   #define FITHAW    _IOWR('X', 120, int)  = 0xC0045878
//
// These are _IOWR (read+write direction). Using raw constants because
// nix::ioctl_write_int! generates _IOW (write-only), which produces a
// different ioctl number (0x40045877 vs 0xC0045877).
const FIFREEZE: libc::c_ulong = 0xC004_5877;
const FITHAW: libc::c_ulong = 0xC004_5878;

/// Virtual/pseudo filesystem types that should not be frozen.
const SKIP_FS_TYPES: &[&str] = &[
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "tmpfs",
    "cgroup",
    "cgroup2",
    "securityfs",
    "debugfs",
    "tracefs",
    "configfs",
    "fusectl",
    "mqueue",
    "hugetlbfs",
    "pstore",
    "binfmt_misc",
    "autofs",
    "rpc_pipefs",
    "nfsd",
    "overlay",
];

/// Freeze all writable filesystems.
///
/// Parses `/proc/mounts` to find writable, non-virtual filesystems,
/// then calls FIFREEZE on each. Returns the list of mount points
/// that were successfully frozen.
pub fn freeze_filesystems() -> Vec<PathBuf> {
    let mounts = match std::fs::read_to_string("/proc/mounts") {
        Ok(content) => content,
        Err(e) => {
            warn!("Failed to read /proc/mounts: {}", e);
            return Vec::new();
        }
    };

    let mut frozen = Vec::new();

    for line in mounts.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }

        let mount_point = fields[1];
        let fs_type = fields[2];
        let options = fields[3];

        // Skip virtual/pseudo filesystems
        if SKIP_FS_TYPES.contains(&fs_type) {
            continue;
        }

        // Skip read-only mounts
        if options.split(',').any(|opt| opt == "ro") {
            continue;
        }

        match do_fsfreeze(mount_point) {
            Ok(()) => {
                debug!(mount_point, "Filesystem frozen");
                frozen.push(PathBuf::from(mount_point));
            }
            Err(e) => {
                // EOPNOTSUPP means the filesystem doesn't support freeze — skip silently.
                // EBUSY means already frozen — count as success.
                if e.raw_os_error() == Some(libc::EBUSY) {
                    debug!(mount_point, "Filesystem already frozen");
                    frozen.push(PathBuf::from(mount_point));
                } else if e.raw_os_error() == Some(libc::EOPNOTSUPP) {
                    debug!(mount_point, fs_type, "Filesystem does not support freeze");
                } else {
                    warn!(mount_point, error = %e, "Failed to freeze filesystem");
                }
            }
        }
    }

    info!(count = frozen.len(), "Filesystems frozen");
    frozen
}

/// Thaw a list of previously frozen mount points.
///
/// Returns the number of filesystems successfully thawed.
pub fn thaw_filesystems(frozen: &[PathBuf]) -> u32 {
    let mut thawed = 0u32;

    for mount_point in frozen {
        let path_str = mount_point.to_string_lossy();
        match do_fsthaw(&path_str) {
            Ok(()) => {
                debug!(mount_point = %path_str, "Filesystem thawed");
                thawed += 1;
            }
            Err(e) => {
                warn!(mount_point = %path_str, error = %e, "Failed to thaw filesystem");
            }
        }
    }

    info!(count = thawed, "Filesystems thawed");
    thawed
}

/// FIFREEZE ioctl — flush dirty pages and block new writes.
fn do_fsfreeze(mount_point: &str) -> io::Result<()> {
    let file = File::open(mount_point)?;
    // SAFETY: FIFREEZE ioctl on a valid file descriptor for a mount point.
    // The data argument (0) is ignored by the kernel for FIFREEZE.
    let ret = unsafe { libc::ioctl(file.as_raw_fd(), FIFREEZE as _, 0) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// FITHAW ioctl — unblock writes on a frozen filesystem.
fn do_fsthaw(mount_point: &str) -> io::Result<()> {
    let file = File::open(mount_point)?;
    // SAFETY: FITHAW ioctl on a valid file descriptor for a mount point.
    let ret = unsafe { libc::ioctl(file.as_raw_fd(), FITHAW as _, 0) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
