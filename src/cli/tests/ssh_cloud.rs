//! Real CLI selection and stdio over loopback REST/CONNECT; no VM or cloud account.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use assert_cmd::Command;
use axum::body::Bytes;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Recording {
    requests: Vec<(Method, String, String)>,
    configs: Vec<Value>,
    connect: String,
    configure_error: bool,
    disabled: bool,
    missing: bool,
    tunnel_error: bool,
    lifecycle_error: bool,
}

struct Cloud {
    url: String,
    state: Arc<Mutex<Recording>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Cloud {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn route(
    State((state, tunnel)): State<(Arc<Mutex<Recording>>, String)>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut state = state.lock().unwrap();
    state.requests.push((
        method.clone(),
        uri.to_string(),
        headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
    ));
    if state.missing || (uri.path().ends_with("/network/tunnel") && state.tunnel_error) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let reply = if uri.path().ends_with("/ssh") || uri.path().ends_with("/ssh/enable") {
        if state.lifecycle_error && (method == Method::DELETE || uri.path().ends_with("/enable")) {
            return (StatusCode::CONFLICT, "box must be running").into_response();
        }
        if uri.path().ends_with("/enable") {
            state.disabled = false;
        } else if method == Method::DELETE {
            state.disabled = true;
        }
        if method == Method::POST && uri.path().ends_with("/ssh") {
            state.configs.push(serde_json::from_slice(&body).unwrap());
            if state.configure_error {
                return (StatusCode::CONFLICT, "configuration refused").into_response();
            }
            state.disabled = false;
        }
        json!({"enabled": !state.disabled, "listen_address": "0.0.0.0:2222",
            "host_public_key": "ssh-ed25519 HOST", "host_key_fingerprint": "SHA256:host",
            "generation": 1})
    } else if uri.path().ends_with("/network/tunnel") {
        json!({"uri": tunnel})
    } else {
        json!({"box_id": "-remote", "name": "dev", "status": "running",
            "created_at": "2026-07-14T00:00:00Z", "updated_at": "2026-07-14T00:00:00Z",
            "image": "alpine:latest", "cpus": 1, "memory_mib": 512, "auto_resume": true})
    };
    axum::Json(reply).into_response()
}

impl Cloud {
    async fn start(echo: bool) -> Self {
        let state = Arc::new(Mutex::new(Recording::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tunnel = format!("http://{}", listener.local_addr().unwrap());
        let captured = state.clone();
        let transport = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(socket.read_u8().await.unwrap());
            }
            captured.lock().unwrap().connect = String::from_utf8(head).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            if echo {
                let mut bytes = Vec::new();
                socket.read_to_end(&mut bytes).await.unwrap();
                bytes.reverse();
                socket.write_all(&bytes).await.unwrap();
            } else {
                // Real OpenSSH reaches the proxy, then fails its SSH handshake.
                socket.write_all(b"not an SSH server\r\n").await.unwrap();
            }
            socket.shutdown().await.unwrap();
        });
        let app = axum::Router::new()
            .fallback(route)
            .with_state((state.clone(), tunnel));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let http = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            url,
            state,
            tasks: vec![http, transport],
        }
    }

    fn save_context(&self, home: &Path, context: &str, prefix: &str) {
        let mut profiles = toml::map::Map::new();
        for name in [context, "other", "default"] {
            profiles.insert(
                name.into(),
                toml::Value::try_from(json!({
                    "url": self.url, "path_prefix": prefix, "api_key": "stored-key"
                }))
                .unwrap(),
            );
        }
        std::fs::write(
            home.join("credentials.toml"),
            toml::to_string(&json!({"profiles": profiles})).unwrap(),
        )
        .unwrap();
        std::fs::write(
            home.join("cli.toml"),
            toml::to_string(&json!({"current_context": context})).unwrap(),
        )
        .unwrap();
    }
}

fn isolated(command: &mut Command, home: &Path) {
    command
        .env("BOXLITE_HOME", home)
        .timeout(Duration::from_secs(15));
    for name in [
        "BOXLITE_CONTEXT",
        "BOXLITE_PROFILE",
        "BOXLITE_REST_URL",
        "BOXLITE_REST_PATH_PREFIX",
        "BOXLITE_API_KEY",
        "BOXLITE_LOG_FILE",
    ] {
        command.env_remove(name);
    }
}

fn cli(home: &Path) -> Command {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    isolated(&mut command, home);
    command
}

fn setup(home: &Path, flags: &[&str]) -> String {
    let output = cli(home)
        .args(flags)
        .args(["ssh", "dev"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    String::from_utf8(output).unwrap()
}

fn key_path(summary: &str) -> PathBuf {
    summary
        .lines()
        .find_map(|line| line.strip_prefix("Private key: "))
        .unwrap()
        .into()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_control_options_preserve_context_authentication_and_saved_configuration() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    setup(home.path(), &[]);
    let config = cloud.state.lock().unwrap().configs[0].clone();
    let path = home.path().join("ssh.json");
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let output = cli(home.path())
        .args([
            "ssh",
            "dev",
            "--configure",
            "--ssh-config",
            path.to_str().unwrap(),
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        serde_json::from_slice::<Value>(&output).unwrap()["host_key_fingerprint"],
        "SHA256:host"
    );
    cloud.state.lock().unwrap().requests.clear();
    for (operation, enabled) in [
        ("--disable", false),
        ("--status", false),
        ("--enable", true),
        ("--status", true),
    ] {
        let output = cli(home.path())
            .args(["ssh", "dev", operation])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        let status: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(status["enabled"], enabled);
        assert_eq!(status["host_key_fingerprint"], "SHA256:host");
    }
    {
        let mut state = cloud.state.lock().unwrap();
        assert_eq!(state.configs, [config.clone(), config]);
        let controls: Vec<_> = state
            .requests
            .iter()
            .filter(|(_, path, _)| path.contains("/ssh"))
            .map(|(method, path, auth)| (method.as_str(), path.as_str(), auth.as_str()))
            .collect();
        assert_eq!(
            controls,
            [
                ("DELETE", "/v1/team/boxes/-remote/ssh", "Bearer stored-key"),
                ("GET", "/v1/team/boxes/-remote/ssh", "Bearer stored-key"),
                (
                    "POST",
                    "/v1/team/boxes/-remote/ssh/enable",
                    "Bearer stored-key"
                ),
                ("GET", "/v1/team/boxes/-remote/ssh", "Bearer stored-key"),
            ]
        );
        state.lifecycle_error = true;
        state.requests.clear();
    }
    for operation in ["--enable", "--disable"] {
        cli(home.path())
            .args(["ssh", "dev", operation])
            .assert()
            .failure()
            .stdout(predicates::str::is_empty())
            .stderr(predicates::str::contains("box must be running"));
    }
    assert_eq!(
        cloud.state.lock().unwrap().requests.len(),
        4,
        "one lookup and one control request, without retries"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_setup_reuses_keys_and_generated_command_preserves_routing() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    let context = "-cloud ' % $()";
    cloud.save_context(home.path(), context, "stored");
    // Named context and an explicit prefix must survive without their environment.
    let first = setup(home.path(), &["--path-prefix=-team/override"]);
    let second = setup(home.path(), &["--path-prefix=-team/override"]);
    let key = key_path(&first);
    assert_eq!(key, key_path(&second));
    assert!(key.starts_with(home.path().canonicalize().unwrap().join("ssh/remote")));
    assert!(!home.path().join("boxes").exists());
    assert!(!first.contains("CLI exit stops"));
    assert!(!first.contains("stored-key"));
    assert!(first.contains("SSH host key fingerprint: SHA256:host"));
    let configs = cloud.state.lock().unwrap().configs.clone();
    assert_eq!(configs.len(), 2);
    assert_eq!(configs[0], configs[1]);
    assert_eq!(configs[0]["listen_address"], "0.0.0.0:22");
    assert_eq!(configs[0]["accounts"][0]["login"], "box");
    assert_eq!(
        configs[0]["host_private_key"],
        std::fs::read_to_string(key.with_file_name("host_key")).unwrap()
    );

    let command = first
        .lines()
        .find_map(|line| line.strip_prefix("  ssh "))
        .unwrap();
    let mut ssh = Command::new("/bin/sh");
    isolated(&mut ssh, home.path());
    // Different saved context and environment cannot redirect the printed command.
    ssh.env("BOXLITE_CONTEXT", "other")
        .env("BOXLITE_REST_URL", "http://127.0.0.1:1")
        .env("BOXLITE_REST_PATH_PREFIX", "wrong")
        .args([
            "-c",
            &format!("ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=2 {command}"),
        ])
        .assert()
        .failure();
    let state = cloud.state.lock().unwrap();
    assert!(
        state.requests.iter().all(
            |(_, path, auth)| path.starts_with("/v1/-team/override/boxes/")
                && auth == "Bearer stored-key"
        ),
        "{:?}",
        state.requests
    );
    assert!(
        state
            .requests
            .iter()
            .any(|(method, path, _)| method == Method::POST
                && path == "/v1/-team/override/boxes/-remote/network/tunnel?port=2222")
    );
    assert!(state.connect.starts_with("CONNECT "), "{}", state.connect);
    assert!(
        state
            .connect
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer stored-key")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[rstest::rstest]
#[case("default")]
#[case("cloud")]
async fn cloud_setup_pins_empty_prefix_after_saved_context_changes(#[case] context: &str) {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), context, "");
    let summary = setup(home.path(), &[]);
    let command = summary
        .lines()
        .find_map(|line| line.strip_prefix("  ssh "))
        .unwrap();
    cloud.save_context(home.path(), context, "changed");
    cloud.state.lock().unwrap().requests.clear();

    let mut ssh = Command::new("/bin/sh");
    isolated(&mut ssh, home.path());
    ssh.env("BOXLITE_REST_PATH_PREFIX", "ambient")
        .args([
            "-c",
            &format!("ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=2 {command}"),
        ])
        .assert()
        .failure();

    let state = cloud.state.lock().unwrap();
    assert_eq!(state.requests.len(), 3, "lookup, SSH status, tunnel");
    assert!(
        state
            .requests
            .iter()
            .all(|(_, path, auth)| path.starts_with("/v1/boxes/") && auth == "Bearer stored-key"),
        "printed SSH command changed routes: {:?}",
        state.requests
    );
    assert!(state.connect.starts_with("CONNECT "), "{}", state.connect);
}

#[rstest::rstest]
#[case::inherited(None, None, "stored")]
#[case::flag_clears(Some(""), Some("ambient"), "")]
#[case::environment_clears(None, Some(""), "")]
#[case::flag_overrides(Some("explicit"), Some("ambient"), "explicit")]
#[case::environment_overrides(None, Some("ambient"), "ambient")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_path_prefix_precedence(
    #[case] flag: Option<&str>,
    #[case] environment: Option<&str>,
    #[case] expected: &str,
) {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "stored");
    let mut command = cli(home.path());
    if let Some(prefix) = flag {
        command.arg(format!("--path-prefix={prefix}"));
    }
    if let Some(prefix) = environment {
        command.env("BOXLITE_REST_PATH_PREFIX", prefix);
    }
    command.args(["ssh", "--status", "dev"]).assert().success();
    let root = if expected.is_empty() {
        "/v1/boxes/".to_string()
    } else {
        format!("/v1/{expected}/boxes/")
    };
    let state = cloud.state.lock().unwrap();
    assert_eq!(state.requests.len(), 2);
    assert!(
        state
            .requests
            .iter()
            .all(|(_, path, _)| path.starts_with(&root)),
        "unexpected routing: {:?}",
        state.requests
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_proxy_relays_binary_data_with_stored_context_and_environment_key() {
    let cloud = Cloud::start(true).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let bytes: Vec<u8> = (0..131_072).map(|n| n as u8).collect();
    let output = cli(home.path())
        .env("BOXLITE_API_KEY", "environment-key")
        .args(["ssh", "--proxy", "dev"])
        .write_stdin(bytes.clone())
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(output, bytes.into_iter().rev().collect::<Vec<_>>());
    let state = cloud.state.lock().unwrap();
    assert_eq!(state.requests.len(), 3);
    assert!(
        state
            .requests
            .iter()
            .all(|(_, path, auth)| path.starts_with("/v1/team/boxes/")
                && auth == "Bearer environment-key")
    );
    assert!(state.configs.is_empty(), "proxy must not configure SSH");
    assert!(
        state
            .connect
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer environment-key")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_tunnel_option_forwards_bytes_and_reports_server_fingerprint() {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let cloud = Cloud::start(true).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let mut command = tokio::process::Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    command.env("BOXLITE_HOME", home.path());
    for name in [
        "BOXLITE_CONTEXT",
        "BOXLITE_PROFILE",
        "BOXLITE_REST_URL",
        "BOXLITE_REST_PATH_PREFIX",
        "BOXLITE_API_KEY",
        "BOXLITE_LOG_FILE",
    ] {
        command.env_remove(name);
    }
    let mut child = command
        .args(["ssh", "dev", "--tunnel"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut address = String::new();
        stdout.read_line(&mut address).await.unwrap();
        let mut client =
            tokio::net::TcpStream::connect(address.trim().strip_prefix("tcp://").unwrap())
                .await
                .unwrap();
        client.write_all(&[0, 1, 128, 255]).await.unwrap();
        client.shutdown().await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert_eq!(response, [255, 128, 1, 0]);
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
            nix::sys::signal::Signal::SIGINT,
        )
        .unwrap();
        assert!(child.wait().await.unwrap().success());
        let mut diagnostics = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut diagnostics)
            .await
            .unwrap();
        assert!(
            diagnostics.contains("SSH host key fingerprint: SHA256:host"),
            "{diagnostics}"
        );
    })
    .await
    .expect("cloud tunnel exchange and shutdown must complete");
    let state = cloud.state.lock().unwrap();
    assert!(state.configs.is_empty(), "tunneling must not configure SSH");
    assert!(
        state
            .requests
            .iter()
            .any(|(method, path, auth)| method == Method::POST
                && path == "/v1/team/boxes/-remote/network/tunnel?port=2222"
                && auth == "Bearer stored-key")
    );
    assert!(
        state
            .connect
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer stored-key")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_setup_isolates_context_endpoint_and_prefix_and_retains_failed_keys() {
    let cloud = Cloud::start(false).await;
    let other = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    cloud.state.lock().unwrap().configure_error = true;
    cli(home.path())
        .args(["ssh", "dev"])
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(predicates::str::contains("configuration refused"));
    cloud.state.lock().unwrap().configure_error = false;
    let first = setup(home.path(), &[]);
    {
        let state = cloud.state.lock().unwrap();
        assert_eq!(
            state.configs.len(),
            2,
            "failed configuration is not retried"
        );
        assert_eq!(state.configs[0], state.configs[1]);
    }
    let context = setup(home.path(), &["--context", "other"]);
    let prefix = setup(home.path(), &["--path-prefix", "another"]);
    let default = setup(home.path(), &["--url", &cloud.url]);
    let endpoint = setup(home.path(), &["--url", &other.url]);
    let paths = [first, context, prefix, default, endpoint].map(|summary| key_path(&summary));
    for (i, path) in paths.iter().enumerate() {
        for previous in &paths[..i] {
            assert_ne!(path, previous);
            assert_ne!(
                std::fs::read(path).unwrap(),
                std::fs::read(previous).unwrap()
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_setup_uses_new_credential_home_and_ignores_local_config() {
    for prefix in ["env-team", ""] {
        let cloud = Cloud::start(false).await;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("new-home");
        let output = cli(&home)
            .env("BOXLITE_REST_URL", &cloud.url)
            .env("BOXLITE_REST_PATH_PREFIX", prefix)
            .env("BOXLITE_API_KEY", "environment-key")
            .args(["--config", "/missing/local-config.json", "ssh", "dev"])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        let summary = String::from_utf8(output).unwrap();
        assert!(key_path(&summary).exists());
        assert!(!home.join("boxes").exists());
        let command = summary
            .lines()
            .find_map(|line| line.strip_prefix("  ssh "))
            .unwrap();
        let mut ssh = Command::new("/bin/sh");
        isolated(&mut ssh, &home);
        ssh.env("BOXLITE_API_KEY", "environment-key")
            .env("BOXLITE_REST_URL", "http://127.0.0.1:1")
            .env("BOXLITE_CONTEXT", "missing")
            .env("BOXLITE_REST_PATH_PREFIX", "wrong")
            .args([
                "-c",
                &format!("ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=2 {command}"),
            ])
            .assert()
            .failure();
        let expected_path = if prefix.is_empty() {
            "/v1/boxes/"
        } else {
            "/v1/env-team/boxes/"
        };
        assert!(
            cloud
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(_, path, auth)| path.starts_with(expected_path)
                    && auth == "Bearer environment-key")
        );
        assert!(cloud.state.lock().unwrap().connect.starts_with("CONNECT "));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_setup_and_proxy_use_stored_oidc_bearer() {
    let cloud = Cloud::start(true).await;
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("credentials.toml"),
        toml::to_string(&json!({
            "profiles": {"cloud": {"url": cloud.url, "auth_method": "oidc",
                "access_token": "oidc-token", "path_prefix": "team"}}
        }))
        .unwrap(),
    )
    .unwrap();
    let summary = setup(home.path(), &["--context", "cloud"]);
    assert!(!summary.contains("oidc-token"));
    cli(home.path())
        .args(["--context", "cloud", "ssh", "--proxy", "dev"])
        .write_stdin("hello")
        .assert()
        .success()
        .stdout("olleh");
    let state = cloud.state.lock().unwrap();
    assert!(
        state
            .requests
            .iter()
            .all(|(_, path, auth)| path.starts_with("/v1/team/") && auth == "Bearer oidc-token")
    );
    assert!(
        state
            .connect
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer oidc-token")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_proxy_reports_disabled_missing_and_unsupported_without_configuring() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    cloud.state.lock().unwrap().disabled = true;
    cli(home.path())
        .args(["ssh", "--proxy", "dev"])
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(predicates::str::contains("guest SSH is disabled"));
    assert_eq!(cloud.state.lock().unwrap().requests.len(), 2);
    {
        let mut state = cloud.state.lock().unwrap();
        state.disabled = false;
        state.tunnel_error = true;
    }
    cli(home.path())
        .args(["ssh", "--proxy", "dev"])
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(predicates::str::contains("not found"));
    cloud.state.lock().unwrap().missing = true;
    for options in [vec!["ssh", "dev"], vec!["ssh", "--proxy", "dev"]] {
        cli(home.path())
            .args(options)
            .assert()
            .failure()
            .stdout(predicates::str::is_empty())
            .stderr(predicates::str::contains("No such box"));
    }
    let state = cloud.state.lock().unwrap();
    assert!(state.configs.is_empty());
    assert!(state.connect.is_empty());
}
