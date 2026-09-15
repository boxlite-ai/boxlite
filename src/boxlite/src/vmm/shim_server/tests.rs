use super::ipc::ControlChannel;
use super::*;
use crate::vmm::ssh_forwarder::tests::Fixture;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};

#[tokio::test]
async fn ssh_control_rejects_missing_and_extra_descriptors_and_closes_received_fds() {
    let (left, right) = UnixStream::pair().unwrap();
    let mut left = ControlChannel(left);
    let mut right = ControlChannel(right);
    left.0.write_all(&[1]).await.unwrap();
    assert!(right.receive::<Request>().await.is_err());

    let (left, right) = UnixStream::pair().unwrap();
    let left = ControlChannel(left);
    let mut right = ControlChannel(right);
    let one = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let two = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addresses = [one.local_addr().unwrap(), two.local_addr().unwrap()];
    left.send_descriptors(&[one.as_raw_fd(), two.as_raw_fd()])
        .await
        .unwrap();
    drop((one, two));
    assert!(right.receive::<Request>().await.is_err());
    for address in addresses {
        std::net::TcpListener::bind(address)
            .expect("rejected SCM_RIGHTS descriptor leaked its listener");
    }
}

#[tokio::test]
async fn ssh_control_rejects_malformed_frames_and_releases_fds() {
    for (length, body, expected) in [
        (0, &b""[..], io::ErrorKind::InvalidData),
        (1024 * 1024 + 1, &b""[..], io::ErrorKind::InvalidData),
        (10, &b"{"[..], io::ErrorKind::UnexpectedEof),
        (6, &b"secret"[..], io::ErrorKind::InvalidData),
    ] {
        let (sender, receiver) = UnixStream::pair().unwrap();
        let mut sender = ControlChannel(sender);
        let mut receiver = ControlChannel(receiver);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let descriptor: OwnedFd = listener.into();
        sender
            .send_descriptors(&[descriptor.as_raw_fd()])
            .await
            .unwrap();
        drop(descriptor);
        sender.0.write_u32(length).await.unwrap();
        sender.0.write_all(body).await.unwrap();
        sender.0.shutdown().await.unwrap();
        let error = receiver.receive::<serde_json::Value>().await.unwrap_err();
        assert_eq!(error.kind(), expected);
        assert!(!error.to_string().contains("secret"));
        std::net::TcpListener::bind(address).expect("rejected frame leaked its descriptor");
    }
}

#[tokio::test]
async fn ssh_control_rejects_unexpected_descriptors_without_leaking() {
    let fixture = Fixture::new(true);
    for request in [
        Request::SetSshForwarding { address: None },
        Request::GetSshSocketAddr,
    ] {
        let mut channel = ControlChannel(
            UnixStream::connect(fixture.sockets.shim_sock())
                .await
                .unwrap(),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let descriptor: OwnedFd = listener.into();
        channel.send(&request, Some(&descriptor)).await.unwrap();
        drop(descriptor);
        let (response, received): (Response, _) = channel.receive().await.unwrap();
        let Response::Error { error } = response else {
            panic!("expected descriptor rejection")
        };
        assert!(error.contains("unexpected descriptor"));
        assert!(received.is_none());
        // A subsequent request ensures the previous control future has returned.
        fixture.client().get_socket_addr().await.unwrap();
        std::net::TcpListener::bind(address).expect("rejected request leaked its descriptor");
    }
}

#[tokio::test(start_paused = true)]
async fn ssh_control_client_timeout_is_bounded() {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let sockets = BoxSockets::new(
        format!("timeout-{}", uuid::Uuid::new_v4()),
        home.path().to_owned(),
    );
    sockets.ensure().unwrap();
    let listener = UnixListener::bind(sockets.shim_sock()).unwrap();
    let server = tokio::spawn(async move {
        let _stream = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let error = ShimClient::new(&sockets)
        .get_socket_addr()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error}");
    server.abort();
    sockets.remove();
}
