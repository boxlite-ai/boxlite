use std::sync::Arc;

use boxlite::ImageHandle;
use boxlite::runtime::types::{ImageDetail, ImageInfo, ImageUsage, ImageVersion};
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
            size_bytes: info.size.map(|size| js_number(size.as_bytes())),
        }
    }
}

/// A count or byte size as the i64 napi hands JS as a number.
///
/// Saturating keeps the JS number surface stable if a backend ever reports a
/// value beyond signed 64-bit range.
fn js_number(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
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

/// One build of an image.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageVersion {
    /// Manifest digest, such as "sha256:…".
    pub digest: String,
    /// Sum of the layer sizes the manifest declares; absent when unknown.
    #[napi(js_name = "sizeBytes")]
    pub size_bytes: Option<i64>,
    /// The reference that was pulled to get this build.
    #[napi(js_name = "sourceRef")]
    pub source_ref: String,
    /// When this build was recorded, as an RFC 3339 string.
    #[napi(js_name = "recordedAt")]
    pub recorded_at: String,
}

impl From<ImageVersion> for JsImageVersion {
    fn from(version: ImageVersion) -> Self {
        Self {
            digest: version.digest,
            size_bytes: version.size_bytes.map(js_number),
            source_ref: version.source_ref,
            recorded_at: version.recorded_at.to_rfc3339(),
        }
    }
}

/// An image name and every build the runtime holds under it.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageDetail {
    /// Registry and repository without a tag, such as "docker.io/library/alpine".
    pub name: String,
    pub tags: Vec<String>,
    /// Provided by the server's operator rather than pulled by a box.
    pub curated: bool,
    /// Newest first.
    pub versions: Vec<JsImageVersion>,
}

impl From<ImageDetail> for JsImageDetail {
    fn from(detail: ImageDetail) -> Self {
        Self {
            name: detail.name,
            tags: detail.tags,
            curated: detail.curated,
            versions: detail
                .versions
                .into_iter()
                .map(JsImageVersion::from)
                .collect(),
        }
    }
}

/// Images held against the allowance, on a REST runtime.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageUsage {
    pub count: i64,
    pub limit: i64,
    /// Sum of the sizes the held builds' manifests declare; a layer two builds
    /// share counts for each.
    #[napi(js_name = "knownBytes")]
    pub known_bytes: i64,
}

impl From<ImageUsage> for JsImageUsage {
    fn from(usage: ImageUsage) -> Self {
        Self {
            count: js_number(usage.count),
            limit: js_number(usage.limit),
            known_bytes: js_number(usage.known_bytes),
        }
    }
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

    /// Every build held under an image name, such as "docker.io/library/alpine".
    #[napi]
    pub async fn get(&self, name: String) -> Result<JsImageDetail> {
        let handle = Arc::clone(&self.handle);
        let detail = handle.get(&name).await.map_err(map_err)?;
        Ok(JsImageDetail::from(detail))
    }

    /// Stop holding an image name, every tag of it.
    #[napi]
    pub async fn remove(&self, name: String) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle.remove(&name).await.map_err(map_err)
    }

    /// Images held against the allowance; REST runtimes only.
    #[napi]
    pub async fn usage(&self) -> Result<JsImageUsage> {
        let handle = Arc::clone(&self.handle);
        let usage = handle.usage().await.map_err(map_err)?;
        Ok(JsImageUsage::from(usage))
    }
}
