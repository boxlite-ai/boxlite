//! Snapshot CRUD and restore handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use boxlite::SnapshotOptions;

use super::super::types::{CreateSnapshotRequest, ListSnapshotsResponse, SnapshotResponse};
use super::super::{AppState, classify_boxlite_error, error_response, get_or_fetch_box};

fn snapshot_to_response(info: &boxlite::SnapshotInfo) -> SnapshotResponse {
    SnapshotResponse {
        id: info.id.clone(),
        box_id: info.box_id.clone(),
        name: info.name.clone(),
        created_at: info.created_at,
        container_disk_bytes: info.disk_info.container_disk_bytes,
        size_bytes: info.disk_info.size_bytes,
    }
}

pub(in crate::commands::serve) async fn create_snapshot(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Json(req): Json<CreateSnapshotRequest>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox
        .snapshots()
        .create(SnapshotOptions::default(), &req.name)
        .await
    {
        Ok(info) => (StatusCode::CREATED, Json(snapshot_to_response(&info))).into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn list_snapshots(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.snapshots().list().await {
        Ok(snaps) => {
            let snapshots = snaps.iter().map(snapshot_to_response).collect();
            Json(ListSnapshotsResponse { snapshots }).into_response()
        }
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn get_snapshot(
    State(state): State<Arc<AppState>>,
    Path((box_id, name)): Path<(String, String)>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.snapshots().get(&name).await {
        Ok(Some(info)) => Json(snapshot_to_response(&info)).into_response(),
        Ok(None) => error_response(
            StatusCode::NOT_FOUND,
            format!("snapshot not found: {name}"),
            "NotFoundError",
        ),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn delete_snapshot(
    State(state): State<Arc<AppState>>,
    Path((box_id, name)): Path<(String, String)>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.snapshots().remove(&name).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn restore_snapshot(
    State(state): State<Arc<AppState>>,
    Path((box_id, name)): Path<(String, String)>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.snapshots().restore(&name).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}
