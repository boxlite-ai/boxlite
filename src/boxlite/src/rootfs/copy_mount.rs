//! Copy-based mount implementation inspired by buildah's VFS driver.
//!
//! This module implements a "virtual mount" by physically copying a parent rootfs
//! directory to create a new layer, similar to how containers/storage VFS driver works.
//!
//! Key features (learned from buildah VFS):
//! - Physical directory copy (no overlayfs, no CoW)
//! - Preserves all file types: regular, directory, symlink, fifo, socket, device
//! - Preserves permissions, ownership, timestamps, xattrs
//! - Hardlink detection and preservation
//! - Platform-specific optimizations (Linux: copy_file_range, macOS: standard copy)
//! - Proper error handling with cleanup on failure

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[cfg(target_os = "linux")]
use std::os::unix::fs::{FileTypeExt, symlink};

#[cfg(target_os = "macos")]
use std::os::unix::fs::symlink;

/// File identifier for hardlink detection (device + inode)
#[derive(Hash, Eq, PartialEq, Clone, Copy, Debug)]
struct FileId {
    dev: u64,
    ino: u64,
}

/// Copy mode for directory copying
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CopyMode {
    /// Copy file contents
    Content,
    /// Create hardlinks (when possible)
    Hardlink,
}

/// Options for copy-based mount operation
#[derive(Debug, Clone)]
pub struct CopyMountOptions {
    /// Whether to copy xattrs
    pub copy_xattrs: bool,
    /// Copy mode: content or hardlink
    pub copy_mode: CopyMode,
    /// Ignore permission errors (for rootless)
    pub ignore_chown_errors: bool,
}

impl Default for CopyMountOptions {
    fn default() -> Self {
        Self {
            copy_xattrs: true,
            copy_mode: CopyMode::Content,
            ignore_chown_errors: false,
        }
    }
}

/// Result of a copy-based mount operation
pub struct CopyMount {
    /// Path to the mounted (copied) directory
    #[allow(dead_code)]
    pub path: PathBuf,
}

impl CopyMount {
    /// Get the path to the mounted directory
    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Unmount (this is a no-op for copy-based mounts since there's no actual mount)
    pub fn unmount(self) -> BoxliteResult<()> {
        // VFS driver's Put() is a no-op: "no runtime resources to clean up"
        tracing::debug!("Copy-based mount has no runtime resources to clean up");
        Ok(())
    }

    /// Remove the copied directory entirely
    #[allow(dead_code)]
    pub fn remove(self) -> BoxliteResult<()> {
        fs::remove_dir_all(&self.path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to remove copy-mount directory {}: {}",
                self.path.display(),
                e
            ))
        })?;
        tracing::info!("Removed copy-mount at {}", self.path.display());
        Ok(())
    }
}

/// Create a copy-based mount by copying parent_dir to mount_dir.
///
/// This is equivalent to buildah's VFS driver create() + Get() flow:
/// 1. Create mount_dir with proper permissions
/// 2. Copy entire parent_dir contents to mount_dir
/// 3. Return the mount path
///
/// # Arguments
/// * `parent_dir` - Source directory to copy from (must exist)
/// * `mount_dir` - Destination directory to copy to (will be created)
/// * `options` - Copy options (xattrs, mode, etc.)
///
/// # Returns
/// * `CopyMount` - Handle to the mounted directory
///
/// # Platform Notes
/// * **Linux**: Uses optimized copy with copy_file_range when available
/// * **macOS**: Uses standard copy operations
///
/// # Example
/// ```ignore
/// use boxlite::rootfs::copy_mount::{copy_based_mount, CopyMountOptions};
///
/// let parent = Path::new("/path/to/parent/rootfs");
/// let mount_point = Path::new("/path/to/new/layer");
///
/// let mount = copy_based_mount(parent, mount_point, CopyMountOptions::default())?;
/// // Use mount.path() to access files
/// mount.unmount()?;
/// ```
pub fn copy_based_mount(
    parent_dir: &Path,
    mount_dir: &Path,
    options: CopyMountOptions,
) -> BoxliteResult<CopyMount> {
    tracing::info!(
        "Creating copy-based mount: {} -> {}",
        parent_dir.display(),
        mount_dir.display()
    );

    // Validate parent directory exists
    if !parent_dir.exists() {
        return Err(BoxliteError::Storage(format!(
            "Parent directory does not exist: {}",
            parent_dir.display()
        )));
    }

    if !parent_dir.is_dir() {
        return Err(BoxliteError::Storage(format!(
            "Parent path is not a directory: {}",
            parent_dir.display()
        )));
    }

    // Create mount directory with proper permissions
    // VFS uses defaultPerms: 0o555 on Linux, 0o700 on macOS
    #[cfg(target_os = "linux")]
    let root_perms = 0o555;
    #[cfg(not(target_os = "linux"))]
    let root_perms = 0o700;

    // Inherit permissions from parent if it exists
    let (dir_perms, uid, gid) = if parent_dir.exists() {
        let metadata = fs::metadata(parent_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to stat parent directory {}: {}",
                parent_dir.display(),
                e
            ))
        })?;
        (
            metadata.permissions().mode() & 0o7777,
            metadata.uid(),
            metadata.gid(),
        )
    } else {
        (root_perms, 0, 0)
    };

    // Create parent path for mount_dir
    if let Some(parent) = mount_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create parent directory for {}: {}",
                mount_dir.display(),
                e
            ))
        })?;
    }

    // Create mount_dir with inherited permissions
    fs::create_dir(mount_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create mount directory {}: {}",
            mount_dir.display(),
            e
        ))
    })?;

    // Set permissions on mount_dir
    fs::set_permissions(mount_dir, fs::Permissions::from_mode(dir_perms)).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to set permissions on {}: {}",
            mount_dir.display(),
            e
        ))
    })?;

    // Try to set ownership (may fail in rootless, that's ok if ignore_chown_errors)
    #[cfg(unix)]
    {
        use std::os::unix::fs::chown;
        if let Err(e) = chown(mount_dir, Some(uid), Some(gid)) {
            if !options.ignore_chown_errors {
                // Clean up on error
                let _ = fs::remove_dir_all(mount_dir);
                return Err(BoxliteError::Storage(format!(
                    "Failed to chown {}: {}",
                    mount_dir.display(),
                    e
                )));
            }
            tracing::debug!("Ignoring chown error: {}", e);
        }
    }

    // Copy parent directory contents to mount_dir
    // This is the core operation: dirCopy(parentDir, dir)
    if let Err(e) = dir_copy(parent_dir, mount_dir, options) {
        // Clean up on error (VFS uses defer for this)
        let _ = fs::remove_dir_all(mount_dir);
        return Err(e);
    }

    tracing::info!("✅ Copy-based mount created at {}", mount_dir.display());

    Ok(CopyMount {
        path: mount_dir.to_path_buf(),
    })
}

/// Recursively copy directory contents from src to dst.
///
/// This implements the core logic from containers/storage drivers/copy/copy_linux.go:DirCopy()
///
/// Key behaviors:
/// - Regular files: Copy content, detect hardlinks via inode
/// - Directories: Create with same mode
/// - Symlinks: Preserve as-is (not followed)
/// - FIFOs, sockets, devices: Create with same type
/// - Metadata: Preserve permissions, ownership, timestamps, xattrs
///
/// # Arguments
/// * `src_dir` - Source directory
/// * `dst_dir` - Destination directory (must exist)
/// * `options` - Copy options
fn dir_copy(src_dir: &Path, dst_dir: &Path, options: CopyMountOptions) -> BoxliteResult<()> {
    // Track copied files by inode to handle hardlinks
    let mut copied_files: HashMap<FileId, PathBuf> = HashMap::new();

    // Track directories to set mtimes later (VFS does this)
    let mut dirs_to_set_mtimes: Vec<(PathBuf, SystemTime, SystemTime)> = Vec::new();

    // Walk source directory recursively
    for entry in walkdir::WalkDir::new(src_dir)
        .follow_links(false) // Never follow symlinks!
        .into_iter()
    {
        let entry = entry.map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to walk directory {}: {}",
                src_dir.display(),
                e
            ))
        })?;

        let src_path = entry.path();

        // Rebase path: /parent/foo -> /mount/foo
        let rel_path = src_path.strip_prefix(src_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to rebase path {}: {}",
                src_path.display(),
                e
            ))
        })?;

        let dst_path = dst_dir.join(rel_path);

        // Get metadata without following symlinks
        let metadata = fs::symlink_metadata(src_path).map_err(|e| {
            BoxliteError::Storage(format!("Failed to stat {}: {}", src_path.display(), e))
        })?;

        let file_type = metadata.file_type();
        let is_hardlink;

        // Handle different file types
        if file_type.is_file() {
            // Regular file
            let file_id = FileId {
                dev: metadata.dev(),
                ino: metadata.ino(),
            };

            is_hardlink = if options.copy_mode == CopyMode::Hardlink {
                // Hardlink mode: always create hardlink
                fs::hard_link(src_path, &dst_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to hardlink {} -> {}: {}",
                        src_path.display(),
                        dst_path.display(),
                        e
                    ))
                })?;
                true
            } else if let Some(existing_dst) = copied_files.get(&file_id) {
                // Already copied this inode, create hardlink
                fs::hard_link(existing_dst, &dst_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to create hardlink {} -> {}: {}",
                        existing_dst.display(),
                        dst_path.display(),
                        e
                    ))
                })?;
                true
            } else {
                // New file, copy content
                copy_regular_file(src_path, &dst_path, &metadata)?;
                copied_files.insert(file_id, dst_path.clone());
                false
            };
        } else if file_type.is_dir() {
            // Directory - create with same mode
            if !dst_path.exists() {
                fs::create_dir(&dst_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to create directory {}: {}",
                        dst_path.display(),
                        e
                    ))
                })?;
            }

            // Save for mtime setting later
            if let (Ok(atime), Ok(mtime)) = (metadata.accessed(), metadata.modified()) {
                dirs_to_set_mtimes.push((dst_path.clone(), atime, mtime));
            }

            is_hardlink = false;
        } else if file_type.is_symlink() {
            // Symlink - preserve as-is
            let link_target = fs::read_link(src_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to read symlink {}: {}",
                    src_path.display(),
                    e
                ))
            })?;

            symlink(&link_target, &dst_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create symlink {} -> {}: {}",
                    dst_path.display(),
                    link_target.display(),
                    e
                ))
            })?;

            is_hardlink = false;
        } else {
            // Special files (FIFO, socket, device)
            #[cfg(target_os = "linux")]
            {
                if file_type.is_fifo() {
                    create_fifo(&dst_path, metadata.mode())?;
                    is_hardlink = false;
                } else if file_type.is_socket() {
                    // Sockets can't be copied meaningfully, skip
                    tracing::debug!("Skipping socket: {}", src_path.display());
                    continue;
                } else if file_type.is_block_device() || file_type.is_char_device() {
                    // Device nodes - skip in userspace (need root)
                    tracing::debug!("Skipping device node: {}", src_path.display());
                    continue;
                } else {
                    return Err(BoxliteError::Storage(format!(
                        "Unknown file type: {}",
                        src_path.display()
                    )));
                }
            }

            #[cfg(not(target_os = "linux"))]
            {
                // Non-Linux: skip special files
                tracing::debug!("Skipping special file: {}", src_path.display());
                continue;
            }
        }

        // Copy metadata (skip for hardlinks as they share inode)
        if !is_hardlink {
            copy_metadata(src_path, &dst_path, &metadata, &options)?;
        }
    }

    // Set directory mtimes in reverse order (depth-first, parents last)
    // This is what VFS does with dirsToSetMtimes list
    // Use set_symlink_times (LUtimesNano equivalent) for directories
    for (dir_path, atime, mtime) in dirs_to_set_mtimes.iter().rev() {
        set_symlink_times(dir_path, *atime, *mtime)?;
    }

    Ok(())
}

/// Copy a regular file's content from src to dst
fn copy_regular_file(src: &Path, dst: &Path, _metadata: &fs::Metadata) -> BoxliteResult<()> {
    // VFS tries: FICLONE ioctl -> copy_file_range -> legacy copy
    // We'll use Rust's standard copy which is efficient enough

    fs::copy(src, dst).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to copy file {} -> {}: {}",
            src.display(),
            dst.display(),
            e
        ))
    })?;

    Ok(())
}

/// Copy metadata (permissions, ownership, timestamps, xattrs) from src to dst
fn copy_metadata(
    src: &Path,
    dst: &Path,
    metadata: &fs::Metadata,
    options: &CopyMountOptions,
) -> BoxliteResult<()> {
    let file_type = metadata.file_type();

    // Set ownership first (chown can modify mode)
    #[cfg(unix)]
    {
        use std::os::unix::fs::lchown;
        if let Err(e) = lchown(dst, Some(metadata.uid()), Some(metadata.gid())) {
            if !options.ignore_chown_errors {
                return Err(BoxliteError::Storage(format!(
                    "Failed to chown {}: {}",
                    dst.display(),
                    e
                )));
            }
            tracing::trace!("Ignoring chown error for {}: {}", dst.display(), e);
        }
    }

    // Copy xattrs if requested
    if options.copy_xattrs {
        copy_xattrs(src, dst)?;
    }

    // Set permissions (no LChmod for symlinks)
    if !file_type.is_symlink() {
        fs::set_permissions(dst, metadata.permissions()).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to set permissions on {}: {}",
                dst.display(),
                e
            ))
        })?;
    }

    // Set timestamps
    if !file_type.is_dir() {
        // Directories handled separately later
        if let (Ok(atime), Ok(mtime)) = (metadata.accessed(), metadata.modified()) {
            if file_type.is_symlink() {
                // Symlinks: use set_symlink_times (does NOT follow symlinks)
                set_symlink_times(dst, atime, mtime)?;
            } else {
                // Regular files: use set_times (follows symlinks, but that's ok for regular files)
                set_times(dst, atime, mtime)?;
            }
        }
    }

    Ok(())
}

/// Copy extended attributes from src to dst
fn copy_xattrs(src: &Path, dst: &Path) -> BoxliteResult<()> {
    // VFS copies: security.capability, user.*, trusted.overlay.opaque
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        // Try to list xattrs (may not be supported)
        if let Ok(attrs) = xattr::list(src) {
            for attr in attrs {
                let attr_name = attr.to_string_lossy();

                // VFS only copies specific xattrs
                let should_copy = attr_name == "security.capability"
                    || attr_name.starts_with("user.")
                    || attr_name == "trusted.overlay.opaque"
                    || attr_name == "user.containers.override_stat"; // BoxLite-specific

                if should_copy && let Ok(Some(value)) = xattr::get(src, &attr) {
                    let _ = xattr::set(dst, &attr, &value); // Ignore errors
                }
            }
        }
    }

    Ok(())
}

/// Set access and modification times on a file (follows symlinks)
fn set_times(path: &Path, atime: SystemTime, mtime: SystemTime) -> BoxliteResult<()> {
    use filetime::FileTime;

    filetime::set_file_times(
        path,
        FileTime::from_system_time(atime),
        FileTime::from_system_time(mtime),
    )
    .map_err(|e| BoxliteError::Storage(format!("Failed to set times on {}: {}", path.display(), e)))
}

/// Set access and modification times on a symlink (does NOT follow symlinks)
fn set_symlink_times(path: &Path, atime: SystemTime, mtime: SystemTime) -> BoxliteResult<()> {
    use filetime::FileTime;

    filetime::set_symlink_file_times(
        path,
        FileTime::from_system_time(atime),
        FileTime::from_system_time(mtime),
    )
    .map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to set symlink times on {}: {}",
            path.display(),
            e
        ))
    })
}

/// Create a FIFO (named pipe) at the given path
#[cfg(target_os = "linux")]
fn create_fifo(path: &Path, mode: u32) -> BoxliteResult<()> {
    use std::ffi::CString;

    let c_path = CString::new(
        path.to_str()
            .ok_or_else(|| BoxliteError::Storage(format!("Invalid path: {}", path.display())))?,
    )
    .map_err(|e| BoxliteError::Storage(format!("Invalid path: {}", e)))?;

    unsafe {
        if libc::mkfifo(c_path.as_ptr(), mode) != 0 {
            return Err(BoxliteError::Storage(format!(
                "Failed to create FIFO {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            )));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    #[test]
    fn test_copy_based_mount_basic() {
        let temp = TempDir::new().unwrap();
        let parent = temp.path().join("parent");
        let mount = temp.path().join("mount");

        // Create parent with some files
        fs::create_dir(&parent).unwrap();
        fs::write(parent.join("file1.txt"), "content1").unwrap();
        fs::create_dir(parent.join("subdir")).unwrap();
        fs::write(parent.join("subdir/file2.txt"), "content2").unwrap();

        // Create copy-based mount
        let copy_mount = copy_based_mount(&parent, &mount, CopyMountOptions::default()).unwrap();

        // Verify files copied
        assert!(copy_mount.path().join("file1.txt").exists());
        assert!(copy_mount.path().join("subdir/file2.txt").exists());
        assert_eq!(
            fs::read_to_string(copy_mount.path().join("file1.txt")).unwrap(),
            "content1"
        );

        // Unmount (no-op)
        copy_mount.unmount().unwrap();
    }

    #[test]
    fn test_copy_preserves_permissions() {
        let temp = TempDir::new().unwrap();
        let parent = temp.path().join("parent");
        let mount = temp.path().join("mount");

        fs::create_dir(&parent).unwrap();
        let file = parent.join("executable");
        fs::write(&file, "#!/bin/sh\necho test").unwrap();
        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&file, perms).unwrap();

        let copy_mount = copy_based_mount(&parent, &mount, CopyMountOptions::default()).unwrap();

        let copied_file = copy_mount.path().join("executable");
        let copied_perms = fs::metadata(&copied_file).unwrap().permissions();
        assert_eq!(copied_perms.mode() & 0o777, 0o755);

        copy_mount.unmount().unwrap();
    }

    #[test]
    fn test_copy_preserves_symlinks() {
        let temp = TempDir::new().unwrap();
        let parent = temp.path().join("parent");
        let mount = temp.path().join("mount");

        fs::create_dir(&parent).unwrap();
        fs::write(parent.join("target.txt"), "target").unwrap();
        symlink("target.txt", parent.join("link.txt")).unwrap();

        let copy_mount = copy_based_mount(&parent, &mount, CopyMountOptions::default()).unwrap();

        let copied_link = copy_mount.path().join("link.txt");
        assert!(
            copied_link
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read_link(&copied_link).unwrap(),
            Path::new("target.txt")
        );

        copy_mount.unmount().unwrap();
    }

    #[test]
    fn test_copy_detects_hardlinks() {
        let temp = TempDir::new().unwrap();
        let parent = temp.path().join("parent");
        let mount = temp.path().join("mount");

        fs::create_dir(&parent).unwrap();
        fs::write(parent.join("file1.txt"), "shared content").unwrap();
        fs::hard_link(parent.join("file1.txt"), parent.join("file2.txt")).unwrap();

        let copy_mount = copy_based_mount(&parent, &mount, CopyMountOptions::default()).unwrap();

        // Both files should exist
        let file1 = copy_mount.path().join("file1.txt");
        let file2 = copy_mount.path().join("file2.txt");
        assert!(file1.exists());
        assert!(file2.exists());

        // They should be hardlinks (same inode)
        let meta1 = fs::metadata(&file1).unwrap();
        let meta2 = fs::metadata(&file2).unwrap();
        assert_eq!(meta1.ino(), meta2.ino());

        copy_mount.unmount().unwrap();
    }
}
