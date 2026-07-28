//! Named-volume handlers (`/v1/volumes`).
//!
//! These mirror the box handlers, delegating to `runtime.volumes()`. The
//! concrete backend returns `Unsupported` for now, so every operation currently
//! responds `400 UnsupportedError`.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::super::types::{ListVolumesResponse, RemoveQuery};
use super::super::{AppState, error_from_boxlite, volume_info_to_response};

pub(in crate::commands::serve) async fn create_volume(
    State(state): State<Arc<AppState>>,
) -> Response {
    let handle = match state.runtime.volumes() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.create().await {
        Ok(info) => (StatusCode::CREATED, Json(volume_info_to_response(&info))).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn list_volumes(
    State(state): State<Arc<AppState>>,
) -> Response {
    let handle = match state.runtime.volumes() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.list().await {
        Ok(infos) => {
            let volumes = infos.iter().map(volume_info_to_response).collect();
            Json(ListVolumesResponse { volumes }).into_response()
        }
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn get_volume(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let handle = match state.runtime.volumes() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.get(&id).await {
        Ok(info) => Json(volume_info_to_response(&info)).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn remove_volume(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<RemoveQuery>,
) -> Response {
    let handle = match state.runtime.volumes() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    let force = query.force.unwrap_or(false);
    match handle.remove(&id, force).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}
