//! Integration tests for `BoxliteOptions::image_registry_proxy`.
//!
//! Every pull targets a registry under `.invalid`, which only a proxy can
//! reach, so a request that arrives at the fake proxy proves the pull used it.
//! None of these tests start a VM.

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use boxlite::runtime::options::BoxliteOptions;
use boxlite::{BoxliteError, BoxliteResult, BoxliteRuntime};
use common::home::PerTestBoxHome;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;

const REGISTRY: &str = "registry.example.invalid";
const CHILD_PROXY_ENV: &str = "BOXLITE_TEST_INTERCEPTED_PULL_PROXY";
const PROXY_ENV_VARS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

/// A runtime built from options given as JSON, the way `--config` supplies them.
fn runtime_from_json(home: &Path, options: Value) -> BoxliteResult<BoxliteRuntime> {
    let mut options: BoxliteOptions = serde_json::from_value(options).unwrap();
    options.home_dir = home.to_path_buf();
    common::non_vm_runtime(options)
}

/// Pull an image from `REGISTRY` through `proxy`; nothing serves it, so it fails.
async fn pull_through(proxy: Value) {
    let home = PerTestBoxHome::isolated_in("/tmp");
    let runtime = runtime_from_json(&home.path, json!({ "image_registry_proxy": proxy })).unwrap();
    let pulled = timeout(
        Duration::from_secs(10),
        runtime
            .images()
            .unwrap()
            .pull(&format!("{REGISTRY}/acme/app:v1")),
    )
    .await
    .expect("pull must finish");
    assert!(pulled.is_err(), "nothing serves the image");
}

async fn read_until(stream: &mut (impl AsyncRead + Unpin), end: &[u8]) -> Option<String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(end) && stream.read(&mut byte).await.ok()? == 1 {
        head.push(byte[0]);
    }
    Some(String::from_utf8_lossy(&head).trim_end().to_string())
}

/// An HTTP proxy recording each request's first line. Without `tls` it refuses
/// every tunnel; with it, it opens the tunnel and intercepts its TLS, recording
/// the first request line inside, which only a completed handshake can carry.
async fn fake_proxy(tls: Option<tokio_rustls::TlsAcceptor>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let Some(connect) = read_until(&mut tcp, b"\r\n\r\n").await else {
                continue;
            };
            log.lock()
                .unwrap()
                .push(connect.lines().next().unwrap_or_default().to_string());
            let Some(tls) = &tls else {
                let _ = tcp.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                continue;
            };
            let _ = tcp
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await;
            if let Ok(mut tunnel) = tls.accept(tcp).await
                && let Some(request) = read_until(&mut tunnel, b"\r\n").await
            {
                log.lock().unwrap().push(request);
                let _ = tunnel.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n").await;
            }
        }
    });
    (url, seen)
}

/// A CA's PEM, and an acceptor presenting a certificate it issued for `REGISTRY`.
fn intercepting_tls() -> (String, tokio_rustls::TlsAcceptor) {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};

    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let leaf_key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec![REGISTRY.to_string()])
        .unwrap()
        .signed_by(&leaf_key, &ca, &ca_key)
        .unwrap();
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(leaf_key.serialize_der());
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![leaf.der().clone()], key.into())
    .unwrap();
    (ca.pem(), tokio_rustls::TlsAcceptor::from(Arc::new(config)))
}

#[tokio::test]
async fn pull_tunnels_through_the_configured_proxy_unless_no_proxy_matches() {
    for (no_proxy, proxied) in [(None, true), (Some(REGISTRY), false)] {
        let (proxy, seen) = fake_proxy(None).await;
        pull_through(json!({ "https_proxy": proxy, "no_proxy": no_proxy })).await;

        let seen = seen.lock().unwrap().clone();
        let tunnel = format!("CONNECT {REGISTRY}:443 HTTP/1.1");
        assert_eq!(
            !seen.is_empty(),
            proxied,
            "no_proxy: {no_proxy:?}; seen: {seen:?}"
        );
        assert!(seen.iter().all(|line| *line == tunnel), "{seen:?}");
    }
}

#[tokio::test]
async fn pull_through_an_intercepting_proxy_trusts_its_ca_from_the_system_store() {
    if let Ok(proxy) = std::env::var(CHILD_PROXY_ENV) {
        pull_through(json!({ "https_proxy": proxy })).await;
        return;
    }

    let (proxy_ca, tls) = intercepting_tls();
    let ca_file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(ca_file.path(), proxy_ca).unwrap();
    let (proxy, seen) = fake_proxy(Some(tls)).await;

    // A child process owns the trust store, so no other test sees SSL_CERT_FILE.
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "pull_through_an_intercepting_proxy_trusts_its_ca_from_the_system_store",
            "--nocapture",
        ])
        .env(CHILD_PROXY_ENV, &proxy)
        .env("SSL_CERT_FILE", ca_file.path())
        .env_remove("SSL_CERT_DIR")
        .kill_on_drop(true);
    for name in PROXY_ENV_VARS {
        command.env_remove(name);
    }
    let output = timeout(Duration::from_secs(20), command.output())
        .await
        .expect("isolated pull test must finish")
        .unwrap();
    assert!(
        output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "isolated pull test failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    let seen = seen.lock().unwrap().clone();
    assert!(
        seen.iter().any(|line| line.starts_with("GET /v2/")),
        "the pull must reach the registry through the intercepting proxy: {seen:?}",
    );
}

#[test]
fn invalid_image_registry_proxy_fails_runtime_creation_before_home_exists() {
    for proxy in [
        json!({ "https_proxy": "htp://proxy.corp:3128" }),
        json!({ "https_proxy": "proxy.corp:3128" }),
        json!({ "http_proxy": "socks5://proxy.corp:1080" }),
        json!({ "https_proxy": "http://proxy.corp:99999" }),
        json!({ "no_proxy": "localhost" }),
    ] {
        let parent = tempfile::tempdir_in("/tmp").unwrap();
        let home = parent.path().join("home");
        let created = runtime_from_json(&home, json!({ "image_registry_proxy": proxy.clone() }));
        assert!(
            matches!(created, Err(BoxliteError::Config(_))),
            "{proxy} must fail as a config error, got {:?}",
            created.err()
        );
        assert!(!home.exists(), "{proxy} must fail before the home exists");
    }
}
