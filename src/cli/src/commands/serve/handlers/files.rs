//! File upload/download handlers (tar-based).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use boxlite::CopyOptions;

use super::super::types::FileQuery;
use super::super::{AppState, error_from_boxlite, error_response, get_or_fetch_box};

pub(in crate::commands::serve) async fn upload_files(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Query(query): Query<FileQuery>,
    body: Bytes,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    // Extract tar to temp dir, then copy into container
    let temp_dir = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create temp dir: {e}"),
                "InternalError",
                "internal",
            );
        }
    };

    let extract_dir = temp_dir.path().join("extracted");
    if let Err(e) = std::fs::create_dir_all(&extract_dir) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create extract dir: {e}"),
            "InternalError",
            "internal",
        );
    }

    let mut archive = tar::Archive::new(&body[..]);
    if let Err(e) = archive.unpack(&extract_dir) {
        return error_response(
            StatusCode::BAD_REQUEST,
            format!("failed to extract tar: {e}"),
            "InvalidArgumentError",
            "invalid_argument",
        );
    }

    if let Err(e) = litebox
        .copy_into(&extract_dir, &query.path, CopyOptions::default())
        .await
    {
        return error_from_boxlite(&e);
    }

    StatusCode::NO_CONTENT.into_response()
}

pub(in crate::commands::serve) async fn download_files(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Query(query): Query<FileQuery>,
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
                "internal",
            );
        }
    };

    if let Err(e) = litebox
        .copy_out(&query.path, temp_dir.path(), CopyOptions::default())
        .await
    {
        return error_from_boxlite(&e);
    }

    // Create tar from extracted files
    let mut builder = tar::Builder::new(Vec::new());
    if let Err(e) = builder.append_dir_all(".", temp_dir.path()) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create tar: {e}"),
            "InternalError",
            "internal",
        );
    }

    let tar_bytes = match builder.into_inner() {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to finalize tar: {e}"),
                "InternalError",
                "internal",
            );
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/x-tar")
        .body(axum::body::Body::from(tar_bytes))
        .unwrap()
}
