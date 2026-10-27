//! Exercise CLI dispatch and output against the cloud snapshot HTTP contract.
use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{Method, StatusCode, Uri},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

type Requests = Arc<Mutex<Vec<(String, Value)>>>;

async fn reply(
    State(requests): State<Requests>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let route = format!("{method} {}", uri.path());
    requests.lock().unwrap().push((
        route.clone(),
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    ));
    let snap = json!({"id":"snap-1","box_id":"source","name":"cozy-otter","status":"ready","created_at":1,"container_disk_bytes":1024,"size_bytes":256});
    let bx = |id: &str, status: &str| json!({"box_id":id,"name":"worker","status":status,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":512});
    let (code, value) = match route.as_str() {
        "GET /v1/config" => (
            200,
            json!({"capabilities":{"snapshots_enabled":true,"create_from_snapshot_enabled":true}}),
        ),
        "GET /v1/acme/boxes/source" => (200, bx("source", "stopped")),
        "GET /v1/acme/boxes/child" => (200, bx("child", "running")),
        "POST /v1/acme/boxes/source/snapshots" => (201, {
            let mut v = snap;
            v["status"] = json!("creating");
            v
        }),
        "GET /v1/acme/boxes/source/snapshots/cozy-otter" | "GET /v1/acme/snapshots/snap-1" => {
            (200, snap)
        }
        "GET /v1/acme/snapshots" | "GET /v1/acme/boxes/source/snapshots" => {
            (200, json!({"snapshots":[snap]}))
        }
        "POST /v1/acme/snapshots/snap-1/boxes" => (201, bx("child", "configured")),
        "POST /v1/acme/boxes/source/snapshots/snap-1/restore" => {
            (202, json!({"id":"restore-1","status":"pending"}))
        }
        "GET /v1/acme/boxes/source/restores/restore-1" => {
            (200, json!({"id":"restore-1","status":"succeeded"}))
        }
        "DELETE /v1/acme/snapshots/snap-1" => (204, Value::Null),
        "DELETE /v1/acme/snapshots/protected" => (403, json!({"message":"denied"})),
        _ => (404, json!({"message":"missing"})),
    };
    (StatusCode::from_u16(code).unwrap(), Json(value))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_cli_round_trip_and_errors() {
    let requests = Requests::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(reply).with_state(requests.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let home = tempfile::tempdir().unwrap();
    let run = |args: &[&str], success: bool| {
        let mut cmd = assert_cmd::Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
        cmd.env_remove("BOXLITE_PROFILE")
            .env_remove("BOXLITE_REST_API_KEY")
            .args([
                "--home",
                home.path().to_str().unwrap(),
                "--url",
                &url,
                "--path-prefix",
                "acme",
            ])
            .args(args)
            .timeout(std::time::Duration::from_secs(15));
        let assertion = if success {
            cmd.assert().success()
        } else {
            cmd.assert().failure()
        };
        assertion.get_output().clone()
    };
    assert_eq!(
        run(&["snapshot", "create", "source"], true).stdout,
        b"snap-1\n"
    );
    let list = run(&["snapshot", "ls", "--format", "json"], true);
    let rows: Value = serde_json::from_slice(&list.stdout).unwrap();
    assert_eq!(rows[0]["BoxId"], "source");
    assert_eq!(rows[0]["Status"], "ready");
    assert_eq!(
        run(&["snapshot", "list", "--box", "source", "-q"], true).stdout,
        b"snap-1\n"
    );
    let get = run(&["snapshot", "inspect", "snap-1", "--format", "json"], true);
    assert_eq!(
        serde_json::from_slice::<Value>(&get.stdout).unwrap()["Name"],
        "cozy-otter"
    );
    assert_eq!(
        run(
            &[
                "create",
                "--snapshot",
                "snap-1",
                "--name",
                "worker",
                "--cpus",
                "2"
            ],
            true
        )
        .stdout,
        b"child\n"
    );
    assert_eq!(
        run(&["snapshot", "restore", "snap-1", "--box", "source"], true).stdout,
        b"source\n"
    );
    run(&["snapshot", "rm", "missing", "--force"], true);
    run(&["snapshot", "rm", "protected", "--force"], false);
    run(&["snapshot", "get", "missing"], false);
    run(&["snapshot", "delete", "snap-1"], true);
    let requests = requests.lock().unwrap();
    let creates: Vec<_> = requests
        .iter()
        .filter(|(route, _)| route == "POST /v1/acme/snapshots/snap-1/boxes")
        .collect();
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0].1["name"], "worker");
    assert_eq!(creates[0].1["options"]["cpus"], 2);
    assert!(creates[0].1["options"].get("image").is_none());
    server.abort();
}
