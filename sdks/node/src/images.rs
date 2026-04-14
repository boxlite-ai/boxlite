use std::sync::Arc;

use boxlite::ImageHandle;
use boxlite::runtime::types::ImageInfo;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// Public metadata about a cached image.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageInfo {
    pub reference: String,
    pub repository: String,
    pub tag: String,
    pub id: String,
    #[napi(js_name = "cachedAt")]
    pub cached_at: String,
    #[napi(js_name = "sizeBytes")]
    pub size_bytes: Option<i64>,
}

impl From<ImageInfo> for JsImageInfo {
    fn from(info: ImageInfo) -> Self {
        Self {
            reference: info.reference,
            repository: info.repository,
            tag: info.tag,
            id: info.id,
            cached_at: info.cached_at.to_rfc3339(),
            // Saturating cast preserves a stable JS number surface if a future
            // backend ever reports a value beyond signed 64-bit range.
            size_bytes: info
                .size
                .map(|size| i64::try_from(size.as_bytes()).unwrap_or(i64::MAX)),
        }
    }
}

/// Result metadata returned from an image pull operation.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImagePullResult {
    pub reference: String,
    #[napi(js_name = "configDigest")]
    pub config_digest: String,
    #[napi(js_name = "layerCount")]
    pub layer_count: u32,
}

/// Runtime-scoped handle for image operations.
#[napi]
pub struct JsImageHandle {
    pub(crate) handle: Arc<ImageHandle>,
}

#[napi]
impl JsImageHandle {
    /// Pull an image and return metadata about the cached result.
    #[napi]
    pub async fn pull(&self, reference: String) -> Result<JsImagePullResult> {
        let handle = Arc::clone(&self.handle);
        let image = handle.pull(&reference).await.map_err(map_err)?;
        Ok(JsImagePullResult {
            reference: image.reference().to_string(),
            config_digest: image.config_digest().to_string(),
            // Saturating cast keeps the public JS contract stable even if the
            // underlying count type ever grows wider than u32.
            layer_count: u32::try_from(image.layer_count()).unwrap_or(u32::MAX),
        })
    }

    /// List cached images for this runtime.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsImageInfo>> {
        let handle = Arc::clone(&self.handle);
        let infos = handle.list().await.map_err(map_err)?;
        Ok(infos.into_iter().map(JsImageInfo::from).collect())
    }
}
