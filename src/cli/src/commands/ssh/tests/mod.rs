//! No-VM tests: argument relations, credential-file loading, and the REST
//! boundary of each command against a recording stub. The guest itself, real
//! SSH logins, and forwarding are proven in `src/cli/tests/ssh.rs`.

use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{OriginalUri, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use boxlite::SshStatus;
use clap::error::ErrorKind;

use super::{SshCommand, tunnel_target};
use crate::cli::{Commands, try_parse_from};

const SECRET: &str = "sentinel-private-key-material";

fn parse(args: &[&str]) -> Result<SshCommand, clap::Error> {
    let cli = try_parse_from(["boxlite", "ssh"].iter().chain(args))?;
    let Commands::Ssh(ssh) = cli.command else {
        panic!("expected the ssh command");
    };
    Ok(ssh.command)
}

fn write(dir: &Path, name: &str, contents: &str) -> String {
    let path = dir.join(name);
    std::fs::write(&path, contents).unwrap();
    path.to_str().unwrap().to_string()
}

fn load(args: &[&str]) -> anyhow::Result<boxlite::SshConfig> {
    match parse(args).expect("parse") {
        SshCommand::Configure(configure) => configure.source.load(),
        other => panic!("no configuration source in {other:?}"),
    }
}

// ============================================================================
// Argument relations
// ============================================================================

#[test]
fn configure_accepts_configuration_options() {
    for options in [
        vec!["--ssh-config", "c.json"],
        vec![
            "--host-key",
            "h",
            "--login",
            "alice",
            "--authorized-key",
            "a.pub",
            "--authorized-key",
            "b.pub",
            "--guest-listen",
            "0.0.0.0:0",
        ],
    ] {
        let args = [vec!["configure", "box"], options].concat();
        let parsed = parse(&args);
        assert!(parsed.is_ok(), "{args:?}: {parsed:?}");
    }
}

#[test]
fn removed_combined_command_is_not_an_alias() {
    for name in ["configure-and-forward", "run"] {
        let parsed = parse(&[name, "box", "--ssh-config", "c.json"]);
        assert!(parsed.is_err(), "removed command was accepted: {parsed:?}");
        assert_eq!(parsed.unwrap_err().kind(), ErrorKind::InvalidSubcommand);
    }
}

#[test]
fn top_level_run_still_accepts_a_box_command() {
    let cli = try_parse_from(["boxlite", "run", "-d", "alpine:latest", "sleep", "600"])
        .expect("top-level run remains available");
    assert!(matches!(cli.command, Commands::Run(_)));
}

#[test]
fn configuration_sources_are_required_and_exclusive() {
    let missing = parse(&["configure", "box"]).unwrap_err();
    assert_eq!(missing.kind(), ErrorKind::MissingRequiredArgument);

    let mixed = parse(&[
        "configure",
        "box",
        "--ssh-config",
        "c.json",
        "--host-key",
        "h",
        "--login",
        "a",
        "--authorized-key",
        "k",
    ])
    .unwrap_err();
    assert_eq!(mixed.kind(), ErrorKind::ArgumentConflict);

    for flag in ["--guest-listen", "--login"] {
        let error = parse(&["configure", "box", "--ssh-config", "c.json", flag, "x"]).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::ArgumentConflict, "{flag}");
    }

    let incomplete = parse(&["configure", "box", "--host-key", "h", "--login", "a"]).unwrap_err();
    assert_eq!(incomplete.kind(), ErrorKind::MissingRequiredArgument);

    let orphan = parse(&["configure", "box", "--login", "a"]).unwrap_err();
    assert_eq!(orphan.kind(), ErrorKind::MissingRequiredArgument);
}

#[test]
fn subcommands_are_named_for_their_effect() {
    let names: Vec<String> = crate::cli::command()
        .find_subcommand("ssh")
        .expect("ssh command")
        .get_subcommands()
        .map(|command| command.get_name().to_string())
        .collect();
    assert_eq!(
        names,
        [
            "configure",
            "setup",
            "status",
            "enable",
            "disable",
            "forward",
            "proxy"
        ]
    );
    assert!(matches!(
        parse(&["forward", "box"]),
        Ok(SshCommand::Forward(_))
    ));
}

#[test]
fn setup_manages_keys_and_proxy_accepts_only_a_box() {
    for name in ["setup", "proxy"] {
        assert!(parse(&[name, "dev"]).is_ok());
        assert!(parse(&[name]).is_err());
        for flag in ["--authorized-key", "--host-key", "--login", "--listen"] {
            assert!(parse(&[name, "dev", flag, "value"]).is_err());
        }
    }
    assert!(matches!(
        parse(&["enable", "dev"]),
        Ok(SshCommand::Enable(_))
    ));
}

#[test]
fn forward_accepts_listeners_and_defaults_to_ephemeral_loopback() {
    let SshCommand::Forward(forward) = parse(&["forward", "box"]).unwrap() else {
        panic!("expected forward");
    };
    assert_eq!(forward.listen.to_string(), "tcp://127.0.0.1:0");

    for listen in ["unix:/tmp/s", "127.0.0.1:2222"] {
        let SshCommand::Forward(forward) = parse(&["forward", "box", "--listen", listen]).unwrap()
        else {
            panic!("expected forward");
        };
        let address = forward.listen.to_string();
        assert_eq!(address.strip_prefix("tcp://").unwrap_or(&address), listen);
    }

    let relative = parse(&["forward", "box", "--listen", "unix:relative"]).unwrap_err();
    assert_eq!(relative.kind(), ErrorKind::ValueValidation);
}

// ============================================================================
// Credential files
// ============================================================================

#[test]
fn flag_mode_builds_one_account_from_key_files() {
    let dir = tempfile::tempdir().unwrap();
    let host = write(dir.path(), "host", "host private key\n");
    let first = write(dir.path(), "a.pub", "\nssh-ed25519 AAAA first\n\n");
    let second = write(dir.path(), "b.pub", "ssh-ed25519 BBBB second");

    let config = load(&[
        "configure",
        "box",
        "--host-key",
        &host,
        "--login",
        "alice",
        "--authorized-key",
        &first,
        "--authorized-key",
        &second,
    ])
    .unwrap();

    assert_eq!(config.listen_address, "0.0.0.0:2222");
    assert_eq!(config.host_private_key, "host private key\n");
    assert_eq!(config.accounts.len(), 1);
    assert_eq!(config.accounts[0].login, "alice");
    assert_eq!(
        config.accounts[0].authorized_keys,
        ["ssh-ed25519 AAAA first", "ssh-ed25519 BBBB second"]
    );
    assert!(config.accounts[0].ca.is_none());
}

#[test]
fn an_authorized_key_file_holds_exactly_one_key() {
    let dir = tempfile::tempdir().unwrap();
    let host = write(dir.path(), "host", "k");
    for contents in ["ssh-ed25519 A\nssh-ed25519 B\n", "\n  \n"] {
        let keys = write(dir.path(), "keys.pub", contents);
        let error = load(&[
            "configure",
            "box",
            "--host-key",
            &host,
            "--login",
            "a",
            "--authorized-key",
            &keys,
        ])
        .unwrap_err();
        assert!(
            error.to_string().contains("exactly one public key"),
            "{error:#}"
        );
    }
}

#[test]
fn json_mode_loads_several_accounts_and_cas() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        dir.path(),
        "ssh.json",
        &serde_json::json!({
            "listen_address": "0.0.0.0:0",
            "host_private_key": "host",
            "accounts": [
                {"login": "alice", "authorized_keys": ["alice key"]},
                {"login": "bob", "ca": {"public_key": "ca key", "principal": "ops"}}
            ]
        })
        .to_string(),
    );

    let config = load(&["configure", "box", "--ssh-config", &path]).unwrap();

    assert_eq!(config.listen_address, "0.0.0.0:0");
    assert_eq!(config.accounts.len(), 2);
    assert_eq!(config.accounts[0].authorized_keys, ["alice key"]);
    let ca = config.accounts[1].ca.as_ref().expect("bob has a CA");
    assert_eq!(
        (ca.public_key.as_str(), ca.principal.as_str()),
        ("ca key", "ops")
    );
}

/// serde's own messages quote string values (`invalid type: string "..."`),
/// so every JSON failure must be reported by position only.
#[test]
fn json_errors_never_echo_file_contents() {
    let dir = tempfile::tempdir().unwrap();
    let cases = [
        format!(
            r#"{{"listen_address": "0.0.0.0:2222", "host_private_key": "{SECRET}", "accounts": "{SECRET}"}}"#
        ),
        format!(r#"{{"host_private_key": "{SECRET}", "{SECRET}": 1}}"#),
        format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{SECRET}"),
        format!(r#"{{"host_private_key": "{SECRET}""#),
    ];
    for contents in cases {
        let path = write(dir.path(), "ssh.json", &contents);
        let error = load(&["configure", "box", "--ssh-config", &path]).unwrap_err();
        let message = format!("{error:#} {error:?}");
        assert!(!message.contains(SECRET), "{message}");
        assert!(
            message.contains("line 1 column") || message.contains("line 2 column"),
            "{message}"
        );
    }
}

#[test]
fn guest_listeners_map_to_the_tunnel_target() {
    let guest = boxlite::net::constants::GUEST_IP;
    assert_eq!(
        tunnel_target("0.0.0.0:41234").unwrap().to_string(),
        format!("{guest}:41234")
    );
    assert_eq!(
        tunnel_target(&format!("{guest}:2222")).unwrap().to_string(),
        format!("{guest}:2222")
    );
    for unreachable in ["127.0.0.1:2222", "[::]:2222", "localhost:2222"] {
        assert!(tunnel_target(unreachable).is_err(), "{unreachable}");
    }
}

// ============================================================================
// REST boundary: commands against a recording stub
// ============================================================================

/// One non-lookup request the stub received.
#[derive(Debug, Clone)]
struct Recorded {
    method: Method,
    path: String,
    body: String,
}

#[derive(Default)]
struct Stub {
    requests: Vec<Recorded>,
    replies: std::collections::VecDeque<(u16, String)>,
}

/// Answers the box lookup itself; records every other request and hands out
/// the scripted replies in order, so a retry shows up as an extra request.
async fn route(
    State(state): State<Arc<Mutex<Stub>>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> Response {
    if method == Method::GET && uri.path() == "/v1/boxes/box-1" {
        let info = serde_json::json!({
            "box_id": "box-1", "name": null, "status": "running",
            "created_at": "2026-07-14T00:00:00Z", "updated_at": "2026-07-14T00:00:00Z",
            "pid": 42, "image": "alpine:latest", "cpus": 1, "memory_mib": 512,
            "auto_resume": true,
        });
        return (StatusCode::OK, axum::Json(info)).into_response();
    }
    let mut stub = state.lock().unwrap();
    stub.requests.push(Recorded {
        method,
        path: uri.to_string(),
        body: String::from_utf8_lossy(&body).into_owned(),
    });
    match stub.replies.pop_front() {
        Some((status, body)) => (
            StatusCode::from_u16(status).unwrap(),
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            body,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "no scripted reply").into_response(),
    }
}

pub(super) struct Server {
    pub(super) url: String,
    state: Arc<Mutex<Stub>>,
    home: tempfile::TempDir,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    pub(super) async fn start(replies: Vec<(u16, String)>) -> Self {
        let state = Arc::new(Mutex::new(Stub {
            requests: Vec::new(),
            replies: replies.into(),
        }));
        let app = axum::Router::new()
            .fallback(route)
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            url,
            state,
            home: tempfile::tempdir().unwrap(),
            task,
        }
    }

    async fn run(&self, args: &[&str]) -> anyhow::Result<()> {
        let home = self.home.path().to_str().unwrap();
        let cli = try_parse_from(
            ["boxlite", "--url", &self.url, "--home", home, "ssh"]
                .iter()
                .chain(args),
        )
        .expect("parse");
        let Commands::Ssh(ssh) = cli.command else {
            panic!("expected the ssh command");
        };
        super::execute(ssh, &cli.global).await
    }

    fn requests(&self) -> Vec<(String, String)> {
        self.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .map(|r| (r.method.to_string(), r.path.clone()))
            .collect()
    }

    pub(super) fn bodies(&self) -> Vec<String> {
        let stub = self.state.lock().unwrap();
        stub.requests.iter().map(|r| r.body.clone()).collect()
    }
}

pub(super) fn status(enabled: bool, listen_address: &str, generation: u64) -> String {
    serde_json::to_string(&SshStatus {
        enabled,
        generation,
        listen_address: listen_address.into(),
        host_public_key: "ssh-ed25519 HOST".into(),
        host_key_fingerprint: "SHA256:host".into(),
    })
    .unwrap()
}

fn ssh_path() -> String {
    "/v1/boxes/box-1/ssh".to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_and_disable_send_one_request_each() {
    let server = Server::start(vec![
        (200, status(true, "0.0.0.0:2222", 3)),
        (200, status(false, "", 3)),
    ])
    .await;

    server.run(&["status", "box-1"]).await.unwrap();
    server.run(&["disable", "box-1"]).await.unwrap();

    assert_eq!(
        server.requests(),
        [("GET".into(), ssh_path()), ("DELETE".into(), ssh_path())]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configure_posts_the_complete_file_configuration_once() {
    let dir = tempfile::tempdir().unwrap();
    let config = serde_json::json!({
        "listen_address": "0.0.0.0:2222",
        "host_private_key": "host",
        "accounts": [
            {"login": "alice", "authorized_keys": ["alice key"], "ca": null},
            {"login": "bob", "authorized_keys": [], "ca": {"public_key": "ca", "principal": "ops"}}
        ]
    });
    let path = write(dir.path(), "ssh.json", &config.to_string());
    let server = Server::start(vec![(
        500,
        r#"{"error":{"message":"boom","type":"Error","code":"internal"}}"#.into(),
    )])
    .await;

    let error = server
        .run(&["configure", "box-1", "--ssh-config", &path])
        .await
        .unwrap_err();

    assert!(format!("{error:#}").contains("boom"), "{error:#}");
    assert_eq!(
        server.requests(),
        [("POST".into(), ssh_path())],
        "never retried"
    );
    let sent: serde_json::Value = serde_json::from_str(&server.bodies()[0]).unwrap();
    assert_eq!(sent, config);
}

#[tokio::test]
async fn setup_and_proxy_report_missing_runtime_configuration() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("missing.json");
    let home = temp.path().join("home");
    for operation in ["setup", "proxy"] {
        let cli = try_parse_from([
            "boxlite",
            "--home",
            home.to_str().unwrap(),
            "--config",
            config.to_str().unwrap(),
            "ssh",
            operation,
            "box-1",
        ])
        .unwrap();
        let Commands::Ssh(args) = cli.command else {
            panic!("expected SSH command")
        };
        let error = super::execute(args, &cli.global).await.unwrap_err();
        assert!(
            error.to_string().contains("Configuration file not found"),
            "{error:#}"
        );
        assert!(
            !home.join("boxes").exists(),
            "invalid runtime configuration must not create box credentials"
        );
    }
}

#[tokio::test]
async fn enable_rejects_rest_without_sending_a_control_request() {
    let server = Server::start(vec![]).await;
    let error = server.run(&["enable", "box-1"]).await.unwrap_err();
    assert!(
        matches!(
            error.downcast_ref::<boxlite::BoxliteError>(),
            Some(boxlite::BoxliteError::Unsupported(_))
        ),
        "{error}"
    );
    assert!(server.requests().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forward_targets_the_port_status_reports() {
    let server = Server::start(vec![(200, status(true, "0.0.0.0:41234", 5))]).await;

    // The stub has no tunnel route, so preparation fails after it is sent.
    server.run(&["forward", "box-1"]).await.unwrap_err();

    assert_eq!(
        server.requests(),
        [
            ("GET".into(), ssh_path()),
            (
                "POST".into(),
                "/v1/boxes/box-1/network/tunnel?port=41234".into()
            ),
        ]
    );
}

#[tokio::test]
async fn forward_relays_bytes_through_the_prepared_rest_tunnel() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let uri = format!("http://{}", upstream.local_addr().unwrap());
    let server = Server::start(vec![
        (200, status(true, "0.0.0.0:41234", 5)),
        (200, serde_json::json!({"uri": uri}).to_string()),
    ])
    .await;
    let socket = server.home.path().join("f");
    let listen = format!("unix:{}", socket.display());
    let args = ["forward", "box-1", "--listen", &listen];
    let forwarding = server.run(&args);
    tokio::pin!(forwarding);
    tokio::time::timeout(Duration::from_secs(5), async {
        let traffic = async {
            tokio::join!(
                async {
                    while !socket.exists() {
                        tokio::task::yield_now().await;
                    }
                    let mut client = tokio::net::UnixStream::connect(&socket).await.unwrap();
                    client.write_all(&[0, 1, 128, 255]).await.unwrap();
                    let mut reply = [0; 4];
                    client.read_exact(&mut reply).await.unwrap();
                    assert_eq!(reply, [255, 128, 1, 0]);
                },
                async {
                    let (mut tunnel, _) = upstream.accept().await.unwrap();
                    let mut head = Vec::new();
                    while !head.ends_with(b"\r\n\r\n") {
                        head.push(tunnel.read_u8().await.unwrap());
                    }
                    assert!(head.starts_with(b"CONNECT "));
                    tunnel
                        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                        .await
                        .unwrap();
                    let mut request = [0; 4];
                    tunnel.read_exact(&mut request).await.unwrap();
                    assert_eq!(request, [0, 1, 128, 255]);
                    request.reverse();
                    tunnel.write_all(&request).await.unwrap();
                }
            );
        };
        tokio::select! {
            result = &mut forwarding => panic!("forwarding ended before the exchange: {result:?}"),
            () = traffic => {}
        }
    })
    .await
    .expect("forwarded exchange must complete");
    assert_eq!(
        server.requests(),
        [
            ("GET".into(), ssh_path()),
            (
                "POST".into(),
                "/v1/boxes/box-1/network/tunnel?port=41234".into()
            ),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forward_refuses_disabled_or_unreachable_ssh_before_tunneling() {
    for reply in [
        status(false, "", 0),
        status(true, "127.0.0.1:2222", 2),
        status(true, "0.0.0.0:0", 2),
    ] {
        let server = Server::start(vec![(200, reply)]).await;

        server.run(&["forward", "box-1"]).await.unwrap_err();

        assert_eq!(server.requests(), [("GET".into(), ssh_path())]);
    }
}
