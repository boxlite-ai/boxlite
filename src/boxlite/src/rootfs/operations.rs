//! Low-level rootfs operations
//!
//! This module provides shared primitives for rootfs manipulation used by both
//! PreparedRootfs (new architecture) and RootfsBuilder (Alpine boot rootfs).
//!
//! All functions are platform-aware and handle cross-platform differences internally.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::Path;

#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::process::Command;

/// Mount overlayfs combining multiple layers (Linux only).
///
/// Creates an overlayfs mount at the target directory with the specified lower,
/// upper, and work directories. Requires CAP_SYS_ADMIN capability.
///
/// # Arguments
/// * `lower_dirs` - Read-only layer directories (bottom to top order)
/// * `upper_dir` - Writable upper layer directory
/// * `work_dir` - Overlayfs work directory (must be on same filesystem as upper)
/// * `target_dir` - Mount point for the merged filesystem
///
/// # Returns
/// * `Ok(())` if mount succeeds
/// * `Err(BoxliteError)` if mount command fails
///
/// # Platform Support
/// * **Linux**: Uses kernel overlayfs via mount command
/// * **macOS**: Returns error (overlayfs not supported)
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub fn mount_overlayfs_from_layers(
    lower_dirs: &[PathBuf],
    upper_dir: &Path,
    work_dir: &Path,
    target_dir: &Path,
) -> BoxliteResult<()> {
    if lower_dirs.is_empty() {
        return Err(BoxliteError::Storage(
            "Cannot mount overlayfs with no lower directories".into(),
        ));
    }

    // Build lowerdir string: layer0:layer1:... (base to top)
    let lowerdir = lower_dirs
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(":");

    let mount_options = format!(
        "lowerdir={},upperdir={},workdir={}",
        lowerdir,
        upper_dir.display(),
        work_dir.display()
    );

    tracing::debug!("Mounting overlayfs with options: {}", mount_options);

    let output = Command::new("mount")
        .args([
            "-t",
            "overlay",
            "overlay",
            "-o",
            &mount_options,
            target_dir
                .to_str()
                .ok_or_else(|| BoxliteError::Storage("Invalid target path".into()))?,
        ])
        .output()
        .map_err(|e| BoxliteError::Storage(format!("Failed to execute mount command: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(BoxliteError::Storage(format!(
            "Failed to mount overlayfs: {}",
            stderr
        )));
    }

    tracing::info!("Overlayfs mounted at {}", target_dir.display());
    Ok(())
}

/// Unmount an overlayfs mount point (Linux only).
///
/// # Arguments
/// * `mount_point` - Directory where overlayfs is mounted
///
/// # Returns
/// * `Ok(())` if unmount succeeds
/// * `Err(BoxliteError)` if unmount command fails
#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub fn unmount_overlayfs(mount_point: &Path) -> BoxliteResult<()> {
    let output = Command::new("umount")
        .arg(mount_point)
        .output()
        .map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to execute umount for {}: {}",
                mount_point.display(),
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(BoxliteError::Storage(format!(
            "Failed to unmount overlayfs at {}: {}",
            mount_point.display(),
            stderr
        )));
    }

    tracing::debug!("Unmounted overlayfs at {}", mount_point.display());
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
pub fn unmount_overlayfs(_mount_point: &Path) -> BoxliteResult<()> {
    Ok(()) // No-op on non-Linux platforms
}

/// Fix rootfs permissions using xattr for permission virtualization.
/// The virtio-fs implementation respects the "user.containers.override_stat" attribute.
///
/// Temporarily grants owner access while synchronizing user.containers.override_stat
/// per-file, then restores each file's actual permissions. Ownership already recorded
/// by the layer extractor is carried through unchanged; entries with none recorded
/// are virtualized to root (0:0).
/// This ensures setuid binaries and executables maintain their correct permission bits.
/// Skips symlinks and special files.
///
/// # Arguments
/// * `rootfs` - Path to the rootfs directory
///
/// # Returns
/// * `Ok(())` if permissions and xattr were set successfully
/// * `Err(...)` if critical operations failed
pub fn fix_rootfs_permissions(rootfs: &Path) -> BoxliteResult<()> {
    use crate::images::{OverrideFileType, OverrideStat};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    tracing::info!(
        "Setting per-file xattr for rootfs permissions on {}",
        rootfs.display()
    );

    // Recursively set xattr for each file, preserving actual mode bits
    fn set_xattr_recursive(path: &Path, depth: usize) -> BoxliteResult<usize> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!("Skipping {}: {}", path.display(), e);
                return Ok(0);
            }
        };

        let mut count = 0;

        // Symlinks and special files do not need permission xattrs.
        if !metadata.is_file() && !metadata.is_dir() {
            return Ok(0);
        }

        // Get actual mode bits (preserve setuid/setgid/sticky bits)
        let mode = metadata.permissions().mode() & 0o7777;

        // xattr reads need owner read access; directories must stay searchable
        // until their children have been synchronized and restored.
        let required = if metadata.is_dir() { 0o700 } else { 0o600 };
        let needs_access = unsafe { libc::geteuid() } != 0 && mode & required != required;
        if needs_access {
            fs::set_permissions(path, fs::Permissions::from_mode(mode | required)).map_err(
                |e| {
                    BoxliteError::Storage(format!(
                        "Failed to grant owner access on {}: {e}",
                        path.display()
                    ))
                },
            )?;
        }

        // Keep errors inside this scope so restoration also runs on failure.
        let result = (|| {
            // Refresh the recorded mode without discarding the recorded ownership.
            // `LayerExtractor` stores the layer's uid/gid here because unprivileged
            // extraction cannot `chown`; overwriting it with 0:0 would drop the only
            // copy before the ext4 builder reads it back. Entries with no prior
            // record default to root, as before.
            //
            // A *present-but-malformed* record must abort instead: it is the only
            // copy of that file's real ownership, and the `xattr::set` below would
            // otherwise permanently overwrite it with a fresh 0:0 record — see
            // `OverrideStat::read_xattr`'s doc comment for why `Ok(None)` and `Err`
            // are deliberately distinct.
            let recorded = OverrideStat::read_xattr(path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to read ownership xattr on {}: {}",
                    path.display(),
                    e
                ))
            })?;
            let (uid, gid) = recorded.as_ref().map_or((0, 0), |s| (s.uid, s.gid));
            let default_type = if metadata.is_dir() {
                OverrideFileType::Dir
            } else {
                OverrideFileType::File
            };
            let file_type = recorded.map_or(default_type, |s| s.file_type);
            let xattr_value = OverrideStat::new(uid, gid, mode, file_type).format();

            // Set xattr (ignore errors on special files like device nodes)
            match xattr::set(
                path,
                "user.containers.override_stat",
                xattr_value.as_bytes(),
            ) {
                Ok(_) => {
                    count += 1;
                    if depth < 2 {
                        // Log first few levels for verification
                        tracing::debug!(
                            "Set xattr on {}: {} (mode: {:o})",
                            path.display(),
                            xattr_value,
                            mode
                        );
                    }
                }
                Err(e) => {
                    // Only log at trace level to avoid spam
                    tracing::trace!("Failed to set xattr on {}: {}", path.display(), e);
                }
            }

            // Recurse into directories
            if metadata.is_dir()
                && let Ok(entries) = fs::read_dir(path)
            {
                for entry in entries.filter_map(|e| e.ok()) {
                    count += set_xattr_recursive(&entry.path(), depth + 1)?;
                }
            }

            Ok(count)
        })();

        if needs_access && let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(mode))
        {
            let error = BoxliteError::Storage(format!(
                "Failed to restore permissions on {}: {e}",
                path.display()
            ));
            if result.is_ok() {
                return Err(error);
            }
            tracing::warn!("{error}");
        }
        result
    }

    let count = set_xattr_recursive(rootfs, 0)?;

    tracing::info!("✅ Per-file xattr set for {} files in rootfs", count);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn fix_rootfs_permissions_reads_locked_files() {
        use crate::images::{OverrideFileType, OverrideStat};
        use std::os::unix::fs::PermissionsExt;

        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipping: requires an unprivileged owner");
            return;
        }
        for mode in [0o0000, 0o0111, 0o7111] {
            let temp = TempDir::new().unwrap();
            let file = temp.path().join("locked");
            fs::write(&file, b"secret").unwrap();
            OverrideStat::new(1234, 5678, 0o644, OverrideFileType::File)
                .write_xattr(&file)
                .unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).unwrap();

            let result = fix_rootfs_permissions(temp.path());
            let restored_mode = fs::symlink_metadata(&file).unwrap().permissions().mode() & 0o7777;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
            result.expect("xattr sync must read a locked file without losing its original mode");
            assert_eq!(restored_mode, mode);
            assert_eq!(
                OverrideStat::read_xattr(&file).unwrap().unwrap(),
                OverrideStat::new(1234, 5678, mode, OverrideFileType::File)
            );
        }
    }

    #[test]
    fn fix_rootfs_permissions_restores_nested_modes_on_success_and_error() {
        use crate::images::{OverrideFileType, OverrideStat};
        use std::os::unix::fs::{PermissionsExt, symlink};

        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipping: requires an unprivileged owner");
            return;
        }
        for corrupt in [false, true] {
            let temp = TempDir::new().unwrap();
            let root = temp.path().join("rootfs");
            let directory = root.join("locked");
            let nested = directory.join("nested");
            fs::create_dir_all(&nested).unwrap();
            let file = nested.join("file");
            let alias = root.join("alias");
            fs::write(&file, b"secret").unwrap();
            OverrideStat::new(1234, 5678, 0o644, OverrideFileType::File)
                .write_xattr(&file)
                .unwrap();
            fs::hard_link(&file, &alias).unwrap();
            if corrupt {
                xattr::set(&file, "user.containers.override_stat", b"invalid").unwrap();
            }
            let outside = temp.path().join("outside");
            fs::write(&outside, b"outside").unwrap();
            fs::set_permissions(&outside, fs::Permissions::from_mode(0o000)).unwrap();
            symlink(&outside, root.join("symlink")).unwrap();
            let socket_path = root.join("socket");
            let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
            fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o000)).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o7111)).unwrap();
            fs::set_permissions(&nested, fs::Permissions::from_mode(0o3111)).unwrap();
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o000)).unwrap();

            // Directly target the restricted parent for the error case, ensuring
            // that an xattr error must unwind two temporarily widened directories.
            let result = fix_rootfs_permissions(if corrupt { &directory } else { &root });
            let mode =
                |path: &Path| fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777;
            let directory_mode = mode(&directory);
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
            let nested_mode = mode(&nested);
            fs::set_permissions(&nested, fs::Permissions::from_mode(0o700)).unwrap();
            let file_modes = (mode(&file), mode(&alias));
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();

            assert_eq!((directory_mode, nested_mode), (0o000, 0o3111));
            assert_eq!(file_modes, (0o7111, 0o7111));
            assert_eq!((mode(&outside), mode(&socket_path)), (0o000, 0o000));
            assert_eq!(fs::read(&file).unwrap(), b"secret");
            if corrupt {
                assert!(result.unwrap_err().to_string().contains("malformed"));
                assert_eq!(
                    xattr::get(&file, "user.containers.override_stat")
                        .unwrap()
                        .unwrap(),
                    b"invalid"
                );
            } else {
                result.expect("xattr sync must traverse restrictive directories");
                for path in [&file, &alias] {
                    assert_eq!(
                        OverrideStat::read_xattr(path).unwrap().unwrap(),
                        OverrideStat::new(1234, 5678, 0o7111, OverrideFileType::File)
                    );
                }
                for (path, original_mode) in [(&directory, 0o000), (&nested, 0o3111)] {
                    assert_eq!(
                        OverrideStat::read_xattr(path).unwrap().unwrap().mode,
                        original_mode
                    );
                }
            }
        }
    }

    /// A malformed `override_stat` xattr must abort `fix_rootfs_permissions`,
    /// not be silently overwritten with a fresh 0:0 record.
    ///
    /// Before this fix, `set_xattr_recursive` treated a read `Err` the same
    /// as "no record" — defaulting to 0:0 and then calling `xattr::set` with
    /// that default, permanently destroying the only copy of the file's real
    /// ownership (unprivileged extraction can't `chown`). This is the sibling
    /// of the same bug fixed in `disk::ext4::SourceScan::record_owner` — same
    /// root cause (`OverrideStat::read_xattr`'s `Err` swallowed), reachable
    /// on the extraction-based rootfs path this function serves.
    #[test]
    fn fix_rootfs_permissions_fails_on_malformed_override_stat() {
        const CONTAINERS_OVERRIDE_XATTR: &str = "user.containers.override_stat";

        let temp = TempDir::new().unwrap();
        let dir = temp.path();
        let f = dir.join("file");
        fs::write(&f, b"x").unwrap();
        xattr::set(&f, CONTAINERS_OVERRIDE_XATTR, b"not-a-valid-record")
            .expect("seed malformed xattr");

        let result = fix_rootfs_permissions(dir);
        assert!(
            result.is_err(),
            "a malformed override_stat xattr is the only copy of a file's \
             declared ownership; fix_rootfs_permissions must fail, not \
             silently overwrite it with a fresh 0:0 record"
        );
    }
}
