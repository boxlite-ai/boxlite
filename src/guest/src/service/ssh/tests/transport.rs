use super::*;
use tokio::net::UnixStream;
use tokio_vsock::{VMADDR_CID_HOST, VMADDR_CID_LOCAL};

// Unix pairs exercise the production stream admission/session boundary on
// Linux without requiring a host vsock device. CID selection is tested too.
async fn ingress(guest: &TestGuest, cid: u32) -> UnixStream {
    let (client, server) = UnixStream::pair().unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        guest
            .guest
            .ssh_manager
            .spawn_connection(server, ConnectionOrigin::Vsock(VsockAddr::new(cid, 1234))),
    )
    .await
    .expect("admission must not wait for SSH identification");
    client
}

async fn host_client(guest: &TestGuest, host: &PrivateKey) -> russh::client::Handle<CheckHostKey> {
    tokio::time::timeout(
        Duration::from_secs(5),
        russh::client::connect_stream(
            Arc::new(russh::client::Config::default()),
            ingress(guest, VMADDR_CID_HOST).await,
            CheckHostKey(host.public_key().clone()),
        ),
    )
    .await
    .unwrap()
    .unwrap()
}

#[tokio::test]
async fn ssh_dedicated_none_authentication_and_forwarding_leave_tcp_authenticated() {
    let mut guest = TestGuest::new().await;
    let host = private_key();
    let address = guest.start(config(&host, &[&private_key()], None)).await;
    let mut tcp = connect(address, &host).await;
    assert!(!tcp.authenticate_none("root").await.unwrap().success());
    let mut client = host_client(&guest, &host).await;
    assert!(client
        .authenticate_none("not-a-configured-account")
        .await
        .unwrap()
        .success());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let channel = client
        .channel_open_direct_tcpip(
            "127.0.0.1",
            listener.local_addr().unwrap().port() as u32,
            "127.0.0.1",
            0,
        )
        .await
        .unwrap();
    let payload = vec![0xa5; 128 * 1024];
    tokio::time::timeout(Duration::from_secs(5), async {
        let traffic = async {
            let mut stream = channel.into_stream();
            stream.write_all(&payload).await.unwrap();
            stream.shutdown().await.unwrap();
            let mut reply = Vec::new();
            stream.read_to_end(&mut reply).await.unwrap();
            assert_eq!(reply, payload);
        };
        let target = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, payload);
            socket.write_all(&bytes).await.unwrap();
            socket.shutdown().await.unwrap();
        };
        tokio::join!(traffic, target);
    })
    .await
    .expect("forwarded reply after EOF must complete");
    guest
        .configure(config(&host, &[&private_key()], None))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), client)
        .await
        .expect("reconfigure closes trusted sessions")
        .ok();
    drop(tcp);
    guest.stop().await;
}

#[tokio::test]
async fn ssh_dedicated_silent_handshake_does_not_block_control_or_disable() {
    let mut guest = TestGuest::new().await;
    let host = private_key();
    guest.start(config(&host, &[&private_key()], None)).await;
    let mut silent = ingress(&guest, VMADDR_CID_HOST).await;
    assert!(
        tokio::time::timeout(Duration::from_secs(2), guest.status())
            .await
            .unwrap()
            .enabled
    );
    let mut client = host_client(&guest, &host).await;
    assert!(client.authenticate_none("ignored").await.unwrap().success());
    guest
        .guest
        .ssh_manager
        .control(Some(false), None)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), client)
        .await
        .expect("disable closes trusted session")
        .ok();
    let mut banner = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), silent.read_to_end(&mut banner))
        .await
        .unwrap()
        .unwrap();
    assert!(banner.starts_with(b"SSH-2.0-"));
    assert!(!guest.status().await.enabled);
    let mut disabled = ingress(&guest, VMADDR_CID_HOST).await;
    assert_eq!(disabled.read(&mut [0; 1]).await.unwrap(), 0);
    guest.stop().await;
}

#[tokio::test]
async fn ssh_dedicated_rejects_guest_cids_before_sending_identification() {
    let mut guest = TestGuest::new().await;
    guest
        .start(config(&private_key(), &[&private_key()], None))
        .await;
    for cid in [VMADDR_CID_LOCAL, 42, VMADDR_CID_ANY] {
        let mut client = ingress(&guest, cid).await;
        assert_eq!(client.read(&mut [0; 1]).await.unwrap(), 0);
        assert_eq!(
            guest
                .guest
                .ssh_manager
                .connection_permits
                .available_permits(),
            limits::MAX_CONNECTIONS
        );
    }
    guest.stop().await;
}
