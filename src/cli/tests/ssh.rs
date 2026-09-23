use assert_cmd::Command;
use predicates::prelude::PredicateBooleanExt;
use predicates::str::contains;

#[test]
fn ssh_commands_expose_help_and_target_flags() {
    for command in [
        "configure",
        "status",
        "disable",
        "setup",
        "forward",
        "connect",
    ] {
        Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .args(["ssh", command, "--help"])
            .assert()
            .success()
            .stdout(contains("--home"))
            .stdout(contains("--config"))
            .stdout(contains("--url"))
            .stdout(contains("--profile"))
            .stdout(contains("--path-prefix"));
    }
}

#[test]
fn ssh_configure_invalid_input_is_redacted() {
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .arg("--home").arg(home.path())
        .args(["ssh", "configure", "test", "--file", "-"])
        .write_stdin(r#"{"listen_address":"0.0.0.0:22","host_private_key":"sentinel-private","accounts":"sentinel-account"}"#)
        .assert().failure();
    let stderr = String::from_utf8_lossy(&output.get_output().stderr);
    assert!(stderr.contains("Invalid SSH configuration"), "{stderr}");
    assert!(!stderr.contains("sentinel"), "{stderr}");
}

#[test]
fn ssh_completion_includes_all_commands() {
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .args(["completion", "bash"])
        .assert()
        .success()
        .stdout(contains("configure"))
        .stdout(contains("setup"))
        .stdout(contains("connect"));
}

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

struct SshServer {
    url: String,
    state: Arc<Mutex<ServerState>>,
    task: tokio::task::JoinHandle<()>,
}

struct ServerState {
    status: Value,
    configurations: usize,
    fail_after_apply: bool,
    paths: Vec<String>,
    tunnel_uri: Option<String>,
    authorizations: Vec<String>,
    block_confirmation: Option<std::path::PathBuf>,
    block_pending: Option<std::path::PathBuf>,
    remove_keygen_after_apply: Option<std::path::PathBuf>,
    tunnel_ports: Vec<u16>,
}

impl SshServer {
    async fn start() -> Self {
        let state = Arc::new(Mutex::new(ServerState {
            status: json!({"enabled":false,"generation":0,"listen_address":"","host_public_key":"","host_key_fingerprint":""}),
            configurations: 0,
            fail_after_apply: false,
            paths: vec![],
            tunnel_uri: None,
            authorizations: vec![],
            block_confirmation: None,
            block_pending: None,
            remove_keygen_after_apply: None,
            tunnel_ports: vec![],
        }));
        let app = axum::Router::new()
            .fallback(server_request)
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, state, task }
    }

    fn cli(&self, home: &std::path::Path) -> Command {
        let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
        cmd.timeout(std::time::Duration::from_secs(20));
        cmd.env_remove("BOXLITE_API_KEY")
            .env_remove("BOXLITE_PROFILE");
        cmd.arg("--home")
            .arg(home)
            .args(["--url", &self.url, "--path-prefix", "team"]);
        cmd
    }

    fn setup(&self, home: &std::path::Path, extra: &[&str]) -> Value {
        let result = self
            .cli(home)
            .args(["ssh", "setup", "alias", "--format", "json"])
            .args(extra)
            .assert()
            .success();
        serde_json::from_slice(&result.get_output().stdout).unwrap()
    }
}
impl Drop for SshServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server_request(
    State(state): State<Arc<Mutex<ServerState>>>,
    req: axum::extract::Request,
) -> axum::response::Response {
    let path = req.uri().path().to_string();
    let method = req.method().to_string();
    let query = req.uri().query().unwrap_or_default().to_owned();
    let authorization = req
        .headers()
        .get("authorization")
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap_or_default();
    let body = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let mut state = state.lock().unwrap();
    state.paths.push(format!("{method} {path}"));
    state.authorizations.push(authorization);
    if path == "/v1/team/boxes/real-id/network/tunnel" && method == "POST" {
        state
            .tunnel_ports
            .push(query.strip_prefix("port=").unwrap().parse().unwrap());
        return match &state.tunnel_uri {
            Some(uri) => Json(json!({"uri":uri})).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        };
    }
    if path == "/v1/team/boxes/alias" || path == "/v1/team/boxes/real-id" {
        return Json(json!({"box_id":"real-id","name":"alias","status":"running","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine:latest","cpus":1,"memory_mib":256})).into_response();
    }
    if path == "/v1/team/boxes/real-id/ssh/configure" && method == "POST" {
        let config: Value = serde_json::from_slice(&body).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("host");
        // The guest trims PEM whitespace; OpenSSH additionally requires a final LF.
        std::fs::write(
            &key,
            format!("{}\n", config["host_private_key"].as_str().unwrap().trim()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        let public = std::process::Command::new("ssh-keygen")
            .args(["-y", "-f"])
            .arg(key)
            .output()
            .unwrap();
        assert!(public.status.success());
        state.configurations += 1;
        state.status = json!({"enabled":true,"generation":state.status["generation"].as_u64().unwrap()+1,"listen_address":config["listen_address"],"host_public_key":String::from_utf8(public.stdout).unwrap().trim(),"host_key_fingerprint":"SHA256:test"});
        if state.status["listen_address"] == "0.0.0.0:0" {
            state.status["listen_address"] = json!("0.0.0.0:23456");
        }
        if let Some(record) = state.block_confirmation.take() {
            std::fs::rename(&record, record.with_extension("pending")).unwrap();
            std::fs::create_dir(&record).unwrap();
        }
        if let Some(keygen) = state.remove_keygen_after_apply.take() {
            std::fs::remove_file(keygen).unwrap();
        }
        if state.fail_after_apply {
            state.fail_after_apply = false;
            return (StatusCode::GATEWAY_TIMEOUT, "sentinel server secret").into_response();
        }
    } else if path == "/v1/team/boxes/real-id/ssh/disable" && method == "POST" {
        state.status["enabled"] = json!(false);
    } else if path != "/v1/team/boxes/real-id/ssh" {
        return StatusCode::NOT_FOUND.into_response();
    }
    if method == "GET"
        && let Some(record) = state.block_pending.take()
    {
        std::fs::rename(&record, record.with_extension("active")).unwrap();
        std::fs::create_dir(&record).unwrap();
    }
    Json(state.status.clone()).into_response()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_setup_reuses_conflicts_rotates_and_recovers_pending_keys() {
    use std::os::unix::fs::PermissionsExt;
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let key = std::path::Path::new(first["identity_file"].as_str().unwrap());
    assert_eq!(
        std::fs::metadata(key).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(key.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(key.to_string_lossy().contains("real-id"));
    let second = server.setup(home.path(), &[]);
    assert_eq!(first["identity_file"], second["identity_file"]);
    assert_eq!(server.state.lock().unwrap().configurations, 1);
    server.state.lock().unwrap().status["generation"] = json!(9);
    server
        .cli(home.path())
        .args(["ssh", "setup", "alias"])
        .assert()
        .failure()
        .stderr(contains("remote configuration preserved"));
    server
        .cli(home.path())
        .args(["ssh", "disable", "alias"])
        .assert()
        .success();
    let replaced = server.setup(home.path(), &[]);
    assert_ne!(first["identity_file"], replaced["identity_file"]);
    server
        .cli(home.path())
        .args(["ssh", "disable", "alias"])
        .assert()
        .success();
    let restored = server.setup(home.path(), &[]);
    assert_ne!(restored["identity_file"], replaced["identity_file"]);
    server
        .cli(home.path())
        .args(["ssh", "disable", "alias"])
        .assert()
        .success();
    server.state.lock().unwrap().fail_after_apply = true;
    server
        .cli(home.path())
        .args(["ssh", "setup", "alias"])
        .assert()
        .failure();
    let count = server.state.lock().unwrap().configurations;
    let recovered = server.setup(home.path(), &[]);
    assert_ne!(recovered["identity_file"], restored["identity_file"]);
    assert_eq!(server.state.lock().unwrap().configurations, count);
    let other = SshServer::start().await;
    let isolated = other.setup(home.path(), &[]);
    assert_ne!(isolated["identity_file"], recovered["identity_file"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_status_preserves_maximum_generation_and_full_mapping() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let expected = json!({"enabled":true,"generation":u64::MAX,"listen_address":"0.0.0.0:22","host_public_key":"public","host_key_fingerprint":"SHA256:test"});
    server.state.lock().unwrap().status = expected.clone();
    let output = server
        .cli(home.path())
        .args(["ssh", "status", "alias"])
        .assert()
        .success();
    let actual: Value = serde_json::from_slice(&output.get_output().stdout).unwrap();
    assert_eq!(actual, expected);
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .paths
            .contains(&"GET /v1/team/boxes/real-id/ssh".to_string())
    );
}

async fn connect_peer(
    server: &SshServer,
    response: &'static [u8],
    read_request: bool,
) -> tokio::task::JoinHandle<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    server.state.lock().unwrap().tunnel_uri =
        Some(format!("http://{}", listener.local_addr().unwrap()));
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(stream.read_u8().await.unwrap());
            assert!(header.len() < 8192);
        }
        assert!(header.starts_with(b"CONNECT "));
        stream
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        let mut request = Vec::new();
        if read_request {
            stream.read_to_end(&mut request).await.unwrap();
        }
        stream.write_all(response).await.unwrap();
        stream.shutdown().await.unwrap();
        request
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_stdio_cli_rest_connect_raw_bytes_and_half_close() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let peer = connect_peer(&server, b"\0\xffreply\r\n", true).await;
    let result = server
        .cli(home.path())
        .args(["network", "tunnel", "alias", "22", "--stdio"])
        .write_stdin(b"\xff\0input\r\n".as_slice())
        .assert()
        .success();
    assert_eq!(result.get_output().stdout, b"\0\xffreply\r\n");
    assert_eq!(peer.await.unwrap(), b"\xff\0input\r\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_stdio_cli_exits_while_stdin_writer_remains_open() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let peer = connect_peer(&server, b"bye", false).await;
    let mut child = tokio::process::Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .arg("--home")
        .arg(home.path())
        .args([
            "--url",
            &server.url,
            "--path-prefix",
            "team",
            "network",
            "tunnel",
            "alias",
            "22",
            "--stdio",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let _open_stdin = child.stdin.take().unwrap();
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output())
        .await
        .expect("remote EOF must cancel stdin")
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"bye");
    peer.await.unwrap();
}

#[test]
fn ssh_stdio_conflicts_with_listener() {
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .args([
            "network", "tunnel", "alias", "22", "--stdio", "--listen", "2222",
        ])
        .assert()
        .failure()
        .stderr(contains("cannot be used with"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_connect_delegates_io_arguments_and_exit_code() {
    use std::os::unix::fs::PermissionsExt;
    let server = SshServer::start().await;
    let home = tempfile::Builder::new()
        .prefix("ssh spaces ' \" %h ")
        .tempdir()
        .unwrap();
    let tools = tempfile::tempdir().unwrap();
    let ssh = tools.path().join("ssh");
    std::fs::write(
        &ssh,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SSH_TEST_ARGS\"\nprintf 'remote-output'\nexit 17\n",
    )
    .unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o700)).unwrap();
    let captured = tools.path().join("args");
    let path = format!(
        "{}:{}",
        tools.path().display(),
        std::env::var("PATH").unwrap()
    );
    server
        .cli(home.path())
        .env("PATH", path)
        .env("SSH_TEST_ARGS", &captured)
        .args(["ssh", "connect", "alias", "--", "sh", "-c", "exit 17"])
        .assert()
        .code(17)
        .stdout("remote-output");
    let args = std::fs::read_to_string(captured).unwrap();
    assert!(args.contains("StrictHostKeyChecking=yes"));
    assert!(args.contains("IdentitiesOnly=yes"));
    assert!(args.contains("'network' 'tunnel' 'real-id' '22' '--stdio'"));
    assert!(args.contains("'--path-prefix' 'team'"));
    assert!(args.contains("'sh' '-c' 'exit 17'"));
    assert!(args.contains("%%h"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_configure_file_and_stdin_reach_rest() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let login = server.setup(home.path(), &[]);
    let key_dir = std::path::Path::new(login["identity_file"].as_str().unwrap())
        .parent()
        .unwrap();
    let config = json!({"listen_address":"0.0.0.0:22","host_private_key":std::fs::read_to_string(key_dir.join("host")).unwrap(),"accounts":[{"login":"boxlite","authorized_keys":[std::fs::read_to_string(key_dir.join("identity.pub")).unwrap()],"ca":null}]}).to_string();
    let file = home.path().join("config.json");
    std::fs::write(&file, &config).unwrap();
    server
        .cli(home.path())
        .args(["ssh", "configure", "alias", "--file"])
        .arg(file)
        .assert()
        .success();
    server
        .cli(home.path())
        .args([
            "ssh",
            "configure",
            "alias",
            "--file",
            "-",
            "--format",
            "yaml",
        ])
        .write_stdin(config)
        .assert()
        .success();
    assert_eq!(server.state.lock().unwrap().configurations, 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_real_openssh_parses_quoted_paths_and_proxy_percent_tokens() {
    let server = SshServer::start().await;
    let home = tempfile::Builder::new()
        .prefix("ssh ' \" %h ")
        .tempdir()
        .unwrap();
    let login = server.setup(home.path(), &[]);
    let peer = connect_peer(&server, b"SSH-2.0-test\r\n", false).await;
    let command = login["command"]
        .as_str()
        .unwrap()
        .replacen("'ssh'", "'ssh' '-vv'", 1);
    let result = Command::new("/bin/sh")
        .args(["-c", &command])
        .env("SHELL", "/bin/bash")
        .timeout(std::time::Duration::from_secs(10))
        .assert()
        .failure();
    let stderr = String::from_utf8_lossy(&result.get_output().stderr);
    assert!(!stderr.contains("not accessible"), "{stderr}");
    assert!(!stderr.contains("invalid quotes"), "{stderr}");
    assert!(stderr.contains("Remote protocol version 2.0"), "{stderr}");
    peer.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_keygen_missing_and_timeout_are_explicit_and_reaped() {
    use std::os::unix::fs::PermissionsExt;
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    server
        .cli(home.path())
        .env("PATH", tools.path())
        .args(["ssh", "setup", "alias"])
        .assert()
        .failure()
        .stderr(contains("install OpenSSH"));
    let script = tools.path().join("ssh-keygen");
    let pidfile = tools.path().join("pid");
    std::fs::write(
        &script,
        "#!/bin/sh\nprintf '%s' \"$$\" > \"$KEYGEN_PID\"\nexec /bin/sleep 60\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    server
        .cli(home.path())
        .timeout(std::time::Duration::from_secs(30))
        .env("PATH", tools.path())
        .env("KEYGEN_PID", &pidfile)
        .args(["ssh", "setup", "alias"])
        .assert()
        .failure()
        .stderr(contains("ssh-keygen timed out"));
    let pid: i32 = std::fs::read_to_string(pidfile).unwrap().parse().unwrap();
    assert_eq!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
        Err(nix::errno::Errno::ESRCH)
    );
    assert_eq!(server.state.lock().unwrap().configurations, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_profile_and_auth_environment_survive_proxy_command() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("credentials.toml"),
        format!(
            "[profiles.saved]\nurl = {:?}\napi_key = 'stored-test-key'\npath_prefix = 'team'\n",
            server.url
        ),
    )
    .unwrap();
    let output = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .arg("--home")
        .arg(home.path())
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_REST_PATH_PREFIX")
        .env("BOXLITE_API_KEY", "env-test-key")
        .args([
            "--profile",
            "saved",
            "ssh",
            "setup",
            "alias",
            "--format",
            "json",
        ])
        .assert()
        .success();
    let login: Value = serde_json::from_slice(&output.get_output().stdout).unwrap();
    let command = login["command"].as_str().unwrap();
    assert!(!command.contains("test-key"));
    let peer = connect_peer(&server, b"SSH-2.0-test\r\n", false).await;
    Command::new("/bin/sh")
        .args(["-c", command])
        .env("BOXLITE_API_KEY", "env-test-key")
        .timeout(std::time::Duration::from_secs(10))
        .assert()
        .failure();
    peer.await.unwrap();
    let state = server.state.lock().unwrap();
    assert!(state.authorizations.len() >= 5);
    assert!(
        state
            .authorizations
            .iter()
            .all(|authorization| authorization == "Bearer env-test-key")
    );
    assert!(
        state
            .paths
            .contains(&"POST /v1/team/boxes/real-id/network/tunnel".to_owned())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_credentials_reject_corrupt_records_and_material_paths() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let login = server.setup(home.path(), &[]);
    let root = std::path::Path::new(login["identity_file"].as_str().unwrap())
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let record = root.join("state.json");
    for (contents, expected) in [
        ("{".to_owned(), "Read SSH credential record"),
        (
            json!({"active":{"material":"../../outside","generation":1}}).to_string(),
            "Invalid SSH material record",
        ),
    ] {
        std::fs::write(&record, contents).unwrap();
        server
            .cli(home.path())
            .args(["ssh", "setup", "alias"])
            .assert()
            .failure()
            .stderr(contains(expected));
    }
    assert_eq!(server.state.lock().unwrap().configurations, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_credentials_reject_symlink_directory_and_ignore_old_lock() {
    use std::os::unix::fs::symlink;
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), home.path().join("ssh")).unwrap();
    server
        .cli(home.path())
        .args(["ssh", "setup", "alias"])
        .assert()
        .failure()
        .stderr(contains("must be a real directory"));
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    std::fs::remove_file(home.path().join("ssh")).unwrap();
    let login = server.setup(home.path(), &[]);
    let root = std::path::Path::new(login["identity_file"].as_str().unwrap())
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let protected = outside.path().join("protected");
    std::fs::write(&protected, "unchanged").unwrap();
    symlink(&protected, root.join("lock")).unwrap();
    server
        .cli(home.path())
        .args(["ssh", "setup", "alias"])
        .assert()
        .success();
    assert_eq!(std::fs::read_to_string(protected).unwrap(), "unchanged");
    assert_eq!(server.state.lock().unwrap().configurations, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_setup_rejects_exhausted_generation_without_configuring() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    server.state.lock().unwrap().status["generation"] = json!(u64::MAX);
    server
        .cli(home.path())
        .args(["ssh", "setup", "alias"])
        .assert()
        .failure()
        .stderr(contains("SSH generation exhausted"));
    assert_eq!(server.state.lock().unwrap().configurations, 0);
}

#[test]
fn ssh_configure_rejects_missing_and_oversized_files() {
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join("config.json");
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .args(["ssh", "configure", "alias", "--file"])
        .arg(&file)
        .assert()
        .failure()
        .stderr(contains("Open SSH configuration file"));
    std::fs::write(&file, vec![b'x'; 1024 * 1024 + 1]).unwrap();
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .args(["ssh", "configure", "alias", "--file"])
        .arg(&file)
        .assert()
        .failure()
        .stderr(contains("exceeds 1 MiB"));
}

async fn start_forward(server: &SshServer, home: &std::path::Path) -> (tokio::process::Child, u16) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut child = tokio::process::Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .arg("--home")
        .arg(home)
        .env_remove("BOXLITE_API_KEY")
        .env_remove("BOXLITE_PROFILE")
        .args([
            "--url",
            &server.url,
            "--path-prefix",
            "team",
            "ssh",
            "forward",
            "alias",
            "--listen",
            "127.0.0.1:0",
            "--format",
            "json",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let login = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut document = String::new();
        while let Some(line) = lines.next_line().await.unwrap() {
            document.push_str(&line);
            if let Ok(value) = serde_json::from_str::<Value>(&document) {
                return value;
            }
        }
        panic!("forward exited before reporting listener");
    })
    .await
    .unwrap();
    assert!(!login["command"].as_str().unwrap().contains("ProxyCommand"));
    (child, login["port"].as_u64().unwrap() as u16)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_forward_recovers_relays_bytes_and_reaps_connections_on_signals() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for signal in [
        nix::sys::signal::Signal::SIGTERM,
        nix::sys::signal::Signal::SIGINT,
    ] {
        let server = SshServer::start().await;
        let home = tempfile::tempdir().unwrap();
        let probe = connect_peer(&server, b"", false).await;
        let (mut child, port) = start_forward(&server, home.path()).await;
        probe.await.unwrap();
        let address = (std::net::Ipv4Addr::LOCALHOST, port);
        // A failed transport must close this client without stopping the listener.
        server.state.lock().unwrap().tunnel_uri = None;
        let mut failed = tokio::net::TcpStream::connect(address).await.unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(10), failed.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        let peer = connect_peer(&server, b"\0\xffresponse", true).await;
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client.write_all(b"\xff\0request").await.unwrap();
        client.shutdown().await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            client.read_to_end(&mut response),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response, b"\0\xffresponse");
        assert_eq!(peer.await.unwrap(), b"\xff\0request");
        // Keep a relay open while signaling, and observe EOF on both ends.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        server.state.lock().unwrap().tunnel_uri =
            Some(format!("http://{}", listener.local_addr().unwrap()));
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        let (mut remote, _) =
            tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(remote.read_u8().await.unwrap());
        }
        remote
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\nready")
            .await
            .unwrap();
        let mut ready = [0; 5];
        client.read_exact(&mut ready).await.unwrap();
        assert_eq!(&ready, b"ready");
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
            signal,
        )
        .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert_eq!(remote.read(&mut byte).await.unwrap(), 0);
        assert_eq!(client.read(&mut byte).await.unwrap(), 0);
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_forward_reports_occupied_port() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer = connect_peer(&server, b"", false).await;
    server
        .cli(home.path())
        .args([
            "ssh",
            "forward",
            "alias",
            "--listen",
            &occupied.local_addr().unwrap().to_string(),
        ])
        .assert()
        .failure()
        .stderr(contains("Bind SSH forward listener"));
    peer.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_connect_signals_reap_system_ssh() {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncBufReadExt, BufReader};
    for (signal, code) in [
        (nix::sys::signal::Signal::SIGINT, 130),
        (nix::sys::signal::Signal::SIGTERM, 143),
    ] {
        let server = SshServer::start().await;
        let home = tempfile::tempdir().unwrap();
        let tools = tempfile::tempdir().unwrap();
        let script = tools.path().join("ssh");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf 'ready:%s\\n' \"$$\" >&2\nexec /bin/sleep 60\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = tokio::process::Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .arg("--home")
            .arg(home.path())
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    tools.path().display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env_remove("BOXLITE_API_KEY")
            .env_remove("BOXLITE_PROFILE")
            .args([
                "--url",
                &server.url,
                "--path-prefix",
                "team",
                "ssh",
                "connect",
                "alias",
            ])
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
        let ssh_pid: i32 = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(line) = stderr.next_line().await.unwrap() {
                if let Some(pid) = line.strip_prefix("ready:") {
                    return pid.parse().unwrap();
                }
            }
            panic!("system SSH did not start");
        })
        .await
        .unwrap();
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
            signal,
        )
        .unwrap();
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.code(), Some(code));
        assert_eq!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(ssh_pid), None),
            Err(nix::errno::Errno::ESRCH)
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_manual_configuration_reuses_key_and_disable_rotates() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let dir = std::path::Path::new(first["identity_file"].as_str().unwrap())
        .parent()
        .unwrap();
    let config = json!({"listen_address":"0.0.0.0:2223","host_private_key":std::fs::read_to_string(dir.join("host")).unwrap(),"accounts":[{"login":"alice","authorized_keys":[std::fs::read_to_string(dir.join("identity.pub")).unwrap()],"ca":null}]});
    server
        .cli(home.path())
        .args(["ssh", "configure", "alias", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .success();
    let reused = server.setup(home.path(), &[]);
    assert_eq!(reused["identity_file"], first["identity_file"]);
    assert_eq!(reused["login"], "alice");
    assert_eq!(reused["port"], 2223);
    assert!(
        reused["command"]
            .as_str()
            .unwrap()
            .contains(&"'2223' '--stdio'".replace('\'', "'\\''"))
    );
    assert_eq!(server.state.lock().unwrap().configurations, 2);
    server
        .cli(home.path())
        .args(["ssh", "disable", "alias"])
        .assert()
        .success();
    let fresh = server.setup(home.path(), &[]);
    assert_ne!(fresh["identity_file"], first["identity_file"]);
    assert_ne!(
        std::fs::read(fresh["identity_file"].as_str().unwrap()).unwrap(),
        std::fs::read(first["identity_file"].as_str().unwrap()).unwrap()
    );
}

fn saved_config(login: &Value, accounts: &[&str], address: &str) -> Value {
    let dir = std::path::Path::new(login["identity_file"].as_str().unwrap())
        .parent()
        .unwrap();
    let public = std::fs::read_to_string(dir.join("identity.pub")).unwrap();
    json!({"listen_address":address,"host_private_key":std::fs::read_to_string(dir.join("host")).unwrap(),"accounts":accounts.iter().map(|login| json!({"login":login,"authorized_keys":[public],"ca":null})).collect::<Vec<_>>()})
}

fn configure_saved(server: &SshServer, home: &std::path::Path, config: &Value) {
    server
        .cli(home)
        .args(["ssh", "configure", "alias", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .success();
}

fn credential_record(login: &Value) -> std::path::PathBuf {
    std::path::Path::new(login["identity_file"].as_str().unwrap())
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("state.json")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_manual_multiple_accounts_select_and_remember_login() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &["--login", "initial"]);
    assert_eq!(first["login"], "initial");
    let config = saved_config(&first, &["alice", "bob"], "0.0.0.0:2223");
    configure_saved(&server, home.path(), &config);
    server
        .cli(home.path())
        .args(["ssh", "setup", "alias"])
        .assert()
        .failure()
        .stderr(contains("Multiple SSH logins"));
    let chosen = server.setup(home.path(), &["--login", "bob"]);
    assert_eq!(chosen["login"], "bob");
    assert_eq!(server.setup(home.path(), &[])["login"], "bob");
    assert_eq!(
        server.setup(home.path(), &["--login", "alice"])["login"],
        "alice"
    );
    server
        .cli(home.path())
        .args(["ssh", "setup", "alias", "--login", "absent"])
        .assert()
        .failure()
        .stderr(contains("No usable saved client credentials"));
    assert_eq!(server.state.lock().unwrap().configurations, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_manual_missing_private_key_preserves_configuration() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let mut config = saved_config(&first, &["external"], "0.0.0.0:2223");
    config["accounts"][0]["ca"] =
        json!({"public_key":config["accounts"][0]["authorized_keys"][0], "principal":"external"});
    std::fs::remove_file(first["identity_file"].as_str().unwrap()).unwrap();
    configure_saved(&server, home.path(), &config);
    let journal: Value =
        serde_json::from_slice(&std::fs::read(credential_record(&first)).unwrap()).unwrap();
    assert_eq!(journal["active"]["config"], config);
    for command in ["setup", "connect", "forward"] {
        server
            .cli(home.path())
            .args(["ssh", command, "alias"])
            .assert()
            .failure()
            .stderr(contains("No usable saved client credentials"));
    }
    assert_eq!(server.state.lock().unwrap().configurations, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_matches_actual_private_key_ignoring_public_sidecar_and_comments() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let mut config = saved_config(&first, &["alice"], "0.0.0.0:2223");
    let public = config["accounts"][0]["authorized_keys"][0]
        .as_str()
        .unwrap()
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    config["accounts"][0]["authorized_keys"][0] = json!(format!("{public} another comment"));
    let identity = std::path::Path::new(first["identity_file"].as_str().unwrap());
    std::fs::write(identity.with_extension("pub"), "invalid sidecar").unwrap();
    configure_saved(&server, home.path(), &config);
    assert_eq!(server.setup(home.path(), &[])["login"], "alice");
    std::fs::write(identity, "invalid private key").unwrap();
    server
        .cli(home.path())
        .args(["ssh", "setup", "alias"])
        .assert()
        .failure()
        .stderr(contains("No usable saved client credentials"));
    assert_eq!(server.state.lock().unwrap().configurations, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_manual_pending_recovers_and_checks_actual_listener() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let config = saved_config(&first, &["alice"], "0.0.0.0:0");
    server.state.lock().unwrap().fail_after_apply = true;
    server
        .cli(home.path())
        .args(["ssh", "configure", "alias", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .failure();
    let recovered = server.setup(home.path(), &[]);
    assert_eq!(recovered["login"], "alice");
    assert_eq!(recovered["port"], 23456);
    let journal: Value =
        serde_json::from_slice(&std::fs::read(credential_record(&first)).unwrap()).unwrap();
    assert!(journal["pending"].is_null());
    assert_eq!(journal["active"]["config"], config);
    assert_eq!(
        journal["active"]["status"]["listen_address"],
        "0.0.0.0:23456"
    );
    for (field, invalid) in [
        ("listen_address", json!("0.0.0.0:23457")),
        ("host_public_key", json!("ssh-ed25519 changed")),
        ("generation", json!(99)),
    ] {
        let original = server.state.lock().unwrap().status[field].clone();
        server.state.lock().unwrap().status[field] = invalid;
        server
            .cli(home.path())
            .args(["ssh", "setup", "alias"])
            .assert()
            .failure()
            .stderr(contains("remote configuration preserved"));
        server.state.lock().unwrap().status[field] = original;
    }
    assert_eq!(server.state.lock().unwrap().configurations, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_legacy_record_upgrades_without_configuring() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let identity = std::path::Path::new(first["identity_file"].as_str().unwrap());
    let material = identity
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    std::fs::write(
        credential_record(&first),
        json!({"active":{"material":material,"generation":1}}).to_string(),
    )
    .unwrap();
    assert_eq!(
        server.setup(home.path(), &[])["identity_file"],
        first["identity_file"]
    );
    let upgraded: Value =
        serde_json::from_slice(&std::fs::read(credential_record(&first)).unwrap()).unwrap();
    assert_eq!(
        upgraded["active"]["config"]["accounts"][0]["login"],
        "boxlite"
    );
    assert_eq!(server.state.lock().unwrap().configurations, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_manual_unsupported_listener_is_saved_but_not_connected() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    for address in ["127.0.0.1:2223", "[::]:2223"] {
        let config = saved_config(&first, &["alice"], address);
        configure_saved(&server, home.path(), &config);
        server
            .cli(home.path())
            .args(["ssh", "setup", "alias"])
            .assert()
            .failure()
            .stderr(contains("do not support listener"));
    }
    let config = saved_config(
        &first,
        &["alice"],
        &format!("{}:2223", boxlite::net::constants::GUEST_IP),
    );
    configure_saved(&server, home.path(), &config);
    assert_eq!(server.setup(home.path(), &[])["port"], 2223);
    assert_eq!(server.state.lock().unwrap().configurations, 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_confirmation_save_failure_keeps_recoverable_material() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let config = saved_config(&first, &["alice"], "0.0.0.0:2223");
    let record = credential_record(&first);
    // Inject an atomic-rename failure after the remote mutation, preserving
    // the pre-confirmation bytes so they can be restored after the obstacle.
    server.state.lock().unwrap().block_confirmation = Some(record.clone());
    server
        .cli(home.path())
        .args(["ssh", "configure", "alias", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .failure()
        .stderr(contains("local confirmation is incomplete"));
    let pending: Value =
        serde_json::from_slice(&std::fs::read(record.with_extension("pending")).unwrap()).unwrap();
    assert_eq!(pending["pending"]["config"], config);
    std::fs::remove_dir(&record).unwrap();
    std::fs::rename(record.with_extension("pending"), &record).unwrap();
    assert_eq!(server.setup(home.path(), &[])["login"], "alice");
    assert_eq!(server.state.lock().unwrap().configurations, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_save_failure_before_submission_does_not_configure() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let record = credential_record(&first);
    server.state.lock().unwrap().block_pending = Some(record);
    let config = saved_config(&first, &["alice"], "0.0.0.0:2223");
    server
        .cli(home.path())
        .args(["ssh", "configure", "alias", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .failure()
        .stderr(contains("Save pending SSH configuration before configure"));
    assert_eq!(server.state.lock().unwrap().configurations, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_saved_configuration_is_isolated_by_profile() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    server.setup(home.path(), &[]);
    server
        .cli(home.path())
        .args(["--profile", "other", "ssh", "setup", "alias"])
        .assert()
        .failure()
        .stderr(contains("saved configuration is missing or inconsistent"));
    assert_eq!(server.state.lock().unwrap().configurations, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_forward_uses_saved_guest_port() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    configure_saved(
        &server,
        home.path(),
        &saved_config(&first, &["alice"], "0.0.0.0:2223"),
    );
    let probe = connect_peer(&server, b"", false).await;
    let (mut child, port) = start_forward(&server, home.path()).await;
    probe.await.unwrap();
    let peer = connect_peer(&server, b"", false).await;
    let stream = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    peer.await.unwrap();
    drop(stream);
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    assert!(child.wait().await.unwrap().success());
    let state = server.state.lock().unwrap();
    assert_eq!(state.tunnel_ports, [2223, 2223]);
    assert_eq!(state.configurations, 2);
}

#[test]
fn ssh_convenience_flags_offer_login_and_reject_replace() {
    for command in ["setup", "connect", "forward"] {
        Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .args(["ssh", command, "--help"])
            .assert()
            .success()
            .stdout(contains("--login"))
            .stdout(contains("--replace").not());
        Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .args(["ssh", command, "alias", "--replace"])
            .assert()
            .failure()
            .stderr(contains("unexpected argument '--replace'"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_preflight_missing_keygen_preserves_journal() {
    assert_preflight_failure(None, "Run ssh-keygen").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_preflight_failed_derivation_preserves_journal() {
    assert_preflight_failure(
        Some("#!/bin/sh\necho sentinel-private >&2\nexit 1\n"),
        "not usable without a passphrase",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_preflight_timeout_preserves_journal() {
    assert_preflight_failure(
        Some("#!/bin/sh\nexec /bin/sleep 60\n"),
        "public key derivation timed out",
    )
    .await;
}

async fn assert_preflight_failure(script: Option<&str>, error: &str) {
    use std::os::unix::fs::PermissionsExt;
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let config = saved_config(&first, &["alice"], "0.0.0.0:2223");
    server.state.lock().unwrap().fail_after_apply = true;
    server
        .cli(home.path())
        .args(["ssh", "configure", "alias", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .failure();
    let record = credential_record(&first);
    let before = std::fs::read(&record).unwrap();
    let journal: Value = serde_json::from_slice(&before).unwrap();
    assert!(!journal["active"].is_null() && !journal["pending"].is_null());
    let tools = tempfile::tempdir().unwrap();
    if let Some(script) = script {
        let keygen = tools.path().join("ssh-keygen");
        std::fs::write(&keygen, script).unwrap();
        std::fs::set_permissions(&keygen, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let output = server
        .cli(home.path())
        .timeout(std::time::Duration::from_secs(40))
        .env("PATH", tools.path())
        .args(["ssh", "configure", "alias", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .failure();
    let stderr = String::from_utf8_lossy(&output.get_output().stderr);
    assert!(stderr.contains(error), "{stderr}");
    assert!(!stderr.contains("sentinel-private"), "{stderr}");
    for line in config["host_private_key"].as_str().unwrap().lines() {
        assert!(!stderr.contains(line), "private key leaked");
    }
    assert_eq!(
        server.state.lock().unwrap().configurations,
        2,
        "preflight failure sent configure"
    );
    assert_eq!(
        std::fs::read(record).unwrap(),
        before,
        "preflight failure changed journal"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_preflight_normalizes_private_key_and_reuses_configuration() {
    for padding in [false, true] {
        let server = SshServer::start().await;
        let home = tempfile::tempdir().unwrap();
        let first = server.setup(home.path(), &[]);
        let mut config = saved_config(&first, &["alice"], "0.0.0.0:0");
        let normalized = config["host_private_key"].as_str().unwrap().to_owned();
        config["host_private_key"] = json!(if padding {
            format!(" \n\t{}\n \t", normalized.trim())
        } else {
            normalized.trim().to_owned()
        });
        configure_saved(&server, home.path(), &config);
        let reused = server.setup(home.path(), &[]);
        assert_eq!(reused["login"], "alice");
        assert_eq!(reused["port"], 23456);
        let record = credential_record(&first);
        let journal: Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        assert_eq!(journal["active"]["config"]["host_private_key"], normalized);
        let host = record
            .parent()
            .unwrap()
            .join(journal["active"]["material"].as_str().unwrap())
            .join("host");
        assert_eq!(std::fs::read_to_string(host).unwrap(), normalized);
        assert_eq!(server.state.lock().unwrap().configurations, 2);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_preflight_confirmation_needs_no_keygen_after_submission() {
    let server = SshServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let first = server.setup(home.path(), &[]);
    let config = saved_config(&first, &["alice"], "0.0.0.0:2223");
    let tools = tempfile::tempdir().unwrap();
    let keygen = tools.path().join("ssh-keygen");
    std::os::unix::fs::symlink("/usr/bin/ssh-keygen", &keygen).unwrap();
    server.state.lock().unwrap().remove_keygen_after_apply = Some(keygen.clone());
    server
        .cli(home.path())
        .env("PATH", tools.path())
        .args(["ssh", "configure", "alias", "--file", "-"])
        .write_stdin(config.to_string())
        .assert()
        .success();
    assert!(!keygen.exists());
    let journal: Value =
        serde_json::from_slice(&std::fs::read(credential_record(&first)).unwrap()).unwrap();
    assert!(journal["pending"].is_null());
    assert_eq!(journal["active"]["config"], config);
    assert_eq!(server.setup(home.path(), &[])["login"], "alice");
    assert_eq!(server.state.lock().unwrap().configurations, 2);
}
