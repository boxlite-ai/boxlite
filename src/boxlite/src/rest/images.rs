//! REST `ImageBackend` — routes runtime-scoped image operations to the
//! API server's `/v1/{prefix}/images` surface. Wire shape MUST stay in
//! lockstep with `apps/api/src/boxlite-rest/boxlite-images.controller.ts`
//! and `apps/runner/pkg/api/controllers/boxlite_images.go`.

use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

use crate::images::ImageObject;
use crate::runtime::images::ImageBackend;
use crate::runtime::types::ImageInfo;

use super::client::ApiClient;

/// Defensive cap on the runner-reported layer count we trust over the
/// wire. Real OCI manifests cap at 127 layers (the docker registry
/// hard limit); 4096 gives ~32× headroom for non-standard registries
/// without letting a malformed / malicious response drive an
/// allocation that scales with `layer_count`.
const MAX_REMOTE_LAYER_COUNT: usize = 4096;

#[derive(Debug, Serialize)]
struct ImagePullRequest<'a> {
    reference: &'a str,
}

/// `POST /v1/{prefix}/images/pull` response. Field names mirror the Go
/// SDK's `ImagePullResult` so the API can forward the runner response
/// byte-for-byte without re-serialising.
#[derive(Debug, Deserialize)]
struct ImagePullResponse {
    reference: String,
    config_digest: String,
    layer_count: usize,
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
        let body = ImagePullRequest {
            reference: image_ref,
        };
        let resp: ImagePullResponse = self.client.post("/images/pull", &body).await?;
        if resp.layer_count > MAX_REMOTE_LAYER_COUNT {
            return Err(BoxliteError::Internal(format!(
                "runner reported {} layers for {} — exceeds sanity cap of {}",
                resp.layer_count, resp.reference, MAX_REMOTE_LAYER_COUNT
            )));
        }
        Ok(ImageObject::new_remote_metadata(
            resp.reference,
            resp.config_digest,
            resp.layer_count,
        ))
    }

    async fn list_images(&self) -> BoxliteResult<Vec<ImageInfo>> {
        // Listing isn't part of this surface; #696 will land that. Keep
        // it explicit instead of pretending it succeeds with an empty
        // list, which would mask wiring bugs.
        Err(BoxliteError::Unsupported(
            "runtime.images.list() over REST is not implemented yet".to_string(),
        ))
    }
}
