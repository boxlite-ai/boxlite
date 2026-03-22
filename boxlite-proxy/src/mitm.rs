//! TLS MITM proxy for secret substitution.
//!
//! For HTTPS connections to secret hosts:
//! 1. TLS terminate with rustls (present cert signed by box CA)
//! 2. Read HTTP request, scan for placeholder strings
//! 3. Substitute placeholders with real secret values
//! 4. TLS connect to real server, forward modified request
//! 5. Relay response back unchanged

use std::sync::Arc;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio::io::{self, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use crate::SecretConfig;
use crate::cert::BoxCA;

/// Perform MITM on an HTTPS connection: terminate TLS from guest side,
/// substitute secret placeholders in HTTP headers/body, re-encrypt to real server.
pub async fn mitm_connection(
    guest_stream: &mut tokio::net::UnixStream,
    hostname: &str,
    port: u16,
    ca: &BoxCA,
    secrets: &[SecretConfig],
) -> Result<(), String> {
    // Generate per-host cert signed by box CA
    let (host_cert_der, host_key) = ca.generate_host_cert(hostname)?;

    let host_key_der = PrivateKeyDer::try_from(host_key.serialize_der())
        .map_err(|e| format!("key conversion failed: {e}"))?;

    // TLS config for guest-facing side (we are the server)
    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(host_cert_der)], host_key_der)
        .map_err(|e| format!("server TLS config failed: {e}"))?;

    let acceptor = TlsAcceptor::from(Arc::new(server_config));

    // TLS handshake with guest
    let mut guest_tls = acceptor
        .accept(guest_stream)
        .await
        .map_err(|e| format!("guest TLS handshake failed: {e}"))?;

    // Connect to real server
    let real_stream = TcpStream::connect(format!("{hostname}:{port}"))
        .await
        .map_err(|e| format!("connect to {hostname}:{port} failed: {e}"))?;

    // TLS config for server-facing side (we are the client)
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let client_config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    let connector = TlsConnector::from(Arc::new(client_config));
    let server_name = ServerName::try_from(hostname.to_string())
        .map_err(|e| format!("invalid server name: {e}"))?;

    let mut server_tls = connector
        .connect(server_name, real_stream)
        .await
        .map_err(|e| format!("server TLS handshake failed: {e}"))?;

    // Read HTTP request from guest, substitute secrets, forward to server
    let mut request_buf = Vec::with_capacity(8192);
    let mut reader = BufReader::new(&mut guest_tls);

    // Read request line + headers (until empty line)
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read request failed: {e}"))?;
        if n == 0 {
            return Ok(()); // connection closed
        }

        // Substitute secrets in header lines
        let mut modified_line = line.clone();
        for secret in secrets {
            if secret_applies_to_host(secret, hostname) {
                modified_line = modified_line.replace(&secret.placeholder, &secret.value);
            }
        }

        if modified_line != line {
            tracing::info!(
                host = %hostname,
                "mitm: secret substituted in request header"
            );
        }

        request_buf.extend_from_slice(modified_line.as_bytes());

        // Empty line = end of headers
        if line.trim().is_empty() {
            break;
        }
    }

    // Parse Content-Length to read body if present
    let content_length = extract_content_length(&request_buf);

    // Read body if Content-Length > 0
    if let Some(len) = content_length {
        let mut body = vec![0u8; len];
        reader
            .read_exact(&mut body)
            .await
            .map_err(|e| format!("read body failed: {e}"))?;

        // Substitute in body
        let mut body_str = String::from_utf8_lossy(&body).to_string();
        let mut body_modified = false;
        for secret in secrets {
            if secret_applies_to_host(secret, hostname) && body_str.contains(&secret.placeholder) {
                body_str = body_str.replace(&secret.placeholder, &secret.value);
                body_modified = true;
            }
        }

        if body_modified {
            // Rewrite Content-Length if body size changed
            let new_body = body_str.as_bytes();
            let headers_str = String::from_utf8_lossy(&request_buf);
            let updated_headers = update_content_length(&headers_str, new_body.len());
            request_buf = updated_headers.into_bytes();
            request_buf.extend_from_slice(new_body);
        } else {
            request_buf.extend_from_slice(&body);
        }
    }

    // Send modified request to real server
    server_tls
        .write_all(&request_buf)
        .await
        .map_err(|e| format!("write to server failed: {e}"))?;

    // Get inner stream back from BufReader
    let guest_tls_inner = reader.into_inner();

    // Relay response and any further data bidirectionally
    io::copy_bidirectional(guest_tls_inner, &mut server_tls)
        .await
        .map_err(|e| format!("relay failed: {e}"))?;

    Ok(())
}

fn secret_applies_to_host(secret: &SecretConfig, hostname: &str) -> bool {
    let hostname = hostname.to_lowercase();
    secret.hosts.iter().any(|h| {
        let h = h.to_lowercase();
        h == hostname || (h.starts_with("*.") && hostname.ends_with(&h[1..]))
    })
}

fn extract_content_length(headers: &[u8]) -> Option<usize> {
    let headers_str = String::from_utf8_lossy(headers).to_lowercase();
    for line in headers_str.lines() {
        if let Some(val) = line.strip_prefix("content-length:") {
            return val.trim().parse().ok();
        }
    }
    None
}

fn update_content_length(headers: &str, new_length: usize) -> String {
    let mut result = String::new();
    for line in headers.lines() {
        if line.to_lowercase().starts_with("content-length:") {
            result.push_str(&format!("Content-Length: {new_length}"));
        } else {
            result.push_str(line);
        }
        result.push_str("\r\n");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitution_in_header_value() {
        let header = "Authorization: Bearer <BOXLITE_SECRET:API_KEY>\r\n";
        let secret = SecretConfig {
            name: "API_KEY".into(),
            hosts: vec!["api.openai.com".into()],
            placeholder: "<BOXLITE_SECRET:API_KEY>".into(),
            value: "sk-real-key".into(),
        };

        let result = header.replace(&secret.placeholder, &secret.value);
        assert_eq!(result, "Authorization: Bearer sk-real-key\r\n");
    }

    #[test]
    fn substitution_in_body() {
        let body = r#"{"api_key": "<BOXLITE_SECRET:KEY>"}"#;
        let secret = SecretConfig {
            name: "KEY".into(),
            hosts: vec!["api.example.com".into()],
            placeholder: "<BOXLITE_SECRET:KEY>".into(),
            value: "real-value".into(),
        };

        let result = body.replace(&secret.placeholder, &secret.value);
        assert_eq!(result, r#"{"api_key": "real-value"}"#);
    }

    #[test]
    fn no_substitution_for_wrong_host() {
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
    fn content_length_parsing() {
        let headers = b"GET / HTTP/1.1\r\nContent-Length: 42\r\nHost: example.com\r\n\r\n";
        assert_eq!(extract_content_length(headers), Some(42));

        let no_cl = b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
        assert_eq!(extract_content_length(no_cl), None);
    }
}
