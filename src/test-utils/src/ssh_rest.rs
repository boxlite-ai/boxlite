//! Local REST peer for exercising native SDK SSH boundaries without a VM.

use std::sync::{Arc, Mutex};

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde_json::{Value, json};

#[derive(Default)]
struct PeerState {
    requests: Vec<(String, Value)>,
    fail: bool,
}

pub struct SshRestServer {
    pub url: String,
    state: Arc<Mutex<PeerState>>,
    task: tokio::task::JoinHandle<()>,
}

impl SshRestServer {
    pub async fn start() -> Self {
        let state = Arc::new(Mutex::new(PeerState::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = axum::Router::new()
            .fallback(request)
            .with_state(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, state, task }
    }

    pub fn fail(&self) {
        self.state.lock().unwrap().fail = true;
    }

    pub fn requests(&self) -> Vec<(String, Value)> {
        self.state.lock().unwrap().requests.clone()
    }
}

impl Drop for SshRestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn request(
    State(state): State<Arc<Mutex<PeerState>>>,
    req: axum::extract::Request,
) -> axum::response::Response {
    let path = req.uri().path().to_owned();
    let method = req.method().to_string();
    let body = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    let mut state = state.lock().unwrap();
    state.requests.push((format!("{method} {path}"), body));
    if path == "/v1/boxes/ssh-test" {
        return Json(json!({"box_id":"ssh-test","name":null,"status":"running","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256})).into_response();
    }
    if ![
        "/v1/boxes/ssh-test/ssh",
        "/v1/boxes/ssh-test/ssh/configure",
        "/v1/boxes/ssh-test/ssh/disable",
    ]
    .contains(&path.as_str())
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if state.fail {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":{"message":"sentinel-private credentials from server","type":"InvalidArgumentError","code":"invalid_argument"}}))).into_response();
    }
    Json(json!({"enabled":!path.ends_with("/disable"),"generation":u64::MAX,"listen_address":"addr","host_public_key":"public","host_key_fingerprint":"fp"})).into_response()
}
