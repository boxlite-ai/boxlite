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

    // Stage the client tar verbatim into a temp subdir, then copy its CONTENTS
    // (include_parent=false) into the box. Flattening the staged dir's top-level
    // entries means the temp dir's own name never enters the box rootfs — the
    // historical `extracted/` leak. The docker-cp file/dir detection happens
    // inside the box (guest), driven by `query.path` (trailing-`/` → directory).
    let staged = match stage_upload_tar(&body, temp_dir.path()).await {
        Ok(p) => p,
        Err(e) => return error_from_boxlite(&e),
    };

    let opts = CopyOptions {
        recursive: true,
        overwrite: query.overwrite_or_default(),
        follow_symlinks: false, // already baked into the client tar at pack time
        include_parent: false,  // flatten staged contents into path (no wrapper)
    };

    if let Err(e) = litebox.copy_into(&staged, &query.path, opts).await {
        return error_from_boxlite(&e);
    }

    StatusCode::NO_CONTENT.into_response()
}

/// Extract the client tar verbatim into a fresh subdir of `temp_root` (no
/// wrapper) and return that staged directory.
///
/// `force_directory: true` places the bytes as-is; the FileToFile/IntoDirectory
/// detection is deferred to the guest, which sees the real destination path.
async fn stage_upload_tar(
    tar_bytes: &[u8],
    temp_root: &std::path::Path,
) -> Result<std::path::PathBuf, boxlite::BoxliteError> {
    let tar_path = temp_root.join("upload.tar");
    tokio::fs::write(&tar_path, tar_bytes)
        .await
        .map_err(|e| boxlite::BoxliteError::Storage(format!("write staged tar: {e}")))?;
    let staged = temp_root.join("staged");
    tokio::fs::create_dir_all(&staged)
        .await
        .map_err(|e| boxlite::BoxliteError::Storage(format!("mkdir staged: {e}")))?;
    boxlite::tar::unpack(
        tar_path,
        staged.clone(),
        boxlite::tar::UnpackContext {
            overwrite: true,
            mkdir_parents: true,
            force_directory: true,
        },
    )
    .await?;
    Ok(staged)
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

    // Isolate the box payload in its own subdir so the re-pack sees ONLY guest
    // output — not the response tar we write next to it. Packing `temp_dir`
    // directly would tar `download.tar` (and any stray temp file) into itself.
    let payload = temp_dir.path().join("payload");
    if let Err(e) = std::fs::create_dir_all(&payload) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create payload dir: {e}"),
            "InternalError",
            "internal",
        );
    }

    let opts = CopyOptions {
        recursive: true,
        overwrite: true, // host-side temp is always fresh
        follow_symlinks: query.follow_symlinks_or_default(),
        include_parent: query.include_parent_or_default(),
    };
    if let Err(e) = litebox.copy_out(&query.path, &payload, opts).await {
        return error_from_boxlite(&e);
    }

    // Re-pack faithfully with the shared packer. include_parent=false flattens
    // payload's top-level entries — exactly what the guest produced — and the
    // per-entry iteration avoids the spurious `.` entry that append_dir_all(".")
    // emits. follow_symlinks=false: the guest already resolved/preserved links
    // per the client's request, so we re-tar the final form as-is.
    let tar_path = temp_dir.path().join("download.tar");
    if let Err(e) = boxlite::tar::pack(
        payload.clone(),
        tar_path.clone(),
        boxlite::tar::PackContext {
            follow_symlinks: false,
            include_parent: false,
        },
    )
    .await
    {
        return error_from_boxlite(&e);
    }

    let tar_bytes = match tokio::fs::read(&tar_path).await {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read download tar: {e}"),
                "InternalError",
                "internal",
            );
        }
    };

    // Infallible construction (no .unwrap()): a typed Content-Type header plus
    // an owned body — mirrors the structured error_response paths above and
    // avoids a latent panic in the serve worker.
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/x-tar")],
        tar_bytes,
    )
        .into_response()
}

#[cfg(test)]
mod upload_staging_tests {
    //! The upload path used to extract into a temp subdir literally named
    //! `extracted/` and then `copy_into(..., CopyOptions::default())` with
    //! `include_parent=true`, leaking `path/extracted/<name>` into the box
    //! (#384). `stage_upload_tar` + `include_parent=false` removes the wrapper.
    use super::*;
    use tempfile::TempDir;

    fn single_file_tar(name: &str, content: &[u8]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_size(content.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, name, content).unwrap();
        b.into_inner().unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn staged_dir_has_no_extracted_wrapper() {
        let tmp = TempDir::new().unwrap();
        let tar = single_file_tar("x.txt", b"hi");
        let staged = stage_upload_tar(&tar, tmp.path()).await.unwrap();

        // The file lands directly in the staged dir — not under any wrapper
        // subdir like the historical "extracted/".
        assert!(staged.join("x.txt").is_file());
        assert!(!staged.join("extracted").exists());
        assert!(!staged.join("staged").exists());
    }
}
