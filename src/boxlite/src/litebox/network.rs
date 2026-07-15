//! Network sub-resource on LiteBox.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::net::TunnelStream;
use crate::runtime::backend::BoxNetworkBackend;

/// Lazily opens the raw byte stream backing a [`BoxTunnel`]. Each backend
/// builds one inside its [`BoxNetworkBackend::tunnel`] impl, capturing whatever
/// it needs (a REST client, a gvproxy handle) so the tunnel stays self-contained
/// and the backend only has to expose `tunnel`.
pub(crate) type TunnelConnector = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = BoxliteResult<TunnelStream>> + Send>> + Send + Sync,
>;

/// Lazily fetches the public endpoint for a [`BoxTunnel`]. Present only for remote
/// boxes, and invoked on demand so a caller that only connects never pays for
/// the describe round-trip.
pub(crate) type TunnelUrlFetch =
    Box<dyn Fn() -> Pin<Box<dyn Future<Output = BoxliteResult<String>> + Send>> + Send + Sync>;

pub(crate) struct UnsupportedNetworkBackend;

#[async_trait::async_trait]
impl BoxNetworkBackend for UnsupportedNetworkBackend {
    async fn tunnel(&self, _target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        Err(BoxliteError::Unsupported(
            "box networking is unavailable".into(),
        ))
    }
}

/// A box service tunnel target. Call [`endpoint`](Self::endpoint) first, then
/// [`connect`](Self::connect) on this handle.
pub struct BoxTunnel {
    endpoint: Option<TunnelUrlFetch>,
    connector: TunnelConnector,
    stream: Arc<tokio::sync::Mutex<Option<TunnelStream>>>,
}

impl BoxTunnel {
    pub(crate) fn new(url: Option<TunnelUrlFetch>, connector: TunnelConnector) -> Self {
        Self {
            endpoint: url,
            connector,
            stream: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Resolve the endpoint, fetching a URL remotely or preparing a local stream.
    pub async fn endpoint(&self) -> BoxliteResult<Option<String>> {
        match &self.endpoint {
            Some(fetch) => Ok(Some(fetch().await?)),
            None => {
                let mut stream = self.stream.lock().await;
                if stream.is_none() {
                    *stream = Some((self.connector)().await?);
                }
                Ok(None)
            }
        }
    }

    /// Consume the prepared local stream or establish the remote stream once.
    pub async fn connect(&self) -> BoxliteResult<TunnelStream> {
        let mut stream = self.stream.lock().await;
        if let Some(stream) = stream.take() {
            return Ok(stream);
        }
        drop(stream);
        (self.connector)().await
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

    /// Describe a tunnel target, returning a [`BoxTunnel`] with endpoint and
    /// connection operations for both local and remote boxes.
    ///
    /// This is the single tunnel entry point: callers that only want the raw
    /// stream use the SDK-specific `connect()` wrapper.
    pub async fn box_tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        self.network_backend.tunnel(target).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use boxlite_shared::errors::BoxliteError;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    use super::*;

    #[derive(Default)]
    struct TestBackend {
        described: Arc<AtomicUsize>,
        connected: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl BoxNetworkBackend for TestBackend {
        async fn tunnel(&self, _target: SocketAddr) -> BoxliteResult<BoxTunnel> {
            let described = Arc::clone(&self.described);
            let connected = Arc::clone(&self.connected);
            Ok(BoxTunnel::new(
                Some(Box::new(move || {
                    let described = Arc::clone(&described);
                    Box::pin(async move {
                        described.fetch_add(1, Ordering::Relaxed);
                        Ok("https://3000-box.proxy.example.test".to_string())
                    })
                })),
                Arc::new(move || {
                    let connected = Arc::clone(&connected);
                    Box::pin(async move {
                        connected.fetch_add(1, Ordering::Relaxed);
                        Err(BoxliteError::Unsupported("test tunnel".to_string()))
                    })
                }),
            ))
        }
    }

    #[tokio::test]
    async fn box_tunnel_fetches_url_and_connects_lazily() {
        let backend = Arc::new(TestBackend::default());
        let network = NetworkHandle::new(backend.clone());
        let target = "192.168.127.2:3000".parse().unwrap();

        // Obtaining the tunnel does no work — no describe, no connect.
        let tunnel = network.box_tunnel(target).await.unwrap();
        assert_eq!(backend.described.load(Ordering::Relaxed), 0);
        assert_eq!(backend.connected.load(Ordering::Relaxed), 0);

        // endpoint() triggers exactly one describe; connect() remains separate.
        let endpoint = tunnel.endpoint().await.unwrap();
        assert_eq!(
            endpoint.as_deref(),
            Some("https://3000-box.proxy.example.test")
        );
        assert_eq!(backend.described.load(Ordering::Relaxed), 1);
        assert_eq!(backend.connected.load(Ordering::Relaxed), 0);

        // Connecting the tunnel triggers exactly one connect.
        assert!(tunnel.connect().await.is_err());
        assert_eq!(backend.connected.load(Ordering::Relaxed), 1);
        assert_eq!(backend.described.load(Ordering::Relaxed), 1);
    }

    struct LocalBackend {
        peer: Arc<tokio::sync::Mutex<Option<UnixStream>>>,
    }

    #[async_trait::async_trait]
    impl BoxNetworkBackend for LocalBackend {
        async fn tunnel(&self, _target: SocketAddr) -> BoxliteResult<BoxTunnel> {
            let peer = Arc::clone(&self.peer);
            Ok(BoxTunnel::new(
                None,
                Arc::new(move || {
                    let peer = Arc::clone(&peer);
                    Box::pin(async move {
                        let (stream, other) = UnixStream::pair().map_err(|error| {
                            BoxliteError::Network(format!("test socket pair failed: {error}"))
                        })?;
                        *peer.lock().await = Some(other);
                        Ok(TunnelStream::Local(stream))
                    })
                }),
            ))
        }
    }

    #[tokio::test]
    async fn local_box_uses_the_same_endpoint_then_connect_flow() {
        let peer = Arc::new(tokio::sync::Mutex::new(None));
        let network = NetworkHandle::new(Arc::new(LocalBackend {
            peer: Arc::clone(&peer),
        }));
        let target = "192.168.127.2:3000".parse().unwrap();

        let tunnel = network.box_tunnel(target).await.unwrap();
        let endpoint = tunnel.endpoint().await.unwrap();
        assert_eq!(endpoint, None);
        let TunnelStream::Local(mut stream) = tunnel.connect().await.unwrap();
        let mut peer = peer.lock().await.take().unwrap();

        peer.write_all(b"local").await.unwrap();
        let mut response = [0; 5];
        stream.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"local");
    }
}
