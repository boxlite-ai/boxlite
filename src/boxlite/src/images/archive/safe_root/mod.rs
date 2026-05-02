//! Rooted path resolution for OCI layer extraction.
//!
//! [`SafeRoot`] resolves relative paths within a root directory, re-anchoring
//! absolute symlink targets (like a chroot). Callers use the resolved
//! [`PathBuf`] with standard `std::fs` operations.
//!
//! Matches containerd `fs.RootPath` / umoci `SecureJoinVFS`: resolve once,
//! then use the OS directly. The struct caches the root fd (Linux/pathrs)
//! to avoid reopening per call.

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
use std::fs;
use std::path::{Path, PathBuf};

pub struct SafeRoot {
    root: PathBuf,
    backend: imp::Backend,
}

impl SafeRoot {
    pub fn open(root: &Path) -> BoxliteResult<Self> {
        fs::create_dir_all(root).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create {}: {}", root.display(), e))
        })?;
        Ok(Self {
            root: root.to_path_buf(),
            backend: imp::Backend::open(root)?,
        })
    }

    /// Resolve `rel` within root. ALL symlinks followed (including final)
    /// and absolute targets re-anchored. Matches containerd `fs.RootPath`.
    pub fn resolve(&self, rel: &Path) -> BoxliteResult<PathBuf> {
        let rel = path::normalize_relative(rel).ok_or_else(|| {
            BoxliteError::Storage(format!("Path escapes root: {}", rel.display()))
        })?;
        if rel.as_os_str().is_empty() {
            return Ok(self.root.clone());
        }
        self.backend.resolve(&rel)
    }

    /// Resolve `rel` within root, returning root itself if `rel` is empty.
    pub fn resolve_or_root(&self, rel: &Path) -> BoxliteResult<PathBuf> {
        if rel.as_os_str().is_empty() {
            Ok(self.root.clone())
        } else {
            self.resolve(rel)
        }
    }

    /// Normalize a path for extraction: strip leading `/`, resolve `.`/`..`.
    /// Returns `None` if `..` underflows past root.
    pub fn normalize(path: &Path) -> Option<PathBuf> {
        path::normalize_relative(path)
    }

    pub fn root_path(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests;
