use super::connect_unix;
use boxlite_shared::{Ssh, SshClient, SshControlRequest, SshControlResponse, SshServer};
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::{UnixListener, UnixStream};
use tokio::time::Instant;
use tonic::{Request, Response, Status};

struct Control;

#[tonic::async_trait]
impl Ssh for Control {
    async fn control(
        &self,
        _: Request<SshControlRequest>,
    ) -> Result<Response<SshControlResponse>, Status> {
        Ok(Response::new(SshControlResponse::default()))
    }
}

async fn assert_connects_when_listener_appears(path: PathBuf) {
    let connect_path = path.clone();
    let connection = tokio::spawn(async move { connect_unix(&connect_path).await });

    // Virtual time advances only after runnable work has drained, so the
    // connector encounters the missing/refused socket before it can listen.
    tokio::time::sleep(Duration::from_millis(100)).await;
    tokio::time::resume();

    if path.exists() {
        std::fs::remove_file(&path).unwrap();
    }
    let listener = UnixListener::bind(&path).unwrap();
    let incoming = futures::stream::unfold(listener, |listener| async {
        Some((listener.accept().await.map(|(stream, _)| stream), listener))
    });
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(SshServer::new(Control))
            .serve_with_incoming_shutdown(incoming, async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });

    let channel = tokio::time::timeout(Duration::from_secs(2), connection)
        .await
        .expect("listener readiness must complete promptly")
        .unwrap()
        .expect("a listener appearing within the connection deadline must connect");
    SshClient::new(channel)
        .control(SshControlRequest::default())
        .await
        .expect("the recovered connection must carry a real RPC");
    stop.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn unix_connect_waits_for_missing_socket() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("control.sock");
    assert_eq!(
        UnixStream::connect(&path).await.unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );
    assert_connects_when_listener_appears(path).await;
}

#[tokio::test(start_paused = true)]
async fn unix_connect_waits_for_refused_socket() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("control.sock");
    drop(UnixListener::bind(&path).unwrap());
    assert_eq!(
        UnixStream::connect(&path).await.unwrap_err().kind(),
        std::io::ErrorKind::ConnectionRefused
    );
    assert_connects_when_listener_appears(path).await;
}

#[tokio::test(start_paused = true)]
async fn unix_connect_missing_socket_obeys_connection_deadline() {
    let home = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let result = connect_unix(&home.path().join("missing.sock")).await;
    assert!(result.is_err());
    assert!(
        started.elapsed() >= Duration::from_secs(30),
        "a transient failure must wait for the configured connection deadline"
    );
    assert!(started.elapsed() < Duration::from_secs(31));
}

#[tokio::test(start_paused = true)]
async fn unix_connect_invalid_path_fails_without_retrying() {
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join("not-a-directory");
    std::fs::write(&file, b"").unwrap();
    let started = Instant::now();
    let result = connect_unix(&file.join("control.sock")).await;
    assert!(result.is_err());
    assert_eq!(started.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn unix_connect_cancellation_stops_waiting() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("control.sock");
    let connect_path = path.clone();
    let connection = tokio::spawn(async move { connect_unix(&connect_path).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    connection.abort();
    assert!(connection.await.unwrap_err().is_cancelled());

    let listener = UnixListener::bind(&path).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), listener.accept())
            .await
            .is_err(),
        "a cancelled connection must not retry when the socket appears"
    );
}
