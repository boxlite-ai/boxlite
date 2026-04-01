//! Connection management.
//!
//! Converts Transport to tonic Channel with lazy initialization.

use std::sync::Arc;
use std::time::Duration;

use boxlite_shared::{BoxliteError, BoxliteResult, Transport};
use hyper_util::rt::TokioIo;
use tokio::sync::OnceCell;
use tonic::transport::{Channel, Endpoint, Uri};
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
        Transport::Tcp { port } => {
            tracing::debug!("Connecting via TCP: 127.0.0.1:{}", port);
            connect_tcp(*port).await
        }
        Transport::Vsock { port } => Err(BoxliteError::Internal(format!(
            "Vsock client not yet implemented (port: {})",
            port
        ))),
    }
}

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

async fn connect_tcp(port: u16) -> BoxliteResult<Channel> {
    let addr = format!("http://127.0.0.1:{}", port);
    let channel = Endpoint::try_from(addr)?
        .connect_timeout(Duration::from_secs(30))
        .connect()
        .await?;

    tracing::debug!("Connected via TCP");
    Ok(channel)
}
