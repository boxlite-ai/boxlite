//! Proxy settings for registry clients.
//!
//! [`validate`] checks an [`ImageRegistryProxy`] once, at runtime creation:
//! reqwest drops a proxy URL with an unknown scheme without an error, and the
//! pull then goes direct.

use boxlite_shared::errors::with_causes;
use boxlite_shared::{BoxliteError, BoxliteResult};
use oci_client::client::ClientConfig;

use crate::runtime::options::ImageRegistryProxy;

/// Reject settings that reqwest would ignore or misread.
pub(super) fn validate(proxy: &ImageRegistryProxy) -> BoxliteResult<()> {
    validate_proxy_url("http_proxy", proxy.http_proxy.as_deref())?;
    validate_proxy_url("https_proxy", proxy.https_proxy.as_deref())?;
    if proxy.no_proxy.is_some() && proxy.http_proxy.is_none() && proxy.https_proxy.is_none() {
        return Err(invalid("no_proxy requires http_proxy or https_proxy"));
    }

    // reqwest parses the URLs only when a client is built.
    let mut config = ClientConfig::default();
    apply(Some(proxy), &mut config);
    oci_client::Client::try_from(config).map_err(|e| invalid(&with_causes(&e)))?;
    Ok(())
}

/// Copy the proxy settings into one registry client's configuration. `None`
/// leaves proxying to the environment variables.
pub(super) fn apply(proxy: Option<&ImageRegistryProxy>, config: &mut ClientConfig) {
    if let Some(proxy) = proxy {
        config.http_proxy = proxy.http_proxy.clone();
        config.https_proxy = proxy.https_proxy.clone();
        config.no_proxy = proxy.no_proxy.clone();
    }
}

fn validate_proxy_url(field: &str, url: Option<&str>) -> BoxliteResult<()> {
    let scheme = url.map(|url| url.split_once("://").map_or("", |(scheme, _)| scheme));
    match scheme.map(str::to_ascii_lowercase).as_deref() {
        None | Some("http" | "https") => Ok(()),
        Some(_) => Err(invalid(&format!(
            "{field} must be an http:// or https:// URL"
        ))),
    }
}

fn invalid(reason: &str) -> BoxliteError {
    BoxliteError::Config(format!("invalid image_registry_proxy: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BoxliteRuntime;
    use crate::runtime::options::BoxliteOptions;
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
    use serde_json::{Value, json};
    use std::ffi::{OsStr, OsString};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;

    /// A registry name that nothing resolves, so only a proxy can reach it.
    const REGISTRY: &str = "registry.example.invalid";

    /// Pull an image through a runtime built with proxy `settings`; nothing
    /// serves it, so the pull fails.
    async fn pull_through(settings: Value) {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = BoxliteRuntime::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            image_registry_proxy: Some(serde_json::from_value(settings).unwrap()),
            ..Default::default()
        })
        .unwrap();
        let images = runtime.images().unwrap();
        let pulled = images.pull(&format!("{REGISTRY}/team/app:1")).await;
        assert!(pulled.is_err());
    }

    /// An HTTP proxy recording each request's first line. Without `tls` it
    /// refuses every CONNECT; with it, it intercepts the tunnel's TLS.
    async fn fake_proxy(tls: Option<TlsAcceptor>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                let connect = request_line(&mut tcp).await;
                log.lock().unwrap().push(connect);
                let Some(tls) = &tls else {
                    let _ = tcp.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                    continue;
                };
                let _ = tcp.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await;
                if let Ok(mut tunnel) = tls.accept(tcp).await {
                    let request = request_line(&mut tunnel).await;
                    log.lock().unwrap().push(request);
                    let _ = tunnel.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n").await;
                }
            }
        });
        (url, seen)
    }

    async fn request_line(stream: &mut (impl AsyncRead + Unpin)) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && matches!(stream.read(&mut byte).await, Ok(1)) {
            head.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&head);
        head.lines().next().unwrap_or_default().to_string()
    }

    /// A CA's PEM, and an acceptor presenting a certificate it issued for the registry.
    fn intercepting_tls() -> (String, TlsAcceptor) {
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
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![leaf.der().clone()], key.into())
            .unwrap();
        (ca.pem(), TlsAcceptor::from(Arc::new(config)))
    }

    /// Sets an environment variable until dropped.
    struct EnvVar(&'static str, Option<OsString>);

    impl EnvVar {
        fn set(name: &'static str, value: impl AsRef<OsStr>) -> Self {
            let previous = std::env::var_os(name);
            // SAFETY: `make test:unit:rust` runs each test in its own process
            // (nextest) or one at a time, so no other test reads the variable.
            unsafe { std::env::set_var(name, value) };
            Self(name, previous)
        }
    }

    impl Drop for EnvVar {
        fn drop(&mut self) {
            // SAFETY: as in `set`.
            unsafe {
                match self.1.take() {
                    Some(previous) => std::env::set_var(self.0, previous),
                    None => std::env::remove_var(self.0),
                }
            }
        }
    }

    #[tokio::test]
    async fn pull_tunnels_through_https_proxy_unless_no_proxy_matches() {
        for (no_proxy, proxied) in [(None, true), (Some("example.invalid"), false)] {
            let (url, seen) = fake_proxy(None).await;
            pull_through(json!({ "https_proxy": url, "no_proxy": no_proxy })).await;

            let seen = seen.lock().unwrap().clone();
            let expected = format!("CONNECT {REGISTRY}:443 HTTP/1.1");
            assert_eq!(!seen.is_empty(), proxied, "{seen:?}");
            assert!(seen.iter().all(|line| *line == expected), "{seen:?}");
        }
    }

    #[tokio::test]
    async fn pull_trusts_intercepting_proxy_once_its_ca_is_in_the_system_store() {
        let (ca_pem, tls) = intercepting_tls();
        let ca_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(ca_file.path(), ca_pem).unwrap();

        for in_system_store in [false, true] {
            // The system store is read from SSL_CERT_FILE when it is set.
            let _store = in_system_store.then(|| EnvVar::set("SSL_CERT_FILE", ca_file.path()));
            let (url, seen) = fake_proxy(Some(tls.clone())).await;
            pull_through(json!({ "https_proxy": url })).await;

            // A request line arrives only once the TLS handshake succeeded.
            let seen = seen.lock().unwrap().clone();
            let reached_registry = seen.iter().any(|line| line.starts_with("GET /v2/"));
            assert_eq!(reached_registry, in_system_store, "{seen:?}");
        }
    }

    /// Validating `settings` must fail with an error containing `expected`.
    fn assert_rejected(settings: Value, expected: &str) {
        let settings = serde_json::from_value(settings).unwrap();
        let Err(err) = validate(&settings) else {
            panic!("accepted settings that should fail with {expected:?}");
        };
        assert!(err.to_string().contains(expected), "{err}");
    }

    #[test]
    fn validate_rejects_settings_reqwest_would_ignore_or_misread() {
        assert_rejected(json!({ "https_proxy": "htp://p:3128" }), "https_proxy must");
        assert_rejected(json!({ "http_proxy": "p.corp:3128" }), "http_proxy must");
        assert_rejected(json!({ "https_proxy": "http://p:99999" }), "invalid port");
        assert_rejected(json!({ "no_proxy": "localhost" }), "no_proxy requires");
    }

    #[test]
    fn invalid_proxy_fails_runtime_creation_as_config_error_without_touching_home() {
        let parent = tempfile::tempdir_in("/tmp").unwrap();
        let home = parent.path().join("boxlite-home");
        let proxy = serde_json::from_value(json!({ "https_proxy": "socks5://p:1080" }));
        let options = BoxliteOptions {
            home_dir: home.clone(),
            image_registry_proxy: Some(proxy.unwrap()),
            ..Default::default()
        };
        match BoxliteRuntime::new_for_test(options) {
            Err(BoxliteError::Config(_)) => {}
            Err(other) => panic!("invalid proxy reported as {other}"),
            Ok(_) => panic!("invalid proxy accepted"),
        }
        assert!(
            !home.exists(),
            "invalid options must fail before the home directory is created"
        );
    }
}
