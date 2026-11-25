//! The CLI's complete outbound policy commands over loopback HTTP.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use assert_cmd::Command;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::IntoResponse,
};
use serde_json::{Value, json};

const BOX: &str = "/v1/tenant/boxes/policy-box";
const POLICY: &str = "/v1/tenant/boxes/policy-box/network/outbound/complete";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_outbound_cli_create_run_replace_and_inspect() {
    for deny in [None, Some(json!([])), Some(json!(["example.com"]))] {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let requests = captured.clone();
        let previous = json!({"revision":"r1", "admission": if deny.is_some() { "extended_ipv4" } else { "legacy" },
            "policy":{"mode":"enabled","allow_net":[],"deny_net":deny.clone().unwrap_or_else(|| json!([]))}});
        let mut updated = previous.clone();
        updated["revision"] = json!("r2");
        let mut newer = updated.clone();
        newer["revision"] = json!("r3");

        let app = Router::new().fallback(move |request: Request<Body>| {
            let (requests, previous, updated, newer) = (requests.clone(), previous.clone(), updated.clone(), newer.clone());
            async move {
                let (parts, body) = request.into_parts();
                let bytes = to_bytes(body, 65536).await.unwrap();
                let body: Value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() };
                let method = parts.method.as_str();
                let path = parts.uri.path();
                assert_eq!(parts.headers["authorization"], "Bearer policy-key");
                let if_match = parts.headers.get("if-match").map(|value| value.to_str().unwrap().to_owned());
                requests.lock().unwrap().push((method.to_owned(), path.to_owned(), if_match, body));
                let metadata = json!({"box_id":"policy-box", "name":"worker", "status":"running", "image":"alpine",
                    "cpus":1, "memory_mib":512, "created_at":"2026-01-01T00:00:00Z", "updated_at":"2026-01-01T00:00:00Z"});
                let (status, value, revision) = match (method, path) {
                    ("GET", "/v1/config") => (StatusCode::OK, json!({"capabilities":{"complete_outbound_policy_enabled":true}}), None),
                    ("POST", "/v1/tenant/boxes") => (StatusCode::CREATED, metadata, None),
                    ("GET", BOX) | ("POST", "/v1/tenant/boxes/policy-box/start") => (StatusCode::OK, metadata, None),
                    ("GET", POLICY) => (StatusCode::OK, previous, Some("\"r1\"")),
                    ("PUT", POLICY) => (StatusCode::OK, updated, Some("\"r2\"")),
                    ("GET", "/v1/tenant/boxes/policy-box/network/outbound/complete/status") => (StatusCode::OK,
                        json!({"persisted":newer,"runtime_persisted":newer,"observed":{"snapshot":newer,"application_state":"confirmed"},"application_state":"confirmed"}), None),
                    _ => (StatusCode::NOT_FOUND, Value::Null, None),
                };
                let mut response = (status, Json(value)).into_response();
                if let Some(revision) = revision { response.headers_mut().insert("etag", revision.parse().unwrap()); }
                response
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let home = tempfile::tempdir().unwrap();
        let mut policy = json!({"mode":"enabled"});
        if let Some(deny) = &deny {
            policy["deny_net"] = deny.clone();
        }
        let file = home.path().join("policy.json");
        std::fs::write(&file, policy.to_string()).unwrap();
        let cli = || {
            let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
            command
                .env("BOXLITE_HOME", home.path())
                .env("BOXLITE_API_KEY", "policy-key")
                .env_remove("BOXLITE_CONTEXT")
                .env_remove("BOXLITE_PROFILE")
                .env_remove("BOXLITE_SECURITY")
                .timeout(Duration::from_secs(15))
                .args(["--url", &url, "--path-prefix", "tenant"]);
            command
        };
        let path = file.to_str().unwrap();
        cli()
            .args([
                "create",
                "--outbound-policy",
                path,
                "--name",
                "worker",
                "alpine",
            ])
            .assert()
            .success();
        cli()
            .args(["run", "--detach", "--outbound-policy", path, "alpine"])
            .assert()
            .success();
        let replaced = cli()
            .args([
                "network",
                "replace-outbound",
                "policy-box",
                "--policy",
                path,
                "--expected-revision",
                "r1",
            ])
            .assert()
            .success();
        let body: Value = serde_json::from_slice(&replaced.get_output().stdout).unwrap();
        assert_eq!(body["acknowledged"]["revision"], "r2");
        assert_eq!(body["status"]["persisted"]["revision"], "r3");
        assert_eq!(body["application_verified"], false);
        let inspected = cli()
            .args(["inspect", "--outbound-policy", "policy-box"])
            .assert()
            .success();
        let body: Value = serde_json::from_slice(&inspected.get_output().stdout).unwrap();
        assert_eq!(body[0]["OutboundPolicy"]["application_state"], "confirmed");
        let requests = captured.lock().unwrap();
        let creates: Vec<_> = requests
            .iter()
            .filter(|request| request.0 == "POST" && request.1 == "/v1/tenant/boxes")
            .collect();
        assert_eq!(creates.len(), 2);
        for create in creates {
            assert_eq!(
                create.3["network"]["outbound"].get("deny_net"),
                deny.as_ref()
            );
        }
        let puts: Vec<_> = requests
            .iter()
            .filter(|request| request.0 == "PUT")
            .collect();
        assert_eq!(puts.len(), 1);
        assert_eq!(puts[0].1, POLICY);
        assert_eq!(puts[0].2.as_deref(), Some("\"r1\""));
        assert_eq!(puts[0].3.get("deny_net"), deny.as_ref());
        task.abort();
    }
}
