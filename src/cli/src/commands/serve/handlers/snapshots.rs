//! Snapshot CRUD and restore handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use boxlite::SnapshotOptions;

use super::super::types::{CreateSnapshotRequest, ListSnapshotsResponse, SnapshotResponse};
use super::super::{AppState, error_from_boxlite, error_response, get_or_fetch_box};

fn snapshot_to_response(info: &boxlite::SnapshotInfo) -> SnapshotResponse {
    SnapshotResponse {
        snapshot_type: info.snapshot_type,
        is_mock: info.is_mock,
        id: info.id.clone(),
        box_id: info.box_id.clone(),
        name: info.name.clone(),
        created_at: info.created_at,
        container_disk_bytes: info.disk_info.container_disk_bytes,
        size_bytes: info.disk_info.size_bytes,
    }
}

pub(in crate::commands::serve) async fn create_box_from_snapshot(
    State(state): State<Arc<AppState>>,
    Path((box_id, name)): Path<(String, String)>,
    Json(req): Json<super::super::types::CloneRequest>,
) -> Response {
    let source = match get_or_fetch_box(&state, &box_id).await {
        Ok(source) => source,
        Err(response) => return response,
    };
    match source.snapshots().create_box(&name, req.name).await {
        Ok(child) => {
            let info = match child.info().await {
                Ok(info) => info,
                Err(error) => return error_from_boxlite(&error),
            };
            let response = state.box_response(&info).await;
            state
                .boxes
                .write()
                .await
                .insert(info.id.to_string(), Arc::new(child));
            (StatusCode::CREATED, Json(response)).into_response()
        }
        Err(error) => error_from_boxlite(&error),
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
        .create(
            SnapshotOptions {
                snapshot_type: req.snapshot_type,
            },
            &req.name,
        )
        .await
    {
        Ok(info) => (StatusCode::CREATED, Json(snapshot_to_response(&info))).into_response(),
        Err(e) => error_from_boxlite(&e),
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
        Err(e) => error_from_boxlite(&e),
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
            "not_found",
        ),
        Err(e) => error_from_boxlite(&e),
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
        Err(e) => error_from_boxlite(&e),
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
        Err(e) => error_from_boxlite(&e),
    }
}
