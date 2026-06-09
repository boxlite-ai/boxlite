//! REST-mode `ImageBackend` implementation.
//!
//! The local-FFI runtime has an `image_manager` that pulls/lists images
//! from its on-disk cache. The REST runtime delegates the same surface to
//! the remote API. Today we wire `list_images` end-to-end (the API
//! aggregates per-org image records and returns them in the
//! `ImageInfoListResponse` shape below); `pull_image` stays
//! `Unsupported` because the SDK consumer's `ImagePullResult` shape
//! pulls layer counts and a manifest digest that aren't available
//! without doing the registry pull on the API/runner side — that's
//! tractable but a separate change.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Deserialize;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::images::ImageObject;
use crate::runtime::images::ImageBackend;
use crate::runtime::types::ImageInfo;

use super::client::ApiClient;

#[derive(Debug, Deserialize)]
pub(crate) struct ImageInfoResponse {
    pub reference: String,
    pub repository: String,
    pub tag: String,
    pub id: String,
    pub cached_at: String,
    #[serde(default)]
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ImageInfoListResponse {
    pub images: Vec<ImageInfoResponse>,
}

impl ImageInfoResponse {
    pub fn to_image_info(&self) -> ImageInfo {
        let cached_at = DateTime::parse_from_rfc3339(&self.cached_at)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        ImageInfo {
            reference: self.reference.clone(),
            repository: self.repository.clone(),
            tag: self.tag.clone(),
            id: self.id.clone(),
            cached_at,
            size: self
                .size_bytes
                .map(crate::runtime::types::Bytes::from_bytes),
        }
    }
}

pub(crate) struct RestImageBackend {
    client: ApiClient,
}

impl RestImageBackend {
    pub fn new(client: ApiClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl ImageBackend for RestImageBackend {
    async fn pull_image(&self, image_ref: &str) -> BoxliteResult<ImageObject> {
        // The SDK consumer ultimately constructs `ImagePullResult { reference,
        // config_digest, layer_count }` from this ImageObject. The first two
        // are available from the server response, but layer_count needs the
        // raw manifest. Until that's surfaced over REST, surface a typed
        // unsupported error so callers don't see a 5xx.
        Err(BoxliteError::Unsupported(format!(
            "image pull over REST is not yet supported (ref={image_ref}); use list to inspect cached images"
        )))
    }

    async fn list_images(&self) -> BoxliteResult<Vec<ImageInfo>> {
        // Per-org list (the API resolves the org from the bearer token).
        let resp: ImageInfoListResponse = self.client.get("/images").await?;
        Ok(resp
            .images
            .iter()
            .map(ImageInfoResponse::to_image_info)
            .collect())
    }
}

#[allow(dead_code)] // Kept for future direct ownership outside the BoxliteRuntime constructor.
pub fn build_rest_image_backend(client: ApiClient) -> Arc<dyn ImageBackend> {
    Arc::new(RestImageBackend::new(client))
}
