//! Public GuestSession archive-file methods remain available and stream bytes.
#![cfg(unix)]

use boxlite::GuestSession;
use boxlite_shared::{
    BoxTransport, DownloadChunk, DownloadRequest, Files, FilesServer, UploadChunk, UploadResponse,
};
use std::io::Write;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, oneshot};
use tonic::{Request, Response, Status, Streaming};

#[derive(Clone)]
struct ArchivePeer {
    received: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    bytes: Arc<Mutex<Vec<u8>>>,
}

#[tonic::async_trait]
impl Files for ArchivePeer {
    async fn upload(
        &self,
        request: Request<Streaming<UploadChunk>>,
    ) -> Result<Response<UploadResponse>, Status> {
        let mut stream = request.into_inner();
        let mut bytes = Vec::new();
        let mut first = true;
        while let Some(chunk) = stream.message().await? {
            assert_eq!(chunk.dest_path, if first { "/target" } else { "" });
            assert_eq!(chunk.container_id, "container");
            assert!(!chunk.mkdir_parents && !chunk.overwrite);
            if first {
                first = false;
                let _ = self.received.lock().await.take().unwrap().send(());
            }
            bytes.extend_from_slice(&chunk.data);
        }
        *self.bytes.lock().await = bytes;
        Ok(Response::new(UploadResponse {
            success: true,
            error: None,
        }))
    }

    type DownloadStream =
        Pin<Box<dyn futures::Stream<Item = Result<DownloadChunk, Status>> + Send>>;

    async fn download(
        &self,
        request: Request<DownloadRequest>,
    ) -> Result<Response<Self::DownloadStream>, Status> {
        let request = request.into_inner();
        assert_eq!(request.src_path, "/source/.");
        assert_eq!(request.container_id, "container");
        assert!(!request.include_parent && request.follow_symlinks);
        let chunk = DownloadChunk {
            data: self.bytes.lock().await.clone(),
        };
        Ok(Response::new(Box::pin(futures::stream::iter([Ok(chunk)]))))
    }
}

#[tokio::test]
async fn archive_file_upload_streams_before_source_eof() {
    let tmp = tempfile::tempdir().unwrap();
    let payload = tmp.path().join("payload");
    std::fs::write(&payload, vec![42; 2 << 20]).unwrap();
    let archive = tmp.path().join("input.tar");
    boxlite_shared::tar::pack(
        payload,
        archive.clone(),
        boxlite_shared::tar::PackContext {
            follow_symlinks: false,
            include_parent: true,
        },
    )
    .await
    .unwrap();
    let expected = std::fs::read(&archive).unwrap();
    let input = tmp.path().join("archive.fifo");
    nix::unistd::mkfifo(
        &input,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let fifo = input.clone();
    let bytes = expected.clone();
    let writer = std::thread::spawn(move || {
        let mut file = std::fs::OpenOptions::new().write(true).open(fifo).unwrap();
        file.write_all(&bytes[..1 << 20]).unwrap();
        let _ = release_rx.blocking_recv();
        file.write_all(&bytes[1 << 20..]).unwrap();
    });

    let (received_tx, received_rx) = oneshot::channel();
    let peer = ArchivePeer {
        received: Arc::new(Mutex::new(Some(received_tx))),
        bytes: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let incoming = futures::stream::unfold(listener, |listener| async move {
        let accepted = listener.accept().await.map(|(socket, _)| socket);
        Some((accepted, listener))
    });
    let server = tokio::spawn(
        tonic::transport::Server::builder()
            .add_service(FilesServer::new(peer))
            .serve_with_incoming(incoming),
    );
    let session = GuestSession::new(BoxTransport::tcp(port));
    let mut files = session.files().await.unwrap();
    let upload = tokio::spawn(async move {
        files
            .upload_tar(&input, "/target", Some("container"), false, false)
            .await
    });
    let progress = tokio::time::timeout(Duration::from_secs(2), received_rx).await;
    let _ = release_tx.send(());
    upload.await.unwrap().unwrap();
    writer.join().unwrap();

    let output = tmp.path().join("output.tar");
    session
        .files()
        .await
        .unwrap()
        .download_tar("/source/.", Some("container"), true, &output)
        .await
        .unwrap();
    let mut files = session.files().await.unwrap();
    for source in [tmp.path().to_path_buf(), tmp.path().join("missing.tar")] {
        let error = files
            .upload_tar(&source, "/target", Some("container"), false, false)
            .await
            .unwrap_err();
        assert!(matches!(error, boxlite_shared::BoxliteError::Storage(_)));
    }
    server.abort();
    assert!(
        progress.is_ok(),
        "upload_tar waited for the whole archive before sending its first chunk"
    );
    assert_eq!(std::fs::read(output).unwrap(), expected);
}
