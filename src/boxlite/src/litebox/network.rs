//! Network sub-resource on LiteBox.

use std::io::ErrorKind;
use std::net::SocketAddr;
use std::os::fd::OwnedFd;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::runtime::backend::BoxNetworkBackend;

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

#[cfg(feature = "rest")]
impl Transport for tokio::io::DuplexStream {
    fn into_split(self: Box<Self>) -> (Box<dyn ReadTransport>, Box<dyn WriteTransport>) {
        // No native split on an in-memory pipe, so this one pays the mutex.
        let (reader, writer) = tokio::io::split(*self);
        (Box::new(reader), Box::new(writer))
    }

    fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
        // In-memory pipe: there is no descriptor.
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
    /// `None` for a remotely served connection, which is an in-memory pipe
    /// rather than a socket. The connection retains ownership and closes it,
    /// matching `socket.fileno()`.
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

/// The transport a [`BoxTunnel`] was built over — fixed at construction,
/// never transitions. Not a state machine.
enum TunnelTransport {
    /// Owned descriptor for the local transport; the fd *is* the tunnel.
    Local(OwnedFd),
    /// Live remote stream plus the public URI it was opened against.
    #[cfg(feature = "rest")]
    Remote {
        uri: String,
        connection: BoxConnection,
    },
}

/// A one-shot box service tunnel target.
///
/// [`uri`](Self::uri) reports where a remote tunnel can be reached;
/// [`connect`](Self::connect) consumes the tunnel, so a second connect is a
/// move error at compile time rather than a runtime state check.
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
    pub(crate) fn remote<T>(uri: String, connection: T) -> Self
    where
        T: Transport + 'static,
    {
        Self {
            transport: TunnelTransport::Remote {
                uri,
                connection: BoxConnection::new(connection),
            },
        }
    }

    /// Where clients can reach a remote box service.
    ///
    /// `None` for a local tunnel: its descriptor *is* the connection, so there
    /// is no address to hand out — use [`connect`](Self::connect) instead.
    pub fn uri(&self) -> Option<&str> {
        match &self.transport {
            TunnelTransport::Local(_) => None,
            #[cfg(feature = "rest")]
            TunnelTransport::Remote { uri, .. } => Some(uri),
        }
    }

    /// Consume this tunnel into its single connection.
    ///
    /// Must run inside a tokio runtime — the local descriptor is registered
    /// with the reactor here.
    pub fn connect(self) -> BoxliteResult<BoxConnection> {
        match self.transport {
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

    /// Establish a one-shot tunnel to a service port inside the box.
    pub async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        self.network_backend.tunnel(target).await
    }
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsRawFd;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    use super::*;

    // Double-connect and uri()-after-connect need no runtime tests: connect()
    // takes `self`, so both are move errors at compile time.

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

    /// The tolerance must sit on the trait impl, not only on the inherent
    /// method: a Rust caller holding the public connection can reach
    /// `poll_shutdown` through `AsyncWriteExt` or `copy_bidirectional` without
    /// ever touching `BoxWriter::shutdown`.
    #[tokio::test]
    async fn async_write_shutdown_also_tolerates_a_hung_up_peer() {
        for split in [false, true] {
            let (stream, peer) = UnixStream::pair().unwrap();
            let fd = OwnedFd::from(stream.into_std().unwrap());
            let connection = BoxTunnel::local(fd).connect().unwrap();
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

    /// The transport used for real remote tunnels — an in-memory duplex pipe —
    /// reports no descriptor and refuses to surrender one.
    #[cfg(feature = "rest")]
    #[tokio::test]
    async fn duplex_backed_connection_reports_and_refuses_a_descriptor() {
        let (local, _peer) = tokio::io::duplex(64);
        let connection = BoxConnection::new(local);

        assert_eq!(connection.raw_fd(), None);
        let error = connection
            .into_fd()
            .expect_err("an in-memory pipe has no descriptor");
        assert!(
            error.to_string().contains("no local descriptor"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn local_tunnel_has_no_uri_and_connects_over_its_own_fd() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let fd = OwnedFd::from(stream.into_std().unwrap());
        let tunnel = BoxTunnel::local(fd);

        // A local descriptor is a live connection, not an address.
        assert_eq!(tunnel.uri(), None);

        let mut connection = tunnel.connect().unwrap();
        peer.write_all(b"one").await.unwrap();
        let mut response = [0; 3];
        connection.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"one");
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

    fn writer_failing_with(kind: ErrorKind) -> BoxWriter {
        BoxWriter {
            inner: Box::new(FailingShutdown(kind)),
        }
    }

    /// The #1110 fix: a peer that already hung up ends a one-shot tunnel
    /// normally, so teardown reports success.
    #[tokio::test]
    async fn shutdown_treats_an_already_disconnected_peer_as_success() {
        let mut writer = writer_failing_with(ErrorKind::NotConnected);
        assert!(writer.shutdown().await.is_ok());
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
        }
    }

    /// Bytes still reach the peer through the split halves, and a real
    /// close after the peer is gone does not error.
    #[tokio::test]
    async fn split_halves_carry_traffic_and_close_after_peer_hangs_up() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let fd = OwnedFd::from(stream.into_std().unwrap());
        let (mut reader, mut writer) = BoxTunnel::local(fd).connect().unwrap().into_split();

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
