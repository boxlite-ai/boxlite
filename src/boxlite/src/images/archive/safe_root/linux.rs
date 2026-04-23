//! Linux backend for [`super::SafeRoot`].
//!
//! Wraps [`pathrs::Root`], which routes every operation through
//! `openat2(RESOLVE_IN_ROOT)` on Linux ≥ 5.6 (with an in-library userspace
//! fallback on older kernels). Containment is enforced atomically by the
//! kernel, so there is no TOCTOU window between validation and use.

use super::SpecialInode;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fs::{File, Permissions};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

pub(super) struct Backend {
    root: pathrs::Root,
}

impl Backend {
    pub(super) fn open(root: &Path) -> BoxliteResult<Self> {
        let inner = pathrs::Root::open(root).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to open pathrs root at {}: {}",
                root.display(),
                e
            ))
        })?;
        Ok(Self { root: inner })
    }

    pub(super) fn ensure_dir(&self, rel: &Path) -> BoxliteResult<()> {
        let perms = Permissions::from_mode(0o755);
        self.root.mkdir_all(rel, &perms).map_err(|e| {
            BoxliteError::Storage(format!("mkdir_all failed for {}: {}", rel.display(), e))
        })?;
        Ok(())
    }

    pub(super) fn create_dir(&self, rel: &Path) -> BoxliteResult<()> {
        let perms = Permissions::from_mode(0o755);
        self.root
            .create(rel, &pathrs::InodeType::Directory(perms))
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to create dir {}: {}", rel.display(), e))
            })
    }

    pub(super) fn create_file(&self, rel: &Path, mode: u32) -> BoxliteResult<File> {
        use std::os::unix::io::{FromRawFd, IntoRawFd};
        let perms = Permissions::from_mode(mode);
        let handle = self
            .root
            .create_file(rel, pathrs::flags::OpenFlags::O_WRONLY, &perms)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to create file {}: {}", rel.display(), e))
            })?;
        // Safety: pathrs returns a fresh owned fd; taking ownership here.
        let fd = handle.into_raw_fd();
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(super) fn create_symlink(&self, rel: &Path, target: &Path) -> BoxliteResult<()> {
        self.root
            .create(rel, &pathrs::InodeType::Symlink(target.to_path_buf()))
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create symlink {} -> {}: {}",
                    rel.display(),
                    target.display(),
                    e
                ))
            })
    }

    pub(super) fn create_hardlink(&self, link_rel: &Path, target_rel: &Path) -> BoxliteResult<()> {
        self.root
            .create(
                link_rel,
                &pathrs::InodeType::Hardlink(target_rel.to_path_buf()),
            )
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create hardlink {} -> {}: {}",
                    link_rel.display(),
                    target_rel.display(),
                    e
                ))
            })
    }

    pub(super) fn create_special(
        &self,
        rel: &Path,
        mode: u32,
        kind: SpecialInode,
    ) -> BoxliteResult<()> {
        let perms = Permissions::from_mode(mode);
        let inode = match kind {
            SpecialInode::Fifo => pathrs::InodeType::Fifo(perms),
            SpecialInode::CharDevice { major, minor } => {
                pathrs::InodeType::CharacterDevice(perms, libc::makedev(major as u32, minor as u32))
            }
            SpecialInode::BlockDevice { major, minor } => {
                pathrs::InodeType::BlockDevice(perms, libc::makedev(major as u32, minor as u32))
            }
        };
        self.root.create(rel, &inode).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create special inode {}: {}",
                rel.display(),
                e
            ))
        })
    }
}
