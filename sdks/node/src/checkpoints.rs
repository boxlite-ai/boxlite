//! Managed disk checkpoints for local and REST runtimes.

use std::sync::Arc;

use boxlite::{CheckpointHandle, CheckpointInfo};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::box_handle::JsBox;
use crate::util::map_err;

#[napi(object)]
pub struct JsCheckpointInfo {
    pub id: String,
    pub name: String,
    #[napi(js_name = "sourceBoxId")]
    pub source_box_id: String,
    #[napi(js_name = "createdAt")]
    pub created_at: String,
    #[napi(js_name = "sizeBytes")]
    pub size_bytes: i64,
    pub state: String,
}

impl From<CheckpointInfo> for JsCheckpointInfo {
    fn from(info: CheckpointInfo) -> Self {
        Self {
            id: info.id,
            name: info.name,
            source_box_id: info.source_box_id,
            created_at: info.created_at.to_rfc3339(),
            size_bytes: i64::try_from(info.size_bytes).unwrap_or(i64::MAX),
            state: format!("{:?}", info.state).to_lowercase(),
        }
    }
}

#[napi]
pub struct JsCheckpointHandle {
    pub(crate) handle: Arc<CheckpointHandle>,
}

#[napi]
impl JsCheckpointHandle {
    #[napi]
    pub async fn create(&self, source: String, name: Option<String>) -> Result<JsCheckpointInfo> {
        Ok(self
            .handle
            .create(&source, name)
            .await
            .map_err(map_err)?
            .into())
    }

    #[napi]
    pub async fn list(&self) -> Result<Vec<JsCheckpointInfo>> {
        Ok(self
            .handle
            .list()
            .await
            .map_err(map_err)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    #[napi]
    pub async fn get(&self, key: String) -> Result<JsCheckpointInfo> {
        Ok(self.handle.get(&key).await.map_err(map_err)?.into())
    }

    /// Force ignores absence and never bypasses active use.
    #[napi]
    pub async fn remove(&self, key: String, force: Option<bool>) -> Result<()> {
        self.handle
            .remove(&key, force.unwrap_or(false))
            .await
            .map_err(map_err)
    }

    #[napi]
    pub async fn create_box(&self, key: String, name: Option<String>) -> Result<JsBox> {
        Ok(JsBox {
            handle: Arc::new(self.handle.create_box(&key, name).await.map_err(map_err)?),
        })
    }

    /// Local recovery preserves the name and returns a new native box ID.
    #[napi]
    pub async fn recover_box(&self, key: String, target: String) -> Result<JsBox> {
        Ok(JsBox {
            handle: Arc::new(
                self.handle
                    .recover_box(&key, &target)
                    .await
                    .map_err(map_err)?,
            ),
        })
    }
}
