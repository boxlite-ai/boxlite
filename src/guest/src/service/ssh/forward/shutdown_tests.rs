use super::*;

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
