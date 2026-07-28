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

/// The transport a [`BoxTunnel`] was built over — fixed at construction,
/// never transitions. Not a state machine.
enum TunnelTransport {
    /// Owned descriptor for the local transport; the fd *is* the tunnel.
    Local(OwnedFd),
    /// Live remote stream plus the public URI it was opened against.
    #[cfg(feature = "rest")]
    Remote {
        uri: String,
        connection: Box<dyn BoxConnection>,
    },
}

/// A one-shot box service tunnel target.
///
/// [`endpoint`](Self::endpoint) lends the descriptor; [`connect`](Self::connect)
/// consumes the tunnel, so a second connect is a move error at compile time
/// rather than a runtime state check.
pub struct BoxTunnel {
    transport: TunnelTransport,
}

impl BoxTunnel {
    /// Wrap an owned transport descriptor. The fd *is* the tunnel — no bridge
    /// copy in between.
    pub(crate) fn local(fd: OwnedFd) -> Self {
        Self {
            transport: TunnelTransport::Local(fd),
        }
    }

    #[cfg(feature = "rest")]
    pub(crate) fn remote<C>(uri: String, connection: C) -> Self
    where
        C: BoxConnection + 'static,
    {
        Self {
            transport: TunnelTransport::Remote {
                uri,
                connection: Box::new(connection),
            },
        }
    }

    /// Describe the prepared tunnel without opening another connection.
    pub fn endpoint(&self) -> BoxEndpoint {
        match &self.transport {
            TunnelTransport::Local(fd) => BoxEndpoint::FileDescriptor(fd.as_raw_fd()),
            #[cfg(feature = "rest")]
            TunnelTransport::Remote { uri, .. } => BoxEndpoint::Uri(uri.clone()),
        }
    }

    /// Consume this tunnel into its single connection.
    ///
    /// Must run inside a tokio runtime — the local descriptor is registered
    /// with the reactor here.
    pub fn connect(self) -> BoxliteResult<Box<dyn BoxConnection>> {
        match self.transport {
            TunnelTransport::Local(fd) => {
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
            TunnelTransport::Remote { connection, .. } => Ok(connection),
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    use super::*;

    // Double-connect and endpoint-after-connect need no runtime tests: connect()
    // takes `self`, so both are move errors at compile time.

    #[cfg(feature = "rest")]
    #[tokio::test]
    async fn remote_tunnel_exposes_uri_and_yields_its_connection() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let tunnel = BoxTunnel::remote("https://3000-box.proxy.example.test".to_string(), stream);

        assert_eq!(
            tunnel.endpoint(),
            BoxEndpoint::Uri("https://3000-box.proxy.example.test".to_string())
        );

        let mut connection = tunnel.connect().unwrap();
        peer.write_all(b"one").await.unwrap();
        let mut response = [0; 3];
        connection.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"one");
    }

    #[tokio::test]
    async fn local_tunnel_hands_back_the_transport_fd() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let fd = OwnedFd::from(stream.into_std().unwrap());
        let transport_fd = fd.as_raw_fd();
        let tunnel = BoxTunnel::local(fd);

        // Zero-copy contract: the endpoint IS the transport fd, not a bridge.
        assert_eq!(tunnel.endpoint(), BoxEndpoint::FileDescriptor(transport_fd));
        assert_eq!(tunnel.endpoint(), BoxEndpoint::FileDescriptor(transport_fd));

        let mut connection = tunnel.connect().unwrap();
        peer.write_all(b"one").await.unwrap();
        let mut response = [0; 3];
        connection.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"one");
    }
}
