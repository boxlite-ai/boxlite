//! Guest init filesystems and writable runtime directories.
//!
//! Mounts tmpfs on directories that require local filesystem semantics
//! (e.g., open-unlink-fstat pattern) which virtio-fs doesn't support.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::mount::{mount, MsFlags};
use nix::sys::statfs::{statfs, PROC_SUPER_MAGIC, TMPFS_MAGIC};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::Path;

/// Mount the filesystems normally supplied by init.krun. Only guest PID 1 calls
/// this, before the zygote forks, so its descendants inherit the writable paths.
pub(crate) fn mount_init_filesystems() -> BoxliteResult<()> {
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
        if mount_id(Path::new("/proc"))? != mount_id(Path::new("/"))? {
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

    // Check the live mount ID against one snapshot. Record our new mounts
    // as we go because /dev and /sys can change the IDs seen by their children.
    let mountinfo = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|e| BoxliteError::Internal(format!("read mountinfo: {e}")))?;
    let mut mounts = HashMap::new();
    for (index, line) in mountinfo.lines().enumerate() {
        let (id, mount) = parse_mountinfo_line(line).ok_or_else(|| {
            BoxliteError::Internal(format!("invalid mountinfo line {}", index + 1))
        })?;
        mounts.insert(id, mount);
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
        if !mounted_as(&mounts, path, filesystem)? {
            mount(
                Some(filesystem),
                path,
                Some(filesystem),
                flags,
                None::<&str>,
            )
            .map_err(|e| BoxliteError::Internal(format!("mount {filesystem} on {path}: {e}")))?;
            mounts.insert(mount_id(Path::new(path))?, (path, filesystem));
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
            )));
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
        if !mounted_as(&mounts, cfg.path, "tmpfs")? {
            mount_tmpfs(cfg)?;
        }
    }
    Ok(())
}

fn parse_mountinfo_line(line: &str) -> Option<(u64, (&str, &str))> {
    let mut fields = line.split_ascii_whitespace();
    let id = fields.next()?.parse().ok()?;
    let mount_point = fields.nth(3)?;
    fields.next()?; // mount options
    fields.find(|field| *field == "-")?;
    let fs_type = fields.next()?;
    Some((id, (mount_point, fs_type)))
}

fn mounted_as(
    mounts: &HashMap<u64, (&str, &str)>,
    path: &str,
    expected: &str,
) -> BoxliteResult<bool> {
    let id = mount_id(Path::new(path))?;
    let (mount_point, fs_type) = mounts.get(&id).ok_or_else(|| {
        BoxliteError::Internal(format!("mount {id} for {path} missing from mountinfo"))
    })?;
    // All paths checked here are fixed ASCII paths that mountinfo never escapes.
    if *mount_point != path {
        return Ok(false);
    }
    if *fs_type != expected {
        return Err(BoxliteError::Internal(format!(
            "{path} is mounted as {fs_type}, expected {expected}"
        )));
    }
    Ok(true)
}

fn mount_id(path: &Path) -> BoxliteResult<u64> {
    use rustix::fs::{statx, AtFlags, StatxFlags, CWD};
    let stat = statx(CWD, path, AtFlags::empty(), StatxFlags::MNT_ID).map_err(|e| {
        BoxliteError::Internal(format!("statx mount ID for {}: {e}", path.display()))
    })?;
    if !StatxFlags::from_bits_retain(stat.stx_mask).contains(StatxFlags::MNT_ID) {
        return Err(BoxliteError::Internal(format!(
            "kernel did not return a mount ID for {}",
            path.display()
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
    tracing::debug!("Mounting essential tmpfs directories");

    for cfg in TMPFS_MOUNTS {
        if !is_tmpfs(Path::new(cfg.path))? {
            mount_tmpfs(cfg)?;
        }
    }

    Ok(())
}

fn mount_tmpfs(cfg: &TmpfsMount) -> BoxliteResult<()> {
    let path = Path::new(cfg.path);

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

    tracing::debug!("Mounted tmpfs on {}", cfg.path);
    Ok(())
}

fn is_tmpfs(path: &Path) -> BoxliteResult<bool> {
    match statfs(path) {
        // An inherited tmpfs is not a mount at this path; the new mount
        // still needs its own permissions. All callers use non-root paths.
        Ok(stat) if stat.filesystem_type() == TMPFS_MAGIC => {
            Ok(mount_id(path)? != mount_id(path.parent().expect("tmpfs mount has a parent"))?)
        }
        Ok(_) | Err(nix::errno::Errno::ENOENT) => Ok(false),
        Err(e) => Err(BoxliteError::Internal(format!(
            "statfs {}: {e}",
            path.display()
        ))),
    }
}
