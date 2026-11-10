//! HTTP admission over the real local runtime; native archive behavior is
//! verified separately by boxlite::runtime::checkpoints tests without a VM.

use super::*;
use serde_json::json;

fn remote_box(id: &str) -> serde_json::Value {
    json!({"box_id": id, "name": "target", "status": "stopped", "image": "alpine:latest",
        "cpus": 2, "memory_mib": 512, "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z"})
}

async fn backend(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{address}"), server)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_capture_refuses_volatile_lifecycle_deadlines() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let captures = Arc::new(AtomicUsize::new(0));
    let count = captures.clone();
    let (backend_url, backend_server) = backend(
        Router::new()
            .route(
                "/v1/boxes/{key}",
                get(|| async { Json(remote_box("original")) }),
            )
            .route(
                "/v1/checkpoints",
                post(move |Json(_): Json<serde_json::Value>| {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        Json(
                            json!({"id":"checkpoint-1","name":"base","source_box_id":"original",
                    "created_at":"2026-01-01T00:00:00Z","size_bytes":4096,"state":"ready"}),
                        )
                    }
                }),
            ),
    )
    .await;
    let temporary = tempfile::tempdir().unwrap();
    let mut state = state(&temporary);
    Arc::get_mut(&mut state).unwrap().runtime =
        BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(backend_url)).unwrap();
    let (url, server) = serve_router(state.clone()).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (auto_stop, auto_delete) in [(60, 0), (0, 120), (0, 0)] {
        state.lifecycle.write().await.insert(
            "original".into(),
            LifecyclePolicy {
                auto_stop,
                auto_delete,
            },
        );
        let response = client
            .post(format!("{url}/v1/checkpoints"))
            .bearer_auth("checkpoint-key")
            .json(&json!({"source_box_id":"target"}))
            .send()
            .await
            .unwrap();
        let expected = if auto_stop == 0 && auto_delete == 0 {
            StatusCode::CREATED
        } else {
            StatusCode::BAD_REQUEST
        };
        let status = response.status();
        let body = response.text().await.unwrap();
        assert_eq!(status, expected, "policy {auto_stop}/{auto_delete}: {body}");
        assert_eq!(
            captures.load(Ordering::SeqCst),
            usize::from(expected == StatusCode::CREATED)
        );
    }
    server.abort();
    backend_server.abort();
}

#[derive(Default)]
struct ReplacementBackend {
    current: tokio::sync::Mutex<String>,
    lookups: std::sync::atomic::AtomicUsize,
    imports: std::sync::atomic::AtomicUsize,
    first_started: tokio::sync::Notify,
    second_snapshot: tokio::sync::Notify,
    release_first: tokio::sync::Notify,
    first_finished: tokio::sync::Notify,
    release_second: tokio::sync::Notify,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_concurrent_named_replacements_evict_every_superseded_handle() {
    use axum::extract::Path;
    use std::sync::atomic::Ordering;
    let control = Arc::new(ReplacementBackend::default());
    *control.current.lock().await = "original".into();
    let read = control.clone();
    let replace = control.clone();
    let import = post(move |Json(_): Json<serde_json::Value>| {
        let replace = replace.clone();
        async move {
            let number = replace.imports.fetch_add(1, Ordering::SeqCst) + 1;
            if number == 1 {
                replace.first_started.notify_one();
                replace.release_first.notified().await;
            } else {
                replace.release_second.notified().await;
            }
            let id = format!("replacement-{number}");
            *replace.current.lock().await = id.clone();
            Json(remote_box(&id))
        }
    });
    let (backend_url, backend_server) =
        backend(Router::new().route("/v1/boxes/import", import).route(
            "/v1/boxes/{key}",
            get(move |Path(key): Path<String>| {
                let read = read.clone();
                async move {
                    let snapshot = read.current.lock().await.clone();
                    if key == "target" {
                        if read.lookups.fetch_add(1, Ordering::SeqCst) == 1 {
                            read.second_snapshot.notify_one();
                            read.first_finished.notified().await;
                        }
                        Json(remote_box(&snapshot)).into_response()
                    } else if key == snapshot {
                        Json(remote_box(&snapshot)).into_response()
                    } else {
                        (
                            StatusCode::NOT_FOUND,
                            Json(json!({"error":{"message":"missing","code":"not_found"}})),
                        )
                            .into_response()
                    }
                }
            }),
        ))
        .await;
    let temporary = tempfile::tempdir().unwrap();
    let mut state = state(&temporary);
    Arc::get_mut(&mut state).unwrap().runtime =
        BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(backend_url)).unwrap();
    let (url, server) = serve_router(state.clone()).await;
    let send = || {
        let url = url.clone();
        tokio::spawn(async move {
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(format!("{url}/v1/boxes/import"))
                .bearer_auth("checkpoint-key")
                .json(&json!({"checkpoint_id":"base","box_id":"target"}))
                .send()
                .await
                .unwrap()
        })
    };
    let first = send();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        control.first_started.notified(),
    )
    .await
    .unwrap();
    let second = send();
    // With serialization the second lookup waits for the first import; old
    // code takes the stale snapshot here. Both paths converge after release.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        control.second_snapshot.notified(),
    )
    .await;
    control.release_first.notify_one();
    let first = first.await.unwrap();
    let status = first.status();
    let body = first.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["box_id"],
        "replacement-1"
    );
    control.first_finished.notify_one();
    control.release_second.notify_one();
    let second = tokio::time::timeout(std::time::Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap();
    let status = second.status();
    let body = second.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["box_id"],
        "replacement-2"
    );
    let cache = state.boxes.read().await;
    assert!(cache.contains_key("replacement-2"));
    assert!(
        !cache.contains_key("replacement-1"),
        "superseded handle survived the second replacement"
    );
    server.abort();
    backend_server.abort();
}

fn state(temporary: &tempfile::TempDir) -> Arc<AppState> {
    Arc::new(AppState {
        runtime: BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
            home_dir: temporary.path().join("runtime"),
            checkpoints_dir: Some(temporary.path().join("archives")),
            ..Default::default()
        })
        .unwrap(),
        boxes: RwLock::new(HashMap::new()),
        executions: RwLock::new(HashMap::new()),
        recovered_terminals: RwLock::new(HashMap::new()),
        api_key: Some("checkpoint-key".into()),
        checkpoint_replacements: tokio::sync::Mutex::new(()),
        lifecycle: RwLock::new(HashMap::new()),
        last_activity: RwLock::new(HashMap::new()),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_routes_enforce_authentication_before_accessing_the_catalog() {
    let temporary = tempfile::tempdir().unwrap();
    let state = state(&temporary);
    let (url, server) = serve_router(state.clone()).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (method, path, body) in [
        (reqwest::Method::GET, "/v1/checkpoints", None),
        (
            reqwest::Method::POST,
            "/v1/checkpoints",
            Some(json!({"source_box_id":"source"})),
        ),
        (reqwest::Method::GET, "/v1/checkpoints/base", None),
        (reqwest::Method::DELETE, "/v1/checkpoints/base", None),
        (
            reqwest::Method::POST,
            "/v1/boxes/import",
            Some(json!({"checkpoint_id":"base","box_id":"source"})),
        ),
    ] {
        let mut request = client.request(method, format!("{url}{path}"));
        if let Some(body) = body {
            request = request.json(&body);
        }
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED,
            "{path}"
        );
    }
    let response = client
        .get(format!("{url}/v1/checkpoints"))
        .bearer_auth("checkpoint-key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        json!({"checkpoints":[]})
    );
    assert!(!temporary.path().join("archives").exists());
    assert!(state.runtime.list_info().await.unwrap().is_empty());
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_requests_refuse_configuration_overrides_and_keep_ordinary_create_working() {
    let temporary = tempfile::tempdir().unwrap();
    let state = state(&temporary);
    let (url, server) = serve_router(state.clone()).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for body in [
        json!({"checkpoint_id":"base","cpus":2}),
        json!({"checkpoint_id":"base","env":{"A":"B"}}),
        json!({"checkpoint_id":"base","advanced":{"privileged":false}}),
        json!({"checkpoint_id":"base","image":"alpine:latest"}),
        json!({"checkpoint_id":null,"image":"alpine:latest"}),
    ] {
        let response = client
            .post(format!("{url}/v1/boxes/import"))
            .bearer_auth("checkpoint-key")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let invalid_ordinary = client
        .post(format!("{url}/v1/boxes"))
        .bearer_auth("checkpoint-key")
        .json(&json!({"image":"example/app:base","cpus":"two"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_ordinary.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(state.runtime.list_info().await.unwrap().is_empty());
    let ordinary = client
        .post(format!("{url}/v1/boxes"))
        .bearer_auth("checkpoint-key")
        .json(&json!({"image":"example/app:base","name":"ordinary","cpus":2}))
        .send()
        .await
        .unwrap();
    assert_eq!(ordinary.status(), StatusCode::CREATED);
    let info = ordinary.json::<serde_json::Value>().await.unwrap();
    assert_eq!(info["name"], "ordinary");
    assert_eq!(info["cpus"], 2);
    assert_eq!(state.runtime.list_info().await.unwrap().len(), 1);

    let missing = client
        .post(format!("{url}/v1/boxes/import"))
        .bearer_auth("checkpoint-key")
        .json(&json!({"checkpoint_id":"missing","name":"must-not-be-created"}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(state.runtime.list_info().await.unwrap().len(), 1);
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_missing_and_force_delete_errors_keep_their_http_contracts() {
    let temporary = tempfile::tempdir().unwrap();
    let (url, server) = serve_router(state(&temporary)).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let get = client
        .get(format!("{url}/v1/checkpoints/missing"))
        .bearer_auth("checkpoint-key")
        .send()
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::NOT_FOUND);
    let delete = client
        .delete(format!("{url}/v1/checkpoints/missing"))
        .bearer_auth("checkpoint-key")
        .send()
        .await
        .unwrap();
    assert_eq!(delete.status(), StatusCode::NOT_FOUND);
    let forced = client
        .delete(format!("{url}/v1/checkpoints/missing?force=true"))
        .bearer_auth("checkpoint-key")
        .send()
        .await
        .unwrap();
    assert_eq!(forced.status(), StatusCode::NO_CONTENT);
    let capture = client
        .post(format!("{url}/v1/checkpoints"))
        .bearer_auth("checkpoint-key")
        .json(&json!({"source_box_id":"missing"}))
        .send()
        .await
        .unwrap();
    assert_eq!(capture.status(), StatusCode::NOT_FOUND);
    let recover = client
        .post(format!("{url}/v1/boxes/import"))
        .bearer_auth("checkpoint-key")
        .json(&json!({"checkpoint_id":"missing","box_id":"missing"}))
        .send()
        .await
        .unwrap();
    assert_eq!(recover.status(), StatusCode::NOT_FOUND);
    let config = client
        .get(format!("{url}/v1/config"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(config["capabilities"]["checkpoints_enabled"], true);
    server.abort();
}
