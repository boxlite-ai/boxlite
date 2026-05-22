//! File upload/download handlers.
//!
//! Wire contract matches the runner's `boxlite_files` endpoints
//! (`apps/runner/pkg/api/controllers/boxlite_files.go`):
//!
//! - `PUT  /files`              raw octet-stream body, single file → CopyInto
//! - `GET  /files`              raw octet-stream body, single file ← CopyOut
//! - `POST /files/bulk-upload`  multipart/form-data with files[N].path + .file pairs
//! - `POST /files/bulk-download` JSON `{paths:[...]}` → multipart response
//!
//! The legacy `application/x-tar` shape on the single-file endpoints is gone:
//! the realigned Rust REST SDK at `src/boxlite/src/rest/litebox.rs` now sends
//! and expects raw octet-stream bodies, so this server must too or `boxlite
//! serve` would be incompatible with its own SDK.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use boxlite::CopyOptions;

use super::super::types::{BulkDownloadRequest, FileQuery};
use super::super::{AppState, classify_boxlite_error, error_response, get_or_fetch_box};

/// Fixed multipart boundary used on bulk-download responses. Must match the
/// runner's `bulkDownloadBoundary` so the same SDK code path can talk to
/// either server.
const BULK_DOWNLOAD_BOUNDARY: &str = "BOXLITE-FILE-BOUNDARY";

// ============================================================================
// Single-file PUT  /v1/default/boxes/{box_id}/files
// ============================================================================

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
            );
        }
    };

    // CopyInto takes a host path, so spill the raw body to a tmp file.
    // The basename is irrelevant — copy_into uses the destination query
    // param verbatim — but giving it a stable name keeps the tmpdir tidy.
    let tmp_path = temp_dir.path().join("upload.bin");
    if let Err(e) = std::fs::File::create(&tmp_path).and_then(|mut f| f.write_all(&body)) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to stage upload body: {e}"),
            "InternalError",
        );
    }

    let opts = CopyOptions {
        overwrite: query.overwrite,
        ..Default::default()
    };

    if let Err(e) = litebox.copy_into(&tmp_path, &query.path, opts).await {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    StatusCode::NO_CONTENT.into_response()
}

// ============================================================================
// Single-file GET  /v1/default/boxes/{box_id}/files
// ============================================================================

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

    // copy_out auto-detects file-to-file vs into-directory based on whether
    // the host destination is an existing directory. We pass a concrete tmp
    // file path so the bytes land exactly there and we don't have to walk
    // a directory after the call.
    let tmp_path = temp_dir.path().join("download.bin");

    let opts = CopyOptions {
        follow_symlinks: query.follow_symlinks,
        ..Default::default()
    };

    if let Err(e) = litebox.copy_out(&query.path, &tmp_path, opts).await {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    let bytes = match std::fs::read(&tmp_path) {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read downloaded file: {e}"),
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

// ============================================================================
// POST /v1/default/boxes/{box_id}/files/bulk-upload
// ============================================================================

/// Bulk-upload many files via multipart/form-data. Field names must follow
/// the `files[N].path` / `files[N].file` convention, with `.path` preceding
/// its matching `.file`. Per-file errors are collected rather than aborting
/// the batch: a 400 is returned with `{uploaded, errors}` on partial
/// success, 200 with `{uploaded}` on full success. Mirrors the runner
/// controller's behaviour at apps/runner/pkg/api/controllers/boxlite_files.go.
pub(in crate::commands::serve) async fn bulk_upload(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    multipart: Multipart,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    // Stage every part to a tmp file under one tempdir so we can clean
    // everything up by dropping the dir, regardless of which CopyInto
    // calls succeeded.
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

    let mut errors: Vec<String> = Vec::new();
    let staged = match stage_bulk_upload_parts(multipart, temp_dir.path()).await {
        Ok((staged, parse_errs)) => {
            errors.extend(parse_errs);
            staged
        }
        Err(resp) => return resp,
    };

    let mut uploaded: Vec<String> = Vec::with_capacity(staged.len());
    for entry in &staged {
        match litebox
            .copy_into(&entry.host_src, &entry.dest, CopyOptions::default())
            .await
        {
            Ok(()) => uploaded.push(entry.dest.clone()),
            Err(e) => errors.push(format!("{}: copy: {}", entry.dest, e)),
        }
    }

    if !errors.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "uploaded": uploaded, "errors": errors })),
        )
            .into_response();
    }
    (StatusCode::OK, Json(json!({ "uploaded": uploaded }))).into_response()
}

struct StagedUpload {
    dest: String,
    host_src: std::path::PathBuf,
}

/// Parse the multipart body, pairing `files[N].path` with `files[N].file`.
/// Files are staged to disk under `tmp_root/<index>.bin` so the upload
/// loop can hand each tmp path to `copy_into`. Per-pair errors accumulate
/// without aborting the batch; only an unrecoverable multipart-framing
/// error returns `Err(Response)`.
async fn stage_bulk_upload_parts(
    mut multipart: Multipart,
    tmp_root: &std::path::Path,
) -> Result<(Vec<StagedUpload>, Vec<String>), Response> {
    let mut dests: HashMap<String, String> = HashMap::new();
    let mut rejected: HashMap<String, bool> = HashMap::new();
    let mut staged: Vec<StagedUpload> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    loop {
        let part = match multipart.next_field().await {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(e) => {
                return Err(error_response(
                    StatusCode::BAD_REQUEST,
                    format!("invalid multipart form: {e}"),
                    "InvalidArgumentError",
                ));
            }
        };

        // Axum hands us the `Content-Disposition: name=` value via
        // `Field::name`. Empty / unnamed parts get skipped.
        let name = match part.name() {
            Some(n) => n.to_string(),
            None => continue,
        };
        let idx = extract_bulk_index(&name);

        if name.ends_with(".path") {
            let bytes = match part.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    errors.push(format!("path[{idx}]: {e}"));
                    rejected.insert(idx, true);
                    continue;
                }
            };
            let text = match std::str::from_utf8(&bytes) {
                Ok(s) => s.to_string(),
                Err(e) => {
                    errors.push(format!("path[{idx}]: invalid utf-8: {e}"));
                    rejected.insert(idx, true);
                    continue;
                }
            };
            if text.trim().is_empty() {
                errors.push(format!("path[{idx}]: empty"));
                rejected.insert(idx, true);
                continue;
            }
            dests.insert(idx, text);
        } else if name.ends_with(".file") {
            let Some(dest) = dests.get(&idx).cloned() else {
                if !rejected.get(&idx).copied().unwrap_or(false) {
                    errors.push(format!(
                        "file[{idx}]: missing .path metadata (must precede .file)"
                    ));
                }
                // Drain the body so the multipart stream advances.
                let _ = part.bytes().await;
                continue;
            };
            let bytes = match part.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    errors.push(format!("{dest}: read: {e}"));
                    continue;
                }
            };
            let host_src = tmp_root.join(format!("{idx}.bin"));
            if let Err(e) = std::fs::write(&host_src, &bytes) {
                errors.push(format!("{dest}: stage: {e}"));
                continue;
            }
            staged.push(StagedUpload { dest, host_src });
        }
        // Any other field name is silently ignored — same as the runner.
    }

    Ok((staged, errors))
}

/// Strip the `files[N].path` / `files[N].file` framing to return just `N`.
/// Field names that don't match the convention come back unchanged; callers
/// only ever consult this for names that already passed the suffix check.
fn extract_bulk_index(field: &str) -> String {
    let s = field.strip_prefix("files[").unwrap_or(field);
    let s = s.strip_suffix("].path").unwrap_or(s);
    let s = s.strip_suffix("].file").unwrap_or(s);
    s.to_string()
}

// ============================================================================
// POST /v1/default/boxes/{box_id}/files/bulk-download
// ============================================================================

/// Bulk-download many files in a single multipart/form-data response. Each
/// requested path becomes either a `name="file"` part (success) or a
/// `name="error"` part (per-file failure). A single failing path never
/// aborts the batch — clients must inspect per-part disposition rather
/// than HTTP status to learn which files made it.
///
/// We build the whole multipart body in memory before returning. The
/// runner streams parts as it produces them so a slow CopyOut doesn't
/// block other parts; the CLI server's expected use cases (local dev,
/// reference impl) don't justify the extra streaming machinery yet.
/// Captured under "Follow-ups" in the PR description.
pub(in crate::commands::serve) async fn bulk_download(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Json(req): Json<BulkDownloadRequest>,
) -> Response {
    if req.paths.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "request body must be {\"paths\": [...]} and non-empty",
            "InvalidArgumentError",
        );
    }

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

    let mut body: Vec<u8> = Vec::new();
    for (idx, src_path) in req.paths.iter().enumerate() {
        let tmp_path = temp_dir.path().join(format!("{idx}.bin"));
        match litebox
            .copy_out(src_path, &tmp_path, CopyOptions::default())
            .await
        {
            Ok(()) => match std::fs::read(&tmp_path) {
                Ok(bytes) => append_file_part(&mut body, src_path, &bytes),
                Err(e) => append_error_part(&mut body, src_path, &format!("open: {e}")),
            },
            Err(e) => append_error_part(&mut body, src_path, &format!("copy: {e}")),
        }
    }
    append_closing_boundary(&mut body);

    let content_type = format!("multipart/form-data; boundary={BULK_DOWNLOAD_BOUNDARY}");
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", content_type)
        .body(axum::body::Body::from(body))
        .unwrap()
}

/// Append a successful-file part: `name="file"; filename="<src_path>"`,
/// `Content-Type: application/octet-stream` (the runner sniffs by file
/// extension; we use a single content-type because the SDK doesn't depend
/// on the per-part type and it keeps the helper simple).
fn append_file_part(body: &mut Vec<u8>, src_path: &str, bytes: &[u8]) {
    write_part_headers(body, "file", src_path, "application/octet-stream");
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
}

/// Append a per-file failure part: `name="error"; filename="<src_path>"`,
/// `Content-Type: text/plain` with the error text as the body. Matches the
/// runner so the SDK can route per-part on the `name` field without
/// inspecting the body.
fn append_error_part(body: &mut Vec<u8>, src_path: &str, message: &str) {
    write_part_headers(body, "error", src_path, "text/plain; charset=utf-8");
    body.extend_from_slice(message.as_bytes());
    body.extend_from_slice(b"\r\n");
}

fn write_part_headers(body: &mut Vec<u8>, name: &str, filename: &str, content_type: &str) {
    body.extend_from_slice(b"--");
    body.extend_from_slice(BULK_DOWNLOAD_BOUNDARY.as_bytes());
    body.extend_from_slice(b"\r\n");
    let disposition = format!(
        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
    );
    body.extend_from_slice(disposition.as_bytes());
    let ctype = format!("Content-Type: {content_type}\r\n\r\n");
    body.extend_from_slice(ctype.as_bytes());
}

fn append_closing_boundary(body: &mut Vec<u8>) {
    body.extend_from_slice(b"--");
    body.extend_from_slice(BULK_DOWNLOAD_BOUNDARY.as_bytes());
    body.extend_from_slice(b"--\r\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `extract_bulk_index` strips the framing on .path and .file fields and
    /// returns the inner index. We treat the index as opaque (the runner
    /// keys its map with the same opaque string) so any value the form
    /// puts between `[` and `]` round-trips.
    #[test]
    fn extract_index_round_trips_numeric() {
        assert_eq!(extract_bulk_index("files[0].path"), "0");
        assert_eq!(extract_bulk_index("files[12].file"), "12");
    }

    #[test]
    fn extract_index_round_trips_string() {
        assert_eq!(extract_bulk_index("files[alpha].path"), "alpha");
    }

    #[test]
    fn extract_index_passes_through_unknown_field() {
        // Non-conforming field names are returned unchanged; the .path/.file
        // suffix check in the caller filters them out before this matters.
        assert_eq!(extract_bulk_index("garbage"), "garbage");
    }

    /// The bulk-download body must end with `--BOUNDARY--\r\n` so a strict
    /// multipart parser knows there are no more parts. The runner's
    /// `multipart.Writer.Close()` writes the same trailer; if we drift, the
    /// SDK fails on the last `NextPart`.
    #[test]
    fn bulk_download_body_ends_with_closing_boundary() {
        let mut body = Vec::new();
        append_file_part(&mut body, "/etc/hosts", b"127.0.0.1 localhost\n");
        append_error_part(&mut body, "/no/such/file", "copy: not found");
        append_closing_boundary(&mut body);

        let expected_close = format!("--{BULK_DOWNLOAD_BOUNDARY}--\r\n");
        assert!(
            body.ends_with(expected_close.as_bytes()),
            "body should end with closing boundary, got tail: {:?}",
            String::from_utf8_lossy(&body[body.len().saturating_sub(64)..]),
        );

        // Both parts must reference the constant boundary so the SDK can
        // split on it. A naive `contains` is enough — the constant is
        // distinctive.
        let as_str = String::from_utf8_lossy(&body);
        assert!(as_str.contains(&format!("--{BULK_DOWNLOAD_BOUNDARY}\r\n")));
        assert!(as_str.contains("name=\"file\"; filename=\"/etc/hosts\""));
        assert!(as_str.contains("name=\"error\"; filename=\"/no/such/file\""));
        assert!(as_str.contains("copy: not found"));
    }
}
