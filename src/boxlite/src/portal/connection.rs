//! Connection management.
//!
//! Converts BoxTransport to tonic Channel with lazy initialization.

use std::sync::Arc;
use std::time::Duration;

use boxlite_shared::{BoxTransport, BoxliteError, BoxliteResult};
use hyper_util::rt::TokioIo;
use tokio::sync::Mutex;
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;

/// Lazy connection to guest.
///
/// Connects on first use to ensure connection happens in the correct async runtime.
#[derive(Clone)]
pub struct Connection {
    transport: BoxTransport,
    channel: Arc<Mutex<Option<Channel>>>,
}

impl Connection {
    /// Create a lazy connection (does not connect immediately).
    pub fn new(transport: BoxTransport) -> Self {
        Self {
            transport,
            channel: Arc::new(Mutex::new(None)),
        }
    }

    /// Get or establish the channel.
    pub async fn channel(&self) -> BoxliteResult<Channel> {
        let mut guard = self.channel.lock().await;
        if let Some(ref channel) = *guard {
            return Ok(channel.clone());
        }
        let channel = connect_transport(&self.transport).await?;
        *guard = Some(channel.clone());
        Ok(channel)
    }

    /// Drop any cached channel so the next request establishes a fresh connection.
    pub async fn reset(&self) {
        let mut guard = self.channel.lock().await;
        *guard = None;
    }
}

/// Connect to a transport.
async fn connect_transport(transport: &BoxTransport) -> BoxliteResult<Channel> {
    match transport {
        BoxTransport::Unix { socket_path } => {
            tracing::debug!("Connecting via Unix: {}", socket_path.display());
            connect_unix(socket_path).await
        }
        BoxTransport::Tcp { port } => {
            tracing::debug!("Connecting via TCP: 127.0.0.1:{}", port);
            connect_tcp(*port).await
        }
        BoxTransport::Vsock { port } => Err(BoxliteError::Internal(format!(
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
                // Guest-ready can precede libkrun's host listener. Retry only
                // connection establishment; tonic's connect_timeout bounds
                // this entire future, including every asynchronous backoff.
                let mut retry_delay = Duration::from_millis(10);
                loop {
                    match tokio::net::UnixStream::connect(&socket_path).await {
                        Ok(stream) => return Ok::<_, std::io::Error>(TokioIo::new(stream)),
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::NotFound
                                    | std::io::ErrorKind::ConnectionRefused
                            ) =>
                        {
                            tokio::time::sleep(retry_delay).await;
                            retry_delay = (retry_delay * 2).min(Duration::from_millis(100));
                        }
                        Err(error) => return Err(error),
                    }
                }
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

#[cfg(test)]
mod tests;

#[cfg(test)]
mod reset_tests {
    use super::*;
    use boxlite_shared::{Ssh, SshClient, SshControlRequest, SshControlResponse, SshServer};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::UnixListener;
    use tonic::{Request, Response, Status};

    struct Control;

    #[tonic::async_trait]
    impl Ssh for Control {
        async fn control(
            &self,
            _: Request<SshControlRequest>,
        ) -> Result<Response<SshControlResponse>, Status> {
            Ok(Response::new(SshControlResponse::default()))
        }
    }

    #[tokio::test]
    async fn reset_clears_cached_channel_and_reconnects() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("box.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let accepts = Arc::new(AtomicUsize::new(0));
        let accepts_server = Arc::clone(&accepts);
        let (stop, stopped) = tokio::sync::oneshot::channel();

        let incoming = futures::stream::unfold(listener, move |listener| {
            let accepts_server = Arc::clone(&accepts_server);
            async move {
                let res = listener.accept().await.map(|(stream, _)| {
                    accepts_server.fetch_add(1, Ordering::SeqCst);
                    stream
                });
                Some((res, listener))
            }
        });

        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(SshServer::new(Control))
                .serve_with_incoming_shutdown(incoming, async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });

        let conn = Connection::new(BoxTransport::unix(sock));
        let ch1 = conn.channel().await.unwrap();
        SshClient::new(ch1)
            .control(SshControlRequest::default())
            .await
            .unwrap();
        // Calling channel() again reuses the cached connection without a second accept.
        let ch1_cached = conn.channel().await.unwrap();
        SshClient::new(ch1_cached)
            .control(SshControlRequest::default())
            .await
            .unwrap();
        assert_eq!(accepts.load(Ordering::SeqCst), 1);

        conn.reset().await;
        let ch2 = conn.channel().await.unwrap();
        SshClient::new(ch2)
            .control(SshControlRequest::default())
            .await
            .unwrap();
        assert_eq!(accepts.load(Ordering::SeqCst), 2);

        let _ = stop.send(());
        server.await.unwrap();
    }
}
