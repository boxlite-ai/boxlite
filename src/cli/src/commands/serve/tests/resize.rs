//! Resize HTTP validation and state errors without starting a VM.

use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_queries_preserve_idle_time_but_explicit_targets_count_as_activity() {
    let home = tempfile::tempdir().unwrap();
    let runtime = BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
        home_dir: home.path().join("boxlite"),
        ..Default::default()
    })
    .unwrap();
    let bx = runtime
        .create(boxlite::BoxOptions::default(), None)
        .await
        .unwrap();
    let id = bx.id().to_string();
    let state = Arc::new(AppState {
        runtime,
        boxes: RwLock::new(HashMap::new()),
        executions: RwLock::new(HashMap::new()),
        recovered_terminals: RwLock::new(HashMap::new()),
        api_key: None,
        lifecycle: RwLock::new(HashMap::new()),
        last_activity: RwLock::new(HashMap::new()),
    });
    let idle_since = std::time::Instant::now() - std::time::Duration::from_secs(60);
    state
        .last_activity
        .write()
        .await
        .insert(id.clone(), idle_since);
    let (url, server) = serve_router(Arc::clone(&state)).await;
    let client = reqwest::Client::new();
    for body in ["{}", r#"{"cpus":null,"memory_mib":null}"#] {
        let response = client
            .post(format!("{url}/v1/boxes/{id}/resize"))
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap();
        assert_ne!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            state.last_activity.read().await.get(&id),
            Some(&idle_since),
            "resource observations must not postpone AutoStop"
        );
    }
    let response = client
        .post(format!("{url}/v1/boxes/{id}/resize"))
        .json(&serde_json::json!({"cpus": 1}))
        .send()
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::NOT_FOUND);
    assert!(
        state.last_activity.read().await[&id] > idle_since,
        "an explicit resize attempt counts as activity even if the box is stopped"
    );
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_rejects_invalid_bodies_missing_boxes_and_nonrunning_boxes() {
    let home = tempfile::tempdir().unwrap();
    let runtime = BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
        home_dir: home.path().join("boxlite"),
        ..Default::default()
    })
    .unwrap();
    let bx = runtime
        .create(boxlite::BoxOptions::default(), None)
        .await
        .unwrap();
    let state = Arc::new(AppState {
        runtime,
        boxes: RwLock::new(HashMap::new()),
        executions: RwLock::new(HashMap::new()),
        recovered_terminals: RwLock::new(HashMap::new()),
        api_key: None,
        lifecycle: RwLock::new(HashMap::new()),
        last_activity: RwLock::new(HashMap::new()),
    });
    let (url, server) = serve_router(state).await;
    let client = reqwest::Client::new();
    let endpoint = format!("{url}/v1/boxes/{}/resize", bx.id());
    for body in [
        r#"{"unknown":2}"#,
        r#"{"cpus":256}"#,
        r#"{"memory_mib":-1}"#,
        "{",
    ] {
        let response = client
            .post(&endpoint)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
        let error: serde_json::Value = response.json().await.unwrap();
        assert_eq!(error["error"]["code"], "invalid_argument");
    }
    let response = client
        .post(&endpoint)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    let (status, message) = if cfg!(target_os = "linux") {
        (StatusCode::CONFLICT, "running")
    } else {
        (StatusCode::BAD_REQUEST, "Linux/KVM")
    };
    assert_eq!(response.status(), status);
    let error: serde_json::Value = response.json().await.unwrap();
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains(message)
    );
    let response = client
        .post(format!("{url}/v1/boxes/missing/resize"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    server.abort();
}
