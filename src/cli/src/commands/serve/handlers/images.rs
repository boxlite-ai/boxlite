//! Image handlers (`/v1/images`).
//!
//! These answer from `runtime.images()`, which on the embedded runtime `serve`
//! runs is the local image cache. `usage` counts a catalog against a limit, and
//! a cache has neither, so it responds `400 UnsupportedError`.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::super::types::{
    ImageDetailResponse, ImageInfoResponse, ImageUsageResponse, ImageVersionResponse,
    ListImagesResponse,
};
use super::super::{AppState, error_from_boxlite};

pub(in crate::commands::serve) async fn list_images(
    State(state): State<Arc<AppState>>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.list().await {
        Ok(images) => {
            let images = images
                .into_iter()
                .map(|image| ImageInfoResponse {
                    cached_at: image.cached_at.to_rfc3339(),
                    size_bytes: image.size.map(|size| size.0),
                    reference: image.reference,
                    repository: image.repository,
                    tag: image.tag,
                    id: image.id,
                })
                .collect();
            Json(ListImagesResponse { images }).into_response()
        }
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn get_image(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.get(&name).await {
        Ok(detail) => Json(ImageDetailResponse {
            name: detail.name,
            tags: detail.tags,
            curated: detail.curated,
            versions: detail
                .versions
                .into_iter()
                .map(|version| ImageVersionResponse {
                    recorded_at: version.recorded_at.to_rfc3339(),
                    digest: version.digest,
                    size_bytes: version.size_bytes,
                    source_ref: version.source_ref,
                })
                .collect(),
        })
        .into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn remove_image(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.remove(&name).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn image_usage(
    State(state): State<Arc<AppState>>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.usage().await {
        Ok(usage) => Json(ImageUsageResponse {
            count: usage.count,
            limit: usage.limit,
            known_bytes: usage.known_bytes,
        })
        .into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}
