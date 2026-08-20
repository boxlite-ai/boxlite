//! Files service interface.
//!
//! Provides tar-based upload/download to the guest container rootfs. The tar
//! bytes are streamed end-to-end (no whole-file memory buffer, no temp file),
//! bridged through `boxlite_shared::tar::{pack_stream, unpack_stream}`.

use async_stream::stream;
use boxlite_shared::{BoxliteError, BoxliteResult, DownloadRequest, FilesClient, UploadChunk};
use futures::{Stream, StreamExt};
use std::io;
use std::pin::Pin;
use tonic::transport::Channel;

/// Files service interface.
pub struct FilesInterface {
    client: FilesClient<Channel>,
}

impl FilesInterface {
    /// Create from a channel.
    pub fn new(channel: Channel) -> Self {
        Self {
            client: FilesClient::new(channel),
        }
    }

    /// Upload a tar byte stream to the guest and extract at `dest_path`.
    ///
    /// `tar` is a stream of raw tar bytes (from
    /// `boxlite_shared::tar::pack_stream`). `is_directory` is the packer's
    /// archive-shape hint, carried on the first chunk only.
    pub async fn upload_tar_stream(
        &mut self,
        dest_path: &str,
        container_id: Option<&str>,
        mkdir_parents: bool,
        overwrite: bool,
        is_directory: bool,
        mut tar: boxlite_shared::tar::PackStream,
    ) -> BoxliteResult<()> {
        let dest = dest_path.to_string();
        let cid = container_id.unwrap_or_default().to_string();

        let stream = stream! {
            let mut first = true;
            while let Some(chunk) = tar.next().await {
                match chunk {
                    Ok(data) => {
                        yield UploadChunk {
                            dest_path: if first { dest.clone() } else { String::new() },
                            container_id: cid.clone(),
                            data,
                            mkdir_parents,
                            overwrite,
                            is_directory: if first { Some(is_directory) } else { None },
                        };
                        first = false;
                    }
                    Err(e) => {
                        // Host-side pack failure mid-stream. End the stream; the
                        // guest aborts on the truncated archive and surfaces the
                        // error through the upload response.
                        tracing::warn!(error = %e, "tar pack failed mid-upload; aborting stream");
                        return;
                    }
                }
            }
        };

        let response = self
            .client
            .upload(stream)
            .await
            .map_err(map_tonic_err)?
            .into_inner();

        if response.success {
            Ok(())
        } else {
            Err(BoxliteError::Internal(
                response.error.unwrap_or_else(|| "Upload failed".into()),
            ))
        }
    }

    /// Download a path from the guest as a tar byte stream.
    ///
    /// Returns the archive-shape hint (`is_directory`, `None` when the guest
    /// predates it) plus a stream of raw tar bytes. The caller decides whether
    /// to stream-unpack directly or fall back to legacy temp-file unpack.
    pub async fn download_tar_stream(
        &mut self,
        container_src: &str,
        container_id: Option<&str>,
        include_parent: bool,
        follow_symlinks: bool,
    ) -> BoxliteResult<(
        Option<bool>,
        Pin<Box<dyn Stream<Item = io::Result<Vec<u8>>> + Send>>,
    )> {
        let request = DownloadRequest {
            src_path: container_src.to_string(),
            container_id: container_id.unwrap_or_default().to_string(),
            include_parent,
            follow_symlinks,
        };

        let mut stream = self
            .client
            .download(request)
            .await
            .map_err(map_tonic_err)?
            .into_inner();

        // The first chunk carries the archive-shape hint (and its data).
        let (is_directory, first_data) = match stream.message().await.map_err(map_tonic_err)? {
            Some(chunk) => (chunk.is_directory, chunk.data),
            None => (None, Vec::new()),
        };

        let rest = stream.map(|r| {
            r.map(|c| c.data)
                .map_err(|e| io::Error::other(e.message()))
        });
        let bytes = futures::stream::once(async move { Ok::<Vec<u8>, io::Error>(first_data) })
            .chain(rest);

        Ok((is_directory, Box::pin(bytes)))
    }
}

fn map_tonic_err(err: tonic::Status) -> BoxliteError {
    BoxliteError::Internal(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite_shared::{
        files_server::{Files, FilesServer},
        DownloadChunk, DownloadRequest, UploadChunk, UploadResponse,
    };
    use futures::StreamExt;
    use std::net::SocketAddr;
    use tokio::task::JoinHandle;
    use tokio_stream::wrappers::ReceiverStream;
    use tonic::transport::Server;
    use tonic::{Request, Response, Status, Streaming};

    /// Mock `Files` service. `is_directory` is what the (mock) guest reports
    /// on its download chunks — `None` simulates an old guest that predates
    /// the archive-shape hint.
    struct MockFiles {
        is_directory: Option<bool>,
        data: Vec<u8>,
    }

    #[tonic::async_trait]
    impl Files for MockFiles {
        async fn upload(
            &self,
            _request: Request<Streaming<UploadChunk>>,
        ) -> Result<Response<UploadResponse>, Status> {
            Ok(Response::new(UploadResponse {
                success: true,
                error: None,
            }))
        }

        type DownloadStream = ReceiverStream<Result<DownloadChunk, Status>>;

        async fn download(
            &self,
            _request: Request<DownloadRequest>,
        ) -> Result<Response<Self::DownloadStream>, Status> {
            let (tx, rx) = tokio::sync::mpsc::channel(4);
            let is_directory = self.is_directory;
            let data = self.data.clone();
            tokio::spawn(async move {
                let _ = tx.send(Ok(DownloadChunk { data, is_directory })).await;
            });
            Ok(Response::new(ReceiverStream::new(rx)))
        }
    }

    async fn start_mock(is_directory: Option<bool>, data: Vec<u8>) -> (SocketAddr, JoinHandle<()>) {
        let svc = FilesServer::new(MockFiles {
            is_directory,
            data,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let incoming =
            tonic::transport::server::TcpIncoming::from_listener(listener, true, None).unwrap();
        let server = tokio::spawn(async move {
            Server::builder()
                .add_service(svc)
                .serve_with_incoming(incoming)
                .await
                .unwrap();
        });
        (address, server)
    }

    async fn download(addr: SocketAddr) -> (Option<bool>, Vec<u8>) {
        let channel = tonic::transport::Endpoint::from_shared(format!("http://{addr}"))
            .unwrap()
            .connect()
            .await
            .unwrap();
        let mut iface = FilesInterface::new(channel);
        let (is_directory, mut stream) = iface
            .download_tar_stream("/some/path", None, true, false)
            .await
            .unwrap();
        let mut data = Vec::new();
        while let Some(chunk) = stream.next().await {
            data.extend_from_slice(&chunk.unwrap());
        }
        (is_directory, data)
    }

    #[tokio::test]
    async fn new_guest_reports_is_directory() {
        let (addr, server) = start_mock(Some(false), b"tar-bytes".to_vec()).await;
        let (is_directory, data) = download(addr).await;
        assert_eq!(is_directory, Some(false));
        assert_eq!(data, b"tar-bytes");
        server.abort();
    }

    #[tokio::test]
    async fn old_guest_omits_is_directory() {
        let (addr, server) = start_mock(None, b"tar-bytes".to_vec()).await;
        let (is_directory, data) = download(addr).await;
        assert_eq!(is_directory, None);
        assert_eq!(data, b"tar-bytes");
        server.abort();
    }
}
