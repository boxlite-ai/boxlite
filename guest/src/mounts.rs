//! Essential filesystem mounts for guest init.
//!
//! Mounts devtmpfs at /dev so the kernel auto-populates block device nodes
//! (e.g., /dev/vda, /dev/vdb), and mounts tmpfs on directories that require
//! local filesystem semantics (open-unlink-fstat pattern) which virtio-fs
//! doesn't support.

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

/// Mount essential filesystems for guest boot.
///
/// Called early in guest startup, before the gRPC server starts.
///
/// 1. **devtmpfs at /dev** — the kernel auto-populates block device nodes
///    (vda, vdb, …) so that later volume-mount RPCs can find them.
/// 2. **tmpfs on /tmp, /var/tmp, /run** — needed because virtio-fs doesn't
///    support the open-unlink-fstat pattern used by apt and other tools.
pub fn mount_essential_filesystems() -> BoxliteResult<()> {
    tracing::info!("Mounting essential guest filesystems");

    mount_devtmpfs()?;

    for mount_cfg in TMPFS_MOUNTS {
        mount_tmpfs(mount_cfg)?;
    }

    Ok(())
}

/// Mount devtmpfs at /dev so the kernel populates block device nodes.
///
/// Without this, /dev/vdb (container disk) doesn't exist even though the
/// kernel sees the disk in /proc/partitions.  Container.Init then fails to
/// mount the 10 GB container disk and writes fall back to the tiny 256 MB
/// guest rootfs on /dev/vda.
fn mount_devtmpfs() -> BoxliteResult<()> {
    let dev_path = Path::new("/dev");

    // Skip if /dev is already a devtmpfs mount
    if is_mounted(dev_path, "devtmpfs")? {
        tracing::debug!("/dev is already devtmpfs, skipping");
        return Ok(());
    }

    if !dev_path.exists() {
        fs::create_dir_all(dev_path)
            .map_err(|e| BoxliteError::Internal(format!("Failed to create /dev: {}", e)))?;
    }

    tracing::debug!("Mounting devtmpfs on /dev");
    mount(
        Some("devtmpfs"),
        dev_path,
        Some("devtmpfs"),
        MsFlags::MS_NOSUID,
        Some("mode=0755"),
    )
    .map_err(|e| {
        tracing::error!("Failed to mount devtmpfs on /dev: {} (errno: {:?})", e, e);
        BoxliteError::Internal(format!("Failed to mount devtmpfs on /dev: {}", e))
    })?;

    tracing::info!("Mounted devtmpfs on /dev");
    Ok(())
}

fn mount_tmpfs(cfg: &TmpfsMount) -> BoxliteResult<()> {
    let path = Path::new(cfg.path);

    // Skip if already mounted as tmpfs
    if is_mounted(path, "tmpfs")? {
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

/// Check whether `path` is already mounted with the given filesystem type.
fn is_mounted(path: &Path, fstype: &str) -> BoxliteResult<bool> {
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
