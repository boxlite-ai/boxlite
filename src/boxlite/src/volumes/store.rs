//! Named-volume metadata type.
//!
//! [`VolumeInfo`] is the storage-agnostic view of a volume returned by the
//! [`VolumeBackend`](crate::runtime::volumes::VolumeBackend) trait and rendered
//! by the CLI. Volumes are addressed by a server-assigned id (like boxes). The
//! concrete backend that would populate it is not yet implemented — see
//! `impl VolumeBackend for LocalRuntime`, which currently returns `Unsupported`
//! until a managed volume backend is wired up.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Public metadata about a volume.
///
/// Mirrors the shape of [`crate::runtime::types::ImageInfo`]: a storage-agnostic
/// view suitable for CLI/table rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeInfo {
    /// Server-assigned volume id — the addressing key for get/remove.
    pub id: String,

    /// When the volume was created.
    pub created_at: DateTime<Utc>,

    /// Size of the payload in bytes, if it could be computed.
    pub size_bytes: Option<u64>,
}
