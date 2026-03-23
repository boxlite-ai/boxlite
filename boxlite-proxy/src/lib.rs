//! BoxLite network proxy — outbound filtering for sandbox isolation.
//!
//! Listens on a Unix socket for connections from gvproxy's DialFunc.
//! Each connection includes the destination address, which is checked
//! against the allowlist before forwarding.

pub mod filter;
pub mod protocol;

use std::path::Path;
use std::sync::Arc;

use filter::AllowNetMatcher;
use tokio::io;
use tokio::net::{TcpStream, UnixListener};

/// Proxy configuration.
#[derive(Clone)]
pub struct ProxyConfig {
    pub allow_net: Vec<String>,
}

/// Start the proxy on a Unix socket. Returns when the listener is closed.
pub async fn run_proxy(socket_path: &Path, config: ProxyConfig) -> Result<(), String> {
    let _ = std::fs::remove_file(socket_path);

    let listener = UnixListener::bind(socket_path)
        .map_err(|e| format!("failed to bind proxy socket {}: {e}", socket_path.display()))?;

    let matcher = Arc::new(AllowNetMatcher::new(&config.allow_net));
    let has_filter = !config.allow_net.is_empty();

    tracing::info!(
        socket = %socket_path.display(),
        allow_net_rules = config.allow_net.len(),
        "Proxy listening"
    );

    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("accept failed: {e}"))?;

        let matcher = Arc::clone(&matcher);

        tokio::spawn(async move {
            if let Err(e) = handle_connection(&mut stream, &matcher, has_filter).await {
                tracing::debug!(error = %e, "proxy connection error");
            }
        });
    }
}

async fn handle_connection(
    stream: &mut tokio::net::UnixStream,
    matcher: &AllowNetMatcher,
    has_filter: bool,
) -> Result<(), String> {
    let dest = protocol::read_destination(stream).await?;

    if has_filter && !matcher.matches_host(&dest.host) {
        tracing::info!(host = %dest.host, port = dest.port, "proxy: BLOCKED");
        return Ok(());
    }

    tracing::debug!(host = %dest.host, port = dest.port, "proxy: allowed");

    let mut remote = TcpStream::connect(&dest.raw)
        .await
        .map_err(|e| format!("connect to {} failed: {e}", dest.raw))?;

    io::copy_bidirectional(stream, &mut remote)
        .await
        .map_err(|e| format!("relay error: {e}"))?;

    Ok(())
}
