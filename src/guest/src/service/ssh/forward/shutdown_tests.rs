use super::*;

#[tokio::test]
async fn cancel_pending_reverse_channel_without_waiting_for_confirmation() {
    use super::super::forwarding_fixture::{completes, ForwardingSession};
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    let root = tempfile::tempdir().unwrap();
    let guest = Arc::new(crate::service::server::GuestServer::new(
        crate::layout::GuestLayout::with_base(root.path()),
    ));
    let tasks = Arc::new(super::super::TaskGroup::default());
    let mut ssh = ForwardingSession::new(guest, tasks.clone()).await;
    let mut manager = ForwardingManager::new(tasks.clone());
    let mut port = 0;
    assert!(
        manager
            .listen_tcpip("127.0.0.1", &mut port, ssh.handle.clone())
            .await
    );
    let mut sibling_port = 0;
    assert!(
        manager
            .listen_tcpip("127.0.0.1", &mut sibling_port, ssh.handle.clone())
            .await
    );
    let mut sockets = Vec::new();
    let mut opens = Vec::new();
    for _ in 0..3 {
        sockets.push(
            TcpStream::connect(("127.0.0.1", port as u16))
                .await
                .unwrap(),
        );
        opens.push(completes(ssh.channels.recv()).await.unwrap());
    }
    let cancelled = tokio::time::timeout(
        Duration::from_secs(5),
        manager.cancel_tcpip("127.0.0.1", port),
    )
    .await;
    // Clean up even on the old implementation before reporting the defect.
    if cancelled.is_err() {
        drop(opens);
        ssh.close().await;
        completes(tasks.wait()).await;
        panic!("listener cancellation waited for unconfirmed channel instead of cancelling it");
    }
    assert!(cancelled.unwrap());
    assert_eq!(
        manager.connection_permits.available_permits(),
        MAX_FORWARD_CONNECTIONS
    );
    for tcp in &mut sockets {
        assert_eq!(completes(tcp.read(&mut [0])).await.unwrap(), 0);
    }
    let replacement = TcpListener::bind(("127.0.0.1", port as u16)).await.unwrap();
    // A later successful open proves SSH processed the late confirmations.
    // None of those confirmations may revive a cancelled TCP relay.
    for opened in opens {
        opened.reply.accept().await;
    }
    let mut sibling_tcp = TcpStream::connect(("127.0.0.1", sibling_port as u16))
        .await
        .unwrap();
    let sibling = completes(ssh.channels.recv()).await.unwrap();
    sibling.reply.accept().await;
    let mut sibling_channel = sibling.channel.into_stream();
    use tokio::io::AsyncWriteExt;
    sibling_tcp.write_all(b"alive").await.unwrap();
    let mut received = [0; 5];
    completes(sibling_channel.read_exact(&mut received))
        .await
        .unwrap();
    assert_eq!(&received, b"alive");
    assert_eq!(
        manager.connection_permits.available_permits(),
        MAX_FORWARD_CONNECTIONS - 1
    );
    ssh.close().await;
    completes(tasks.wait()).await;
    drop(replacement);
}

#[tokio::test]
async fn established_reverse_channel_survives_listener_cancel_until_disconnect() {
    use super::super::forwarding_fixture::{completes, ForwardingSession};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    completes(async {
        let root = tempfile::tempdir().unwrap();
        let guest = Arc::new(crate::service::server::GuestServer::new(
            crate::layout::GuestLayout::with_base(root.path()),
        ));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let mut ssh = ForwardingSession::new(guest, tasks.clone()).await;
        let mut manager = ForwardingManager::new(tasks.clone());
        let mut port = 0;
        assert!(
            manager
                .listen_tcpip("127.0.0.1", &mut port, ssh.handle.clone())
                .await
        );
        let mut tcp = TcpStream::connect(("127.0.0.1", port as u16))
            .await
            .unwrap();
        let opened = ssh.channels.recv().await.unwrap();
        assert_eq!(opened.address, "127.0.0.1");
        opened.reply.accept().await;
        let mut channel = opened.channel.into_stream();
        tcp.write_all(b"before").await.unwrap();
        let mut before = [0; 6];
        channel.read_exact(&mut before).await.unwrap();
        assert_eq!(&before, b"before");
        assert!(manager.cancel_tcpip("127.0.0.1", port).await);
        assert!(TcpStream::connect(("127.0.0.1", port as u16))
            .await
            .is_err());
        tcp.write_all(b"after").await.unwrap();
        tcp.shutdown().await.unwrap();
        let mut request = Vec::new();
        channel.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"after");
        channel.write_all(b"response").await.unwrap();
        let mut response = [0; 8];
        tcp.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"response");
        ssh.close().await;
        tasks.wait().await;
        assert_eq!(
            manager.connection_permits.available_permits(),
            MAX_FORWARD_CONNECTIONS
        );
        assert_eq!(tcp.read(&mut response).await.unwrap(), 0);
    })
    .await;
}
