//! Network sub-resource on LiteBox.

use std::future::Future;
use std::net::SocketAddr;
use std::os::fd::{AsRawFd, OwnedFd};
use std::pin::Pin;
use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::runtime::backend::BoxNetworkBackend;

/// A descriptor for a box service tunnel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoxEndpoint {
    /// A URI clients can use to reach a remote box service.
    Uri(String),
    /// A borrowed descriptor for the prepared local connection.
    FileDescriptor(i32),
}

/// Public byte-stream capability for a box service connection.
pub trait BoxConnection: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}

impl<T> BoxConnection for T where T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}

type ConnectFuture = Pin<Box<dyn Future<Output = BoxliteResult<Box<dyn BoxConnection>>> + Send>>;
type Connector = Arc<dyn Fn() -> ConnectFuture + Send + Sync>;

enum TunnelState {
    Pending,
    LocalReady(OwnedFd),
    Connected,
}

/// A one-shot box service tunnel target.
pub struct BoxTunnel {
    uri: Option<String>,
    connector: Connector,
    state: tokio::sync::Mutex<TunnelState>,
}

impl BoxTunnel {
    pub(crate) fn new<F, Fut, C>(uri: Option<String>, connect: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = BoxliteResult<C>> + Send + 'static,
        C: BoxConnection + 'static,
    {
        let connector = Arc::new(move || {
            let future = connect();
            Box::pin(async move {
                future
                    .await
                    .map(|stream| Box::new(stream) as Box<dyn BoxConnection>)
            }) as ConnectFuture
        });
        Self {
            uri,
            connector,
            state: tokio::sync::Mutex::new(TunnelState::Pending),
        }
    }

    /// Return the remote URI or prepare and borrow the local connection descriptor.
    pub async fn endpoint(&self) -> BoxliteResult<BoxEndpoint> {
        if let Some(uri) = &self.uri {
            return Ok(BoxEndpoint::Uri(uri.clone()));
        }

        let mut state = self.state.lock().await;
        match &*state {
            TunnelState::LocalReady(fd) => {
                return Ok(BoxEndpoint::FileDescriptor(fd.as_raw_fd()));
            }
            TunnelState::Connected => {
                return Err(BoxliteError::InvalidState(
                    "tunnel connection has already been consumed".into(),
                ));
            }
            TunnelState::Pending => {}
        }

        let connection = (self.connector)().await?;
        let fd = connection_fd(connection).await?;
        let raw_fd = fd.as_raw_fd();
        *state = TunnelState::LocalReady(fd);
        Ok(BoxEndpoint::FileDescriptor(raw_fd))
    }

    /// Consume this tunnel's single connection.
    pub async fn connect(&self) -> BoxliteResult<Box<dyn BoxConnection>> {
        let mut state = self.state.lock().await;
        match std::mem::replace(&mut *state, TunnelState::Connected) {
            TunnelState::Pending => match (self.connector)().await {
                Ok(connection) => Ok(connection),
                Err(error) => {
                    *state = TunnelState::Pending;
                    Err(error)
                }
            },
            TunnelState::LocalReady(fd) => {
                let stream = std::os::unix::net::UnixStream::from(fd);
                stream.set_nonblocking(true).map_err(|error| {
                    BoxliteError::Network(format!("configure tunnel descriptor: {error}"))
                })?;
                tokio::net::UnixStream::from_std(stream)
                    .map(|stream| Box::new(stream) as Box<dyn BoxConnection>)
                    .map_err(|error| {
                        BoxliteError::Network(format!("open tunnel descriptor: {error}"))
                    })
            }
            TunnelState::Connected => Err(BoxliteError::InvalidState(
                "tunnel connection has already been consumed".into(),
            )),
        }
    }
}

async fn connection_fd(mut connection: Box<dyn BoxConnection>) -> BoxliteResult<OwnedFd> {
    let (sdk, mut bridge) = tokio::net::UnixStream::pair().map_err(|error| {
        BoxliteError::Network(format!("create tunnel descriptor bridge: {error}"))
    })?;
    tokio::spawn(async move {
        let _ = tokio::io::copy_bidirectional(&mut connection, &mut bridge).await;
    });
    sdk.into_std()
        .map(OwnedFd::from)
        .map_err(|error| BoxliteError::Network(format!("export tunnel descriptor: {error}")))
}

/// Handle for network operations on a LiteBox.
///
/// Obtained via `litebox.network()`. Owns backend handles and can be used
/// independently from the originating `LiteBox` borrow.
pub struct NetworkHandle {
    network_backend: Arc<dyn BoxNetworkBackend>,
}

impl NetworkHandle {
    pub(crate) fn new(network_backend: Arc<dyn BoxNetworkBackend>) -> Self {
        Self { network_backend }
    }

    /// Prepare a one-shot tunnel endpoint without opening a data connection.
    pub async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        self.network_backend.tunnel(target).await
    }
}

#[cfg(test)]
mod tests {
    use boxlite_shared::errors::BoxliteError;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    use super::*;

    #[tokio::test]
    async fn remote_tunnel_connects_once_lazily() {
        let (peer_tx, mut peer_rx) = tokio::sync::mpsc::unbounded_channel();
        let tunnel = BoxTunnel::new(
            Some("https://3000-box.proxy.example.test".to_string()),
            move || {
                let peer_tx = peer_tx.clone();
                async move {
                    let (stream, peer) = UnixStream::pair().map_err(|error| {
                        BoxliteError::Network(format!("test socket pair failed: {error}"))
                    })?;
                    peer_tx.send(peer).unwrap();
                    Ok(stream)
                }
            },
        );

        assert_eq!(
            tunnel.endpoint().await.unwrap(),
            BoxEndpoint::Uri("https://3000-box.proxy.example.test".to_string())
        );
        assert!(peer_rx.try_recv().is_err(), "tunnel() must not connect");

        let mut first = tunnel.connect().await.unwrap();
        let mut first_peer = peer_rx.recv().await.unwrap();
        first_peer.write_all(b"one").await.unwrap();
        let mut first_response = [0; 3];
        first.read_exact(&mut first_response).await.unwrap();
        assert_eq!(&first_response, b"one");
        assert!(matches!(
            tunnel.connect().await,
            Err(BoxliteError::InvalidState(_))
        ));
    }

    #[tokio::test]
    async fn local_endpoint_prepares_fd_consumed_by_connect() {
        let (peer_tx, mut peer_rx) = tokio::sync::mpsc::unbounded_channel();
        let tunnel = BoxTunnel::new(None, move || {
            let peer_tx = peer_tx.clone();
            async move {
                let (stream, peer) = UnixStream::pair().map_err(|error| {
                    BoxliteError::Network(format!("test socket pair failed: {error}"))
                })?;
                peer_tx.send(peer).unwrap();
                Ok(stream)
            }
        });

        let endpoint = tunnel.endpoint().await.unwrap();
        assert!(matches!(endpoint, BoxEndpoint::FileDescriptor(fd) if fd >= 0));
        let same_endpoint = tunnel.endpoint().await.unwrap();
        assert_eq!(endpoint, same_endpoint);

        let mut first = tunnel.connect().await.unwrap();
        let mut first_peer = peer_rx.recv().await.unwrap();
        first_peer.write_all(b"one").await.unwrap();
        let mut first_response = [0; 3];
        first.read_exact(&mut first_response).await.unwrap();
        assert_eq!(&first_response, b"one");
        assert!(matches!(
            tunnel.connect().await,
            Err(BoxliteError::InvalidState(_))
        ));
        assert!(matches!(
            tunnel.endpoint().await,
            Err(BoxliteError::InvalidState(_))
        ));
    }
}
