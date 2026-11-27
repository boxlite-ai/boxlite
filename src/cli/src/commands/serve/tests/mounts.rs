use axum::Extension;
use serde_json::Value;

use super::*;

async fn start_app(enabled: bool, authenticated: bool) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut state = lifecycle_state();
    if authenticated {
        state.api_key = Some("mount-test-key".into());
    }
    let mut router = serve_app(
        Arc::new(state),
        browser_guard::BrowserGuard::new("127.0.0.1", &[]),
    );
    if enabled {
        router = router.layer(Extension(
            ExperimentalFeatures::parse("native-vmm").unwrap(),
        ));
    }
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, task)
}

const COLLECTION: &str = "/v1/boxes/missing/mounts";

async fn assert_error(response: reqwest::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"]["code"],
        code
    );
}

#[tokio::test]
async fn runtime_mount_routes_gate_all_operations_before_parsing() {
    let (url, server) = start_app(false, false).await;
    let client = reqwest::Client::new();
    let config = client
        .get(format!("{url}/v1/config"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(config["capabilities"]["runtime_mounts_enabled"], false);
    for (method, suffix) in [
        (reqwest::Method::POST, ""),
        (reqwest::Method::GET, ""),
        (reqwest::Method::GET, "/by-target"),
        (reqwest::Method::DELETE, "/by-target"),
    ] {
        let response = client
            .request(method, format!("{url}{COLLECTION}{suffix}"))
            .send()
            .await
            .unwrap();
        assert_error(response, StatusCode::BAD_REQUEST, "unsupported").await;
    }
    server.abort();
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[tokio::test]
async fn runtime_mount_routes_preserve_authentication_and_strict_targets() {
    let (url, server) = start_app(true, true).await;
    let client = reqwest::Client::new();
    let config = client
        .get(format!("{url}/v1/config"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(config["capabilities"]["runtime_mounts_enabled"], true);
    for (method, suffix) in [
        (reqwest::Method::POST, ""),
        (reqwest::Method::GET, ""),
        (reqwest::Method::GET, "/by-target"),
        (reqwest::Method::DELETE, "/by-target"),
    ] {
        let response = client
            .request(method, format!("{url}{COLLECTION}{suffix}"))
            .send()
            .await
            .unwrap();
        assert_error(response, StatusCode::UNAUTHORIZED, "unauthenticated").await;
    }
    for (method, suffix) in [
        (reqwest::Method::GET, "/by-target"),
        (reqwest::Method::GET, "/by-target?target="),
        (reqwest::Method::GET, "/by-target?target=%2Fbad%FF"),
        (reqwest::Method::DELETE, "/by-target?target=%2Fbad%FF"),
        (reqwest::Method::DELETE, "/by-target?target=/a&%74arget=/b"),
    ] {
        let response = client
            .request(method, format!("{url}{COLLECTION}{suffix}"))
            .bearer_auth("mount-test-key")
            .send()
            .await
            .unwrap();
        assert_error(response, StatusCode::BAD_REQUEST, "invalid_argument").await;
    }
    let response = client
        .post(format!("{url}{COLLECTION}"))
        .bearer_auth("mount-test-key")
        .json(&serde_json::json!({"source": "/"}))
        .send()
        .await
        .unwrap();
    assert_error(response, StatusCode::BAD_REQUEST, "invalid_argument").await;
    server.abort();
}
