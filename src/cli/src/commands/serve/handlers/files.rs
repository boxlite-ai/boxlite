//! File upload/download handlers (tar-based).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::StreamExt;

use boxlite::CopyOptions;

use super::super::types::FileQuery;
use super::super::{AppState, error_from_boxlite, get_or_fetch_box};

pub(in crate::commands::serve) async fn upload_files(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Query(query): Query<FileQuery>,
    request: Request,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    // Relay the HTTP body straight into the guest upload stream — no temp dir,
    // no re-pack.
    let stream = request.into_body().into_data_stream().map(|r| {
        r.map(|b| b.to_vec())
            .map_err(|e| std::io::Error::other(e.to_string()))
    });
    if let Err(e) = litebox
        .copy_in_tar(
            &query.path,
            CopyOptions::default(),
            query.is_directory,
            stream,
        )
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

    // Relay the guest's tar stream straight into the HTTP response — no temp
    // dir, no re-tar.
    let (is_directory, stream) = match litebox
        .copy_out_tar(&query.path, CopyOptions::default())
        .await
    {
        Ok(x) => x,
        Err(e) => return error_from_boxlite(&e),
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/x-tar");
    // Only emit the hint when known — an empty value would be read by the
    // client as `Some(false)` and wrongly skip the legacy fallback path.
    if let Some(b) = is_directory {
        builder = builder.header("X-Boxlite-Is-Directory", if b { "true" } else { "false" });
    }
    builder
        .body(Body::from_stream(stream.into_inner()))
        .unwrap()
}
