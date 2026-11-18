//! Real CLI selection and stdio over loopback REST/CONNECT; no VM or cloud account.

use std::collections::BTreeSet;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use assert_cmd::Command;
use axum::http::Method;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[path = "fixtures/ssh_cloud.rs"]
mod fixture;
use fixture::*;

impl Cloud {
    /// Store OIDC credentials without an API key, to distinguish bearer selection.
    fn save_oidc_context(&self, home: &Path) {
        std::fs::write(
            home.join("credentials.toml"),
            toml::to_string(&json!({
                "profiles": {"cloud": {"url": self.url, "auth_method": "oidc",
                    "access_token": "oidc-token", "path_prefix": "team"}}
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(home.join("cli.toml"), "current_context = 'cloud'\n").unwrap();
    }
}

/// Run the real default CLI and expect OpenSSH's handshake-failure code:
/// this fixture establishes authenticated CONNECT, not a successful SSH login.
fn connect(home: &Path, flags: &[&str]) {
    cli(home)
        .args(flags)
        .args(["ssh", "dev"])
        .assert()
        .code(255)
        .stdout(predicates::str::is_empty());
}

/// Create a genuine Ed25519 private/public pair for the explicit control fixture.
fn generate_key(path: &Path) {
    let result = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(path)
        .status()
        .expect("run ssh-keygen");
    assert!(result.success(), "ssh-keygen failed for {}", path.display());
}

/// Configure SSH through the real CLI before proxy/tunnel tests, which otherwise
/// would deadlock against this fixture's echo-only (non-SSH) CONNECT listener.
fn configure_fixture(home: &Path) -> Value {
    let keys = tempfile::tempdir().unwrap();
    let host = keys.path().join("host");
    let client = keys.path().join("client");
    generate_key(&host);
    generate_key(&client);
    let output = cli(home)
        .args([
            "--context",
            "cloud",
            "ssh",
            "--configure",
            "dev",
            "--host-key",
        ])
        .arg(&host)
        .args(["--login", "box", "--authorized-key"])
        .arg(client.with_extension("pub"))
        .args(["--guest-listen", "0.0.0.0:2222"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    serde_json::from_slice(&output).unwrap()
}

/// Prepare installation with a distinct user SSH home and credential home.
fn install_command(home: &Path, user_home: &Path) -> Command {
    let mut command = cli(home);
    command
        .env("HOME", user_home)
        .args(["ssh", "dev", "--install-ssh-config"]);
    command
}

/// Explicit configure and control calls preserve saved host identity and
/// authentication; lifecycle failures must not be retried.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_control_options_preserve_context_authentication_and_saved_configuration() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let initial = configure_fixture(home.path());
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
    let configured: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(
        configured["host_key_fingerprint"],
        initial["host_key_fingerprint"]
    );
    cloud.state.lock().unwrap().requests.clear();
    for (operation, enabled, generation) in [
        ("--disable", false, 2),
        ("--status", false, 2),
        ("--enable", true, 3),
        ("--status", true, 3),
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
        assert_eq!(status["generation"], generation);
        assert_eq!(
            status["host_key_fingerprint"],
            if enabled {
                initial["host_key_fingerprint"].clone()
            } else {
                json!("")
            }
        );
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

/// A second real CLI connection reuses its identity and reads healthy status;
/// both attempts reach authenticated CONNECT, then fail non-SSH handshake.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_reuses_keys_and_routes_authenticated_connect() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "-cloud ' % $()", "stored");
    connect(home.path(), &["--path-prefix=-team/override"]);
    let key = only_credential_directory(home.path()).join("client_key");
    let initial_key = std::fs::read(&key).unwrap();
    connect(home.path(), &["--path-prefix=-team/override"]);
    assert_eq!(
        only_credential_directory(home.path()).join("client_key"),
        key
    );
    assert_eq!(std::fs::read(&key).unwrap(), initial_key);
    assert!(!home.path().join("boxes").exists());

    let state = cloud.state.lock().unwrap();
    assert_eq!(
        state.configs.len(),
        1,
        "healthy service is not reconfigured"
    );
    assert_eq!(state.generation, 1);
    assert_eq!(state.configs[0]["listen_address"], "0.0.0.0:22");
    assert_eq!(state.configs[0]["accounts"][0]["login"], "box");
    assert_eq!(
        state.configs[0]["host_private_key"],
        std::fs::read_to_string(key.with_file_name("host_key")).unwrap()
    );
    assert!(
        state.requests.iter().all(|(_, path, auth)| {
            path.starts_with("/v1/-team/override/boxes/") && auth == "Bearer stored-key"
        }),
        "{:?}",
        state.requests
    );
    assert_eq!(
        state
            .requests
            .iter()
            .filter(|(method, path, _)| { method == Method::POST && path.ends_with("/ssh") })
            .count(),
        1
    );
    assert_eq!(
        state
            .requests
            .iter()
            .filter(|(method, path, _)| { method == Method::GET && path.ends_with("/ssh") })
            .count(),
        1,
        "the second connection reads a healthy status"
    );
    assert_eq!(
        state
            .requests
            .iter()
            .filter(|(method, path, _)| {
                method == Method::POST
                    && path == "/v1/-team/override/boxes/-remote/network/tunnel?port=22"
            })
            .count(),
        2
    );
    assert_eq!(state.connects.len(), 2);
    assert!(state.connects.iter().all(|connect| {
        connect.starts_with("CONNECT ")
            && connect
                .to_ascii_lowercase()
                .contains("x-boxlite-authorization: bearer stored-key")
    }));
}

/// Reconnecting to a disabled saved identity enables it once without replacing
/// keys or reconfiguring the guest.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_enables_saved_configuration_without_reconfiguring() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    connect(home.path(), &[]);
    let key = only_credential_directory(home.path()).join("client_key");
    let original = std::fs::read(&key).unwrap();
    cli(home.path())
        .args(["ssh", "--disable", "dev"])
        .assert()
        .success();
    cloud.state.lock().unwrap().requests.clear();
    connect(home.path(), &[]);

    let state = cloud.state.lock().unwrap();
    assert_eq!(state.generation, 2);
    assert_eq!(state.configs.len(), 1);
    assert_eq!(std::fs::read(key).unwrap(), original);
    assert_eq!(state.connects.len(), 2);
    assert_eq!(
        state
            .requests
            .iter()
            .filter(|(method, path, _)| { method == Method::POST && path.ends_with("/ssh/enable") })
            .count(),
        1
    );
    assert!(state.requests.iter().all(|(method, path, auth)| {
        path.starts_with("/v1/team/boxes/")
            && auth == "Bearer stored-key"
            && !(method == Method::POST && path.ends_with("/ssh"))
    }));
}

/// An explicitly empty prefix stays authoritative after persisted context edits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[rstest::rstest]
#[case("default")]
#[case("cloud")]
async fn cloud_connect_explicit_empty_prefix_survives_saved_context_changes(#[case] context: &str) {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), context, "");
    connect(home.path(), &["--path-prefix="]);
    cloud.save_context(home.path(), context, "changed");
    cloud.state.lock().unwrap().requests.clear();
    connect(home.path(), &["--path-prefix="]);

    let state = cloud.state.lock().unwrap();
    assert_eq!(state.configs.len(), 1);
    assert_eq!(state.requests.len(), 3, "lookup, SSH status, tunnel");
    assert!(
        state
            .requests
            .iter()
            .all(|(_, path, auth)| path.starts_with("/v1/boxes/") && auth == "Bearer stored-key"),
        "explicit empty prefix changed routes: {:?}",
        state.requests
    );
    assert_eq!(state.connects.len(), 2);
}

/// CLI flag, process environment, then saved prefix precedence determines actual
/// REST and CONNECT routing, not a printed command for a future invocation.
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
    command
        .args(["ssh", "dev"])
        .assert()
        .code(255)
        .stdout(predicates::str::is_empty());
    let root = if expected.is_empty() {
        "/v1/boxes/".to_string()
    } else {
        format!("/v1/{expected}/boxes/")
    };
    let state = cloud.state.lock().unwrap();
    assert_eq!(state.configs.len(), 1);
    assert_eq!(state.connects.len(), 1);
    assert!(
        state
            .requests
            .iter()
            .all(|(_, path, auth)| path.starts_with(&root) && auth == "Bearer stored-key"),
        "unexpected routing: {:?}",
        state.requests
    );
    assert!(
        state.connects[0]
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer stored-key")
    );
}

/// Binary stdio through explicit proxy mode uses the selected environment bearer
/// without changing the independently configured guest SSH service.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_proxy_relays_binary_data_with_stored_context_and_environment_key() {
    let cloud = Cloud::start(true).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    configure_fixture(home.path());
    cloud.state.lock().unwrap().requests.clear();
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
    assert_eq!(state.configs.len(), 1, "proxy must not reconfigure SSH");
    assert!(
        state.connects[0]
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer environment-key")
    );
}

/// Explicit tunnel mode retains its listener until interrupted and reports the
/// fingerprint derived from the previously accepted host configuration.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_tunnel_option_forwards_bytes_and_reports_server_fingerprint() {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let cloud = Cloud::start(true).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let fixture = configure_fixture(home.path());
    cloud.state.lock().unwrap().requests.clear();
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
            diagnostics.contains(fixture["host_key_fingerprint"].as_str().unwrap()),
            "{diagnostics}"
        );
    })
    .await
    .expect("cloud tunnel exchange and shutdown must complete");
    let state = cloud.state.lock().unwrap();
    assert_eq!(state.configs.len(), 1, "tunneling must not reconfigure SSH");
    assert!(
        state
            .requests
            .iter()
            .any(|(method, path, auth)| method == Method::POST
                && path == "/v1/team/boxes/-remote/network/tunnel?port=2222"
                && auth == "Bearer stored-key")
    );
    assert!(
        state.connects[0]
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer stored-key")
    );
}

/// Failed configure keeps its identity; changes in context, endpoint, or prefix
/// create distinct credentials and authenticated CONNECT routes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_isolates_context_endpoint_and_prefix_and_retains_failed_keys() {
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
    let failed_directory = only_credential_directory(home.path());
    assert!(cloud.state.lock().unwrap().connects.is_empty());
    assert_eq!(cloud.state.lock().unwrap().configs.len(), 0);
    cloud.state.lock().unwrap().configure_error = false;
    connect(home.path(), &[]);
    {
        let state = cloud.state.lock().unwrap();
        assert_eq!(
            state.attempted_configs.len(),
            2,
            "failed configure is not retried"
        );
        assert_eq!(state.attempted_configs[0], state.attempted_configs[1]);
        assert_eq!(state.configs, [state.attempted_configs[1].clone()]);
        assert_eq!(state.connects.len(), 1);
    }
    assert_eq!(only_credential_directory(home.path()), failed_directory);

    let mut paths = vec![failed_directory.join("client_key")];
    for flags in [
        vec!["--context", "other"],
        vec!["--path-prefix", "another"],
        vec!["--url", cloud.url.as_str()],
        vec!["--url", other.url.as_str()],
    ] {
        let before = credential_directories(home.path());
        connect(home.path(), &flags);
        let after = credential_directories(home.path());
        let added: Vec<_> = after.difference(&before).collect();
        assert_eq!(added.len(), 1, "each routing scope gets an identity");
        paths.push(added[0].join("client_key"));
    }
    for (i, path) in paths.iter().enumerate() {
        for previous in &paths[..i] {
            assert_ne!(path, previous);
            assert_ne!(
                std::fs::read(path).unwrap(),
                std::fs::read(previous).unwrap()
            );
        }
    }
    let state = cloud.state.lock().unwrap();
    assert_eq!(state.configs.len(), 4);
    assert_eq!(state.connects.len(), 4);
    assert!(
        state
            .requests
            .iter()
            .any(|(_, path, _)| path.starts_with("/v1/another/boxes/"))
    );
    assert!(
        state
            .requests
            .iter()
            .any(|(_, path, _)| path.starts_with("/v1/team/boxes/"))
    );
    assert_eq!(other.state.lock().unwrap().configs.len(), 1);
    assert_eq!(other.state.lock().unwrap().connects.len(), 1);
}

/// REST selection creates credentials in the new remote home without reading
/// nonexistent local runtime config, for both present and empty prefixes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_uses_new_credential_home_and_ignores_local_config() {
    for prefix in ["env-team", ""] {
        let cloud = Cloud::start(false).await;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("new-home");
        cli(&home)
            .env("BOXLITE_REST_URL", &cloud.url)
            .env("BOXLITE_REST_PATH_PREFIX", prefix)
            .env("BOXLITE_API_KEY", "environment-key")
            .args(["--config", "/missing/local-config.json", "ssh", "dev"])
            .assert()
            .code(255)
            .stdout(predicates::str::is_empty());
        assert!(only_credential_directory(&home).join("client_key").exists());
        assert!(!home.join("boxes").exists());
        let expected_path = if prefix.is_empty() {
            "/v1/boxes/"
        } else {
            "/v1/env-team/boxes/"
        };
        let state = cloud.state.lock().unwrap();
        assert!(
            state.requests.iter().all(|(_, path, auth)| {
                path.starts_with(expected_path) && auth == "Bearer environment-key"
            }),
            "{:?}",
            state.requests
        );
        assert_eq!(state.configs.len(), 1);
        assert_eq!(state.connects.len(), 1);
        assert!(state.connects[0].starts_with("CONNECT "));
        assert!(
            state.connects[0]
                .to_ascii_lowercase()
                .contains("x-boxlite-authorization: bearer environment-key")
        );
    }
}

/// Default connection sends the persisted OIDC bearer to REST and CONNECT;
/// the deliberately non-SSH peer still makes the OpenSSH process exit 255.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_uses_stored_oidc_bearer() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_oidc_context(home.path());
    connect(home.path(), &["--context", "cloud"]);
    let state = cloud.state.lock().unwrap();
    assert_eq!(state.configs.len(), 1);
    assert!(
        state.requests.iter().all(|(_, path, auth)| {
            path.starts_with("/v1/team/") && auth == "Bearer oidc-token"
        })
    );
    assert_eq!(state.connects.len(), 1);
    assert!(
        state.connects[0]
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer oidc-token")
    );
}

/// Explicit proxy mode uses the stored OIDC bearer and the echo listener only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_proxy_uses_stored_oidc_bearer() {
    let cloud = Cloud::start(true).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_oidc_context(home.path());
    configure_fixture(home.path());
    cloud.state.lock().unwrap().requests.clear();
    cli(home.path())
        .args(["--context", "cloud", "ssh", "--proxy", "dev"])
        .write_stdin("hello")
        .assert()
        .success()
        .stdout("olleh");
    let state = cloud.state.lock().unwrap();
    assert_eq!(state.configs.len(), 1);
    assert!(
        state.requests.iter().all(|(_, path, auth)| {
            path.starts_with("/v1/team/") && auth == "Bearer oidc-token"
        })
    );
    assert_eq!(state.connects.len(), 1);
    assert!(
        state.connects[0]
            .to_ascii_lowercase()
            .contains("x-boxlite-authorization: bearer oidc-token")
    );
}

/// Unconfigured/disabled SSH and missing boxes fail before CONNECT; an already
/// configured proxy never changes the guest's SSH configuration.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_proxy_reports_disabled_missing_and_unsupported_with_saved_configuration() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let status = cli(home.path())
        .args(["ssh", "--status", "dev"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let initial: Value = serde_json::from_slice(&status).unwrap();
    assert_eq!(initial["enabled"], false);
    assert_eq!(initial["generation"], 0);
    assert_eq!(initial["host_public_key"], "");
    cli(home.path())
        .args(["ssh", "--enable", "dev"])
        .assert()
        .failure()
        .stderr(predicates::str::contains("SSH configuration is required"));
    cli(home.path())
        .args(["ssh", "--proxy", "dev"])
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(predicates::str::contains("guest SSH is disabled"));
    assert_eq!(cloud.state.lock().unwrap().configs.len(), 0);
    let fixture = configure_fixture(home.path());
    assert_eq!(fixture["generation"], 1);
    cli(home.path())
        .args(["ssh", "--disable", "dev"])
        .assert()
        .success();
    cloud.state.lock().unwrap().requests.clear();
    cli(home.path())
        .args(["ssh", "--proxy", "dev"])
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(predicates::str::contains("guest SSH is disabled"));
    assert_eq!(cloud.state.lock().unwrap().requests.len(), 2);
    cli(home.path())
        .args(["ssh", "--enable", "dev"])
        .assert()
        .success();
    cloud.state.lock().unwrap().tunnel_error = true;
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
    assert_eq!(state.configs.len(), 1, "proxy does not configure SSH");
    assert!(state.connects.is_empty());
}

/// Search failures in an earlier PATH component do not mask later valid tools;
/// inaccessible-only search directories retain their permission diagnostics.
#[rstest::rstest]
#[case::file_prefix(false, true)]
#[case::inaccessible_prefix(true, true)]
#[case::inaccessible_only(true, false)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_searches_past_invalid_path_entries(
    #[case] inaccessible: bool,
    #[case] include_valid_tools: bool,
) {
    // SAFETY: geteuid has no arguments or memory-safety preconditions.
    if inaccessible && unsafe { nix::libc::geteuid() } == 0 {
        eprintln!("root bypasses directory permissions; skipping inaccessible PATH case");
        return;
    }
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let entries = tempfile::tempdir().unwrap();
    let invalid = entries.path().join("invalid");
    if inaccessible {
        std::fs::create_dir(&invalid).unwrap();
        std::fs::set_permissions(&invalid, std::fs::Permissions::from_mode(0o000)).unwrap();
    } else {
        std::fs::write(&invalid, "not a directory").unwrap();
    }
    let mut path = vec![invalid.clone()];
    if include_valid_tools {
        path.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    }
    let result = cli(home.path())
        .env("PATH", std::env::join_paths(path).unwrap())
        .args(["ssh", "dev"])
        .assert();
    if inaccessible {
        std::fs::set_permissions(&invalid, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let state = cloud.state.lock().unwrap();
    if include_valid_tools {
        result.code(255).stdout(predicates::str::is_empty());
        assert_eq!(state.configs.len(), 1);
        assert_eq!(state.connects.len(), 1);
        assert!(
            state.connects[0]
                .to_ascii_lowercase()
                .contains("x-boxlite-authorization: bearer stored-key")
        );
    } else {
        result
            .failure()
            .stderr(predicates::str::contains("Permission denied"));
        assert!(state.requests.is_empty());
        assert!(credential_directories(home.path()).is_empty());
    }
}

/// Owner permissions take precedence over execute bits granted to other users.
/// Both PATH cases run only in CLI subprocesses: denied-only must touch no REST
/// or credential state, while a later executable still reaches CONNECT.
#[rstest::rstest]
#[case::inaccessible_only(false)]
#[case::later_executable(true)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_checks_effective_execute_access(#[case] include_valid_ssh: bool) {
    // SAFETY: geteuid has no arguments or memory-safety preconditions.
    if unsafe { nix::libc::geteuid() } == 0 {
        eprintln!("root bypasses owner execute permissions; skipping permission-class case");
        return;
    }
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let tools = tempfile::tempdir().unwrap();
    let inaccessible = tools.path().join("ssh");
    std::fs::write(&inaccessible, "#!/bin/sh\nexit 99\n").unwrap();
    std::fs::set_permissions(&inaccessible, std::fs::Permissions::from_mode(0o641)).unwrap();
    let system_path = std::env::var_os("PATH").unwrap();
    let keygen = std::env::split_paths(&system_path)
        .map(|directory| directory.join("ssh-keygen"))
        .find(|path| path.is_file())
        .expect("the test runner needs system ssh-keygen");
    symlink(
        std::fs::canonicalize(keygen).unwrap(),
        tools.path().join("ssh-keygen"),
    )
    .unwrap();
    let mut path = vec![tools.path().to_path_buf()];
    if include_valid_ssh {
        path.extend(std::env::split_paths(&system_path));
    }
    let result = cli(home.path())
        .env("PATH", std::env::join_paths(path).unwrap())
        .args(["ssh", "dev"])
        .assert();
    let state = cloud.state.lock().unwrap();
    if include_valid_ssh {
        result.code(255);
        assert_eq!(state.configs.len(), 1);
        assert_eq!(state.connects.len(), 1);
    } else {
        result.failure();
        assert!(
            state.requests.is_empty(),
            "inaccessible ssh must fail before any REST requests"
        );
        assert!(credential_directories(home.path()).is_empty());
        assert!(state.attempted_configs.is_empty());
        assert!(state.connects.is_empty());
    }
}

/// Missing, directory, or nonexecuting OpenSSH tools fail before creating a
/// runtime home, credentials, or sending even an initial REST lookup.
#[rstest::rstest]
#[case::empty_path(false, false, "ssh")]
#[case::ssh_only(true, false, "ssh-keygen")]
#[case::directory_ssh(false, true, "ssh")]
#[case::nonexecutable_keygen(true, true, "ssh-keygen")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_requires_openssh_before_runtime_or_credentials(
    #[case] include_ssh: bool,
    #[case] rejected_entry: bool,
    #[case] missing_tool: &str,
) {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let initial_home_entries: BTreeSet<_> = std::fs::read_dir(home.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    let tools = tempfile::tempdir().unwrap();
    if include_ssh {
        let ssh = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| directory.join("ssh"))
            .find(|path| {
                std::fs::metadata(path).is_ok_and(|metadata| {
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                })
            })
            .expect("the test runner needs system ssh");
        symlink(
            std::fs::canonicalize(ssh).unwrap(),
            tools.path().join("ssh"),
        )
        .unwrap();
        if rejected_entry {
            std::fs::write(tools.path().join("ssh-keygen"), "not executable").unwrap();
        }
    } else if rejected_entry {
        std::fs::create_dir(tools.path().join("ssh")).unwrap();
    }
    cli(home.path())
        .env("PATH", tools.path())
        .args(["ssh", "dev"])
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(predicates::str::contains(format!(
            "OpenSSH client tool '{missing_tool}' was not found in PATH; install the OpenSSH client package."
        )));
    let local_home = home.path().join("local");
    cli(&local_home)
        .env("PATH", tools.path())
        .args(["--config", "/missing/runtime-config.json", "ssh", "unresolved"])
        .assert()
        .failure()
        .stderr(predicates::str::contains(format!(
            "OpenSSH client tool '{missing_tool}' was not found in PATH; install the OpenSSH client package."
        )));
    assert!(
        !local_home.exists(),
        "preflight precedes local runtime creation"
    );
    let current_home_entries: BTreeSet<_> = std::fs::read_dir(home.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(current_home_entries, initial_home_entries);
    assert!(!home.path().join("boxes").exists());
    assert!(credential_directories(home.path()).is_empty());
    let state = cloud.state.lock().unwrap();
    assert!(
        state.requests.is_empty(),
        "no REST reads or writes before preflight"
    );
    assert!(state.attempted_configs.is_empty());
    assert!(state.connects.is_empty());
}

/// Reject SSH-incompatible paths before mutating guest service or writing keys.
#[rstest::rstest]
#[case::environment_expansion("home-${HOME}")]
#[case::control_character("home-\n")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_rejects_unusable_paths_before_side_effects(#[case] name: &str) {
    let cloud = Cloud::start(false).await;
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join(name);
    std::fs::create_dir(&home).unwrap();
    cloud.save_context(&home, "cloud", "team");
    let original = configure_fixture(&home);
    cloud.state.lock().unwrap().requests.clear();

    let output = cli(&home).args(["ssh", "dev"]).output().unwrap();
    assert!(
        !output.status.success(),
        "unsupported paths must be rejected"
    );
    let state = cloud.state.lock().unwrap();
    assert_eq!(
        state.configs.len(),
        1,
        "unusable paths must be rejected before replacing guest SSH configuration"
    );
    assert_eq!(state.status(), original);
    assert!(
        state
            .requests
            .iter()
            .all(|(method, _, _)| *method == Method::GET),
        "unusable paths must not mutate guest services: {:?}",
        state.requests
    );
    assert!(state.connects.is_empty());
    assert!(
        !home.join("ssh").exists(),
        "unusable paths must not create managed credentials"
    );
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("SSH command paths"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A termination signal while tunnel preparation blocks must release the CLI
/// without starting OpenSSH, retaining the expected signal-derived exit code.
#[rstest::rstest]
#[case::interrupt(nix::sys::signal::Signal::SIGINT)]
#[case::terminate(nix::sys::signal::Signal::SIGTERM)]
#[case::hangup(nix::sys::signal::Signal::SIGHUP)]
#[case::quit(nix::sys::signal::Signal::SIGQUIT)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_connect_cancels_pending_tunnel_preparation(
    #[case] signal: nix::sys::signal::Signal,
) {
    use std::process::Stdio;
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let entered = Arc::new(tokio::sync::Notify::new());
    cloud.state.lock().unwrap().blocked_tunnel = Some(entered.clone());
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
        .args(["ssh", "dev"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    if tokio::time::timeout(Duration::from_secs(10), entered.notified())
        .await
        .is_err()
    {
        child.kill().await.unwrap();
        panic!("fixture did not observe the tunnel preparation request");
    }
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        signal,
    )
    .unwrap();
    let exited = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    let status = match exited {
        Ok(result) => result.unwrap(),
        Err(_) => {
            child.kill().await.unwrap();
            panic!("SSH CLI ignored {signal} while tunnel preparation was pending");
        }
    };
    assert_eq!(status.code(), Some(128 + signal as i32));
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .await
        .unwrap();
    assert!(stdout.is_empty());
    let state = cloud.state.lock().unwrap();
    assert_eq!(state.configs.len(), 1);
    assert!(state.enabled);
    assert!(
        state.connects.is_empty(),
        "cancellation must not launch an SSH connection"
    );
}

/// HOME must identify OpenSSH's account home before installation has any effect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_install_rejects_mismatched_home_before_side_effects() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    install_command(home.path(), user_home.path())
        .assert()
        .failure()
        .stdout(predicates::str::is_empty());

    assert!(
        !home.path().join("ssh").exists(),
        "credentials were created"
    );
    assert!(
        !user_home.path().join(".ssh").exists(),
        "SSH config was created"
    );
    assert!(
        !user_home.path().join(".boxlite").exists(),
        "managed config was created"
    );
    let state = cloud.state.lock().unwrap();
    assert!(state.requests.is_empty(), "runtime contacted REST");
    assert!(
        state.attempted_configs.is_empty(),
        "guest configuration was attempted"
    );
    assert!(state.configs.is_empty());
    assert_eq!(state.generation, 0);
    assert!(state.connects.is_empty());
}

/// Local proxy selection bypasses stale or malformed remote preferences instead
/// of accidentally resolving the ambient cloud context.
#[rstest::rstest]
#[case::stale_context(false)]
#[case::malformed_credentials(true)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_local_proxy_bypasses_remote_selection(#[case] malformed: bool) {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    std::fs::write(
        home.path().join("cli.toml"),
        "current_context = 'removed'\n",
    )
    .unwrap();
    if malformed {
        std::fs::write(home.path().join("credentials.toml"), "[not valid TOML").unwrap();
    }
    let output = cli(home.path())
        .env("HOME", user_home.path())
        .env("BOXLITE_CONTEXT", "removed")
        .env("BOXLITE_PROFILE", "removed")
        .env("BOXLITE_REST_URL", &cloud.url)
        .env("BOXLITE_REST_PATH_PREFIX", "ambient")
        .env("BOXLITE_API_KEY", "environment-key")
        .args([
            "ssh",
            "--proxy",
            "--proxy-local",
            "--",
            "missing-local-install-box",
        ])
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .get_output()
        .clone();
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(!error.contains("context `"), "{error}");
    assert!(!error.contains("context preferences"), "{error}");
    assert!(!error.contains("credentials.toml"), "{error}");
    assert!(!error.contains("unexpected argument"), "{error}");
    assert!(cloud.state.lock().unwrap().requests.is_empty());
    assert!(cloud.state.lock().unwrap().connects.is_empty());
    // Stub builds may fail runtime qualification before looking up this missing box.
}
