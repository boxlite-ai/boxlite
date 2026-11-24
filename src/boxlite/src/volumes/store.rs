//! Named-volume metadata type.
//!
//! [`VolumeInfo`] is the storage-agnostic view of a volume returned by the
//! [`VolumeBackend`](crate::runtime::volumes::VolumeBackend) trait and rendered
//! by the CLI. Volumes are addressed by a runtime-assigned id (like boxes).
//! `LocalVolumeStore` persists this metadata beside each volume's payload.

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

    /// Volume name, unique within the owning scope. Mountable in place of the
    /// id, so a box can name the volume it wants without knowing the id. The
    /// server defaults it to the id when the caller supplies none.
    pub name: String,

    /// When the volume was created.
    pub created_at: DateTime<Utc>,

    /// Size of the payload in bytes, if it could be computed.
    pub size_bytes: Option<u64>,
}
