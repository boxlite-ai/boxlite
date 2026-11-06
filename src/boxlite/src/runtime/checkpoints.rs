//! Managed disk archives, independent of the source box and its snapshots.

mod archive;
mod catalog;
mod lifecycle;
mod local;
pub use archive::PreparedCheckpointArchive;
pub(crate) use lifecycle::{Lifecycle, RecoveryLease};
pub(crate) use local::LocalCheckpoints;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::{BoxliteError, BoxliteResult, LiteBox};

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

/// Immutable archive identity supplied by checkpoint storage after download.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CheckpointArchiveSource {
    pub path: PathBuf,
    /// Lowercase SHA-256 hex, optionally prefixed with `sha256:`.
    pub sha256: String,
    pub pinned_image: String,
}

#[expect(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait CheckpointBackend: Send + Sync {
    async fn create(&self, source: &str, name: Option<String>) -> BoxliteResult<CheckpointInfo>;
    async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>>;
    async fn get(&self, key: &str) -> BoxliteResult<CheckpointInfo>;
    async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()>;
    async fn create_box(&self, key: &str, name: Option<String>) -> BoxliteResult<LiteBox>;
    async fn recover_box(&self, key: &str, target: &str) -> BoxliteResult<LiteBox>;

    async fn prepare_archive(
        &self,
        _source: CheckpointArchiveSource,
        _platform_env: Option<BTreeMap<String, String>>,
    ) -> BoxliteResult<PreparedCheckpointArchive> {
        Err(BoxliteError::Unsupported(
            "checkpoint archive preparation requires a local runtime".into(),
        ))
    }
}

/// Runtime-wide checkpoint management for either local storage or a REST server.
#[derive(Clone)]
pub struct CheckpointHandle {
    backend: Arc<dyn CheckpointBackend>,
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

    /// Capture the source box through its existing disk export operation.
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
        self.backend.create(source, name).await
    }

    pub async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        self.backend.list().await
    }

    pub async fn get(&self, key: &str) -> BoxliteResult<CheckpointInfo> {
        checked_name(key)?;
        self.backend.get(key).await
    }

    /// Force suppresses absence only, never an in-use or corrupt checkpoint.
    pub async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()> {
        checked_name(key)?;
        self.backend.remove(key, force).await
    }

    /// Create a stopped local box, or submit the corresponding REST create.
    /// The checkpoint retains its archive and can be used again.
    pub async fn create_box(&self, key: &str, name: Option<String>) -> BoxliteResult<LiteBox> {
        checked_name(key)?;
        self.backend.create_box(key, name).await
    }

    /// Replace an idle box from this checkpoint. Local import preserves the
    /// target name but assigns a new ID; failures retain the checkpoint.
    pub async fn recover_box(&self, key: &str, target: &str) -> BoxliteResult<LiteBox> {
        checked_name(key)?;
        if target.is_empty() || target.contains('\0') {
            return Err(BoxliteError::InvalidArgument(
                "recovery target must be a box ID or name".into(),
            ));
        }
        self.backend.recover_box(key, target).await
    }

    /// Validate an archive and its pinned startup image before replacing a box.
    /// The returned owner keeps a private derived archive alive for ordinary
    /// import. Optional platform metadata may replace only reserved identity
    /// keys; execution settings and other user variables are inherited.
    pub async fn prepare_archive(
        &self,
        source: CheckpointArchiveSource,
        platform_env: Option<BTreeMap<String, String>>,
    ) -> BoxliteResult<PreparedCheckpointArchive> {
        self.backend.prepare_archive(source, platform_env).await
    }
}

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
