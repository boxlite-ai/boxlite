//! Named-volume metadata type.
//!
//! [`VolumeInfo`] is the storage-agnostic view of a named volume returned by
//! the [`VolumeBackend`](crate::runtime::volumes::VolumeBackend) trait and
//! rendered by the CLI. The concrete backend that would populate it is not yet
//! implemented — see `impl VolumeBackend for LocalRuntime`, which currently
//! returns `Unsupported` until a managed volume backend is wired up.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Public metadata about a named volume.
///
/// Mirrors the shape of [`crate::runtime::types::ImageInfo`]: a storage-agnostic
/// view suitable for CLI/table rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeInfo {
    /// User-facing volume name (a single path segment).
    pub name: String,

    /// Absolute path to the volume's payload directory, when backed by a local
    /// store. This is the mountpoint a future `-v name:path` would bind into
    /// the guest.
    pub mountpoint: PathBuf,

    /// When the volume was created.
    pub created_at: DateTime<Utc>,

    /// Size of the payload in bytes, if it could be computed.
    pub size_bytes: Option<u64>,
}
