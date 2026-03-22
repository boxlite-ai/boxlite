//! BoxLite network proxy — filtering + MITM + secret substitution.
//!
//! Listens on a Unix socket for connections from gvproxy's DialFunc.
//! Each connection includes the destination address, which is checked
//! against the allowlist. For HTTPS connections to secret hosts,
//! the proxy performs TLS MITM to substitute secret placeholders.

pub mod cert;
pub mod filter;
pub mod mitm;
pub mod protocol;

use std::path::Path;
use std::sync::Arc;

use cert::BoxCA;
use filter::AllowNetMatcher;
use tokio::io;
use tokio::net::{TcpStream, UnixListener};

/// Secret configuration for MITM substitution.
#[derive(Clone, Debug)]
pub struct SecretConfig {
    pub name: String,
    pub hosts: Vec<String>,
    pub placeholder: String,
    pub value: String,
}

/// Proxy configuration.
#[derive(Clone)]
pub struct ProxyConfig {
    pub allow_net: Vec<String>,
    pub secrets: Vec<SecretConfig>,
}

/// Start the proxy on a Unix socket. Returns when the listener is closed.
pub async fn run_proxy(socket_path: &Path, config: ProxyConfig) -> Result<(), String> {
    // Remove stale socket
    let _ = std::fs::remove_file(socket_path);

    let listener = UnixListener::bind(socket_path)
        .map_err(|e| format!("failed to bind proxy socket {}: {e}", socket_path.display()))?;

    let matcher = Arc::new(AllowNetMatcher::new(&config.allow_net));
    let secrets = Arc::new(config.secrets);
    let has_filter = !config.allow_net.is_empty();

    // Generate per-box CA if secrets are configured (needed for MITM)
    let ca = if !secrets.is_empty() {
        Some(Arc::new(
            BoxCA::new().map_err(|e| format!("CA generation failed: {e}"))?,
        ))
    } else {
        None
    };

    tracing::info!(
        socket = %socket_path.display(),
        allow_net_rules = config.allow_net.len(),
        secrets_count = secrets.len(),
        "Proxy listening"
    );

    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("accept failed: {e}"))?;

        let matcher = Arc::clone(&matcher);
        let secrets = Arc::clone(&secrets);
        let ca = ca.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_connection(
                &mut stream,
                &matcher,
                &secrets,
                has_filter,
                ca.as_ref().map(|c| c.as_ref()),
            )
            .await
            {
                tracing::debug!(error = %e, "proxy connection error");
            }
        });
    }
}

async fn handle_connection(
    stream: &mut tokio::net::UnixStream,
    matcher: &AllowNetMatcher,
    secrets: &[SecretConfig],
    has_filter: bool,
    ca: Option<&BoxCA>,
) -> Result<(), String> {
    // Read destination from Go relay
    let dest = protocol::read_destination(stream).await?;

    // Check allowlist (if filtering enabled)
    if has_filter && !matcher.matches_host(&dest.host) {
        tracing::info!(
            host = %dest.host,
            port = dest.port,
            "proxy: BLOCKED by allowlist"
        );
        // Close connection — Go side gets an error, returns RST to guest
        return Ok(());
    }

    tracing::debug!(
        host = %dest.host,
        port = dest.port,
        "proxy: allowed"
    );

    // Connect to real destination
    let mut remote = TcpStream::connect(&dest.raw)
        .await
        .map_err(|e| format!("connect to {} failed: {e}", dest.raw))?;

    // Check if MITM is needed for secret substitution
    let needs_mitm = ca.is_some()
        && secrets.iter().any(|s| {
            s.hosts.iter().any(|h| {
                let h = h.to_lowercase();
                let hostname = dest.host.to_lowercase();
                h == hostname || (h.starts_with("*.") && hostname.ends_with(&h[1..]))
            })
        });

    if needs_mitm {
        // Close the pre-dialed connection — MITM dials its own TLS
        drop(remote);

        tracing::info!(host = %dest.host, "proxy: MITM active");
        return mitm::mitm_connection(stream, &dest.host, dest.port, ca.unwrap(), secrets).await;
    }

    // Non-MITM: bidirectional relay
    io::copy_bidirectional(stream, &mut remote)
        .await
        .map_err(|e| format!("relay error: {e}"))?;

    Ok(())
}
