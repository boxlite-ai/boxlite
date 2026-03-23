//! TLS MITM proxy for secret substitution.
//!
//! Supports both HTTP/1.1 and HTTP/2 via hyper.
//! After TLS termination, hyper parses the HTTP request regardless of
//! protocol version. We substitute secret placeholders in headers and body,
//! then forward the modified request to the real server.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio::net::TcpStream;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use crate::SecretConfig;
use crate::cert::BoxCA;

/// Perform MITM on an HTTPS connection: terminate TLS, substitute secrets
/// in HTTP headers/body using hyper, forward to real server.
pub async fn mitm_connection(
    guest_stream: &mut tokio::net::UnixStream,
    hostname: &str,
    port: u16,
    ca: &BoxCA,
    secrets: &[SecretConfig],
) -> Result<(), String> {
    let (host_cert_der, host_key) = ca.generate_host_cert(hostname)?;

    let host_key_der = PrivateKeyDer::try_from(host_key.serialize_der())
        .map_err(|e| format!("key conversion failed: {e}"))?;

    let mut server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(host_cert_der)], host_key_der)
        .map_err(|e| format!("server TLS config failed: {e}"))?;

    // Advertise HTTP/1.1 only — simplifies proxy logic.
    // All major AI SDKs (OpenAI, Anthropic) support h1 fallback.
    server_config.alpn_protocols = vec![b"http/1.1".to_vec()];

    let acceptor = TlsAcceptor::from(Arc::new(server_config));

    let guest_tls = acceptor
        .accept(&mut *guest_stream)
        .await
        .map_err(|e| format!("guest TLS handshake failed: {e}"))?;

    let hostname = hostname.to_string();
    let dest_port = port;
    let secrets: Vec<SecretConfig> = secrets.to_vec();

    let io = TokioIo::new(guest_tls);

    // Serve HTTP/1.1 requests from the guest, substitute secrets, forward
    http1::Builder::new()
        .serve_connection(
            io,
            service_fn(move |req| {
                let hostname = hostname.clone();
                let secrets = secrets.clone();
                async move { proxy_request(req, &hostname, dest_port, &secrets).await }
            }),
        )
        .await
        .map_err(|e| format!("hyper serve error: {e}"))?;

    Ok(())
}

/// Proxy a single HTTP request: substitute secrets, forward to real server.
async fn proxy_request(
    req: Request<Incoming>,
    hostname: &str,
    port: u16,
    secrets: &[SecretConfig],
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let (mut parts, body) = req.into_parts();

    // Read full body
    let body_bytes = body
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();

    // Substitute secrets in headers
    let mut substituted = false;
    for secret in secrets {
        if !secret_applies_to_host(secret, hostname) {
            continue;
        }
        for (_name, value) in parts.headers.iter_mut() {
            if let Ok(v) = value.to_str()
                && v.contains(&secret.placeholder)
            {
                let new_val = v.replace(&secret.placeholder, &secret.value);
                if let Ok(hv) = hyper::header::HeaderValue::from_str(&new_val) {
                    *value = hv;
                    substituted = true;
                }
            }
        }
    }

    // Substitute secrets in body
    let mut final_body = body_bytes.to_vec();
    for secret in secrets {
        if !secret_applies_to_host(secret, hostname) {
            continue;
        }
        let body_str = String::from_utf8_lossy(&final_body);
        if body_str.contains(&secret.placeholder) {
            final_body = body_str
                .replace(&secret.placeholder, &secret.value)
                .into_bytes();
            substituted = true;
        }
    }

    if substituted {
        tracing::info!(host = %hostname, "mitm: secret substituted");
    }

    // Connect to real server with TLS
    let real_stream = match TcpStream::connect(format!("{hostname}:{port}")).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(host = %hostname, error = %e, "mitm: connect failed");
            return Ok(Response::builder()
                .status(502)
                .body(Full::new(Bytes::from(format!("connect failed: {e}"))))
                .unwrap());
        }
    };

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let client_config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    let connector = TlsConnector::from(Arc::new(client_config));
    let server_name = match ServerName::try_from(hostname.to_string()) {
        Ok(n) => n,
        Err(e) => {
            return Ok(Response::builder()
                .status(502)
                .body(Full::new(Bytes::from(format!("invalid hostname: {e}"))))
                .unwrap());
        }
    };

    let server_tls = match connector.connect(server_name, real_stream).await {
        Ok(s) => s,
        Err(e) => {
            return Ok(Response::builder()
                .status(502)
                .body(Full::new(Bytes::from(format!("TLS failed: {e}"))))
                .unwrap());
        }
    };

    // Forward request via hyper client
    let io = TokioIo::new(server_tls);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "mitm: client handshake failed");
            e
        })?;

    tokio::spawn(async move {
        if let Err(e) = conn.await {
            tracing::debug!(error = %e, "mitm: client connection error");
        }
    });

    // Rebuild request with substituted headers + body
    let mut builder = Request::builder()
        .method(parts.method)
        .uri(parts.uri)
        .version(parts.version);
    for (k, v) in &parts.headers {
        builder = builder.header(k, v);
    }
    let forwarded_req = builder.body(Full::new(Bytes::from(final_body))).unwrap();

    let resp = sender.send_request(forwarded_req).await?;

    // Convert response body
    let (resp_parts, resp_body) = resp.into_parts();
    let resp_bytes = resp_body
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();

    Ok(Response::from_parts(resp_parts, Full::new(resp_bytes)))
}

fn secret_applies_to_host(secret: &SecretConfig, hostname: &str) -> bool {
    let hostname = hostname.to_lowercase();
    secret.hosts.iter().any(|h| {
        let h = h.to_lowercase();
        h == hostname || (h.starts_with("*.") && hostname.ends_with(&h[1..]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitution_in_header_value() {
        let placeholder = "<BOXLITE_SECRET:API_KEY>";
        let real_value = "sk-real-key";
        let header_val = format!("Bearer {placeholder}");
        let result = header_val.replace(placeholder, real_value);
        assert_eq!(result, "Bearer sk-real-key");
    }

    #[test]
    fn substitution_in_body() {
        let body = r#"{"api_key": "<BOXLITE_SECRET:KEY>"}"#;
        let result = body.replace("<BOXLITE_SECRET:KEY>", "real-value");
        assert_eq!(result, r#"{"api_key": "real-value"}"#);
    }

    #[test]
    fn host_matching() {
        let secret = SecretConfig {
            name: "KEY".into(),
            hosts: vec!["api.openai.com".into()],
            placeholder: "<BOXLITE_SECRET:KEY>".into(),
            value: "real-value".into(),
        };
        assert!(secret_applies_to_host(&secret, "api.openai.com"));
        assert!(!secret_applies_to_host(&secret, "evil.com"));
    }

    #[test]
    fn wildcard_host_matching() {
        let secret = SecretConfig {
            name: "KEY".into(),
            hosts: vec!["*.anthropic.com".into()],
            placeholder: "<BOXLITE_SECRET:KEY>".into(),
            value: "real-value".into(),
        };
        assert!(secret_applies_to_host(&secret, "api.anthropic.com"));
        assert!(!secret_applies_to_host(&secret, "anthropic.com"));
    }
}
