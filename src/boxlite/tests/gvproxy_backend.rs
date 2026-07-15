#![cfg(feature = "gvproxy")]

//! Live gvproxy backend integration tests.
//!
//! These exercise the cross-process contract between the core-side
//! `GvproxyBackend` control client and a real shim-side `GvproxyInstance`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use boxlite::net::gvproxy::GvproxyInstance;
use boxlite::net::{
    GvproxyBackend, NetworkBackend, NetworkBackendConfig, NetworkBackendSpec, TransportProtocol,
};
use notify::Watcher;

const SERVICES_SOCKET_READY_TIMEOUT: Duration = Duration::from_secs(30);

fn backend_for(
    dir: &tempfile::TempDir,
) -> (
    GvproxyInstance,
    GvproxyBackend,
    boxlite::net::NetworkBackendEndpoint,
    PathBuf,
) {
    let net_sock = dir.path().join("net.sock");
    let control_sock = dir.path().join("gvproxy-ctl.sock");
    let spec = NetworkBackendSpec {
        port_mappings: Vec::new(),
        socket_path: net_sock.clone(),
        allow_net: Vec::new(),
        secrets: Vec::new(),
        ca_cert_pem: None,
        ca_key_pem: None,
    };
    let (instance, endpoint) = GvproxyInstance::from_config(&spec).expect("create gvproxy");
    let config = NetworkBackendConfig {
        port_mappings: Vec::new(),
        socket_path: net_sock,
        allow_net: Vec::new(),
        secrets: Vec::new(),
        ca_dir: dir.path().to_path_buf(),
    };
    (
        instance,
        GvproxyBackend::from_config(&config),
        endpoint,
        control_sock,
    )
}

async fn wait_for_services(backend: &GvproxyBackend, control_sock: PathBuf) {
    if backend.list_forwards().await.is_ok() {
        return;
    }

    let socket_for_watch = control_sock.clone();
    tokio::task::spawn_blocking(move || wait_for_socket_file(socket_for_watch))
        .await
        .expect("wait for gvproxy services socket task")
        .unwrap_or_else(|err| panic!("{err}"));

    backend.list_forwards().await.unwrap_or_else(|err| {
        panic!(
            "gvproxy services socket {} was created but not reachable: {err}",
            control_sock.display()
        )
    });
}

fn wait_for_socket_file(control_sock: PathBuf) -> Result<(), String> {
    if control_sock.exists() {
        return Ok(());
    }

    let parent = control_sock
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", control_sock.display()))?
        .to_path_buf();
    let socket_name = control_sock
        .file_name()
        .ok_or_else(|| format!("{} has no file name", control_sock.display()))?
        .to_os_string();
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::RecommendedWatcher::new(
        move |event| {
            let _ = tx.send(event);
        },
        notify::Config::default(),
    )
    .map_err(|err| format!("watch {} failed: {err}", parent.display()))?;
    watcher
        .watch(&parent, notify::RecursiveMode::NonRecursive)
        .map_err(|err| format!("watch {} failed: {err}", parent.display()))?;

    let deadline = std::time::Instant::now() + SERVICES_SOCKET_READY_TIMEOUT;
    loop {
        if control_sock.exists() {
            return Ok(());
        }

        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| {
                format!(
                    "gvproxy services socket {} never became reachable",
                    control_sock.display()
                )
            })?;

        match rx.recv_timeout(remaining) {
            Ok(Ok(event)) => {
                let saw_socket = event.paths.iter().any(|path| {
                    path == &control_sock || path.file_name() == Some(socket_name.as_os_str())
                });
                if saw_socket && control_sock.exists() {
                    return Ok(());
                }
            }
            Ok(Err(err)) => {
                return Err(format!("watch {} failed: {err}", parent.display()));
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "gvproxy services socket {} never became reachable",
                    control_sock.display()
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(format!("watch {} stopped unexpectedly", parent.display()));
            }
        }
    }
}

#[tokio::test]
async fn live_gvproxy_backend_expose_list_unexpose_roundtrip() {
    let dir = tempfile::Builder::new()
        .prefix("bl-live-gvproxy-")
        .tempdir_in("/tmp")
        .unwrap();
    let (_instance, backend, endpoint, control_sock) = backend_for(&dir);
    wait_for_services(&backend, control_sock).await;

    match endpoint {
        boxlite::net::NetworkBackendEndpoint::UnixSocket { path, .. } => {
            assert_eq!(path, dir.path().join("net.sock"));
        }
    }

    let local_socket = dir.path().join("forward.sock");
    let local = local_socket.display().to_string();
    let has_local =
        |forwards: &[boxlite::net::Forward]| forwards.iter().any(|forward| forward.local == local);

    assert!(
        !has_local(&backend.list_forwards().await.unwrap()),
        "forward should be absent before expose"
    );

    backend
        .expose(&local, "tcp://192.168.127.2:80", TransportProtocol::Unix)
        .await
        .expect("expose forward");
    assert!(
        has_local(&backend.list_forwards().await.unwrap()),
        "forward should be present after expose"
    );

    backend
        .unexpose(&local, TransportProtocol::Unix)
        .await
        .expect("unexpose forward");
    assert!(
        !has_local(&backend.list_forwards().await.unwrap()),
        "forward should be absent after unexpose"
    );
}

#[tokio::test]
async fn live_gvproxy_backend_tunnel_handshake_returns_fd() {
    let dir = tempfile::Builder::new()
        .prefix("bl-live-gvproxy-tunnel-")
        .tempdir_in("/tmp")
        .unwrap();
    let (_instance, backend, _, control_sock) = backend_for(&dir);
    wait_for_services(&backend, control_sock).await;

    let target: SocketAddr = "192.168.127.2:8080".parse().unwrap();
    let tunnel = backend.tunnel(target).await.expect("tunnel handshake");

    assert_eq!(tunnel.peer_addr(), target);
    assert!(tunnel.into_fd().is_some());
}
