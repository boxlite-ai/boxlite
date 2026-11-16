//! Runtime directory delivery (M6) handlers.
//!
//! Mounts address by container target: the collection routes deliver the
//! host source in the body, and the `by-target` routes carry the target as
//! a query parameter.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use boxlite::MountRequest;

use super::super::types::{CreateMountRequest, ListMountsResponse, MountResponse};
use super::super::{AppState, error_from_boxlite, error_response, get_or_fetch_box};

use std::collections::HashMap;

fn mount_to_response(info: &boxlite::MountInfo) -> MountResponse {
    MountResponse {
        source: info.source.display().to_string(),
        target: info.target.display().to_string(),
        read_only: info.read_only,
        state: info.state,
    }
}

/// Reads the `target` query parameter; `None` means the caller answers
/// `400` right away via [`missing_target_response`].
fn required_target(query: &HashMap<String, String>) -> Option<String> {
    match query.get("target") {
        Some(target) if !target.is_empty() => Some(target.clone()),
        _ => None,
    }
}

/// The `400` the API contract promises when `target` is absent or empty.
fn missing_target_response() -> Response {
    error_response(
        StatusCode::BAD_REQUEST,
        "query parameter `target` is required".to_string(),
        "InvalidArgumentError",
        "invalid_argument",
    )
}

pub(in crate::commands::serve) async fn add_mount(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Json(req): Json<CreateMountRequest>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let request = MountRequest {
        source: req.source.into(),
        target: req.target.into(),
        read_only: req.read_only,
    };
    match litebox.mounts().add(request).await {
        Ok(info) => (StatusCode::CREATED, Json(mount_to_response(&info))).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn list_mounts(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.mounts().list().await {
        Ok(mounts) => {
            let mounts = mounts.iter().map(mount_to_response).collect();
            Json(ListMountsResponse { mounts }).into_response()
        }
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn get_mount(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let target = match required_target(&query) {
        Some(target) => target,
        None => return missing_target_response(),
    };
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.mounts().get(&target).await {
        Ok(Some(info)) => Json(mount_to_response(&info)).into_response(),
        Ok(None) => error_response(
            StatusCode::NOT_FOUND,
            format!("no mount at target: {target}"),
            "NotFoundError",
            "not_found",
        ),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn remove_mount(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let target = match required_target(&query) {
        Some(target) => target,
        None => return missing_target_response(),
    };
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.mounts().remove(&target).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}
