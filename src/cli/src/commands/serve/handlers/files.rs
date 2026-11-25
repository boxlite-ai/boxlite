//! File upload/download handlers (tar-based).
//!
//! Tar bytes pass directly between HTTP and the backend. Guest-provided link
//! entries stay in the archive; their targets must not be opened on the host.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::StreamExt;

use boxlite::CopyOptions;

use super::super::types::FileQuery;
use super::super::{AppState, error_from_boxlite, get_or_resume_box};

pub(in crate::commands::serve) async fn upload_files(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Query(query): Query<FileQuery>,
    body: Body,
) -> Response {
    let litebox = match get_or_resume_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    // Preserve entry order and duplicates so the guest enforces the policy
    // against each original entry, including earlier writes in this upload.
    let stream = body.into_data_stream().map(|chunk| {
        chunk
            .map(|bytes| bytes.to_vec())
            .map_err(std::io::Error::other)
    });
    if let Err(e) = litebox
        .copy_in_stream(
            stream,
            &query.path,
            CopyOptions {
                overwrite: query.overwrite.unwrap_or(true),
                ..CopyOptions::default()
            },
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
    let litebox = match get_or_resume_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let stream = match litebox
        .copy_out_stream(&query.path, CopyOptions::default())
        .await
    {
        Ok(stream) => stream,
        Err(e) => return error_from_boxlite(&e),
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/x-tar")
        .body(Body::from_stream(stream))
        .unwrap()
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    mod streaming;

    use std::collections::HashMap;
    use std::sync::Arc;

    use axum::Json;
    use axum::extract::{Path, Query};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use tokio::sync::RwLock;

    use super::super::super::types::FileQuery;
    use super::super::super::{AppState, BoxliteRuntime};
    use super::download_files;

    const BOX_ID: &str = "01HJK4TNRPQSXYZ8WM6NCVT9R5";
    const GUEST_CANARY: &str = "bui-1725-host-canary";

    struct GuestUpstream {
        url: String,
        task: tokio::task::JoinHandle<()>,
    }

    /// Simulate the guest copy protocol with a directory containing links that
    /// leave the guest namespace and point at temporary host files.
    async fn guest_upstream() -> (GuestUpstream, tempfile::TempDir) {
        let host_root = tempfile::tempdir().expect("create host fixture root");
        let linked_file = host_root.path().join("linked-file.txt");
        std::fs::write(&linked_file, GUEST_CANARY).expect("write linked host file");

        let linked_dir = host_root.path().join("linked-dir");
        std::fs::create_dir_all(&linked_dir).expect("create linked host directory");
        std::fs::write(linked_dir.join("nested.txt"), GUEST_CANARY)
            .expect("write linked host file in directory");

        let guest_dir = host_root.path().join("probe");
        std::fs::create_dir_all(&guest_dir).expect("create guest directory");
        std::fs::write(guest_dir.join("regular.txt"), "guest-owned")
            .expect("write guest-owned file");
        std::os::unix::fs::symlink(&linked_file, guest_dir.join("host-file"))
            .expect("create guest file link");
        std::os::unix::fs::symlink(&linked_dir, guest_dir.join("host-dir"))
            .expect("create guest directory link");

        let mut builder = tar::Builder::new(Vec::new());
        builder.follow_symlinks(false);
        builder
            .append_dir_all("probe", &guest_dir)
            .expect("pack guest fixture");
        let guest_tar = builder.into_inner().expect("finish guest fixture");

        let box_info = serde_json::json!({
            "box_id": BOX_ID,
            "name": "download-box",
            "status": "running",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "pid": null,
            "image": "alpine:latest",
            "cpus": 1,
            "memory_mib": 512,
            "auto_stop": 0,
            "auto_delete": 0,
            "auto_resume": true,
        });

        let app = axum::Router::new()
            .route(
                "/v1/boxes/{id}",
                axum::routing::get(
                    move |axum::extract::Path(id): axum::extract::Path<String>| {
                        let box_info = box_info.clone();
                        async move {
                            assert_eq!(id, BOX_ID);
                            Json(box_info).into_response()
                        }
                    },
                ),
            )
            .route(
                "/v1/boxes/{id}/files",
                axum::routing::get(move || async move {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/x-tar")
                        .body(axum::body::Body::from(guest_tar.clone()))
                        .expect("build guest download response")
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind guest upstream");
        let url = format!("http://{}", listener.local_addr().expect("guest address"));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        (GuestUpstream { url, task }, host_root)
    }

    #[tokio::test]
    async fn download_preserves_guest_symlinks_without_reading_their_targets() {
        let (upstream, host_root) = guest_upstream().await;
        let runtime = BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(upstream.url.clone()))
            .expect("REST runtime");
        let state = Arc::new(AppState {
            runtime,
            boxes: RwLock::new(HashMap::new()),
            executions: RwLock::new(HashMap::new()),
            api_key: None,
            lifecycle: RwLock::new(HashMap::new()),
            last_activity: RwLock::new(HashMap::new()),
            recovered_terminals: RwLock::new(HashMap::new()),
            browser_sessions: Default::default(),
            admission_locks: Default::default(),
            agent_turns: tokio::sync::Mutex::new(HashMap::new()),
        });

        let response = download_files(
            axum::extract::State(Arc::clone(&state)),
            Path(BOX_ID.to_string()),
            Query(FileQuery {
                path: "/probe".to_string(),
                overwrite: None,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read response body");
        assert!(
            !String::from_utf8_lossy(&body).contains(GUEST_CANARY),
            "download response leaked a linked host file"
        );

        let mut archive = tar::Archive::new(&body[..]);
        let mut saw_file_link = false;
        let mut saw_dir_link = false;
        for entry in archive.entries().expect("read response entries") {
            let mut entry = entry.expect("read response entry");
            let name = entry.path().expect("entry path").to_path_buf();
            let header = entry.header();

            if name.ends_with("regular.txt") {
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut bytes).expect("read regular file");
                let contents = String::from_utf8_lossy(&bytes);
                assert_eq!(contents, "guest-owned");
            } else if name.ends_with("host-file") {
                assert_eq!(header.entry_type(), tar::EntryType::Symlink);
                assert_eq!(
                    header
                        .link_name()
                        .expect("link name")
                        .map(|value| value.to_path_buf()),
                    Some(host_root.path().join("linked-file.txt"))
                );
                saw_file_link = true;
            } else if name.ends_with("host-dir") {
                assert_eq!(header.entry_type(), tar::EntryType::Symlink);
                assert_eq!(
                    header
                        .link_name()
                        .expect("link name")
                        .map(|value| value.to_path_buf()),
                    Some(host_root.path().join("linked-dir"))
                );
                saw_dir_link = true;
            }
        }

        assert!(saw_file_link, "guest file link must remain a link entry");
        assert!(
            saw_dir_link,
            "guest directory link must remain a link entry"
        );
        upstream.task.abort();
    }
}
