//! Persistent host directory mounts for local Linux x86_64 native boxes.
//!
//! SQLite holds the declarations a box boots with and the last committed
//! progress of its current VM. A running change also coordinates a shim export
//! with a guest mount. Mount operations require the `native-vmm` experimental
//! feature.
//!
//! Only the native engine changes mounts; other builds carry the public types.
#![cfg_attr(
    not(all(feature = "native", target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]

use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use serde::{Deserialize, Serialize};

use crate::runtime::backend::BoxBackend;
#[cfg(all(test, feature = "native", target_os = "linux", target_arch = "x86_64"))]
mod tests;

/// A host directory and its destination in the container.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MountRequest {
    /// Host directory to deliver. A symbolic link is refused at open.
    pub source: PathBuf,
    /// Absolute container path below `/`, without `..`. Missing directories
    /// are created; a path that has entries, or one reached through a symbolic
    /// link, is refused.
    pub target: PathBuf,
    /// Whether the container sees the directory read-only.
    pub read_only: bool,
}

/// Last committed state of a directory mount.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MountState {
    /// Saved for delivery when the box starts.
    Configured,
    /// Reserved for delivery in the current VM run.
    Preparing,
    /// Visible in the container at the target path.
    Mounted,
    /// Removal is incomplete; repeating the removal finishes it.
    Detaching,
}

/// A mount as callers see it. The identities the shim and the guest record stay internal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MountInfo {
    /// Host directory the content comes from.
    pub source: PathBuf,
    /// Container path the directory is visible at.
    pub target: PathBuf,
    /// Whether the container sees the directory read-only.
    pub read_only: bool,
    /// Where the mount is in its lifecycle.
    pub state: MountState,
}

/// Last committed progress of one mount in one VM run.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct MountProgress {
    pub request: MountRequest,
    pub state: MountState,
    /// The request that owns the entry. A step of any other request leaves it alone.
    pub request_id: [u8; 16],
    /// The shim export of a runtime add, once its registration replied.
    pub export: Option<String>,
    /// Whether a start delivered the mount. The guest then recorded it under
    /// `request_id`, and the shim holds no export for it.
    pub delivered_at_start: bool,
}

/// The target as the shim, the guest and the store all spell it: an absolute
/// UTF-8 path of at least one normal component, without `..`.
pub(crate) fn normalize_target(target: &str) -> Option<String> {
    if !target.starts_with('/') || target.contains('\0') {
        return None;
    }
    let mut components = Vec::new();
    for component in Path::new(target).components() {
        match component {
            Component::RootDir | Component::CurDir => (),
            Component::Normal(name) => components.push(name.to_str()?),
            _ => return None,
        }
    }
    (!components.is_empty()).then(|| format!("/{}", components.join("/")))
}

/// A caller's target, checked and normalized.
pub(crate) fn target_key(target: &Path) -> BoxliteResult<String> {
    let target = target.to_str().ok_or_else(|| {
        BoxliteError::InvalidArgument(format!("mount target must be valid UTF-8: {target:?}"))
    })?;
    normalize_target(target).ok_or_else(|| {
        BoxliteError::InvalidArgument(format!(
            "mount target must be an absolute path below `/`, without `..`: {target:?}"
        ))
    })
}

/// Persistent directory mounts of a box, reached through [`LiteBox::mount`](super::LiteBox::mount).
#[derive(Clone)]
pub struct MountHandle {
    backend: Arc<dyn BoxBackend>,
}

impl fmt::Debug for MountHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MountHandle")
            .field("box_id", self.backend.id())
            .finish()
    }
}

impl MountHandle {
    /// Retain the backend without starting it; the backend decides support.
    pub(super) fn new(backend: Arc<dyn BoxBackend>) -> Self {
        Self { backend }
    }

    /// Save a directory declaration. A stopped box returns [`MountState::Configured`].
    /// A running box returns [`MountState::Mounted`] after guest confirmation and commit.
    pub async fn add(&self, request: MountRequest) -> BoxliteResult<MountInfo> {
        self.backend.mount_add(request).await
    }

    /// Remove the declaration at `target`. On a running box the guest detaches the
    /// mount lazily, preserving open descriptors. A missing target returns `NotFound`.
    pub async fn remove(&self, target: impl AsRef<Path>) -> BoxliteResult<()> {
        self.backend.mount_remove(target.as_ref()).await
    }

    /// Read effective declarations and current delivery progress from the store.
    pub async fn list(&self) -> BoxliteResult<Vec<MountInfo>> {
        self.backend.mount_list().await
    }

    /// Read the latest committed entry at `target`, or `None` if it is absent.
    pub async fn get(&self, target: impl AsRef<Path>) -> BoxliteResult<Option<MountInfo>> {
        self.backend.mount_get(target.as_ref()).await
    }
}
