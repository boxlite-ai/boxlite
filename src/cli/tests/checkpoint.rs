//! Real CLI commands against a loopback REST endpoint; no guest VM is used.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use assert_cmd::Command;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::IntoResponse,
};
use predicates::str::contains;
use serde_json::{Value, json};
use tempfile::TempDir;

#[derive(Clone, Debug)]
struct Recorded {
    method: String,
    path: String,
    query: String,
    body: Value,
    bearer: String,
    content_type: String,
    bytes: Vec<u8>,
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn start(
        handler: impl Fn(&Recorded) -> (StatusCode, Value) + Send + Sync + 'static,
    ) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let handler = Arc::new(handler);
        let app = Router::new().fallback(move |request: Request<Body>| {
            let captured = captured.clone();
            let handler = handler.clone();
            async move {
                let mut recorded = Recorded {
                    method: request.method().to_string(),
                    path: request.uri().path().into(),
                    query: request.uri().query().unwrap_or_default().into(),
                    body: Value::Null,
                    bearer: request
                        .headers()
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .into(),
                    content_type: request
                        .headers()
                        .get("content-type")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .into(),
                    bytes: Vec::new(),
                };
                let body = to_bytes(request.into_body(), 65536).await.unwrap();
                if !body.is_empty() && recorded.content_type == "application/json" {
                    recorded.body = serde_json::from_slice(&body).unwrap();
                }
                recorded.bytes = body.to_vec();
                let response = handler(&recorded);
                captured.lock().unwrap().push(recorded);
                (response.0, Json(response.1)).into_response()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            url,
            requests,
            task,
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn cli(home: &TempDir, server: &Server) -> Command {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    command
        .env("BOXLITE_HOME", home.path())
        .env("BOXLITE_API_KEY", "cp-key")
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_CONTEXT")
        .env_remove("BOXLITE_PROFILE")
        .env_remove("BOXLITE_REST_PATH_PREFIX")
        .env_remove("BOXLITE_SECURITY")
        .timeout(Duration::from_secs(15))
        .args(["--url", &server.url, "--path-prefix", "tenant"]);
    for variable in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env_remove(variable);
    }
    command
}

fn info(id: &str) -> Value {
    json!({"id": id, "name": "base", "source_box_id": "source-box",
        "created_at": "2026-11-05T00:00:00Z", "size_bytes": 4096, "state": "ready"})
}

fn box_info() -> Value {
    json!({"box_id": "cloudBox1234", "name": "worker", "status": "stopped",
        "created_at": "2026-11-05T00:00:00Z", "updated_at": "2026-11-05T00:00:00Z",
        "image": "example/app:base", "cpus": 3, "memory_mib": 768})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_create_list_get_delete_use_the_tenant_and_expected_request_shapes() {
    let home = TempDir::new().unwrap();
    let server = Server::start(|request| {
        if request.method == "DELETE" {
            return (StatusCode::OK, json!({}));
        }
        if request.method == "GET" && request.path.ends_with("/checkpoints") {
            (
                StatusCode::OK,
                json!({"checkpoints": [info("checkpoint-1")]}),
            )
        } else {
            (StatusCode::OK, info("checkpoint-1"))
        }
    })
    .await;
    cli(&home, &server)
        .args(["checkpoint", "create", "source-box", "--name", "base"])
        .assert()
        .success()
        .stdout("checkpoint-1\n");
    cli(&home, &server)
        .args(["checkpoint", "list", "--format", "json"])
        .assert()
        .success()
        .stdout(contains("checkpoint-1"));
    cli(&home, &server)
        .args(["checkpoint", "get", "checkpoint-1"])
        .assert()
        .success()
        .stdout(contains("\"state\": \"ready\""));
    cli(&home, &server)
        .args(["checkpoint", "delete", "checkpoint-1"])
        .assert()
        .success()
        .stdout("checkpoint-1\n");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(
        requests
            .iter()
            .all(|request| request.bearer == "Bearer cp-key")
    );
    assert_eq!(requests[0].path, "/v1/tenant/checkpoints");
    assert_eq!(
        requests[0].body,
        json!({"source_box_id":"source-box","name":"base"})
    );
    assert_eq!(requests[1].path, "/v1/tenant/checkpoints");
    assert_eq!(requests[2].path, "/v1/tenant/checkpoints/checkpoint-1");
    assert_eq!(requests[3].method, "DELETE");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_import_inherits_config_and_replacement_keeps_the_public_box_id() {
    let home = TempDir::new().unwrap();
    let server = Server::start(|_| (StatusCode::OK, box_info())).await;
    cli(&home, &server)
        .args(["import", "--checkpoint", "checkpoint-1", "--name", "worker"])
        .assert()
        .success()
        .stdout("cloudBox1234\n");
    cli(&home, &server)
        .args([
            "import",
            "--box",
            "cloudBox1234",
            "--checkpoint",
            "checkpoint-1",
        ])
        .assert()
        .success()
        .stdout("cloudBox1234\n");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].path, "/v1/tenant/boxes/import");
    assert_eq!(
        requests[0].body,
        json!({"checkpoint_id":"checkpoint-1","name":"worker"})
    );
    assert_eq!(requests[1].path, "/v1/tenant/boxes/import");
    assert_eq!(
        requests[1].body,
        json!({"checkpoint_id":"checkpoint-1","box_id":"cloudBox1234"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_list_and_get_render_captured_metadata_as_tables() {
    let home = TempDir::new().unwrap();
    let server = Server::start(|request| {
        let body = if request.path.ends_with("/checkpoints") {
            json!({"checkpoints":[info("checkpoint-1")]})
        } else {
            info("checkpoint-1")
        };
        (StatusCode::OK, body)
    })
    .await;
    for arguments in [
        vec!["checkpoint", "list"],
        vec!["checkpoint", "get", "checkpoint-1", "--format", "table"],
    ] {
        cli(&home, &server)
            .args(arguments)
            .assert()
            .success()
            .stdout(contains("ID"))
            .stdout(contains("SOURCE"))
            .stdout(contains("checkpoint-1"))
            .stdout(contains("source-box"))
            .stdout(contains("ready"));
    }
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_import_entry_keeps_ordinary_binary_archive_uploads() {
    let home = TempDir::new().unwrap();
    let server = Server::start(|request| {
        let body = if request.path.ends_with("/config") {
            json!({"capabilities":{"import_enabled":true}})
        } else {
            box_info()
        };
        (StatusCode::OK, body)
    })
    .await;
    let bytes = b"archive\x00\xffbytes";
    let archive = home.path().join("saved.boxlite");
    std::fs::write(&archive, bytes).unwrap();
    cli(&home, &server)
        .arg("import")
        .arg(&archive)
        .args(["--name", "worker"])
        .assert()
        .success()
        .stdout("cloudBox1234\n");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/v1/config");
    assert_eq!(requests[1].method, "POST");
    assert_eq!(requests[1].path, "/v1/tenant/boxes/import");
    assert_eq!(requests[1].query, "name=worker");
    assert_eq!(requests[1].content_type, "application/octet-stream");
    assert_eq!(requests[1].bytes, bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_flag_does_not_add_fields_to_ordinary_box_creation() {
    let home = TempDir::new().unwrap();
    let server = Server::start(|_| (StatusCode::OK, box_info())).await;
    cli(&home, &server)
        .args(["create", "example/app:base", "--name", "worker"])
        .assert()
        .success();
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/v1/tenant/boxes");
    assert_eq!(requests[0].body["image"], "example/app:base");
    assert!(requests[0].body.get("checkpoint_id").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_creation_refuses_execution_overrides_before_sending_requests() {
    let home = TempDir::new().unwrap();
    let server = Server::start(|_| panic!("a rejected command must not reach the server")).await;
    for flags in [
        vec!["--cpus", "2"],
        vec!["--memory", "256"],
        vec!["-e", "A=B"],
        vec!["--entrypoint", "/bin/sh"],
        vec!["--network", "disabled"],
        vec!["-v", "/tmp:/tmp"],
    ] {
        let mut command = cli(&home, &server);
        command
            .args(["import", "--checkpoint", "checkpoint-1"])
            .args(flags)
            .assert()
            .failure()
            .stderr(contains("unexpected argument"));
    }
    assert!(server.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_list_follows_encoded_pagination_and_refuses_repeated_tokens() {
    let home = TempDir::new().unwrap();
    let server = Server::start(|request| {
        if request.query.is_empty() {
            (
                StatusCode::OK,
                json!({"checkpoints":[info("first")],"next_page_token":"next&not=another"}),
            )
        } else {
            (StatusCode::OK, json!({"checkpoints":[info("second")]}))
        }
    })
    .await;
    cli(&home, &server)
        .args(["checkpoint", "list", "--quiet"])
        .assert()
        .success()
        .stdout("first\nsecond\n");
    assert_eq!(
        server.requests.lock().unwrap()[1].query,
        "page_token=next%26not%3Danother"
    );

    let repeating = Server::start(|_| {
        (
            StatusCode::OK,
            json!({"checkpoints":[],"next_page_token":"same"}),
        )
    })
    .await;
    cli(&home, &repeating)
        .args(["checkpoint", "list"])
        .assert()
        .failure()
        .stderr(contains("repeated a pagination token"));
    assert_eq!(repeating.requests.lock().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_force_deletion_suppresses_absence_but_not_in_use_errors() {
    let home = TempDir::new().unwrap();
    let absent = Server::start(|_| (StatusCode::NOT_FOUND, json!({"message":"missing"}))).await;
    cli(&home, &absent)
        .args(["checkpoint", "delete", "missing", "--force"])
        .assert()
        .success();
    let busy =
        Server::start(|_| (StatusCode::CONFLICT, json!({"message":"checkpoint in use"}))).await;
    cli(&home, &busy)
        .args(["checkpoint", "delete", "busy", "--force"])
        .assert()
        .failure();
    assert_eq!(busy.requests.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_storage_flag_is_not_supported() {
    let home = TempDir::new().unwrap();
    let server = Server::start(|_| panic!("client directory must not be sent remotely")).await;
    cli(&home, &server)
        .args([
            "checkpoint",
            "--checkpoints-dir",
            "/private/checkpoints",
            "list",
        ])
        .assert()
        .failure()
        .stderr(contains("unexpected argument '--checkpoints-dir'"));
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn checkpoint_commands_require_a_rest_context_without_initializing_a_local_runtime() {
    let home = TempDir::new().unwrap();
    for args in [
        vec!["checkpoint", "list"],
        vec!["checkpoint", "create", "source"],
        vec!["import", "--checkpoint", "base", "--name", "worker"],
        vec!["import", "--checkpoint", "base", "--box", "target"],
    ] {
        Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .env("BOXLITE_HOME", home.path())
            .env_remove("BOXLITE_REST_URL")
            .env_remove("BOXLITE_API_KEY")
            .env_remove("BOXLITE_CONTEXT")
            .env_remove("BOXLITE_PROFILE")
            .env_remove("BOXLITE_REST_PATH_PREFIX")
            .timeout(Duration::from_secs(15))
            .args(args)
            .assert()
            .failure()
            .stderr(contains(
                "checkpoints are only implemented for REST runtimes",
            ));
    }
    assert!(!home.path().join("checkpoints").exists());
    assert!(!home.path().join("boxes").exists());
}
