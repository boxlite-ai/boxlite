//! HTTP admission over the real local runtime; native archive behavior is
//! verified separately by boxlite::runtime::checkpoints tests without a VM.

use super::*;
use serde_json::json;

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
            "/v1/boxes/source/recover",
            Some(json!({"checkpoint_id":"base"})),
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
            .post(format!("{url}/v1/boxes"))
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
        .post(format!("{url}/v1/boxes"))
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
        .post(format!("{url}/v1/boxes/missing/recover"))
        .bearer_auth("checkpoint-key")
        .json(&json!({"checkpoint_id":"missing"}))
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
