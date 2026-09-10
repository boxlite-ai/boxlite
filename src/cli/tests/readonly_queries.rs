use assert_cmd::Command;
use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

const BOX_NAME: &str = "issue-258-query-box";

fn runtime_for(home: &Path) -> BoxliteRuntime {
    BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.to_path_buf(),
        image_registries: Vec::new(),
    })
    .expect("create the process-A runtime owner")
}

async fn create_configured_box(runtime: &BoxliteRuntime) -> String {
    let handle = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("issue-258-fixture:latest".into()),
                auto_delete: Some(0),
                ..Default::default()
            },
            Some(BOX_NAME.to_string()),
        )
        .await
        .expect("persist configured box through the public Runtime API");
    let id = handle.id().to_string();
    drop(handle);
    id
}

fn cli_command(home: &Path) -> Command {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    command.timeout(Duration::from_secs(30));
    command
        .env("BOXLITE_HOME", home)
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_API_KEY")
        .env_remove("BOXLITE_PROFILE");
    command.arg("--home").arg(home);
    command
}

fn run_cli(home: &Path, args: &[&str]) -> Output {
    cli_command(home)
        .args(args)
        .output()
        .expect("run boxlite CLI child process")
}

fn assert_query_succeeded(output: &Output, query: &str) {
    assert!(
        output.status.success(),
        "`boxlite {query}` must query committed state while another process owns the Runtime lock\nstatus: {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

struct RecoverySentinels {
    temp_file: PathBuf,
    orphan_file: PathBuf,
}

impl RecoverySentinels {
    fn create(home: &Path) -> Self {
        let temp_file = home.join("tmp/issue-258-query-sentinel");
        fs::write(&temp_file, "keep").expect("create temp cleanup sentinel");

        // A normal Runtime startup treats an unrecorded box directory as an
        // orphan during recovery. Read-only queries must leave it untouched.
        let orphan_file = home.join("boxes/issue258keep/sentinel");
        fs::create_dir_all(orphan_file.parent().unwrap()).expect("create recovery sentinel dir");
        fs::write(&orphan_file, "keep").expect("create recovery sentinel file");

        Self {
            temp_file,
            orphan_file,
        }
    }

    fn assert_untouched(&self) {
        assert_eq!(
            fs::read_to_string(&self.temp_file).expect("read temp cleanup sentinel"),
            "keep",
            "read-only query must not clean the Runtime temp directory",
        );
        assert_eq!(
            fs::read_to_string(&self.orphan_file).expect("read recovery sentinel"),
            "keep",
            "read-only query must not run orphan recovery",
        );
    }
}

#[tokio::test]
async fn list_reads_committed_create_and_delete_while_another_process_owns_runtime() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = runtime_for(&home.path);
    let box_id = create_configured_box(&runtime).await;
    let sentinels = RecoverySentinels::create(&home.path);

    let created = run_cli(&home.path, &["list", "--all", "--format", "json"]);
    sentinels.assert_untouched();
    assert_query_succeeded(&created, "list --all --format json");
    let rows: Value = serde_json::from_slice(&created.stdout).expect("list output is JSON");
    let rows = rows.as_array().expect("list output is an array");
    assert!(
        rows.iter().any(|row| {
            row.get("ID").and_then(Value::as_str) == Some(box_id.as_str())
                && row.get("Names").and_then(Value::as_str) == Some(BOX_NAME)
                && row.get("Status").and_then(Value::as_str) == Some("Configured")
        }),
        "CLI list did not observe the box committed by the Runtime owner: {rows:?}",
    );

    runtime
        .remove(&box_id, false)
        .await
        .expect("delete box through the public Runtime API");
    let deleted = run_cli(&home.path, &["list", "--all", "--format", "json"]);
    sentinels.assert_untouched();
    assert_query_succeeded(&deleted, "list --all --format json after delete");
    let rows: Value = serde_json::from_slice(&deleted.stdout).expect("list output is JSON");
    assert!(
        rows.as_array()
            .expect("list output is an array")
            .iter()
            .all(|row| row.get("ID").and_then(Value::as_str) != Some(box_id.as_str())),
        "CLI list still showed a box after the Runtime owner committed its deletion",
    );
}

#[tokio::test]
async fn images_queries_while_another_process_owns_runtime() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = runtime_for(&home.path);
    let box_id = create_configured_box(&runtime).await;
    let sentinels = RecoverySentinels::create(&home.path);

    let output = run_cli(&home.path, &["images", "--format", "json"]);
    sentinels.assert_untouched();
    assert_query_succeeded(&output, "images --format json");
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).expect("images output is JSON"),
        Value::Array(Vec::new()),
        "creating a configured box must not invent an image-cache entry",
    );
    runtime
        .remove(&box_id, false)
        .await
        .expect("delete test box through the public Runtime API");
}

#[tokio::test]
async fn info_reads_committed_counts_while_another_process_owns_runtime() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = runtime_for(&home.path);
    let box_id = create_configured_box(&runtime).await;
    let sentinels = RecoverySentinels::create(&home.path);

    let output = run_cli(&home.path, &["info", "--format", "json"]);
    sentinels.assert_untouched();
    assert_query_succeeded(&output, "info --format json");
    let info: Value = serde_json::from_slice(&output.stdout).expect("info output is JSON");
    assert_eq!(info.get("boxesTotal").and_then(Value::as_u64), Some(1));
    assert_eq!(info.get("boxesConfigured").and_then(Value::as_u64), Some(1));
    assert_eq!(info.get("boxesRunning").and_then(Value::as_u64), Some(0));
    assert_eq!(info.get("boxesStopped").and_then(Value::as_u64), Some(0));
    assert_eq!(info.get("imagesCount").and_then(Value::as_u64), Some(0));
    runtime
        .remove(&box_id, false)
        .await
        .expect("delete test box through the public Runtime API");
}

#[test]
fn queries_initialize_a_fresh_home_without_contention() {
    for command in ["list", "images", "info"] {
        let home = tempfile::tempdir().unwrap();
        let output = run_cli(home.path(), &[command, "--format", "json"]);
        assert_query_succeeded(&output, command);
        assert!(home.path().join("db/boxlite.db").is_file());
    }
}

#[tokio::test]
async fn local_images_and_info_ignore_rest_url_during_contention() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let _runtime = runtime_for(&home.path);
    for command in ["images", "info"] {
        // Explicit --url is rejected by these local-only commands; the
        // existing routing contract ignores an ambient REST URL instead.
        let output = cli_command(&home.path)
            .env("BOXLITE_REST_URL", "http://127.0.0.1:1")
            .args([command, "--format", "json"])
            .output()
            .unwrap();
        assert_query_succeeded(&output, command);
        let explicit = run_cli(&home.path, &["--url", "http://127.0.0.1:1", command]);
        assert_eq!(explicit.status.code(), Some(2));
        assert!(
            String::from_utf8_lossy(&explicit.stderr)
                .contains(&format!("--url is not valid for `boxlite {command}`"))
        );
    }
}

#[tokio::test]
async fn list_keeps_rest_routing_during_local_contention() {
    use std::io::{Read, Write};
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let _runtime = runtime_for(&home.path);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        // Bound even when a routing regression means no connection arrives.
        socket2::SockRef::from(&listener)
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (mut stream, _) = listener.accept().expect("REST list must reach server");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = [0; 8192];
        let count = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..count]);
        assert!(request.starts_with("GET "), "{request}");
        let body = r#"{"error":{"message":"issue258-rest-sentinel","type":"InternalError","code":"internal"}}"#;
        write!(stream, "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let output = run_cli(&home.path, &["--url", &url, "list", "--format", "json"]);
    server.join().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("issue258-rest-sentinel"));
}
