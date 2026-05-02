//! Linux: pathrs resolve with walk fallback for non-existent paths.

use super::path;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::os::fd::{AsFd, AsRawFd};
use std::path::{Path, PathBuf};

pub(super) struct Backend {
    root: pathrs::Root,
    root_path: PathBuf,
}

impl Backend {
    pub(super) fn open(root: &Path) -> BoxliteResult<Self> {
        let inner = pathrs::Root::open(root)
            .map_err(|e| BoxliteError::Storage(format!("pathrs open {}: {}", root.display(), e)))?;
        Ok(Self {
            root: inner,
            root_path: root.to_path_buf(),
        })
    }

    pub(super) fn resolve(&self, rel: &Path) -> BoxliteResult<PathBuf> {
        match self.root.resolve(rel) {
            Ok(handle) => {
                let fd = handle.as_fd();
                let proc_path = format!("/proc/self/fd/{}", fd.as_raw_fd());
                std::fs::read_link(&proc_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "readlink /proc/self/fd for {}: {}",
                        rel.display(),
                        e
                    ))
                })
            }
            Err(e)
                if e.kind() == pathrs::error::ErrorKind::OsError(Some(libc::ENOENT))
                    || e.kind() == pathrs::error::ErrorKind::OsError(Some(libc::ENOTDIR)) =>
            {
                // Path doesn't fully exist — fall back to walk algorithm.
                path::resolve_walk(&self.root_path, rel)
            }
            Err(e) => Err(BoxliteError::Storage(format!(
                "pathrs resolve {}: {}",
                rel.display(),
                e
            ))),
        }
    }
}
