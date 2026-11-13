//! Shared loopback REST/CONNECT fixture for CLI and in-crate install tests.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use assert_cmd::Command;
use axum::body::Bytes;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use russh::keys::HashAlg;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
pub(crate) struct Recording {
    pub(crate) requests: Vec<(Method, String, String)>,
    pub(crate) configs: Vec<Value>,
    pub(crate) attempted_configs: Vec<Value>,
    pub(crate) connects: Vec<String>,
    pub(crate) enabled: bool,
    pub(crate) generation: u64,
    pub(crate) host_public_key: String,
    pub(crate) host_key_fingerprint: String,
    pub(crate) configure_error: bool,
    pub(crate) missing: bool,
    pub(crate) tunnel_error: bool,
    pub(crate) lifecycle_error: bool,
    pub(crate) blocked_tunnel: Option<Arc<tokio::sync::Notify>>,
}

impl Recording {
    /// Store only an accepted configuration and derive the status identity
    /// from its real private host key; rejected writes leave status unchanged.
    fn configure(&mut self, config: Value) {
        let key = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(key.path(), config["host_private_key"].as_str().unwrap()).unwrap();
        let private = russh::keys::load_secret_key(key.path(), None).unwrap();
        let public = private.public_key();
        self.host_public_key = russh::keys::PublicKey::new(public.key_data().clone(), "")
            .to_openssh()
            .unwrap();
        self.host_key_fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
        self.configs.push(config);
        self.enabled = true;
        self.generation += 1;
    }

    /// Report the saved generation even when disabled, but hide inactive
    /// listener and host identity as the guest status API does.
    pub(crate) fn status(&self) -> Value {
        let (listen_address, public_key, fingerprint) = if self.enabled {
            (
                self.configs.last().unwrap()["listen_address"]
                    .as_str()
                    .unwrap(),
                self.host_public_key.as_str(),
                self.host_key_fingerprint.as_str(),
            )
        } else {
            ("", "", "")
        };
        json!({
            "enabled": self.enabled,
            "generation": self.generation,
            "listen_address": listen_address,
            "host_public_key": public_key,
            "host_key_fingerprint": fingerprint,
        })
    }
}

pub(crate) struct Cloud {
    pub(crate) url: String,
    pub(crate) state: Arc<Mutex<Recording>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Cloud {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Record REST authorization headers and model SSH enable/configure transitions;
/// the tunnel endpoint is deliberately separate from the non-SSH CONNECT peer.
async fn route(
    State((state, tunnel)): State<(Arc<Mutex<Recording>>, String)>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let blocked_tunnel = {
        let mut state = state.lock().unwrap();
        state.requests.push((
            method.clone(),
            uri.to_string(),
            headers
                .get("authorization")
                .map(|value| value.to_str().unwrap())
                .unwrap_or_default()
                .into(),
        ));
        if uri.path().ends_with("/network/tunnel") {
            state.blocked_tunnel.clone()
        } else {
            None
        }
    };
    if let Some(entered) = blocked_tunnel {
        entered.notify_one();
        return std::future::pending().await;
    }
    let mut state = state.lock().unwrap();
    if state.missing || (uri.path().ends_with("/network/tunnel") && state.tunnel_error) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let reply = if uri.path().ends_with("/ssh") || uri.path().ends_with("/ssh/enable") {
        if state.lifecycle_error && (method == Method::DELETE || uri.path().ends_with("/enable")) {
            return (StatusCode::CONFLICT, "box must be running").into_response();
        }
        if uri.path().ends_with("/enable") {
            if state.configs.is_empty() {
                return (StatusCode::CONFLICT, "SSH configuration is required").into_response();
            }
            if !state.enabled {
                state.generation += 1;
            }
            state.enabled = true;
        } else if method == Method::DELETE {
            state.enabled = false;
        }
        if method == Method::POST && uri.path().ends_with("/ssh") {
            let config: Value = serde_json::from_slice(&body).unwrap();
            state.attempted_configs.push(config.clone());
            if state.configure_error {
                return (StatusCode::CONFLICT, "configuration refused").into_response();
            }
            state.configure(config);
        }
        state.status()
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
    /// Run a reusable CONNECT listener: echo mode exercises binary proxy data;
    /// normal mode rejects SSH after CONNECT, proving routing rather than login.
    pub(crate) async fn start(echo: bool) -> Self {
        let state = Arc::new(Mutex::new(Recording::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tunnel = format!("http://{}", listener.local_addr().unwrap());
        let captured = state.clone();
        let transport = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(socket.read_u8().await.unwrap());
                }
                captured
                    .lock()
                    .unwrap()
                    .connects
                    .push(String::from_utf8(head).unwrap());
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
                    // Real OpenSSH reaches CONNECT, then fails its SSH handshake.
                    socket.write_all(b"not an SSH server\r\n").await.unwrap();
                }
                socket.shutdown().await.unwrap();
            }
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

    pub(crate) fn save_context(&self, home: &Path, context: &str, prefix: &str) {
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

pub(crate) fn isolated(command: &mut Command, home: &Path) {
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

pub(crate) fn cli_executable() -> PathBuf {
    let executable = std::env::var_os("CARGO_BIN_EXE_boxlite")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let harness = std::env::current_exe().expect("locate the CLI test harness");
            // Cargo uses both profile/deps and profile/build/<package>/<hash>/out.
            let profile = harness
                .ancestors()
                .find(|path| path.ends_with("deps") || path.ends_with("build"))
                .and_then(Path::parent)
                .unwrap_or_else(|| {
                    panic!(
                        "unrecognized Cargo test path {}; set CARGO_BIN_EXE_boxlite",
                        harness.display()
                    )
                });
            profile.join(format!("boxlite{}", std::env::consts::EXE_SUFFIX))
        });
    assert!(
        executable.is_file(),
        "CLI binary not found at {}; build boxlite or set CARGO_BIN_EXE_boxlite",
        executable.display()
    );
    executable
}

pub(crate) fn cli(home: &Path) -> Command {
    let mut command = Command::new(cli_executable());
    isolated(&mut command, home);
    command
}

/// Discover generated remote identities by their actual directory shape instead
/// of duplicating the production hash of context, endpoint, and routing prefix.
pub(crate) fn credential_directories(home: &Path) -> BTreeSet<PathBuf> {
    let root = home.join("ssh/remote");
    if !root.exists() {
        return BTreeSet::new();
    }
    std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path().join("-remote"))
        .filter(|directory| directory.join("client_key").exists())
        .collect()
}

/// Require one managed remote identity for tests that do not vary routing scope.
pub(crate) fn only_credential_directory(home: &Path) -> PathBuf {
    let directories = credential_directories(home);
    assert_eq!(directories.len(), 1, "expected one managed SSH identity");
    directories.into_iter().next().unwrap()
}
