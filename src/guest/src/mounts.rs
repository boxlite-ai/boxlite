//! Essential tmpfs mounts for guest filesystem
//!
//! Mounts tmpfs on directories that require local filesystem semantics
//! (e.g., open-unlink-fstat pattern) which virtio-fs doesn't support.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::mount::{mount, MsFlags};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

/// tmpfs mount configuration
struct TmpfsMount {
    path: &'static str,
    mode: u32,
}

/// Directories that need tmpfs
const TMPFS_MOUNTS: &[TmpfsMount] = &[
    TmpfsMount {
        path: "/tmp",
        mode: 0o1777,
    },
    TmpfsMount {
        path: "/var/tmp",
        mode: 0o1777,
    },
    TmpfsMount {
        path: "/run",
        mode: 0o755,
    },
];

/// Ensure /proc, /sys, and /dev are mounted.
///
/// On macOS-hosted VMs (Hypervisor.framework), the kernel handles these.
/// On Windows-hosted VMs (WHPX), the initrd's switch_root may leave them
/// unmounted if the init script doesn't `mount --move` them. This function
/// mounts them if missing so the guest agent works on all platforms.
pub fn mount_virtual_filesystems() -> BoxliteResult<()> {
    let vfs: &[(&str, &str)] = &[("proc", "/proc"), ("sysfs", "/sys"), ("devtmpfs", "/dev")];

    for &(fstype, path) in vfs {
        let p = Path::new(path);
        if !p.exists() {
            fs::create_dir_all(p)
                .map_err(|e| BoxliteError::Internal(format!("Failed to create {}: {}", path, e)))?;
        }
        // Skip if already mounted (check by trying to read a known entry)
        let probe = match fstype {
            "proc" => p.join("self").exists(),
            "devtmpfs" => p.join("null").exists(),
            _ => p.join(".").read_dir().is_ok_and(|mut d| d.next().is_some()),
        };
        if probe {
            tracing::debug!("{} already mounted, skipping", path);
            continue;
        }

        if let Err(e) = mount(
            Some(fstype),
            p,
            Some(fstype),
            MsFlags::empty(),
            None::<&str>,
        ) {
            tracing::warn!("Failed to mount {} on {}: {}", fstype, path, e);
        } else {
            tracing::info!("Mounted {} on {}", fstype, path);
        }
    }

    // Mount cgroup2 if missing — libcontainer's intermediate process requires
    // /sys/fs/cgroup to exist even when the OCI spec has cgroups disabled.
    let cgroup_path = Path::new("/sys/fs/cgroup");
    if !cgroup_path.exists() {
        fs::create_dir_all(cgroup_path).map_err(|e| {
            BoxliteError::Internal(format!("Failed to create /sys/fs/cgroup: {}", e))
        })?;
    }
    if !is_mounted_as(cgroup_path, "cgroup2")? {
        if let Err(e) = mount(
            Some("cgroup2"),
            cgroup_path,
            Some("cgroup2"),
            MsFlags::empty(),
            None::<&str>,
        ) {
            tracing::warn!("Failed to mount cgroup2 on /sys/fs/cgroup: {}", e);
        } else {
            tracing::info!("Mounted cgroup2 on /sys/fs/cgroup");
        }
    } else {
        tracing::debug!("/sys/fs/cgroup already mounted as cgroup2");
    }

    Ok(())
}

/// Mount essential tmpfs directories
///
/// Called early in guest startup, before gRPC server starts.
/// These mounts are needed because virtio-fs doesn't support the
/// open-unlink-fstat pattern used by apt and other tools.
pub fn mount_essential_tmpfs() -> BoxliteResult<()> {
    tracing::info!("Mounting essential tmpfs directories");

    for mount_cfg in TMPFS_MOUNTS {
        mount_tmpfs(mount_cfg)?;
    }

    Ok(())
}

fn mount_tmpfs(cfg: &TmpfsMount) -> BoxliteResult<()> {
    let path = Path::new(cfg.path);

    // Skip if already mounted as tmpfs
    if is_tmpfs(path)? {
        tracing::debug!("{} is already tmpfs, skipping", cfg.path);
        return Ok(());
    }

    // Create directory if it doesn't exist
    if !path.exists() {
        fs::create_dir_all(path)
            .map_err(|e| BoxliteError::Internal(format!("Failed to create {}: {}", cfg.path, e)))?;
    }

    // Mount tmpfs - use empty flags to be safe
    tracing::debug!("Attempting to mount tmpfs on {}", cfg.path);
    if let Err(e) = mount(
        Some("tmpfs"),
        path,
        Some("tmpfs"),
        MsFlags::empty(),
        None::<&str>,
    ) {
        // Log debug info on failure
        tracing::error!(
            "Failed to mount tmpfs on {}: {} (errno: {:?})",
            cfg.path,
            e,
            e
        );
        if let Ok(mounts) = fs::read_to_string("/proc/mounts") {
            tracing::debug!("Current mounts:\n{}", mounts);
        }
        return Err(BoxliteError::Internal(format!(
            "Failed to mount tmpfs on {}: {}",
            cfg.path, e
        )));
    }

    // Set correct permissions after mount
    fs::set_permissions(path, fs::Permissions::from_mode(cfg.mode)).map_err(|e| {
        BoxliteError::Internal(format!("Failed to set permissions on {}: {}", cfg.path, e))
    })?;

    tracing::info!("Mounted tmpfs on {}", cfg.path);
    Ok(())
}

fn is_tmpfs(path: &Path) -> BoxliteResult<bool> {
    is_mounted_as(path, "tmpfs")
}

fn is_mounted_as(path: &Path, fstype: &str) -> BoxliteResult<bool> {
    let mounts = match fs::read_to_string("/proc/mounts") {
        Ok(content) => content,
        Err(_) => return Ok(false), // /proc may not be mounted yet
    };

    let path_str = path.to_string_lossy();

    for line in mounts.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[1] == path_str && parts[2] == fstype {
            return Ok(true);
        }
    }

    Ok(false)
}
