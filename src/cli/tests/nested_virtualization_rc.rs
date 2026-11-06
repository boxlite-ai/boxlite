use assert_cmd::Command;
use predicates::prelude::*;

mod common;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_virtualization_remote_cli_uses_server_policy() {
    use axum::{Json, extract::State, http::StatusCode};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    async fn create(
        State(requests): State<Arc<Mutex<Vec<Value>>>>,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        requests.lock().unwrap().push(body);
        (
            StatusCode::CREATED,
            Json(json!({
                "box_id":"remote-box", "status":"configured", "image":"alpine:latest",
                "cpus":1, "memory_mib":128, "pid":null,
                "created_at":"2026-01-01T00:00:00Z", "updated_at":"2026-01-01T00:00:00Z"
            })),
        )
    }
    let requests = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new()
        .route("/v1/boxes", axum::routing::post(create))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("credentials.toml"),
        format!("[profiles.cloud]\nurl = {url:?}\napi_key = 'test-key'\n"),
    )
    .unwrap();
    std::fs::write(home.path().join("cli.toml"), "current_context = 'cloud'\n").unwrap();
    let mut values = vec![
        std::ffi::OsString::from("unknown"),
        std::ffi::OsString::from("nested-virtualization"),
    ];
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        values.push(std::ffi::OsString::from_vec(vec![0xff]));
    }
    for explicit_url in [true, false] {
        for value in &values {
            let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
            command
                .arg("--home")
                .arg(home.path())
                .env("BOXLITE_EXPERIMENTAL", value)
                .env_remove("BOXLITE_REST_URL")
                .env_remove("BOXLITE_CONTEXT")
                .env_remove("BOXLITE_PROFILE")
                .env_remove("BOXLITE_REST_PATH_PREFIX")
                .timeout(std::time::Duration::from_secs(10));
            if explicit_url {
                command.args(["--url", &url]);
            }
            command.args(["create", "alpine:latest"]).assert().success();
        }
    }
    let bodies = requests.lock().unwrap();
    assert_eq!(bodies.len(), values.len() * 2);
    for body in bodies.iter() {
        assert!(
            body.get("advanced")
                .and_then(|v| v.get("nested_virtualization"))
                .is_none(),
            "{body}"
        );
    }
    server.abort();
}

/// Opens `/dev/kvm` inside the workload and creates a VM through it: proof the
/// opt-in reaches a working nested hypervisor, not just a device node.
///
/// `KVM_GET_API_VERSION` (0xAE00) always answers 12; `KVM_CREATE_VM` (0xAE01)
/// only succeeds when the host really exposes nesting.
const CREATE_NESTED_VM: &str = "\
import fcntl, os
kvm = os.open('/dev/kvm', os.O_RDWR | os.O_CLOEXEC)
api = fcntl.ioctl(kvm, 0xAE00, 0)
assert api == 12, api
vm = fcntl.ioctl(kvm, 0xAE01, 0)
assert vm >= 0, vm
print(f'nested-kvm-api={api}')
os.close(vm)
os.close(kvm)
";

/// Needs nesting-capable hardware, so it is opt-in: the self-hosted integration
/// runner sets the variable, and developers can set it on suitable machines.
#[test]
fn nested_virtualization_can_create_kvm_vm() {
    if std::env::var_os("BOXLITE_TEST_NESTED_VIRTUALIZATION").is_none() {
        eprintln!("skipping nested KVM smoke test (set BOXLITE_TEST_NESTED_VIRTUALIZATION=1)");
        return;
    }

    let mut ctx = common::boxlite();
    ctx.cmd.timeout(std::time::Duration::from_secs(180));
    ctx.cmd.env("BOXLITE_EXPERIMENTAL", "nested-virtualization");
    ctx.cmd.args([
        "run",
        "--rm",
        "python:3.12-alpine",
        "python3",
        "-c",
        CREATE_NESTED_VM,
    ]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("nested-kvm-api=12"));
}
