//! Named-volume metadata type.
//!
//! [`VolumeInfo`] is the storage-agnostic view of a volume returned by the
//! [`VolumeBackend`](crate::runtime::volumes::VolumeBackend) trait and rendered
//! by the CLI. Volumes are addressed by a server-assigned id (like boxes).
//! Populated by the REST backend (`/v1/volumes`); `impl VolumeBackend for
//! LocalRuntime` still returns `Unsupported` — there's no local volume store.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Lifecycle state of a managed volume, mirroring the API's `VolumeState`
/// enum (`apps/api/src/box/enums/volume-state.enum.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VolumeState {
    Creating,
    Ready,
    PendingCreate,
    PendingDelete,
    Deleting,
    Deleted,
    Error,
}

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

    /// Current lifecycle state. Creation is asynchronous — a freshly created
    /// volume starts at `PendingCreate`/`Creating` and only becomes usable
    /// once it reaches `Ready`; see [`crate::runtime::volumes::VolumeHandle::wait_until_ready`].
    pub state: VolumeState,

    /// Failure detail when `state` is `Error`.
    pub error_reason: Option<String>,
}
