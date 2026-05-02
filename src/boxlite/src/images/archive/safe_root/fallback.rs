//! Non-Linux: delegates to the shared walk algorithm.

use super::path;
use boxlite_shared::errors::BoxliteResult;
use std::path::{Path, PathBuf};

pub(super) struct Backend {
    root: PathBuf,
}

impl Backend {
    pub(super) fn open(root: &Path) -> BoxliteResult<Self> {
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    pub(super) fn resolve(&self, rel: &Path) -> BoxliteResult<PathBuf> {
        path::resolve_walk(&self.root, rel)
    }
}
