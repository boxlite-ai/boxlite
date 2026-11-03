//! Persistent memory checkpoints, independent of their source box's lifetime.

pub(crate) mod local;
pub use local::cloud::{
    CloudCheckpointConfiguration, CloudCheckpointImportOptions, CloudCheckpointInspection,
};

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{BoxliteError, BoxliteResult, LiteBox};

/// Public catalog metadata. Host paths and storage credentials are never exposed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointInfo {
    pub id: String,
    pub box_id: String,
    pub name: String,
    pub created_at: i64,
    pub status: String,
    pub error: Option<String>,
    pub cpus: u16,
    pub memory_bytes: u64,
    pub container_disk_bytes: u64,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ImportIdentity {
    pub operation_id: String,
    pub checkpoint_id: String,
    pub digest: String,
}

pub(crate) fn validate_name(name: &str) -> BoxliteResult<()> {
    if name.is_empty()
        || name.len() > 128
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(BoxliteError::InvalidArgument(
            "checkpoint name must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}".into(),
        ));
    }
    Ok(())
}

#[expect(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait CheckpointBackend: Send + Sync {
    async fn create(&self, name: Option<String>) -> BoxliteResult<CheckpointInfo>;
    async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>>;
    async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<CheckpointInfo>>;
    async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()>;
    async fn create_from(&self, id_or_name: &str, name: Option<String>) -> BoxliteResult<LiteBox>;
    async fn export_archive(&self, _id: &str, _path: &std::path::Path) -> BoxliteResult<()> {
        Err(BoxliteError::Unsupported(
            "managed checkpoint archives require a local runtime".into(),
        ))
    }
    async fn import_archive(
        &self,
        _path: &std::path::Path,
        _operation: &str,
    ) -> BoxliteResult<CheckpointInfo> {
        Err(BoxliteError::Unsupported(
            "managed checkpoint archives require a local runtime".into(),
        ))
    }
    async fn create_from_operation(
        &self,
        _id: &str,
        _name: Option<String>,
        _operation: &str,
    ) -> BoxliteResult<LiteBox> {
        Err(BoxliteError::Unsupported(
            "durable native checkpoint import requires a local runtime".into(),
        ))
    }
    async fn import_pair(
        &self,
        _path: &std::path::Path,
        _options: CloudCheckpointImportOptions,
    ) -> BoxliteResult<CheckpointInfo> {
        Err(BoxliteError::Unsupported(
            "cloud pair registration requires a local runtime".into(),
        ))
    }
}

pub(crate) struct UnsupportedCheckpoints;
#[async_trait]
impl CheckpointBackend for UnsupportedCheckpoints {
    async fn create(&self, _: Option<String>) -> BoxliteResult<CheckpointInfo> {
        Err(unsupported())
    }
    async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        Err(unsupported())
    }
    async fn get(&self, _: &str) -> BoxliteResult<Option<CheckpointInfo>> {
        Err(unsupported())
    }
    async fn remove(&self, _: &str, _: bool) -> BoxliteResult<()> {
        Err(unsupported())
    }
    async fn create_from(&self, _: &str, _: Option<String>) -> BoxliteResult<LiteBox> {
        Err(unsupported())
    }
}
fn unsupported() -> BoxliteError {
    BoxliteError::Unsupported("this backend does not support checkpoint management".into())
}

/// Checkpoints captured from one box. An absent scoped lookup returns `None`.
#[derive(Clone)]
pub struct CheckpointHandle {
    pub(crate) backend: Arc<dyn CheckpointBackend>,
}

impl std::fmt::Debug for CheckpointHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CheckpointHandle").finish_non_exhaustive()
    }
}

impl CheckpointHandle {
    pub(crate) fn new(backend: Arc<dyn CheckpointBackend>) -> Self {
        Self { backend }
    }

    /// Capture an explicitly paused box; an omitted name is generated.
    pub async fn create(&self, name: Option<String>) -> BoxliteResult<CheckpointInfo> {
        if let Some(name) = &name {
            validate_name(name)?;
        }
        self.backend.create(name).await
    }
    pub async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        self.backend.list().await
    }
    pub async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<CheckpointInfo>> {
        validate_name(id_or_name)?;
        self.backend.get(id_or_name).await
    }
    /// `force` suppresses only absence, never an in-use or storage failure.
    pub async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        validate_name(id_or_name)?;
        self.backend.remove(id_or_name, force).await
    }
}

/// Runtime/organization catalog, including checkpoints whose source was deleted.
#[derive(Clone, Debug)]
pub struct RuntimeCheckpointHandle(pub(crate) CheckpointHandle);

impl RuntimeCheckpointHandle {
    pub async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        self.0.list().await
    }
    pub async fn get(&self, id_or_name: &str) -> BoxliteResult<CheckpointInfo> {
        self.0
            .get(id_or_name)
            .await?
            .ok_or_else(|| BoxliteError::NotFound(format!("checkpoint '{id_or_name}'")))
    }
    pub async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        self.0.remove(id_or_name, force).await
    }
}
