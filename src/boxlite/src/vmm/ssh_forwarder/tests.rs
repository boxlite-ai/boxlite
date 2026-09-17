use super::*;
use crate::net::socket_path::BoxSockets;
use crate::vmm::shim_server::{ShimClient, ShimServer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixListener};

pub(in crate::vmm) struct Fixture {
    _home: tempfile::TempDir,
    pub(in crate::vmm) sockets: BoxSockets,
    raw: UnixListener,
    forwarder: Option<ShimServer>,
}

impl Fixture {
    pub(in crate::vmm) fn new(network_enabled: bool) -> Self {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let sockets = BoxSockets::new(
            format!("ssh-{}", uuid::Uuid::new_v4()),
            home.path().join("sockets"),
        );
        std::fs::create_dir(sockets.real_dir()).unwrap();
        sockets.ensure().unwrap();
        let raw = UnixListener::bind(sockets.ssh_sock()).unwrap();
        let forwarder = Some(ShimServer::start(sockets.clone(), network_enabled).unwrap());
        Self {
            _home: home,
            sockets,
            raw,
            forwarder,
        }
    }

    pub(in crate::vmm) fn client(&self) -> ShimClient {
        ShimClient::new(&self.sockets)
    }

    async fn set(&self, address: &str) -> SocketAddr {
        let listener = std::net::TcpListener::bind(address).unwrap();
        let address = listener.local_addr().unwrap();
        self.client()
            .set(Some((listener.into(), address)))
            .await
            .unwrap();
        assert_eq!(
            self.client().get_socket_addr().await.unwrap(),
            Some(address)
        );
        address
    }

    async fn established(&self, address: SocketAddr) -> (TcpStream, UnixStream) {
        let mut client = TcpStream::connect(address).await.unwrap();
        let mut guest = self.raw.accept().await.unwrap().0;
        guest.write_all(b"ready").await.unwrap();
        let mut ready = [0; 5];
        client.read_exact(&mut ready).await.unwrap();
        assert_eq!(&ready, b"ready");
        (client, guest)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.forwarder.take();
        self.sockets.remove();
    }
}

#[tokio::test]
async fn ssh_forwarder_tcp_transfer_large_streams_and_half_close() {
    let fixture = Fixture::new(true);
    for address in ["127.0.0.1:0", "[::1]:0"] {
        let address = fixture.set(address).await;
        let (mut client, mut guest) = fixture.established(address).await;
        let transfer = async {
            let server = async {
                let mut bytes = Vec::new();
                guest.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, vec![0xa5; 512 * 1024]);
                guest.write_all(&vec![0x5a; 512 * 1024]).await.unwrap();
                guest.shutdown().await.unwrap();
            };
            let client = async {
                client.write_all(&vec![0xa5; 512 * 1024]).await.unwrap();
                client.shutdown().await.unwrap();
                let mut reply = Vec::new();
                client.read_to_end(&mut reply).await.unwrap();
                assert_eq!(reply, vec![0x5a; 512 * 1024]);
            };
            tokio::join!(server, client);
        };
        tokio::time::timeout(CONNECT_TIMEOUT, transfer)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn ssh_forwarder_replaces_listener_and_revokes_connections_on_set() {
    let fixture = Fixture::new(true);
    let first = fixture.set("127.0.0.1:0").await;
    let (mut client, mut guest) = fixture.established(first).await;
    let second = fixture.set("127.0.0.1:0").await;
    assert_eq!(client.read(&mut [0]).await.unwrap(), 0);
    assert_eq!(guest.read(&mut [0]).await.unwrap(), 0);
    assert!(TcpStream::connect(first).await.is_err());

    let (mut client, mut guest) = fixture.established(second).await;
    fixture.client().set(None).await.unwrap();
    assert_eq!(fixture.client().get_socket_addr().await.unwrap(), None);
    assert_eq!(client.read(&mut [0]).await.unwrap(), 0);
    assert_eq!(guest.read(&mut [0]).await.unwrap(), 0);
    assert!(TcpStream::connect(second).await.is_err());
    // Forwarding control never closes or unlinks the independent Unix bridge.
    let mut direct = UnixStream::connect(fixture.sockets.ssh_sock())
        .await
        .unwrap();
    let mut guest = fixture.raw.accept().await.unwrap().0;
    direct.write_all(b"x").await.unwrap();
    let mut byte = [0];
    guest.read_exact(&mut byte).await.unwrap();
    assert_eq!(&byte, b"x");
}

#[tokio::test]
async fn ssh_partial_control_frame_does_not_block_ingress() {
    let fixture = Fixture::new(true);
    let address = fixture.set("127.0.0.1:0").await;
    let mut stalled = UnixStream::connect(fixture.sockets.shim_sock())
        .await
        .unwrap();
    stalled.write_all(&[0, 0, 0]).await.unwrap();
    tokio::time::timeout(CONNECT_TIMEOUT, fixture.established(address))
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_forwarder_ip_permission_denies_tcp() {
    let fixture = Fixture::new(false);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let error = fixture
        .client()
        .set(Some((listener.into(), address)))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("security.network_enabled"));
    fixture.client().set(None).await.unwrap();
    assert_eq!(fixture.client().get_socket_addr().await.unwrap(), None);
    std::net::TcpListener::bind(address).expect("rejected descriptor leaked");
}

#[tokio::test]
async fn ssh_forwarder_connection_limit_closes_excess_stream_and_releases_on_disable() {
    let fixture = Fixture::new(true);
    let address = fixture.set("127.0.0.1:0").await;
    let mut streams = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        streams.push(fixture.established(address).await);
    }
    let mut excess = TcpStream::connect(address).await.unwrap();
    assert_eq!(
        tokio::time::timeout(CONNECT_TIMEOUT, excess.read(&mut [0]))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    fixture.client().set(None).await.unwrap();
    for (mut client, mut guest) in streams {
        assert_eq!(client.read(&mut [0]).await.unwrap(), 0);
        assert_eq!(guest.read(&mut [0]).await.unwrap(), 0);
    }
}

#[tokio::test]
async fn ssh_descriptor_validation_rejects_files_datagrams_connected_streams_and_wrong_endpoints() {
    let expected: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let file: OwnedFd = tempfile::tempfile().unwrap().into();
    assert!(Listener::from_fd(file, &expected).is_err());
    let datagram: OwnedFd = std::net::UdpSocket::bind(expected).unwrap().into();
    assert!(Listener::from_fd(datagram, &expected).is_err());
    let (stream, _) = std::os::unix::net::UnixStream::pair().unwrap();
    assert!(Listener::from_fd(stream.into(), &expected).is_err());
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let unix = std::os::unix::net::UnixListener::bind(home.path().join("foreign.sock")).unwrap();
    assert!(Listener::from_fd(unix.into(), &expected).is_err());
    let listener = std::net::TcpListener::bind(expected).unwrap();
    assert!(Listener::from_fd(listener.into(), &"127.0.0.2:0".parse().unwrap()).is_err());
    let listener = std::net::TcpListener::bind(expected).unwrap();
    // The wire carries the actual endpoint; port zero is no longer a wildcard.
    assert!(Listener::from_fd(listener.into(), &expected).is_err());
    let listener = std::net::TcpListener::bind(expected).unwrap();
    let stream = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    assert!(Listener::from_fd(stream.into(), &expected).is_err());
}

#[tokio::test]
async fn ssh_forwarder_finished_task_has_no_address() {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let mut forwarder = SshForwarder::new(home.path().join("guest.sock"));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    forwarder
        .set(Some((listener.into(), address)))
        .await
        .unwrap();
    assert_eq!(forwarder.get_socket_addr(), Some(address));
    let listening = forwarder.listening.as_mut().unwrap();
    listening.shutdown.cancel();
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        while !listening.task.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(forwarder.get_socket_addr(), None);
    forwarder.set(None).await.unwrap();
}

#[tokio::test]
async fn ssh_shim_shutdown_joins_services_and_closes_streams_and_socket() {
    let mut fixture = Fixture::new(true);
    let address = fixture.set("127.0.0.1:0").await;
    let (mut client, mut guest) = fixture.established(address).await;
    fixture.forwarder.take();
    assert!(!fixture.sockets.shim_sock().exists());
    assert_eq!(client.read(&mut [0]).await.unwrap(), 0);
    assert_eq!(guest.read(&mut [0]).await.unwrap(), 0);
    assert!(TcpStream::connect(address).await.is_err());
}
