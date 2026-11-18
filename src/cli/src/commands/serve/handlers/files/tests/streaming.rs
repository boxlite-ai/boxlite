use super::super::upload_files;
use super::*;
use axum::body::Body;
use axum::extract::State;
use futures::StreamExt;
use std::time::Duration;
use tokio::sync::{Mutex, oneshot};

async fn file_upstream(files: axum::routing::MethodRouter) -> (GuestUpstream, Arc<AppState>) {
    let info = serde_json::json!({
        "box_id": BOX_ID, "name": "streaming", "status": "running",
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
        "pid": null, "image": "alpine:latest", "cpus": 1, "memory_mib": 512,
        "auto_stop": 0, "auto_delete": 0, "auto_resume": true,
    });
    let app = axum::Router::new()
        .route(
            "/v1/boxes/{id}",
            axum::routing::get(move || {
                let info = info.clone();
                async move { Json(info) }
            }),
        )
        .route("/v1/boxes/{id}/files", files);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let runtime = BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(url.clone())).unwrap();
    let state = Arc::new(AppState {
        runtime,
        boxes: RwLock::new(HashMap::new()),
        executions: RwLock::new(HashMap::new()),
        api_key: None,
        lifecycle: RwLock::new(HashMap::new()),
        last_activity: RwLock::new(HashMap::new()),
        recovered_terminals: RwLock::new(HashMap::new()),
    });
    (GuestUpstream { url, task }, state)
}

async fn download_upstream(body: Body) -> (GuestUpstream, Arc<AppState>) {
    let body = Arc::new(Mutex::new(Some(body)));
    file_upstream(axum::routing::get(move || {
        let body = body.clone();
        async move {
            Response::builder()
                .header("content-type", "application/x-tar")
                .body(body.lock().await.take().unwrap())
                .unwrap()
        }
    }))
    .await
}

fn payload_archive() -> Vec<u8> {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("payload");
    std::fs::write(&source, vec![42; 4 << 20]).unwrap();
    let mut builder = tar::Builder::new(Vec::new());
    builder.append_path_with_name(source, "payload").unwrap();
    builder.into_inner().unwrap()
}

#[tokio::test]
async fn download_emits_data_before_upstream_eof() {
    let mut archive = payload_archive();
    let rest = archive.split_off(1 << 20);
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let source = async_stream::stream! {
        yield Ok::<_, std::io::Error>(archive);
        let _ = release_rx.await;
        yield Ok(rest);
    };
    let (upstream, state) = download_upstream(Body::from_stream(source)).await;
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        let response = download_files(
            State(state),
            Path(BOX_ID.to_string()),
            Query(FileQuery {
                path: "/payload".into(),
                overwrite: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body().into_data_stream();
        assert!(!body.next().await.unwrap().unwrap().is_empty());
    })
    .await;
    let _ = release_tx.send(());
    upstream.task.abort();
    assert!(
        result.is_ok(),
        "download waited for the complete upstream archive"
    );
}

#[tokio::test]
async fn upload_forwards_original_archive_before_request_eof() {
    let archive = payload_archive();
    let expected = archive.clone();
    let (received_tx, received_rx) = oneshot::channel();
    let (body_tx, body_rx) = oneshot::channel();
    let signals = Arc::new(Mutex::new(Some((received_tx, body_tx))));
    let (upstream, state) = file_upstream(axum::routing::put(move |body: Body| {
        let signals = signals.clone();
        async move {
            let (received, collected) = signals.lock().await.take().unwrap();
            let mut stream = body.into_data_stream();
            let mut bytes = stream.next().await.unwrap().unwrap().to_vec();
            let _ = received.send(());
            while let Some(chunk) = stream.next().await {
                bytes.extend_from_slice(&chunk.unwrap());
            }
            let _ = collected.send(bytes);
            StatusCode::NO_CONTENT
        }
    }))
    .await;
    let app = axum::Router::new()
        .route("/files/{id}", axum::routing::put(upload_files))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/files/{BOX_ID}?path=/target",
        listener.local_addr().unwrap()
    );
    let front = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let mut first = archive;
    let rest = first.split_off(1 << 20);
    let source = async_stream::stream! {
        yield Ok::<_, std::io::Error>(first);
        let _ = release_rx.await;
        yield Ok(rest);
    };
    let upload = tokio::spawn(async move {
        reqwest::Client::new()
            .put(url)
            .body(reqwest::Body::wrap_stream(source))
            .send()
            .await
            .unwrap()
    });
    let progress = tokio::time::timeout(Duration::from_secs(2), received_rx).await;
    let _ = release_tx.send(());
    let response = upload.await.unwrap();
    let delivered = body_rx.await.unwrap();
    front.abort();
    upstream.task.abort();
    assert!(
        progress.is_ok(),
        "upload collected the request before forwarding data"
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        delivered, expected,
        "the server must relay the archive without wrapping or repacking it"
    );
}

#[tokio::test]
async fn raw_rest_upload_refuses_no_overwrite_without_polling_input() {
    let (upstream, state) = file_upstream(axum::routing::put(|| async {
        panic!("an unsupported upload must not reach HTTP");
        #[expect(
            unreachable_code,
            reason = "The panic sentinel still needs an HTTP response type."
        )]
        StatusCode::NO_CONTENT
    }))
    .await;
    let bx = state.runtime.get(BOX_ID).await.unwrap().unwrap();
    let source = futures::stream::once(async {
        panic!("an unsupported upload must not poll its source");
        #[expect(
            unreachable_code,
            reason = "The panic sentinel still needs the stream's item type."
        )]
        Ok::<_, std::io::Error>(Vec::new())
    });
    let error = bx
        .copy_in_stream(
            source,
            "/target",
            boxlite::CopyOptions::default().no_overwrite(),
        )
        .await
        .unwrap_err();
    upstream.task.abort();
    assert!(
        matches!(error, boxlite::BoxliteError::Unsupported(_)),
        "{error:?}"
    );
}

#[tokio::test]
async fn download_propagates_an_error_after_the_tar_end_marker() {
    let archive = payload_archive();
    let expected = archive.clone();
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let source = async_stream::stream! {
        yield Ok::<_, std::io::Error>(archive);
        let _ = release_rx.await;
        yield Err(std::io::Error::other("source failed after the tar end marker"));
    };
    let (upstream, state) = download_upstream(Body::from_stream(source)).await;
    let response = tokio::time::timeout(
        Duration::from_secs(2),
        download_files(
            State(state),
            Path(BOX_ID.to_string()),
            Query(FileQuery {
                path: "/payload".into(),
                overwrite: None,
            }),
        ),
    )
    .await
    .expect("response headers must not wait for EOF");
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body().into_data_stream();
    let mut received = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), async {
        while received.len() < expected.len() {
            received.extend_from_slice(&body.next().await.unwrap().unwrap());
        }
    })
    .await
    .unwrap();
    release_tx.send(()).unwrap();
    let terminal = tokio::time::timeout(Duration::from_secs(2), body.next())
        .await
        .unwrap();
    upstream.task.abort();
    assert_eq!(received, expected);
    assert!(
        terminal.unwrap().is_err(),
        "a transport failure after a valid tar must not become EOF"
    );
}

#[tokio::test]
async fn dropping_a_download_releases_the_rest_source() {
    let (dropped_tx, dropped_rx) = oneshot::channel::<()>();
    let source = async_stream::stream! {
        let _lifetime = dropped_tx;
        yield Ok::<_, std::io::Error>(vec![42; 1 << 20]);
        std::future::pending::<()>().await;
    };
    let (upstream, state) = download_upstream(Body::from_stream(source)).await;
    let response = tokio::time::timeout(
        Duration::from_secs(2),
        download_files(
            State(state),
            Path(BOX_ID.to_string()),
            Query(FileQuery {
                path: "/payload".into(),
                overwrite: None,
            }),
        ),
    )
    .await
    .expect("response must stream before EOF");
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body().into_data_stream();
    assert!(!body.next().await.unwrap().unwrap().is_empty());
    drop(body);
    let released = tokio::time::timeout(Duration::from_secs(5), dropped_rx).await;
    upstream.task.abort();
    assert!(
        released.is_ok(),
        "dropping the HTTP relay must release the idle upstream source"
    );
}

#[tokio::test]
async fn cancelling_a_raw_rest_upload_releases_its_source() {
    let (received_tx, received_rx) = oneshot::channel();
    let received = Arc::new(Mutex::new(Some(received_tx)));
    let (upstream, state) = file_upstream(axum::routing::put(move |body: Body| {
        let received = received.clone();
        async move {
            let mut body = body.into_data_stream();
            body.next().await.unwrap().unwrap();
            received.lock().await.take().unwrap().send(()).unwrap();
            while let Some(chunk) = body.next().await {
                if chunk.is_err() {
                    return StatusCode::BAD_REQUEST;
                }
            }
            StatusCode::NO_CONTENT
        }
    }))
    .await;
    let bx = state.runtime.get(BOX_ID).await.unwrap().unwrap();
    let (dropped_tx, dropped_rx) = oneshot::channel::<()>();
    let source = async_stream::stream! {
        let _lifetime = dropped_tx;
        yield Ok::<_, std::io::Error>(vec![42; 1 << 20]);
        std::future::pending::<()>().await;
    };
    let upload =
        tokio::spawn(bx.copy_in_stream(source, "/target", boxlite::CopyOptions::default()));
    tokio::time::timeout(Duration::from_secs(2), received_rx)
        .await
        .unwrap()
        .unwrap();
    upload.abort();
    assert!(upload.await.unwrap_err().is_cancelled());
    let released = tokio::time::timeout(Duration::from_secs(5), dropped_rx).await;
    upstream.task.abort();
    assert!(
        released.is_ok(),
        "cancelled REST upload retained the idle source"
    );
}
