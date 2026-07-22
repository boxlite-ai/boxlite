//! Network sub-resource on LiteBox.

use std::net::SocketAddr;
use std::os::fd::{AsRawFd, OwnedFd};
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

enum TunnelState {
    LocalReady(OwnedFd),
    #[cfg(feature = "rest")]
    RemoteReady {
        uri: String,
        connection: Box<dyn BoxConnection>,
    },
    Connected,
}

/// A one-shot box service tunnel target.
pub struct BoxTunnel {
    state: tokio::sync::Mutex<TunnelState>,
}

impl BoxTunnel {
    /// Wrap an owned transport descriptor. The fd *is* the tunnel — no bridge
    /// copy in between: `endpoint()` lends it out, `connect()` consumes it.
    pub(crate) fn local(fd: OwnedFd) -> Self {
        Self {
            state: tokio::sync::Mutex::new(TunnelState::LocalReady(fd)),
        }
    }

    #[cfg(feature = "rest")]
    pub(crate) fn remote<C>(uri: String, connection: C) -> Self
    where
        C: BoxConnection + 'static,
    {
        Self {
            state: tokio::sync::Mutex::new(TunnelState::RemoteReady {
                uri,
                connection: Box::new(connection),
            }),
        }
    }

    /// Describe the prepared tunnel without opening another connection.
    pub async fn endpoint(&self) -> BoxliteResult<BoxEndpoint> {
        match &*self.state.lock().await {
            TunnelState::LocalReady(fd) => Ok(BoxEndpoint::FileDescriptor(fd.as_raw_fd())),
            #[cfg(feature = "rest")]
            TunnelState::RemoteReady { uri, .. } => Ok(BoxEndpoint::Uri(uri.clone())),
            TunnelState::Connected => Err(BoxliteError::InvalidState(
                "tunnel connection has already been consumed".into(),
            )),
        }
    }

    /// Consume this tunnel's single connection.
    pub async fn connect(&self) -> BoxliteResult<Box<dyn BoxConnection>> {
        let mut state = self.state.lock().await;
        match std::mem::replace(&mut *state, TunnelState::Connected) {
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
            #[cfg(feature = "rest")]
            TunnelState::RemoteReady { connection, .. } => Ok(connection),
            TunnelState::Connected => Err(BoxliteError::InvalidState(
                "tunnel connection has already been consumed".into(),
            )),
        }
    }
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

    /// Establish a one-shot tunnel and return its prepared endpoint and connection.
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

    #[cfg(feature = "rest")]
    #[tokio::test]
    async fn remote_tunnel_exposes_and_consumes_prepared_connection() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let tunnel = BoxTunnel::remote("https://3000-box.proxy.example.test".to_string(), stream);

        assert_eq!(
            tunnel.endpoint().await.unwrap(),
            BoxEndpoint::Uri("https://3000-box.proxy.example.test".to_string())
        );

        let mut first = tunnel.connect().await.unwrap();
        peer.write_all(b"one").await.unwrap();
        let mut first_response = [0; 3];
        first.read_exact(&mut first_response).await.unwrap();
        assert_eq!(&first_response, b"one");
        assert!(matches!(
            tunnel.connect().await,
            Err(BoxliteError::InvalidState(_))
        ));
    }

    #[tokio::test]
    async fn local_tunnel_hands_back_the_transport_fd() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let fd = OwnedFd::from(stream.into_std().unwrap());
        let transport_fd = fd.as_raw_fd();
        let tunnel = BoxTunnel::local(fd);

        // Zero-copy contract: the endpoint IS the transport fd, not a bridge.
        let endpoint = tunnel.endpoint().await.unwrap();
        assert_eq!(endpoint, BoxEndpoint::FileDescriptor(transport_fd));
        let same_endpoint = tunnel.endpoint().await.unwrap();
        assert_eq!(endpoint, same_endpoint);

        let mut first = tunnel.connect().await.unwrap();
        peer.write_all(b"one").await.unwrap();
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
