//! Non-Linux backend for [`super::SafeRoot`].
//!
//! Uses plain `std::fs` plus a pre-`create_dir_all` sweep that removes any
//! escape symlink found in the ancestor chain — otherwise the kernel would
//! silently follow such a symlink in the fast path. This is weaker than
//! Linux's `openat2(RESOLVE_IN_ROOT)` against concurrent adversaries but is
//! adequate for boxlite's single-threaded extractor.

use super::SpecialInode;
use super::path::is_symlink_target_safe;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use tracing::warn;

pub(super) struct Backend {
    root: PathBuf,
}

impl Backend {
    pub(super) fn open(root: &Path) -> BoxliteResult<Self> {
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    fn abs(&self, rel: &Path) -> PathBuf {
        self.root.join(rel)
    }

    pub(super) fn ensure_dir(&self, rel: &Path) -> BoxliteResult<()> {
        let parent = self.abs(rel);
        self.scrub_escape_symlinks(&parent)?;

        match fs::create_dir_all(&parent) {
            Ok(_) => return Ok(()),
            Err(e) => match e.raw_os_error() {
                Some(libc::ENOTDIR) => { /* fall through to obstacle removal */ }
                Some(libc::EEXIST) if parent.is_dir() => return Ok(()),
                _ => {
                    return Err(BoxliteError::Storage(format!(
                        "Failed to create dir {}: {}",
                        parent.display(),
                        e
                    )));
                }
            },
        }

        // Slow path: walk up, collect non-directory obstacles, remove them.
        let mut obstacles: Vec<PathBuf> = Vec::new();
        let mut cursor: &Path = &parent;
        while cursor != self.root.as_path() {
            match fs::symlink_metadata(cursor) {
                Ok(m) if m.is_dir() => break,
                Ok(_) => obstacles.push(cursor.to_path_buf()),
                Err(e)
                    if e.kind() == io::ErrorKind::NotFound
                        || e.raw_os_error() == Some(libc::ENOTDIR) => {}
                Err(e) => {
                    return Err(BoxliteError::Storage(format!(
                        "Failed to stat {}: {}",
                        cursor.display(),
                        e
                    )));
                }
            }
            match cursor.parent() {
                Some(p) => cursor = p,
                None => break,
            }
        }
        for obstacle in obstacles.iter().rev() {
            fs::remove_file(obstacle)
                .or_else(|_| fs::remove_dir_all(obstacle))
                .map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to remove obstacle {}: {}",
                        obstacle.display(),
                        e
                    ))
                })?;
        }
        fs::create_dir_all(&parent).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create dir {}: {}", parent.display(), e))
        })
    }

    pub(super) fn create_dir(&self, rel: &Path) -> BoxliteResult<()> {
        let path = self.abs(rel);
        if path.exists() {
            return Ok(());
        }
        fs::create_dir(&path).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create dir {}: {}", path.display(), e))
        })
    }

    pub(super) fn create_file(&self, rel: &Path, mode: u32) -> BoxliteResult<File> {
        let path = self.abs(rel);
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&path)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to create file {}: {}", path.display(), e))
            })
    }

    pub(super) fn create_symlink(&self, rel: &Path, target: &Path) -> BoxliteResult<()> {
        let path = self.abs(rel);
        std::os::unix::fs::symlink(target, &path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create symlink {} -> {}: {}",
                path.display(),
                target.display(),
                e
            ))
        })
    }

    pub(super) fn create_hardlink(&self, link_rel: &Path, target_rel: &Path) -> BoxliteResult<()> {
        let link = self.abs(link_rel);
        let target = self.abs(target_rel);
        fs::hard_link(&target, &link).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create hardlink {} -> {}: {}",
                link.display(),
                target.display(),
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
        let path = self.abs(rel);
        let c_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| BoxliteError::Storage(format!("Path contains NUL: {}", path.display())))?;
        let (kind_bits, dev) = match kind {
            SpecialInode::Fifo => (libc::S_IFIFO, 0 as libc::dev_t),
            SpecialInode::CharDevice { major, minor } => {
                (libc::S_IFCHR, libc::makedev(major, minor))
            }
            SpecialInode::BlockDevice { major, minor } => {
                (libc::S_IFBLK, libc::makedev(major, minor))
            }
        };
        let full_mode = kind_bits | (mode as libc::mode_t & 0o7777);
        let res = unsafe { libc::mknod(c_path.as_ptr(), full_mode, dev) };
        if res == 0 {
            Ok(())
        } else {
            Err(BoxliteError::Storage(format!(
                "Failed to mknod {}: {}",
                path.display(),
                io::Error::last_os_error()
            )))
        }
    }

    /// Walk from root down to `leaf`, removing any ancestor symlink whose
    /// target escapes `root`. Without this, `fs::create_dir_all` silently
    /// follows a symlink-to-dir pointing at the host filesystem.
    fn scrub_escape_symlinks(&self, leaf: &Path) -> BoxliteResult<()> {
        let mut ancestors: Vec<PathBuf> = Vec::new();
        let mut cursor: Option<&Path> = Some(leaf);
        while let Some(c) = cursor {
            if c == self.root.as_path() {
                break;
            }
            ancestors.push(c.to_path_buf());
            cursor = c.parent();
        }
        ancestors.reverse();

        for ancestor in &ancestors {
            let meta = match fs::symlink_metadata(ancestor) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.file_type().is_symlink() {
                continue;
            }
            let link_target = fs::read_link(ancestor).ok();
            let escapes = link_target
                .as_deref()
                .map(|t| {
                    let Ok(rel) = ancestor.strip_prefix(&self.root) else {
                        return true;
                    };
                    !is_symlink_target_safe(&self.root, rel, t)
                })
                .unwrap_or(true);
            if escapes {
                warn!(
                    "Removing escape symlink from extraction ancestry: {} -> {:?}",
                    ancestor.display(),
                    link_target
                );
                fs::remove_file(ancestor).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to remove escape symlink {}: {}",
                        ancestor.display(),
                        e
                    ))
                })?;
                break;
            }
        }
        Ok(())
    }
}
