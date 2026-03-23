//! Go↔Rust proxy protocol — simple text-based destination passing.
//!
//! Go sends: "host:port\n"
//! Rust reads the line, parses host and port, then handles the connection.

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixStream;

/// Parsed destination from the Go proxy dialer.
pub struct Destination {
    pub host: String,
    pub port: u16,
    pub raw: String,
}

/// Read the destination address from the Go relay.
/// Protocol: Go sends "host:port\n" as the first line.
pub async fn read_destination(stream: &mut UnixStream) -> Result<Destination, String> {
    let mut reader = BufReader::new(&mut *stream);
    let mut line = String::new();

    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("failed to read destination: {e}"))?;

    let raw = line.trim().to_string();
    if raw.is_empty() {
        return Err("empty destination".into());
    }

    // Parse "host:port"
    let (host, port) = raw
        .rsplit_once(':')
        .ok_or_else(|| format!("invalid destination format: {raw}"))?;

    let port: u16 = port
        .parse()
        .map_err(|_| format!("invalid port in destination: {raw}"))?;

    Ok(Destination {
        host: host.to_string(),
        port,
        raw,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn parse_host_port() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let client = tokio::spawn({
            let path = sock_path.clone();
            async move {
                let mut conn = UnixStream::connect(path).await.unwrap();
                conn.write_all(b"api.openai.com:443\n").await.unwrap();
            }
        });

        let (mut server_conn, _) = listener.accept().await.unwrap();
        let dest = read_destination(&mut server_conn).await.unwrap();
        assert_eq!(dest.host, "api.openai.com");
        assert_eq!(dest.port, 443);

        client.await.unwrap();
    }

    #[tokio::test]
    async fn malformed_input_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let client = tokio::spawn({
            let path = sock_path.clone();
            async move {
                let mut conn = UnixStream::connect(path).await.unwrap();
                conn.write_all(b"no-port-here\n").await.unwrap();
            }
        });

        let (mut server_conn, _) = listener.accept().await.unwrap();
        let result = read_destination(&mut server_conn).await;
        assert!(result.is_err());

        client.await.unwrap();
    }
}
