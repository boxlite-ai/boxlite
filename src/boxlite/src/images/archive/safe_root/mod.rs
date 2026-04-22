//! Safe, containment-enforced filesystem operations for OCI layer extraction.
//!
//! All destructive filesystem work during layer extraction goes through
//! [`SafeRoot`]. It guarantees that no operation — symlink creation,
//! directory creation, file write, hardlink, device node — can escape the
//! extraction root, even when a tar entry was crafted by an attacker to trick
//! the kernel into following a symlink out to the host filesystem (CWE-22,
//! GHSA-f396-4rp4-7v2j).
//!
//! # Module layout
//!
//! * [`path`] — pure lexical helpers (no filesystem I/O).
//! * [`linux`] — Linux backend wrapping [`pathrs::Root`]
//!   (`openat2(RESOLVE_IN_ROOT)`). Kernel-atomic containment.
//! * [`fallback`] — non-Linux backend. Lexical checks plus an ancestor
//!   symlink scrub before `create_dir_all`.
//! * [`mod@self`] — [`SafeRoot`] public API + the policy layer that sits
//!   above the backends (validation before delegation).

mod path;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as imp;

#[cfg(not(target_os = "linux"))]
mod fallback;
#[cfg(not(target_os = "linux"))]
use fallback as imp;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use tar::EntryType;
use tracing::trace;

/// Kinds of special inodes [`SafeRoot`] can create.
#[derive(Debug, Clone, Copy)]
pub enum SpecialInode {
    /// FIFO / named pipe.
    Fifo,
    /// Character device `(major, minor)`.
    CharDevice {
        major: libc::dev_t,
        minor: libc::dev_t,
    },
    /// Block device `(major, minor)`.
    BlockDevice {
        major: libc::dev_t,
        minor: libc::dev_t,
    },
}

/// Translate a tar entry type into the matching [`SpecialInode`] variant,
/// if any.
pub fn special_from_entry(
    entry_type: EntryType,
    major: libc::dev_t,
    minor: libc::dev_t,
) -> Option<SpecialInode> {
    match entry_type {
        EntryType::Fifo => Some(SpecialInode::Fifo),
        EntryType::Char => Some(SpecialInode::CharDevice { major, minor }),
        EntryType::Block => Some(SpecialInode::BlockDevice { major, minor }),
        _ => None,
    }
}

/// Anchored root for containment-checked filesystem operations.
///
/// Created via [`SafeRoot::open`]; all subsequent ops take paths *relative*
/// to the root and are guaranteed to stay inside it.
pub struct SafeRoot {
    root: PathBuf,
    backend: imp::Backend,
}

impl SafeRoot {
    /// Open a root directory for safe extraction, creating it (recursively)
    /// if it doesn't already exist.
    pub fn open(root: &Path) -> BoxliteResult<Self> {
        fs::create_dir_all(root).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create destination directory {}: {}",
                root.display(),
                e
            ))
        })?;
        Ok(Self {
            root: root.to_path_buf(),
            backend: imp::Backend::open(root)?,
        })
    }

    /// The extraction root directory this handle was opened on.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Absolute on-disk path for an in-root relative path.
    ///
    /// Escape hatch for ops that have no fd-based equivalent in SafeRoot yet
    /// (chown, xattr, utimensat). Because the path is built under `root` and
    /// the relative part has been normalized, the *lexical* path is safe —
    /// callers still shouldn't follow it through symlinks.
    pub fn full_path(&self, rel: &Path) -> BoxliteResult<PathBuf> {
        let rel = path::normalize_relative(rel).ok_or_else(|| {
            BoxliteError::Storage(format!("Path escapes extraction root: {}", rel.display()))
        })?;
        Ok(self.root.join(rel))
    }

    /// `true` iff `rel` exists (without following a trailing symlink).
    pub fn exists_nofollow(&self, rel: &Path) -> bool {
        let Ok(abs) = self.full_path(rel) else {
            return false;
        };
        fs::symlink_metadata(&abs).is_ok()
    }

    /// Whether a symlink at `rel` pointing at `target` would stay inside the
    /// extraction root. Intended for callers that need to reject unsafe
    /// entries *before* any destructive operation runs (e.g. the tar
    /// extractor's early symlink check).
    pub fn is_symlink_target_safe(&self, rel: &Path, target: &Path) -> bool {
        path::is_symlink_target_safe(&self.root, rel, target)
    }

    /// Ensure all ancestor directories of `rel` exist, replacing any
    /// non-directory or escape-symlink obstacles with real directories.
    pub fn ensure_parent(&self, rel: &Path) -> BoxliteResult<()> {
        let rel = path::normalize_relative(rel).ok_or_else(|| {
            BoxliteError::Storage(format!("Path escapes extraction root: {}", rel.display()))
        })?;
        let Some(parent) = rel.parent() else {
            return Ok(());
        };
        if parent.as_os_str().is_empty() {
            return Ok(());
        }
        self.backend.ensure_dir(parent)
    }

    /// Create a single directory. Parents must already exist.
    pub fn create_dir(&self, rel: &Path) -> BoxliteResult<()> {
        self.backend.create_dir(rel)
    }

    /// Create (or truncate) a regular file with mode `mode`, returning a
    /// writable [`File`]. Writes through the handle are guaranteed to land
    /// under `root`.
    pub fn create_file(&self, rel: &Path, mode: u32) -> BoxliteResult<File> {
        self.backend.create_file(rel, mode)
    }

    /// Create a symlink at `rel` pointing at `target`. Rejects with an error
    /// if the target would escape the extraction root.
    pub fn create_symlink(&self, rel: &Path, target: &Path) -> BoxliteResult<()> {
        if !self.is_symlink_target_safe(rel, target) {
            return Err(BoxliteError::Storage(format!(
                "Refusing unsafe symlink {} -> {}: target escapes extraction root",
                rel.display(),
                target.display()
            )));
        }
        self.backend.create_symlink(rel, target)
    }

    /// Create a hardlink at `link_rel` pointing at the existing in-root entry
    /// at `target_rel`. Rejects with an error if either path would escape
    /// containment via `..` underflow — the fallback backend joins these
    /// lexically, so the kernel would otherwise follow them out of root.
    pub fn create_hardlink(&self, link_rel: &Path, target_rel: &Path) -> BoxliteResult<()> {
        let link_rel = path::normalize_relative(link_rel).ok_or_else(|| {
            BoxliteError::Storage(format!(
                "Hardlink link path escapes extraction root: {}",
                link_rel.display()
            ))
        })?;
        let target_rel = path::normalize_relative(target_rel).ok_or_else(|| {
            BoxliteError::Storage(format!(
                "Hardlink target escapes extraction root: {}",
                target_rel.display()
            ))
        })?;
        self.backend.create_hardlink(&link_rel, &target_rel)
    }

    /// Create a special inode (FIFO, character device, block device).
    /// Device nodes silently succeed with no-op when not running as root.
    pub fn create_special(
        &self,
        rel: &Path,
        mode: u32,
        kind: SpecialInode,
        is_root: bool,
    ) -> BoxliteResult<()> {
        if matches!(
            kind,
            SpecialInode::CharDevice { .. } | SpecialInode::BlockDevice { .. }
        ) && !is_root
        {
            trace!("Skipping device node {} (requires root)", rel.display());
            return Ok(());
        }
        self.backend.create_special(rel, mode, kind)
    }

    /// Remove whatever is at `rel` if it exists, without following a
    /// trailing symlink. No-op if `rel` is already a directory and
    /// `keep_if_dir` is true (used when a layer merges into an existing
    /// directory tree).
    pub fn remove_nofollow(&self, rel: &Path, keep_if_dir: bool) -> BoxliteResult<()> {
        let path = self.full_path(rel)?;
        match fs::symlink_metadata(&path) {
            Ok(meta) => {
                if keep_if_dir && meta.is_dir() && !meta.file_type().is_symlink() {
                    return Ok(());
                }
                fs::remove_file(&path)
                    .or_else(|_| fs::remove_dir_all(&path))
                    .map_err(|e| {
                        BoxliteError::Storage(format!(
                            "Failed to remove existing path {}: {}",
                            path.display(),
                            e
                        ))
                    })
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(BoxliteError::Storage(format!(
                "Failed to stat {}: {}",
                path.display(),
                e
            ))),
        }
    }
}

#[cfg(test)]
mod tests;
