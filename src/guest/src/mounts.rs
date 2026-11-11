//! Guest init filesystems and writable runtime directories.
//!
//! Mounts tmpfs on directories that require local filesystem semantics
//! (e.g., open-unlink-fstat pattern) which virtio-fs doesn't support.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::mount::{mount, MsFlags};
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::Path;

/// Mount the filesystems normally supplied by init.krun. Only guest PID 1 calls
/// this, before the zygote forks, so its descendants inherit the writable paths.
pub(crate) fn mount_init_filesystems() -> BoxliteResult<()> {
    use nix::sys::statfs::{statfs, PROC_SUPER_MAGIC};
    let restricted =
        MsFlags::MS_NOSUID | MsFlags::MS_NOEXEC | MsFlags::MS_NODEV | MsFlags::MS_RELATIME;
    let mut directories = fs::DirBuilder::new();
    directories.recursive(true).mode(0o755);

    // /proc must exist before mountinfo can validate the other mount points.
    // statx also detects a bind mount here, even on the root filesystem.
    directories.create("/proc")?;
    let proc_type = statfs("/proc")
        .map_err(|e| BoxliteError::Internal(format!("statfs /proc: {e}")))?
        .filesystem_type();
    if proc_type != PROC_SUPER_MAGIC {
        if mount_id("/proc")? != mount_id("/")? {
            return Err(BoxliteError::Internal(format!(
                "/proc has an unexpected filesystem: {proc_type:?}"
            )));
        }
        mount(
            Some("proc"),
            "/proc",
            Some("proc"),
            restricted,
            None::<&str>,
        )
        .map_err(|e| BoxliteError::Internal(format!("mount proc on /proc: {e}")))?;
    }

    for (path, filesystem, flags) in [
        ("/dev", "devtmpfs", MsFlags::MS_RELATIME),
        ("/sys", "sysfs", restricted),
        ("/sys/fs/cgroup", "cgroup2", restricted),
        (
            "/dev/pts",
            "devpts",
            MsFlags::MS_NOSUID | MsFlags::MS_NOEXEC | MsFlags::MS_RELATIME,
        ),
        (
            "/dev/shm",
            "tmpfs",
            MsFlags::MS_NOSUID | MsFlags::MS_NOEXEC | MsFlags::MS_RELATIME,
        ),
    ] {
        directories.create(path)?;
        if !mounted_as(path, filesystem)? {
            mount(
                Some(filesystem),
                path,
                Some(filesystem),
                flags,
                None::<&str>,
            )
            .map_err(|e| BoxliteError::Internal(format!("mount {filesystem} on {path}: {e}")))?;
        }
    }

    match std::os::unix::fs::symlink("/proc/self/fd", "/dev/fd") {
        Ok(()) => (),
        Err(e)
            if e.kind() == std::io::ErrorKind::AlreadyExists
                && fs::read_link("/dev/fd")? == Path::new("/proc/self/fd") => {}
        Err(e) => {
            return Err(BoxliteError::Internal(format!(
                "create /dev/fd symlink: {e}"
            )))
        }
    }
    mount(
        None::<&str>,
        "/",
        None::<&str>,
        MsFlags::MS_REC | MsFlags::MS_SHARED,
        None::<&str>,
    )
    .map_err(|e| BoxliteError::Internal(format!("make guest root shared: {e}")))?;

    // Keep libkrun's existing tmpfs behavior. Init additionally rejects an
    // unexpected mount rather than hiding it under another filesystem.
    for cfg in TMPFS_MOUNTS {
        directories.create(cfg.path)?;
        mounted_as(cfg.path, "tmpfs")?;
    }
    mount_essential_tmpfs()
}

fn mounted_as(path: &str, expected: &str) -> BoxliteResult<bool> {
    let id = mount_id(path)?;
    let mounts = procfs::process::Process::myself()
        .and_then(|p| p.mountinfo())
        .map_err(|e| BoxliteError::Internal(format!("read mountinfo for {path}: {e}")))?;
    let mounted = mounts
        .iter()
        .find(|m| m.mnt_id as u64 == id)
        .ok_or_else(|| {
            BoxliteError::Internal(format!("mount {id} for {path} missing from mountinfo"))
        })?;
    if mounted.mount_point != Path::new(path) {
        return Ok(false);
    }
    if mounted.fs_type != expected {
        return Err(BoxliteError::Internal(format!(
            "{path} is mounted as {}, expected {expected}",
            mounted.fs_type
        )));
    }
    Ok(true)
}

fn mount_id(path: &str) -> BoxliteResult<u64> {
    use rustix::fs::{statx, AtFlags, StatxFlags, CWD};
    let stat = statx(CWD, path, AtFlags::empty(), StatxFlags::MNT_ID)
        .map_err(|e| BoxliteError::Internal(format!("statx mount ID for {path}: {e}")))?;
    if !StatxFlags::from_bits_retain(stat.stx_mask).contains(StatxFlags::MNT_ID) {
        return Err(BoxliteError::Internal(format!(
            "kernel did not return a mount ID for {path}"
        )));
    }
    Ok(stat.stx_mnt_id)
}

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
