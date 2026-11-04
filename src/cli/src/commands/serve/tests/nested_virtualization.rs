//! Real serve routes over a test-host runtime; no VM is started.
use super::*;
use boxlite::experimental::{ExperimentalFeatures, RuntimeBuilder};
use serde_json::{Value, json};

struct Server {
    state: Arc<AppState>,
    url: String,
    task: tokio::task::JoinHandle<()>,
    _home: tempfile::TempDir,
}

async fn server(enabled: bool) -> Server {
    let home = tempfile::tempdir().unwrap();
    let features =
        ExperimentalFeatures::parse(if enabled { "nested-virtualization" } else { "" }).unwrap();
    let runtime = RuntimeBuilder::new(boxlite::BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .with_features(features)
    .build_for_test()
    .unwrap();
    let mut state = lifecycle_state();
    state.runtime = runtime;
    state.nested_virtualization_enabled = enabled;
    state.api_key = Some("nested-api-test-key".into());
    let state = Arc::new(state);
    let (url, task) = serve_router(state.clone()).await;
    Server {
        state,
        url,
        task,
        _home: home,
    }
}

async fn finish(server: Server) {
    server.task.abort();
    let _ = server.task.await;
    server.state.runtime.shutdown(None).await.unwrap();
}

#[tokio::test]
async fn nested_virtualization_discovery_and_direct_authorization_agree() {
    let server = server(false).await;
    let client = reqwest::Client::new();
    let config: Value = client
        .get(format!("{}/v1/config", server.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        config["capabilities"]["nested_virtualization_enabled"],
        false
    );
    let response = client
        .post(format!("{}/v1/boxes", server.url))
        .bearer_auth("nested-api-test-key")
        .json(&json!({"image":"alpine:latest", "advanced":{"nested_virtualization":true}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["error"]["code"], "unsupported");
    assert!(server.state.runtime.list_info().await.unwrap().is_empty());
    finish(server).await;
}

#[tokio::test]
async fn nested_virtualization_sdk_to_serve_confirms_persisted_metadata() {
    let server = server(true).await;
    let remote = BoxliteRuntime::rest(
        boxlite::BoxliteRestOptions::new(&server.url).with_api_key("nested-api-test-key"),
    )
    .unwrap();
    let mut options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        ..Default::default()
    };
    options.advanced.nested_virtualization = true;
    let sandbox = remote
        .create(options.clone(), Some("nested".into()))
        .await
        .unwrap();
    let info = sandbox.info().await.unwrap();
    assert_eq!(info.advanced.unwrap().nested_virtualization, Some(true));
    let saved = server
        .state
        .runtime
        .get_info("nested")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.advanced.unwrap().nested_virtualization, Some(true));
    let listed = remote.list_info().await.unwrap();
    assert_eq!(
        listed[0].advanced.as_ref().unwrap().nested_virtualization,
        Some(true)
    );
    let (_, created) = remote
        .get_or_create(options, Some("nested".into()))
        .await
        .unwrap();
    assert!(!created);
    finish(server).await;
}

#[tokio::test]
async fn nested_virtualization_serve_defaults_false_and_rejects_bad_types() {
    let server = server(true).await;
    let client = reqwest::Client::new();
    for nested in [Value::Null, json!("true"), json!(1), json!({}), json!([])] {
        let response = client
            .post(format!("{}/v1/boxes", server.url))
            .bearer_auth("nested-api-test-key")
            .json(&json!({"advanced":{"nested_virtualization":nested}}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["error"]["code"], "invalid_argument");
    }
    assert!(server.state.runtime.list_info().await.unwrap().is_empty());
    for advanced in [None, Some(json!({"nested_virtualization":false}))] {
        let mut body = json!({"image":"alpine:latest"});
        if let Some(advanced) = advanced {
            body["advanced"] = advanced;
        }
        let response = client
            .post(format!("{}/v1/boxes", server.url))
            .bearer_auth("nested-api-test-key")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let created: Value = response.json().await.unwrap();
        assert_eq!(created["advanced"]["nested_virtualization"], false);
        assert!(created["advanced"].get("security").is_none());
    }
    finish(server).await;
}

#[tokio::test]
async fn nested_virtualization_serve_keeps_api_key_boundary() {
    let server = server(true).await;
    let response = reqwest::Client::new()
        .post(format!("{}/v1/boxes", server.url))
        .json(&json!({"advanced":{"nested_virtualization":true}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(server.state.runtime.list_info().await.unwrap().is_empty());
    finish(server).await;
}
