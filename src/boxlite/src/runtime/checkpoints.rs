//! Managed disk archives, independent of the source box and its snapshots.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{BoxliteError, BoxliteResult};

/// Metadata for a checkpoint whose complete archive has been published.
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
    async fn create(&self, source: &str, name: Option<String>) -> BoxliteResult<CheckpointInfo>;
    async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>>;
    async fn get(&self, key: &str) -> BoxliteResult<CheckpointInfo>;
    async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()>;
}

/// Checkpoint management through a REST server; local runtimes return Unsupported.
///
/// Using a checkpoint is a box operation: create a box from one with
/// `RootfsSpec::Checkpoint`.
#[derive(Clone)]
pub struct CheckpointHandle {
    backend: Option<Arc<dyn CheckpointBackend>>,
}

impl std::fmt::Debug for CheckpointHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CheckpointHandle").finish_non_exhaustive()
    }
}

impl CheckpointHandle {
    pub(crate) fn new(backend: Option<Arc<dyn CheckpointBackend>>) -> Self {
        Self { backend }
    }

    /// Ask the REST server to capture a stopped source box.
    pub async fn create(
        &self,
        source: &str,
        name: Option<String>,
    ) -> BoxliteResult<CheckpointInfo> {
        if source.is_empty() || source.contains('\0') {
            return Err(BoxliteError::InvalidArgument(
                "checkpoint source must be a box ID or name".into(),
            ));
        }
        if let Some(name) = &name {
            checked_name(name)?;
        }
        self.backend()?.create(source, name).await
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
