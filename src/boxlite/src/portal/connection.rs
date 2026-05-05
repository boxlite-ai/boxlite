//! Connection management.
//!
//! Converts Transport to tonic Channel with lazy initialization.
//! Uses AF_UNIX sockets on all platforms (including Windows via uds_windows).

use std::sync::Arc;
use std::time::Duration;

use boxlite_shared::{BoxliteError, BoxliteResult, Transport};
use hyper_util::rt::TokioIo;
use tokio::sync::OnceCell;
use tonic::transport::Uri;
use tonic::transport::{Channel, Endpoint};
use tower::service_fn;

/// Lazy connection to guest.
///
/// Connects on first use to ensure connection happens in the correct async runtime.
#[derive(Clone)]
pub struct Connection {
    transport: Transport,
    channel: Arc<OnceCell<Channel>>,
}

impl Connection {
    /// Create a lazy connection (does not connect immediately).
    pub fn new(transport: Transport) -> Self {
        Self {
            transport,
            channel: Arc::new(OnceCell::new()),
        }
    }

    /// Get or establish the channel.
    pub async fn channel(&self) -> BoxliteResult<Channel> {
        let channel = self
            .channel
            .get_or_try_init(|| async { connect_transport(&self.transport).await })
            .await?;

        Ok(channel.clone())
    }
}

/// Connect to a transport.
async fn connect_transport(transport: &Transport) -> BoxliteResult<Channel> {
    match transport {
        Transport::Unix { socket_path } => {
            tracing::debug!("Connecting via Unix: {}", socket_path.display());
            connect_unix(socket_path).await
        }
        Transport::Vsock { port } => Err(BoxliteError::Internal(format!(
            "Vsock client not yet implemented (port: {})",
            port
        ))),
        _ => Err(BoxliteError::Internal(
            "Unsupported transport type".to_string(),
        )),
    }
}

#[cfg(unix)]
async fn connect_unix(socket_path: &std::path::Path) -> BoxliteResult<Channel> {
    let socket_path = socket_path.to_path_buf();

    let channel = Endpoint::try_from("http://[::]:50051")?
        .connect_timeout(Duration::from_secs(30))
        .connect_with_connector(service_fn(move |_: Uri| {
            let socket_path = socket_path.clone();
            async move {
                let stream = tokio::net::UnixStream::connect(socket_path).await?;
                Ok::<_, std::io::Error>(TokioIo::new(stream))
            }
        }))
        .await?;

    tracing::debug!("Connected via Unix socket");
    Ok(channel)
}

#[cfg(windows)]
async fn connect_unix(socket_path: &std::path::Path) -> BoxliteResult<Channel> {
    use std::os::windows::io::{FromRawSocket, IntoRawSocket};

    let socket_path = socket_path.to_path_buf();

    let channel = Endpoint::try_from("http://[::]:50051")?
        .connect_timeout(Duration::from_secs(30))
        .connect_with_connector(service_fn(move |_: Uri| {
            let socket_path = socket_path.clone();
            async move {
                // Connect via uds_windows in a blocking task
                let path = socket_path.clone();
                let std_stream =
                    tokio::task::spawn_blocking(move || uds_windows::UnixStream::connect(&path))
                        .await
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))??;

                // Convert AF_UNIX SOCKET handle to tokio-compatible async stream.
                // Windows IOCP doesn't distinguish AF_UNIX from AF_INET at the handle level,
                // so we can safely wrap it as a TcpStream for async I/O.
                // This is the same technique used by VS Code Remote and Docker Desktop.
                let raw = std_stream.into_raw_socket();
                let tcp_stream = unsafe { std::net::TcpStream::from_raw_socket(raw) };
                tcp_stream.set_nonblocking(true)?;
                let tokio_stream = tokio::net::TcpStream::from_std(tcp_stream)?;
                Ok::<_, std::io::Error>(TokioIo::new(tokio_stream))
            }
        }))
        .await?;

    tracing::debug!("Connected via Unix socket (Windows AF_UNIX)");
    Ok(channel)
}
