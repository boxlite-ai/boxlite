//! File upload/download handlers.
//!
//! Upload uses WebDAV verbs scoped under `/files/{*path}`:
//!   - `PUT`   — write request body as a single file
//!   - `MKCOL` — create an empty directory
//! Bulk download stays at `GET /files?path=...` returning a tar archive so
//! callers can pull a whole tree in one round-trip.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};

use boxlite::CopyOptions;

use super::super::types::{FileQuery, WebdavQuery};
use super::super::{AppState, classify_boxlite_error, error_response, get_or_fetch_box};

/// Dispatch WebDAV verbs (PUT, MKCOL) on `/files/{*path}`.
///
/// Axum's `MethodFilter` only covers standard methods, so this single handler
/// matches `any()` and branches on the request method.
pub(in crate::commands::serve) async fn webdav_dispatch(
    State(state): State<Arc<AppState>>,
    Path((box_id, path)): Path<(String, String)>,
    Query(query): Query<WebdavQuery>,
    method: Method,
    body: Bytes,
) -> Response {
    let container_path = normalize_container_path(&path);
    if container_path.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "container path cannot be empty".into(),
            "InvalidArgumentError",
        );
    }

    match method.as_str() {
        "PUT" => upload_file(state, box_id, container_path, body, query.overwrite).await,
        "MKCOL" => make_collection(state, box_id, container_path).await,
        _ => error_response(
            StatusCode::METHOD_NOT_ALLOWED,
            format!("method {} not supported on /files/{{path}}", method),
            "MethodNotAllowed",
        ),
    }
}

async fn upload_file(
    state: Arc<AppState>,
    box_id: String,
    container_path: String,
    body: Bytes,
    overwrite: bool,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    // Split into parent dir + basename; tar-pack extracts a single-file
    // archive at the parent and re-creates the file with the basename.
    let (parent, basename) = match split_parent_basename(&container_path) {
        Some(pair) => pair,
        None => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "PUT requires a non-empty file name".into(),
                "InvalidArgumentError",
            );
        }
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
    let host_file = temp_dir.path().join(&basename);
    if let Err(e) = tokio::fs::write(&host_file, &body).await {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to stage upload: {e}"),
            "InternalError",
        );
    }

    let opts = CopyOptions {
        overwrite,
        // The host file's basename IS the destination basename; the parent
        // directory is the extract root, so we must NOT include the parent.
        include_parent: false,
        ..CopyOptions::default()
    };
    if let Err(e) = litebox.copy_into(&host_file, &parent, opts).await {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    StatusCode::NO_CONTENT.into_response()
}

async fn make_collection(
    state: Arc<AppState>,
    box_id: String,
    container_path: String,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let (parent, basename) = match split_parent_basename(&container_path) {
        Some(pair) => pair,
        None => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "MKCOL requires a non-empty directory name".into(),
                "InvalidArgumentError",
            );
        }
    };

    // Build an empty host directory with the target basename and copy it in
    // with include_parent=true so the directory itself (not just its empty
    // contents) materializes under `parent`.
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
    let host_dir = temp_dir.path().join(&basename);
    if let Err(e) = std::fs::create_dir(&host_dir) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to stage directory: {e}"),
            "InternalError",
        );
    }

    let opts = CopyOptions {
        include_parent: true,
        ..CopyOptions::default()
    };
    if let Err(e) = litebox.copy_into(&host_dir, &parent, opts).await {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    StatusCode::CREATED.into_response()
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
            );
        }
    };

    if let Err(e) = litebox
        .copy_out(&query.path, temp_dir.path(), CopyOptions::default())
        .await
    {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    let mut builder = tar::Builder::new(Vec::new());
    if let Err(e) = builder.append_dir_all(".", temp_dir.path()) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create tar: {e}"),
            "InternalError",
        );
    }

    let tar_bytes = match builder.into_inner() {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to finalize tar: {e}"),
                "InternalError",
            );
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/x-tar")
        .body(axum::body::Body::from(tar_bytes))
        .unwrap()
}

/// Normalize a URL path segment captured by the router into an absolute
/// container path with a single leading `/` and no trailing slash.
fn normalize_container_path(raw: &str) -> String {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{}", trimmed)
    }
}

/// Split `/a/b/c` into ("/a/b", "c"). Returns None if there is no basename.
fn split_parent_basename(path: &str) -> Option<(String, String)> {
    let (head, tail) = path.rsplit_once('/')?;
    if tail.is_empty() {
        return None;
    }
    let parent = if head.is_empty() { "/" } else { head };
    Some((parent.to_string(), tail.to_string()))
}
