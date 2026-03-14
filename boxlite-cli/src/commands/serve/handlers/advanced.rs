//! Clone, export, and import handlers.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use boxlite::{BoxArchive, CloneOptions, ExportOptions};

use super::super::types::{CloneRequest, ImportQuery};
use super::super::{
    AppState, box_info_to_response, classify_boxlite_error, error_response, get_or_fetch_box,
};

pub(in crate::commands::serve) async fn clone_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Json(req): Json<CloneRequest>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.clone_box(CloneOptions::default(), req.name).await {
        Ok(cloned) => {
            let info = cloned.info();
            let cloned_id = info.id.to_string();
            let resp = box_info_to_response(&info);
            state
                .boxes
                .write()
                .await
                .insert(cloned_id, Arc::new(cloned));
            (StatusCode::CREATED, Json(resp)).into_response()
        }
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn export_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let temp_dir = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create temp dir: {e}"),
                "InternalError",
            );
        }
    };

    match litebox
        .export(ExportOptions::default(), temp_dir.path())
        .await
    {
        Ok(archive) => {
            let bytes = match std::fs::read(archive.path()) {
                Ok(b) => b,
                Err(e) => {
                    return error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("failed to read archive: {e}"),
                        "InternalError",
                    );
                }
            };

            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/octet-stream")
                .body(axum::body::Body::from(bytes))
                .unwrap()
        }
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn import_box(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ImportQuery>,
    body: Bytes,
) -> Response {
    let temp_dir = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create temp dir: {e}"),
                "InternalError",
            );
        }
    };

    let archive_path = temp_dir.path().join("import.boxlite");
    if let Err(e) = std::fs::write(&archive_path, &body) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to write archive: {e}"),
            "InternalError",
        );
    }

    let archive = BoxArchive::new(archive_path);
    match state.runtime.import_box(archive, query.name).await {
        Ok(litebox) => {
            let info = litebox.info();
            let box_id = info.id.to_string();
            let resp = box_info_to_response(&info);
            state.boxes.write().await.insert(box_id, Arc::new(litebox));
            (StatusCode::CREATED, Json(resp)).into_response()
        }
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}
