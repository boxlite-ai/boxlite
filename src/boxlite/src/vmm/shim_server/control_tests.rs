use super::*;
use std::os::fd::AsRawFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

#[tokio::test]
async fn shim_control_connection_limit_and_shutdown_release_partial_frames() {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let path = home.path().join("shim.sock");
    let server = ControlServer::bind(path.clone(), true).unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let forwarder = Arc::new(Mutex::new(SshForwarder::new("unused.sock".into())));
    let shutdown = CancellationToken::new();
    let mut serving = Box::pin(server.run(forwarder, shutdown.clone()));
    let mut clients = Vec::new();
    let mut addresses = Vec::new();
    for _ in 0..MAX_CONTROL_CONNECTIONS {
        let stream = UnixStream::connect(&path).await.unwrap();
        let mut channel = ControlChannel(stream);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        addresses.push(listener.local_addr().unwrap());
        channel
            .send_descriptors(&[listener.as_raw_fd()])
            .await
            .unwrap();
        drop(listener);
        channel.0.write_all(&[0, 0]).await.unwrap();
        clients.push(channel);
        assert!(futures::poll!(&mut serving).is_pending());
    }
    let mut excess = UnixStream::connect(&path).await.unwrap();
    let mut byte = [0];
    tokio::select! {
        _ = &mut serving => panic!("control server stopped"),
        result = tokio::time::timeout(CONNECT_TIMEOUT, excess.read(&mut byte)) => {
            assert_eq!(result.unwrap().unwrap(), 0, "excess control connection stayed open");
        }
    }
    shutdown.cancel();
    serving.await.unwrap();
    drop(server);
    assert!(!path.exists());
    // Do not close the senders first: both queued ancillary rights and decoded
    // descriptors must have been released by the server's shutdown.
    for address in addresses {
        std::net::TcpListener::bind(address).expect("shutdown leaked a partial frame FD");
    }
    for mut channel in clients {
        let result = channel.0.read(&mut [0]).await;
        assert!(matches!(result, Ok(0)) || result.is_err());
    }
}

#[tokio::test(start_paused = true)]
async fn shim_control_receive_timeout_releases_descriptor() {
    let (client, server) = UnixStream::pair().unwrap();
    let client = ControlChannel(client);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    client
        .send_descriptors(&[listener.as_raw_fd()])
        .await
        .unwrap();
    drop(listener);
    let forwarder = Arc::new(Mutex::new(SshForwarder::new("unused.sock".into())));
    let start = tokio::time::Instant::now();
    let result = ControlServer::respond(ControlChannel(server), forwarder, true).await;
    assert!(result.is_err());
    assert_eq!(start.elapsed(), CONNECT_TIMEOUT);
    std::net::TcpListener::bind(address).expect("read timeout leaked descriptor");
}

#[tokio::test]
async fn shim_control_bind_preserves_files_and_symlinks() {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let path = home.path().join("shim.sock");
    std::fs::write(&path, b"owned by caller").unwrap();
    assert!(ControlServer::bind(path.clone(), true).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"owned by caller");
    let link = home.path().join("link.sock");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(ControlServer::bind(link.clone(), true).is_err());
    assert!(
        std::fs::symlink_metadata(link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
