//! Network sub-resource on LiteBox.

use std::io::ErrorKind;
use std::net::SocketAddr;
use std::os::fd::OwnedFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinSet;
use tokio_util::either::Either;
use tokio_util::sync::CancellationToken;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::runtime::backend::BoxNetworkBackend;

const MAX_FORWARD_CONNECTIONS: usize = 64;

/// Local address owned by a tunnel forwarder.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SocketAddress {
    Tcp(SocketAddr),
    Unix(PathBuf),
}

impl std::fmt::Display for SocketAddress {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Tcp(address) => write!(formatter, "tcp://{address}"),
            Self::Unix(path) => write!(formatter, "unix:{}", path.display()),
        }
    }
}

/// Combines the two byte-stream traits into something boxable.
///
/// `dyn AsyncRead + AsyncWrite` is rejected by rustc (E0225: only auto traits
/// may be additional), so a supertrait alias is the sanctioned workaround.
/// Deliberately **private**: callers get the concrete [`BoxConnection`], never
/// this. Same arrangement as `hyper`'s `pub(super) trait Io` behind `Upgraded`.
pub(crate) trait Transport: AsyncRead + AsyncWrite + Send + Unpin {
    /// Split into owned halves, preferring the transport's own split.
    ///
    /// A real socket hands back lock-free halves; only transports without a
    /// native split pay `tokio::io::split`'s shared mutex.
    fn into_split(self: Box<Self>) -> (Box<dyn ReadTransport>, Box<dyn WriteTransport>);

    /// The descriptor, borrowed — `None` when this transport has none.
    ///
    /// The transport keeps ownership and closes it on drop, so this is the
    /// `socket.fileno()` contract rather than a transfer.
    fn raw_fd(&self) -> Option<std::os::fd::RawFd>;

    /// Give up the descriptor entirely, transferring ownership to the caller.
    ///
    /// Consuming, and it cannot hand the transport back on failure: the
    /// underlying `into_std` takes `self` by value. Ask
    /// [`raw_fd`](Self::raw_fd) first if you need the transport to survive the
    /// question.
    fn into_fd(self: Box<Self>) -> BoxliteResult<OwnedFd>;
}

pub(crate) trait ReadTransport: AsyncRead + Send + Unpin {}
impl<T: AsyncRead + Send + Unpin> ReadTransport for T {}

pub(crate) trait WriteTransport: AsyncWrite + Send + Unpin {}
impl<T: AsyncWrite + Send + Unpin> WriteTransport for T {}

impl Transport for tokio::net::UnixStream {
    fn into_split(self: Box<Self>) -> (Box<dyn ReadTransport>, Box<dyn WriteTransport>) {
        let (reader, writer) = tokio::net::UnixStream::into_split(*self);
        (Box::new(reader), Box::new(writer))
    }

    fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
        Some(std::os::fd::AsRawFd::as_raw_fd(self))
    }

    fn into_fd(self: Box<Self>) -> BoxliteResult<OwnedFd> {
        // Deregisters from the reactor; the caller owns the descriptor after.
        (*self)
            .into_std()
            .map(OwnedFd::from)
            .map_err(|error| BoxliteError::Network(format!("detach tunnel descriptor: {error}")))
    }
}

/// The remote transport: an HTTP CONNECT stream hyper has upgraded.
///
/// Its descriptor is unreachable by construction — hyper owns the socket, it
/// may be TLS-framed, and `Upgraded` can hold already-read tunnel bytes that no
/// descriptor would carry. So both fd accessors decline.
#[cfg(feature = "rest")]
impl Transport for hyper_util::rt::TokioIo<hyper::upgrade::Upgraded> {
    fn into_split(self: Box<Self>) -> (Box<dyn ReadTransport>, Box<dyn WriteTransport>) {
        // No native split, so this one pays `tokio::io::split`'s mutex.
        let (reader, writer) = tokio::io::split(*self);
        (Box::new(reader), Box::new(writer))
    }

    fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
        None
    }

    fn into_fd(self: Box<Self>) -> BoxliteResult<OwnedFd> {
        Err(BoxliteError::Unsupported(
            "a remotely served tunnel connection has no local descriptor".into(),
        ))
    }
}

/// A bidirectional byte stream to a service inside a box.
///
/// Opaque on purpose: the transport behind it is an implementation detail, so
/// swapping one never breaks callers.
pub struct BoxConnection {
    inner: Box<dyn Transport>,
}

/// Read half of a [`BoxConnection`].
pub struct BoxReader {
    inner: Box<dyn ReadTransport>,
}

/// Write half of a [`BoxConnection`].
pub struct BoxWriter {
    inner: Box<dyn WriteTransport>,
}

impl BoxConnection {
    pub(crate) fn new<T: Transport + 'static>(transport: T) -> Self {
        Self {
            inner: Box::new(transport),
        }
    }

    /// Split into halves that can read and write concurrently.
    ///
    /// Bidirectional traffic needs this: holding one lock across a large write
    /// would stall reads for its whole duration.
    pub fn into_split(self) -> (BoxReader, BoxWriter) {
        let (reader, writer) = self.inner.into_split();
        (BoxReader { inner: reader }, BoxWriter { inner: writer })
    }

    /// The descriptor behind this connection, borrowed.
    ///
    /// `None` for a remotely served connection: hyper owns that socket and it
    /// may be TLS-framed, so no descriptor of ours carries its bytes. The
    /// connection retains ownership and closes it, matching `socket.fileno()`.
    pub fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
        self.inner.raw_fd()
    }

    /// Consume the connection and take ownership of its descriptor.
    ///
    /// The caller must close the result. Errors for a remotely served
    /// connection, which has no descriptor to give.
    pub fn into_fd(self) -> BoxliteResult<OwnedFd> {
        self.inner.into_fd()
    }
}

/// Treat an already-disconnected peer as a completed half-close.
///
/// The normal end of a one-shot tunnel is the peer hanging up first, and macOS
/// reports `ENOTCONN` for `shutdown(2)` on an AF_UNIX socket whose peer is gone
/// where Linux reports success. Every other error still propagates.
///
/// This lives at the `poll_shutdown` layer so *every* route reaches it —
/// `BoxWriter::shutdown`, `AsyncWriteExt::shutdown` on either public type, and
/// `copy_bidirectional` — rather than only the paths the SDKs happen to use.
fn tolerate_disconnected_peer(poll: Poll<std::io::Result<()>>) -> Poll<std::io::Result<()>> {
    match poll {
        Poll::Ready(Err(error)) if error.kind() == ErrorKind::NotConnected => Poll::Ready(Ok(())),
        other => other,
    }
}

impl BoxWriter {
    /// Half-close the write side, signalling EOF to the peer.
    ///
    /// Errors are mapped into [`BoxliteError`]; the disconnected-peer tolerance
    /// itself comes from this type's [`AsyncWrite`] impl.
    pub async fn shutdown(&mut self) -> BoxliteResult<()> {
        AsyncWriteExt::shutdown(self)
            .await
            .map_err(|error| BoxliteError::Network(format!("shut down tunnel writer: {error}")))
    }
}

impl AsyncRead for BoxConnection {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for BoxConnection {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        tolerate_disconnected_peer(Pin::new(&mut self.inner).poll_shutdown(cx))
    }
}

impl AsyncRead for BoxReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for BoxWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        tolerate_disconnected_peer(Pin::new(&mut self.inner).poll_shutdown(cx))
    }
}

/// The transport a [`BoxTunnel`] was built over.
enum TunnelTransport {
    Local(OwnedFd),
    #[cfg(feature = "rest")]
    Remote {
        uri: String,
        connection: BoxConnection,
    },
}

#[derive(Clone)]
struct TunnelOpener {
    network_backend: Arc<dyn BoxNetworkBackend>,
    target: SocketAddr,
}

impl TunnelOpener {
    async fn open(&self) -> BoxliteResult<BoxTunnel> {
        self.network_backend.tunnel(self.target).await
    }
}

/// A prepared, one-shot tunnel to one TCP service inside a box.
pub struct BoxTunnel {
    transport: TunnelTransport,
    opener: Option<TunnelOpener>,
}

impl BoxTunnel {
    pub(crate) fn local(fd: OwnedFd) -> Self {
        Self {
            transport: TunnelTransport::Local(fd),
            opener: None,
        }
    }

    #[cfg(feature = "rest")]
    pub(crate) fn remote<T>(uri: String, connection: T) -> Self
    where
        T: Transport + 'static,
    {
        Self {
            transport: TunnelTransport::Remote {
                uri,
                connection: BoxConnection::new(connection),
            },
            opener: None,
        }
    }

    fn with_opener(mut self, opener: TunnelOpener) -> Self {
        self.opener = Some(opener);
        self
    }

    pub fn uri(&self) -> Option<&str> {
        match &self.transport {
            TunnelTransport::Local(_) => None,
            #[cfg(feature = "rest")]
            TunnelTransport::Remote { uri, .. } => Some(uri),
        }
    }

    fn connect_transport(transport: TunnelTransport) -> BoxliteResult<BoxConnection> {
        match transport {
            TunnelTransport::Local(fd) => {
                let stream = std::os::unix::net::UnixStream::from(fd);
                stream.set_nonblocking(true).map_err(|error| {
                    BoxliteError::Network(format!("configure tunnel descriptor: {error}"))
                })?;
                tokio::net::UnixStream::from_std(stream)
                    .map(BoxConnection::new)
                    .map_err(|error| {
                        BoxliteError::Network(format!("open tunnel descriptor: {error}"))
                    })
            }
            #[cfg(feature = "rest")]
            TunnelTransport::Remote { connection, .. } => Ok(connection),
        }
    }

    /// Consume this prepared tunnel into its single connection.
    pub fn connect(self) -> BoxliteResult<BoxConnection> {
        Self::connect_transport(self.transport)
    }

    /// Consume this prepared tunnel into a local multi-connection forwarder.
    pub async fn forward(self, listen: SocketAddress) -> BoxliteResult<TunnelForwarder> {
        self.forward_with_bound(listen, |_| Ok(())).await
    }

    /// Bind and synchronously report the canonical address before accepting.
    #[doc(hidden)]
    pub async fn forward_with_bound<F>(
        self,
        listen: SocketAddress,
        on_bound: F,
    ) -> BoxliteResult<TunnelForwarder>
    where
        F: FnOnce(&SocketAddress) -> BoxliteResult<()>,
    {
        let BoxTunnel { transport, opener } = self;
        let opener = opener
            .ok_or_else(|| BoxliteError::Internal("tunnel is missing its network opener".into()))?;
        let first_connection = Self::connect_transport(transport)?;
        let listener = BoundListener::bind(listen).await?;
        let address = listener.address();
        on_bound(&address)?;
        let state = Arc::new(ForwarderState::new(address));
        let task_state = Arc::clone(&state);
        tokio::spawn(async move {
            run_forwarder(listener, first_connection, opener, task_state).await;
        });

        Ok(TunnelForwarder {
            owner: Arc::new(ForwarderOwner { state }),
        })
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

    /// Establish a prepared, one-shot tunnel to a service port inside the box.
    pub async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        if target.port() == 0 {
            return Err(BoxliteError::InvalidArgument(
                "tunnel target port must be non-zero".into(),
            ));
        }
        let opener = TunnelOpener {
            network_backend: Arc::clone(&self.network_backend),
            target,
        };
        self.network_backend
            .tunnel(target)
            .await
            .map(|tunnel| tunnel.with_opener(opener))
    }
}

/// A running local listener that opens one box tunnel per client.
#[derive(Clone)]
pub struct TunnelForwarder {
    owner: Arc<ForwarderOwner>,
}

impl std::fmt::Debug for TunnelForwarder {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TunnelForwarder")
            .field("local_addr", &self.local_addr())
            .finish_non_exhaustive()
    }
}

impl TunnelForwarder {
    pub fn local_addr(&self) -> &SocketAddress {
        &self.owner.state.address
    }

    /// Wait for explicit closure or a fatal listener error.
    pub async fn wait(&self) -> BoxliteResult<()> {
        self.owner.state.wait().await
    }

    /// Stop accepting and cancel active relays, then wait for cleanup.
    pub async fn close(&self) -> BoxliteResult<()> {
        self.owner.state.cancel.cancel();
        self.wait().await
    }
}

struct ForwarderOwner {
    state: Arc<ForwarderState>,
}

impl Drop for ForwarderOwner {
    fn drop(&mut self) {
        self.state.cancel.cancel();
    }
}

type ForwarderOutcome = Result<(), String>;

struct ForwarderState {
    address: SocketAddress,
    cancel: CancellationToken,
    outcome: watch::Sender<Option<ForwarderOutcome>>,
}

impl ForwarderState {
    fn new(address: SocketAddress) -> Self {
        let (outcome, _) = watch::channel(None);
        Self {
            address,
            cancel: CancellationToken::new(),
            outcome,
        }
    }

    fn finish(&self, outcome: ForwarderOutcome) {
        self.outcome.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(outcome);
            true
        });
    }

    async fn wait(&self) -> BoxliteResult<()> {
        let mut outcome = self.outcome.subscribe();
        outcome
            .wait_for(Option::is_some)
            .await
            .expect("forwarder outcome sender is retained by its state")
            .clone()
            .expect("wait_for returned only after observing an outcome")
            .map_err(BoxliteError::Network)
    }
}

enum BoundListener {
    Tcp(TcpListener),
    Unix {
        listener: UnixListener,
        cleanup: UnixSocketCleanup,
    },
}

impl BoundListener {
    async fn bind(address: SocketAddress) -> BoxliteResult<Self> {
        match address {
            SocketAddress::Tcp(address) => {
                TcpListener::bind(address)
                    .await
                    .map(Self::Tcp)
                    .map_err(|error| {
                        BoxliteError::Network(format!("bind tunnel listener {address}: {error}"))
                    })
            }
            SocketAddress::Unix(path) => {
                if !path.is_absolute() {
                    return Err(BoxliteError::InvalidArgument(format!(
                        "tunnel Unix socket path must be absolute: {}",
                        path.display()
                    )));
                }
                match std::fs::symlink_metadata(&path) {
                    Ok(_) => {
                        return Err(BoxliteError::AlreadyExists(format!(
                            "tunnel Unix socket path {}",
                            path.display()
                        )));
                    }
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(BoxliteError::Network(format!(
                            "inspect tunnel Unix socket path {}: {error}",
                            path.display()
                        )));
                    }
                }

                let listener = UnixListener::bind(&path).map_err(|error| {
                    BoxliteError::Network(format!(
                        "bind tunnel Unix socket {}: {error}",
                        path.display()
                    ))
                })?;
                let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
                    BoxliteError::Network(format!(
                        "inspect bound tunnel Unix socket {}: {error}",
                        path.display()
                    ))
                })?;
                Ok(Self::Unix {
                    listener,
                    cleanup: UnixSocketCleanup {
                        path,
                        device: metadata.dev(),
                        inode: metadata.ino(),
                    },
                })
            }
        }
    }

    fn address(&self) -> SocketAddress {
        match self {
            Self::Tcp(listener) => SocketAddress::Tcp(
                listener
                    .local_addr()
                    .expect("bound TCP listener must have a local address"),
            ),
            Self::Unix { cleanup, .. } => SocketAddress::Unix(cleanup.path.clone()),
        }
    }

    async fn accept(&self) -> std::io::Result<LocalForwardStream> {
        match self {
            Self::Tcp(listener) => listener
                .accept()
                .await
                .map(|(stream, _)| Either::Left(stream)),
            Self::Unix { listener, .. } => listener
                .accept()
                .await
                .map(|(stream, _)| Either::Right(stream)),
        }
    }
}

struct UnixSocketCleanup {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl Drop for UnixSocketCleanup {
    fn drop(&mut self) {
        // POSIX has no atomic compare-and-unlink operation. This immediate
        // identity check avoids removing a visible replacement in ordinary
        // cases, but a replacement racing between this check and unlink is an
        // unavoidable best-effort TOCTOU limitation.
        let Ok(metadata) = std::fs::symlink_metadata(&self.path) else {
            return;
        };
        if metadata.file_type().is_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
            && let Err(error) = std::fs::remove_file(&self.path)
        {
            tracing::warn!(path = %self.path.display(), %error, "failed to remove tunnel Unix socket");
        }
    }
}

type LocalForwardStream = Either<TcpStream, UnixStream>;

enum RelayTunnel {
    Prepared(BoxConnection),
    Open(TunnelOpener),
}

async fn run_forwarder(
    listener: BoundListener,
    first_connection: BoxConnection,
    opener: TunnelOpener,
    state: Arc<ForwarderState>,
) {
    let permits = Arc::new(Semaphore::new(MAX_FORWARD_CONNECTIONS));
    let mut relays = JoinSet::new();
    let mut first_connection = Some(first_connection);
    let outcome = 'accepting: loop {
        while let Some(result) = relays.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error, "tunnel relay task failed");
            }
        }

        let permit = tokio::select! {
            _ = state.cancel.cancelled() => break 'accepting Ok(()),
            permit = Arc::clone(&permits).acquire_owned() => {
                match permit {
                    Ok(permit) => permit,
                    Err(_) => break 'accepting Ok(()),
                }
            }
        };

        let stream = loop {
            let accepted = tokio::select! {
                _ = state.cancel.cancelled() => break 'accepting Ok(()),
                accepted = listener.accept() => accepted,
            };
            match accepted {
                Ok(stream) => break stream,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => {
                    break 'accepting Err(format!(
                        "accept connection on {}: {error}",
                        state.address
                    ));
                }
            }
        };

        let relay_cancel = state.cancel.clone();
        let relay_target = opener.target;
        let relay_tunnel = first_connection
            .take()
            .map(RelayTunnel::Prepared)
            .unwrap_or_else(|| RelayTunnel::Open(opener.clone()));
        relays.spawn(async move {
            let _permit = permit;
            if let Err(error) = relay_client(stream, relay_tunnel, relay_cancel).await {
                tracing::warn!(target = %relay_target, %error, "tunnel client relay failed");
            }
        });
    };

    state.cancel.cancel();
    relays.abort_all();
    while let Some(result) = relays.join_next().await {
        if let Err(error) = result
            && !error.is_cancelled()
        {
            tracing::warn!(%error, "tunnel relay task failed during cleanup");
        }
    }
    drop(listener);
    state.finish(outcome);
}

async fn relay_client(
    mut local: LocalForwardStream,
    tunnel: RelayTunnel,
    cancel: CancellationToken,
) -> BoxliteResult<()> {
    tokio::select! {
        _ = cancel.cancelled() => Ok(()),
        result = async {
            let mut remote = match tunnel {
                RelayTunnel::Prepared(connection) => connection,
                RelayTunnel::Open(opener) => opener.open().await?.connect()?,
            };
            tokio::io::copy_bidirectional(&mut local, &mut remote)
                .await
                .map(|_| ())
                .map_err(|error| BoxliteError::Network(format!("relay tunnel bytes: {error}")))
        } => result,
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::os::fd::AsRawFd;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpStream, UnixListener, UnixStream};

    use super::*;

    #[cfg(feature = "rest")]
    #[tokio::test]
    async fn remote_tunnel_exposes_uri_and_yields_its_connection() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let tunnel = BoxTunnel::remote("https://3000-box.proxy.example.test".to_string(), stream);

        assert_eq!(tunnel.uri(), Some("https://3000-box.proxy.example.test"));

        let mut connection = tunnel.connect().unwrap();
        peer.write_all(b"one").await.unwrap();
        let mut response = [0; 3];
        connection.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"one");
    }

    struct EchoNetworkBackend;

    #[async_trait::async_trait]
    impl BoxNetworkBackend for EchoNetworkBackend {
        async fn tunnel(&self, _target: SocketAddr) -> BoxliteResult<BoxTunnel> {
            let (sdk, mut peer) = UnixStream::pair().unwrap();
            tokio::spawn(async move {
                let (mut reader, mut writer) = peer.split();
                let _ = tokio::io::copy(&mut reader, &mut writer).await;
            });
            let fd: OwnedFd = sdk.into_std().unwrap().into();
            Ok(BoxTunnel::local(fd))
        }
    }

    fn echo_network() -> NetworkHandle {
        NetworkHandle::new(Arc::new(EchoNetworkBackend))
    }

    struct FailSecondNetworkBackend {
        attempts: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl BoxNetworkBackend for FailSecondNetworkBackend {
        async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
            if self.attempts.fetch_add(1, Ordering::SeqCst) == 1 {
                return Err(BoxliteError::Network("intentional setup failure".into()));
            }
            EchoNetworkBackend.tunnel(target).await
        }
    }

    struct HoldingNetworkBackend {
        attempts: AtomicUsize,
        peers: Mutex<Vec<UnixStream>>,
    }

    #[async_trait::async_trait]
    impl BoxNetworkBackend for HoldingNetworkBackend {
        async fn tunnel(&self, _target: SocketAddr) -> BoxliteResult<BoxTunnel> {
            let (sdk, peer) = UnixStream::pair().unwrap();
            self.attempts.fetch_add(1, Ordering::SeqCst);
            self.peers.lock().unwrap().push(peer);
            let fd: OwnedFd = sdk.into_std().unwrap().into();
            Ok(BoxTunnel::local(fd))
        }
    }

    #[tokio::test]
    async fn forward_tcp_reports_allocated_address_and_accepts_repeated_clients() {
        let network = echo_network();
        let target = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8080);
        let tunnel = network.tunnel(target).await.unwrap();
        let forwarder = tunnel
            .forward(SocketAddress::Tcp(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                0,
            )))
            .await
            .unwrap();
        let SocketAddress::Tcp(bound) = forwarder.local_addr() else {
            panic!("expected TCP listener");
        };
        assert_ne!(bound.port(), 0);

        for payload in [b"first".as_slice(), b"second".as_slice()] {
            let mut client = TcpStream::connect(bound).await.unwrap();
            client.write_all(payload).await.unwrap();
            let mut echoed = vec![0; payload.len()];
            client.read_exact(&mut echoed).await.unwrap();
            assert_eq!(echoed, payload);
        }

        forwarder.close().await.unwrap();
        forwarder.close().await.unwrap();
        forwarder.wait().await.unwrap();
    }

    #[tokio::test]
    async fn forward_reports_bound_address_before_accepting() {
        let backend = Arc::new(HoldingNetworkBackend {
            attempts: AtomicUsize::new(0),
            peers: Mutex::new(Vec::new()),
        });
        let tunnel = NetworkHandle::new(backend.clone())
            .tunnel("127.0.0.1:8080".parse().unwrap())
            .await
            .unwrap();

        let forwarder = tunnel
            .forward_with_bound(
                SocketAddress::Tcp("127.0.0.1:0".parse().unwrap()),
                |address| {
                    assert_ne!(address, &SocketAddress::Tcp("127.0.0.1:0".parse().unwrap()));
                    assert_eq!(
                        backend.attempts.load(Ordering::SeqCst),
                        1,
                        "no client tunnel may open before the bound-address callback"
                    );
                    Ok(())
                },
            )
            .await
            .unwrap();

        forwarder.close().await.unwrap();
    }

    #[tokio::test]
    async fn tunnel_rejects_zero_guest_port_before_opening() {
        let backend = Arc::new(HoldingNetworkBackend {
            attempts: AtomicUsize::new(0),
            peers: Mutex::new(Vec::new()),
        });
        let error = match NetworkHandle::new(backend.clone())
            .tunnel("127.0.0.1:0".parse().unwrap())
            .await
        {
            Ok(_) => panic!("zero guest port must be rejected"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("target port must be non-zero"));
        assert_eq!(backend.attempts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn forward_tcp_relays_concurrent_clients_and_half_close() {
        let network = echo_network();
        let target = "127.0.0.1:8080".parse().unwrap();
        let forwarder = network
            .tunnel(target)
            .await
            .unwrap()
            .forward(SocketAddress::Tcp("127.0.0.1:0".parse().unwrap()))
            .await
            .unwrap();
        let SocketAddress::Tcp(bound) = *forwarder.local_addr() else {
            panic!("expected TCP listener");
        };

        let clients = (0..8).map(|client_id| {
            tokio::spawn(async move {
                let payload = format!("client-{client_id}").into_bytes();
                let mut client = TcpStream::connect(bound).await.unwrap();
                client.write_all(&payload).await.unwrap();
                client.shutdown().await.unwrap();
                let mut echoed = Vec::new();
                client.read_to_end(&mut echoed).await.unwrap();
                assert_eq!(echoed, payload);
            })
        });
        for client in clients {
            client.await.unwrap();
        }

        let waiter = {
            let forwarder = forwarder.clone();
            tokio::spawn(async move { forwarder.wait().await })
        };
        forwarder.close().await.unwrap();
        waiter.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn forward_client_setup_failure_does_not_stop_later_clients() {
        let network = NetworkHandle::new(Arc::new(FailSecondNetworkBackend {
            attempts: AtomicUsize::new(0),
        }));
        let forwarder = network
            .tunnel("127.0.0.1:8080".parse().unwrap())
            .await
            .unwrap()
            .forward(SocketAddress::Tcp("127.0.0.1:0".parse().unwrap()))
            .await
            .unwrap();
        let SocketAddress::Tcp(bound) = *forwarder.local_addr() else {
            panic!("expected TCP listener");
        };

        let mut first = TcpStream::connect(bound).await.unwrap();
        first.write_all(b"first").await.unwrap();
        let mut echoed = [0; 5];
        first.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"first");

        let mut failed = TcpStream::connect(bound).await.unwrap();
        failed.write_all(b"failed").await.unwrap();
        let mut byte = [0; 1];
        match failed.read(&mut byte).await {
            Ok(0) => {}
            Err(error) if error.kind() == ErrorKind::ConnectionReset => {}
            other => panic!("failed client should close: {other:?}"),
        }

        let mut client = TcpStream::connect(bound).await.unwrap();
        client.write_all(b"second").await.unwrap();
        let mut response = [0; 6];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"second");
        forwarder.close().await.unwrap();
    }

    #[tokio::test]
    async fn forward_acquires_all_64_permits_before_accepting_another_client() {
        let backend = Arc::new(HoldingNetworkBackend {
            attempts: AtomicUsize::new(0),
            peers: Mutex::new(Vec::new()),
        });
        let network = NetworkHandle::new(backend.clone());
        let forwarder = network
            .tunnel("127.0.0.1:8080".parse().unwrap())
            .await
            .unwrap()
            .forward(SocketAddress::Tcp("127.0.0.1:0".parse().unwrap()))
            .await
            .unwrap();
        let SocketAddress::Tcp(bound) = *forwarder.local_addr() else {
            panic!("expected TCP listener");
        };

        let mut clients = Vec::new();
        for _ in 0..=MAX_FORWARD_CONNECTIONS {
            clients.push(TcpStream::connect(bound).await.unwrap());
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while backend.attempts.load(Ordering::SeqCst) < MAX_FORWARD_CONNECTIONS {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("64 relays should start");
        tokio::task::yield_now().await;
        assert_eq!(
            backend.attempts.load(Ordering::SeqCst),
            MAX_FORWARD_CONNECTIONS,
            "the 65th client must remain in the listener backlog"
        );

        forwarder.close().await.unwrap();
        drop(clients);
    }

    #[tokio::test]
    async fn forward_unix_refuses_existing_path_and_removes_owned_socket() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("forward.sock");
        std::fs::write(&path, b"keep").unwrap();
        let network = echo_network();
        let target = "127.0.0.1:8080".parse().unwrap();
        let tunnel = network.tunnel(target).await.unwrap();

        let error = tunnel
            .forward(SocketAddress::Unix(path.clone()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("already exists"));
        assert_eq!(std::fs::read(&path).unwrap(), b"keep");

        std::fs::remove_file(&path).unwrap();
        let forwarder = network
            .tunnel(target)
            .await
            .unwrap()
            .forward(SocketAddress::Unix(PathBuf::from(&path)))
            .await
            .unwrap();
        assert!(path.exists());
        forwarder.close().await.unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn forward_unix_preserves_a_visible_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("forward.sock");
        let displaced = directory.path().join("displaced.sock");
        let network = echo_network();
        let target = "127.0.0.1:8080".parse().unwrap();
        let forwarder = network
            .tunnel(target)
            .await
            .unwrap()
            .forward(SocketAddress::Unix(path.clone()))
            .await
            .unwrap();

        std::fs::rename(&path, &displaced).unwrap();
        let replacement = UnixListener::bind(&path).unwrap();
        forwarder.close().await.unwrap();

        assert!(path.exists(), "a replacement socket must be preserved");
        drop(replacement);
    }

    #[tokio::test]
    async fn dropping_the_final_forwarder_cancels_and_cleans_up() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("drop.sock");
        let forwarder = echo_network()
            .tunnel("127.0.0.1:8080".parse().unwrap())
            .await
            .unwrap()
            .forward(SocketAddress::Unix(path.clone()))
            .await
            .unwrap();
        assert!(path.exists());
        drop(forwarder);

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while path.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("drop should clean up the listener");
    }

    #[test]
    fn socket_address_uses_scriptable_canonical_notation() {
        assert_eq!(
            SocketAddress::Tcp("[::1]:8080".parse().unwrap()).to_string(),
            "tcp://[::1]:8080"
        );
        assert_eq!(
            SocketAddress::Unix(PathBuf::from("/tmp/app.sock")).to_string(),
            "unix:/tmp/app.sock"
        );
    }

    #[tokio::test]
    async fn tunnel_remains_a_one_shot_prepared_connection() {
        let tunnel = echo_network()
            .tunnel("127.0.0.1:8080".parse().unwrap())
            .await
            .unwrap();
        assert_eq!(tunnel.uri(), None);

        let payload = b"one";
        let mut connection = tunnel.connect().unwrap();
        connection.write_all(payload).await.unwrap();
        let mut response = vec![0; payload.len()];
        connection.read_exact(&mut response).await.unwrap();
        assert_eq!(response, payload);
    }

    /// The tolerance must sit on the trait impl, not only on the inherent
    /// method: a Rust caller holding the public connection can reach
    /// `poll_shutdown` through `AsyncWriteExt` or `copy_bidirectional` without
    /// ever touching `BoxWriter::shutdown`.
    #[tokio::test]
    async fn async_write_shutdown_also_tolerates_a_hung_up_peer() {
        for split in [false, true] {
            let (stream, peer) = UnixStream::pair().unwrap();
            let connection = BoxConnection::new(stream);
            drop(peer);

            let result = if split {
                let (_reader, mut writer) = connection.into_split();
                AsyncWriteExt::shutdown(&mut writer).await
            } else {
                let mut connection = connection;
                AsyncWriteExt::shutdown(&mut connection).await
            };
            assert!(result.is_ok(), "split={split} should tolerate ENOTCONN");
        }
    }

    #[tokio::test]
    async fn local_tunnel_uri_is_none_without_connecting() {
        let backend = Arc::new(HoldingNetworkBackend {
            attempts: AtomicUsize::new(0),
            peers: Mutex::new(Vec::new()),
        });
        let tunnel = NetworkHandle::new(backend.clone())
            .tunnel("127.0.0.1:8080".parse().unwrap())
            .await
            .unwrap();

        assert_eq!(tunnel.uri(), None);
        assert_eq!(backend.attempts.load(Ordering::SeqCst), 1);
    }

    /// Zero-copy contract: the descriptor the connection surrenders IS the
    /// original transport, not a bridged copy — so bytes written to the peer
    /// arrive on it with no copy task in between.
    #[tokio::test]
    async fn connection_surrenders_the_original_transport_fd() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let fd = OwnedFd::from(stream.into_std().unwrap());
        let transport_fd = fd.as_raw_fd();

        let connection = BoxTunnel::local(fd).connect().unwrap();
        // Borrowing reports the same descriptor without consuming anything.
        assert_eq!(connection.raw_fd(), Some(transport_fd));

        let taken = connection.into_fd().expect("local yields its fd");
        assert_eq!(taken.as_raw_fd(), transport_fd);

        peer.write_all(b"one").await.unwrap();
        let recovered = std::os::unix::net::UnixStream::from(taken);
        recovered.set_nonblocking(true).unwrap();
        let mut recovered = UnixStream::from_std(recovered).unwrap();
        let mut response = [0; 3];
        recovered.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"one");
    }

    /// A writer whose `poll_shutdown` fails with a chosen kind.
    ///
    /// The real-socket behaviour this guards is platform-specific — macOS
    /// reports `ENOTCONN`, Linux reports success — so a `UnixStream` test would
    /// pass on Linux with or without the guard and prove nothing there. Driving
    /// `poll_shutdown` directly pins the branch on every platform.
    struct FailingShutdown(ErrorKind);

    impl AsyncWrite for FailingShutdown {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Err(std::io::Error::new(self.0, "injected")))
        }
    }

    impl AsyncRead for FailingShutdown {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(())) // immediate EOF; these tests only drive shutdown
        }
    }

    impl Transport for FailingShutdown {
        fn into_split(self: Box<Self>) -> (Box<dyn ReadTransport>, Box<dyn WriteTransport>) {
            let (reader, writer) = tokio::io::split(*self);
            (Box::new(reader), Box::new(writer))
        }

        fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
            None
        }

        fn into_fd(self: Box<Self>) -> BoxliteResult<OwnedFd> {
            Err(BoxliteError::Unsupported("test double".into()))
        }
    }

    fn writer_failing_with(kind: ErrorKind) -> BoxWriter {
        BoxWriter {
            inner: Box::new(FailingShutdown(kind)),
        }
    }

    /// The unsplit type has its own `poll_shutdown`, so it needs its own
    /// injection: the real-socket test above cannot pin it on Linux.
    fn connection_failing_with(kind: ErrorKind) -> BoxConnection {
        BoxConnection::new(FailingShutdown(kind))
    }

    /// The #1110 fix: a peer that already hung up ends a one-shot tunnel
    /// normally, so teardown reports success.
    #[tokio::test]
    async fn shutdown_treats_an_already_disconnected_peer_as_success() {
        let mut writer = writer_failing_with(ErrorKind::NotConnected);
        assert!(writer.shutdown().await.is_ok());

        let mut connection = connection_failing_with(ErrorKind::NotConnected);
        assert!(AsyncWriteExt::shutdown(&mut connection).await.is_ok());
    }

    /// The guard must stay narrow — it is not a blanket swallow.
    #[tokio::test]
    async fn shutdown_still_reports_every_other_failure() {
        for kind in [
            ErrorKind::BrokenPipe,
            ErrorKind::ConnectionReset,
            ErrorKind::PermissionDenied,
        ] {
            let error = writer_failing_with(kind)
                .shutdown()
                .await
                .expect_err("only NotConnected is tolerated");
            assert!(
                error.to_string().contains("shut down tunnel writer"),
                "{kind:?} should surface as a network error, got: {error}"
            );

            let error = AsyncWriteExt::shutdown(&mut connection_failing_with(kind))
                .await
                .expect_err("only NotConnected is tolerated");
            assert_eq!(error.kind(), kind, "the unsplit type must stay as narrow");
        }
    }

    /// Bytes still reach the peer through the split halves, and a real
    /// close after the peer is gone does not error.
    #[tokio::test]
    async fn split_halves_carry_traffic_and_close_after_peer_hangs_up() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let (mut reader, mut writer) = BoxConnection::new(stream).into_split();

        writer.write_all(b"ping").await.unwrap();
        let mut got = [0; 4];
        peer.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"ping");

        peer.write_all(b"pong").await.unwrap();
        let mut back = [0; 4];
        reader.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"pong");

        drop(peer);
        writer
            .shutdown()
            .await
            .expect("teardown after hangup is ok");
    }
}
