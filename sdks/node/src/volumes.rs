use std::sync::Arc;

use boxlite::runtime::VolumeHandle;
use boxlite::runtime::types::VolumeInfo;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// Public metadata about a named volume.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsVolumeInfo {
    pub id: String,
    /// Volume name, mountable in place of the id. Defaults to the id.
    pub name: String,
    #[napi(js_name = "createdAt")]
    pub created_at: String,
    #[napi(js_name = "sizeBytes")]
    pub size_bytes: Option<i64>,
}

impl From<&VolumeInfo> for JsVolumeInfo {
    fn from(info: &VolumeInfo) -> Self {
        Self {
            id: info.id.clone(),
            name: info.name.clone(),
            created_at: info.created_at.to_rfc3339(),
            // Saturating cast preserves a stable JS number surface if a future
            // backend ever reports a value beyond signed 64-bit range.
            size_bytes: info
                .size_bytes
                .map(|size| i64::try_from(size).unwrap_or(i64::MAX)),
        }
    }
}

impl From<VolumeInfo> for JsVolumeInfo {
    fn from(info: VolumeInfo) -> Self {
        Self::from(&info)
    }
}

/// Runtime-scoped handle for named-volume operations.
#[napi]
pub struct JsVolumeHandle {
    pub(crate) handle: Arc<VolumeHandle>,
}

#[napi]
impl JsVolumeHandle {
    /// Create a volume and return its metadata.
    ///
    /// `name` is optional and can be mounted in place of the volume's id. The
    /// server names the volume after its id when omitted.
    #[napi]
    pub async fn create(&self, name: Option<String>) -> Result<JsVolumeInfo> {
        let handle = Arc::clone(&self.handle);
        let info = handle.create(name.as_deref()).await.map_err(map_err)?;
        Ok(JsVolumeInfo::from(&info))
    }

    /// List all named volumes for this runtime.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsVolumeInfo>> {
        let handle = Arc::clone(&self.handle);
        let infos = handle.list().await.map_err(map_err)?;
        Ok(infos.into_iter().map(JsVolumeInfo::from).collect())
    }

    /// Get metadata for a single volume by id.
    #[napi]
    pub async fn get(&self, id: String) -> Result<JsVolumeInfo> {
        let handle = Arc::clone(&self.handle);
        let info = handle.get(&id).await.map_err(map_err)?;
        Ok(JsVolumeInfo::from(&info))
    }

    /// Remove a volume by id. With `force`, a missing volume is a no-op.
    #[napi]
    pub async fn remove(&self, id: String, force: Option<bool>) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle
            .remove(&id, force.unwrap_or(false))
            .await
            .map_err(map_err)
    }
}
