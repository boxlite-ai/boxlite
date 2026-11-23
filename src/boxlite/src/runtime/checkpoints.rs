//! Managed checkpoint archives, independent of the source box and its snapshots.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::Arc;

use crate::{BoxliteError, BoxliteResult};

/// Contents of a checkpoint archive.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckpointKind {
    /// Disk data only.
    #[default]
    Disk,
    /// Disk data, guest memory, and VM state.
    Full,
    /// An unrecognized kind reported by the server.
    #[serde(other)]
    Unknown,
}

impl CheckpointKind {
    pub fn is_disk(&self) -> bool {
        *self == Self::Disk
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disk => "disk",
            Self::Full => "full",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for CheckpointKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Options for checkpoint creation.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckpointOptions {
    /// Requested archive kind. `None` selects a disk checkpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<CheckpointKind>,
}

/// Metadata for a managed checkpoint and its archive state.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckpointInfo {
    pub id: String,
    pub name: String,
    pub source_box_id: String,
    pub created_at: DateTime<Utc>,
    pub size_bytes: u64,
    #[serde(default)]
    pub state: CheckpointState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    #[serde(default, skip_serializing_if = "CheckpointKind::is_disk")]
    pub kind: CheckpointKind,
    /// Archived guest memory size in bytes, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_size_bytes: Option<u64>,
}

/// Ready means the entire archive is available, including upload on REST.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckpointState {
    Creating,
    #[default]
    Ready,
    Failed,
    Deleting,
}

#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait CheckpointBackend: Send + Sync {
    async fn create(
        &self,
        source: &str,
        name: Option<String>,
        options: CheckpointOptions,
    ) -> BoxliteResult<CheckpointInfo>;
    async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>>;
    async fn get(&self, key: &str) -> BoxliteResult<CheckpointInfo>;
    async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()>;
}

/// Checkpoint management through a REST server. Local runtimes return `Unsupported`.
///
/// Using a checkpoint is a box operation: create a box from one with
/// `RootfsSpec::Checkpoint`.
#[derive(Clone)]
pub struct CheckpointHandle {
    backend: Option<Arc<dyn CheckpointBackend>>,
}

impl fmt::Debug for CheckpointHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CheckpointHandle").finish_non_exhaustive()
    }
}

impl CheckpointHandle {
    pub(crate) fn new(backend: Option<Arc<dyn CheckpointBackend>>) -> Self {
        Self { backend }
    }

    /// Create a disk checkpoint of a stopped source box.
    pub async fn create(
        &self,
        source: &str,
        name: Option<String>,
    ) -> BoxliteResult<CheckpointInfo> {
        self.create_with_options(source, name, CheckpointOptions::default())
            .await
    }

    /// Create a checkpoint with the requested options. REST supports disk capture.
    pub async fn create_with_options(
        &self,
        source: &str,
        name: Option<String>,
        options: CheckpointOptions,
    ) -> BoxliteResult<CheckpointInfo> {
        if source.is_empty() || source.contains('\0') {
            return Err(BoxliteError::InvalidArgument(
                "checkpoint source must be a box ID or name".into(),
            ));
        }
        if let Some(name) = &name {
            checked_name(name)?;
        }
        if options.kind == Some(CheckpointKind::Unknown) {
            return Err(BoxliteError::InvalidArgument(
                "unknown checkpoint kind".into(),
            ));
        }
        self.backend()?.create(source, name, options).await
    }

    pub async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        self.backend()?.list().await
    }

    pub async fn get(&self, key: &str) -> BoxliteResult<CheckpointInfo> {
        checked_name(key)?;
        self.backend()?.get(key).await
    }

    /// Force suppresses absence only, never an in-use or corrupt checkpoint.
    pub async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()> {
        checked_name(key)?;
        self.backend()?.remove(key, force).await
    }

    fn backend(&self) -> BoxliteResult<&dyn CheckpointBackend> {
        self.backend
            .as_deref()
            .ok_or_else(|| BoxliteError::Unsupported(UNSUPPORTED_ON_LOCAL.into()))
    }
}

pub(crate) const UNSUPPORTED_ON_LOCAL: &str = "checkpoints are only implemented for REST runtimes";

pub(crate) fn checked_name(name: &str) -> BoxliteResult<&str> {
    if name.is_empty()
        || name.len() > 128
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(BoxliteError::InvalidArgument(
            "checkpoint name must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}".into(),
        ));
    }
    Ok(name)
}

#[cfg(test)]
mod tests;
