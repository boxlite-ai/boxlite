use std::sync::{Arc, Mutex};

use axum::{Json, Router, routing::post};
use serde_json::{Value, json};
use tokio::{net::TcpListener, process::Command};

#[tokio::test]
async fn memory_mib_survives_cli_and_rest_without_rounding() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let app = Router::new().route(
        "/v1/boxes",
        post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                captured.lock().unwrap().push(body.clone());
                Json(
                    json!({"box_id": "memory", "status": "configured", "image": "alpine",
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
                "cpus": 1, "memory_mib": body.get("memory_mib").cloned().unwrap_or(json!(1024))}),
                )
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = tempfile::tempdir().unwrap();
    for memory in [
        None,
        Some(256_u32),
        Some(257),
        Some(513),
        Some(768),
        Some(1536),
        Some(u32::MAX),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_boxlite"));
        command
            .arg("--home")
            .arg(home.path())
            .args(["--url", &url, "create"]);
        if let Some(memory) = memory {
            command.arg("--memory").arg(memory.to_string());
        }
        let output = command.arg("alpine").output().await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests.last().unwrap().get("memory_mib"),
            memory.map(|v| json!(v)).as_ref()
        );
    }
    let count = requests.lock().unwrap().len();
    for memory in ["0", "-1", "255", "256.5", "4294967296"] {
        let output = Command::new(env!("CARGO_BIN_EXE_boxlite"))
            .arg("--home")
            .arg(home.path())
            .args(["--url", &url, "create", "--memory", memory, "alpine"])
            .output()
            .await
            .unwrap();
        assert!(!output.status.success(), "accepted {memory}");
    }
    assert_eq!(requests.lock().unwrap().len(), count);
    server.abort();
}
