//! Resize HTTP validation and state errors without starting a VM.

use super::*;

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
