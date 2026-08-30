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
    let mounts = match fs::read_to_string("/proc/mounts") {
        Ok(content) => content,
        Err(_) => return Ok(false), // /proc may not be mounted yet
    };

    let path_str = path.to_string_lossy();

    for line in mounts.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[1] == path_str && parts[2] == "tmpfs" {
            return Ok(true);
        }
    }

    Ok(false)
}
