//! File upload/download handlers (tar-based).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use boxlite::CopyOptions;
use boxlite_shared::tar::{PackContext, UnpackContext};

use super::super::types::FileQuery;
use super::super::{AppState, error_from_boxlite, error_response, get_or_fetch_box};
use super::payload::{BodyWriteError, stream_file_body, write_body_to_file};

pub(in crate::commands::serve) async fn upload_files(
    State(state): State<Arc<AppState>>,
    AxumPath(box_id): AxumPath<String>,
    Query(query): Query<FileQuery>,
    body: Body,
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

    let upload_tar = temp_dir.path().join("upload.tar");
    if let Err(e) = write_body_to_file(body, &upload_tar).await {
        return match e {
            BodyWriteError::BodyTooLarge => error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body too large".to_string(),
                "PayloadTooLargeError",
                "payload_too_large",
            ),
            BodyWriteError::Io(e) => error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to write upload archive: {e}"),
                "InternalError",
                "internal",
            ),
        };
    }

    let extract_dir = temp_dir.path().join("extracted");
    if let Err(e) = boxlite_shared::tar::unpack(
        upload_tar,
        extract_dir.clone(),
        UnpackContext {
            overwrite: true,
            mkdir_parents: true,
            force_directory: true,
        },
    )
    .await
    {
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
    AxumPath(box_id): AxumPath<String>,
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

    let tar_dir = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create tar temp dir: {e}"),
                "InternalError",
                "internal",
            );
        }
    };
    let tar_path = tar_dir.path().join("files.tar");

    if let Err(e) = boxlite_shared::tar::pack(
        temp_dir.path().to_path_buf(),
        tar_path.clone(),
        PackContext {
            follow_symlinks: false,
            include_parent: false,
        },
    )
    .await
    {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create tar: {e}"),
            "InternalError",
            "internal",
        );
    }
    drop(temp_dir);

    let body = match stream_file_body(&tar_path, vec![tar_dir]).await {
        Ok(body) => body,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read tar: {e}"),
                "InternalError",
                "internal",
            );
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/x-tar")
        .body(body)
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pack_download_dir_uses_shared_tar_without_parent_entry() {
        let src_dir = tempfile::tempdir().unwrap();
        std::fs::write(src_dir.path().join("hello.txt"), b"hello").unwrap();

        let tar_dir = tempfile::tempdir().unwrap();
        let tar_path = tar_dir.path().join("files.tar");
        boxlite_shared::tar::pack(
            src_dir.path().to_path_buf(),
            tar_path.clone(),
            PackContext {
                follow_symlinks: false,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let extract_dir = tempfile::tempdir().unwrap();
        boxlite_shared::tar::unpack(
            tar_path,
            extract_dir.path().to_path_buf(),
            UnpackContext {
                overwrite: true,
                mkdir_parents: true,
                force_directory: true,
            },
        )
        .await
        .unwrap();

        let extracted = std::fs::read(extract_dir.path().join("hello.txt")).unwrap();
        assert_eq!(extracted, b"hello");
    }
}
