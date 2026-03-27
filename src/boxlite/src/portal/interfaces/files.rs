//! Files service interface.
//!
//! Provides tar-based upload/download to the guest container rootfs.

use boxlite_shared::{BoxliteError, BoxliteResult, DownloadRequest, FilesClient, UploadChunk};
use tokio::fs::File;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::Channel;

const CHUNK_SIZE: usize = 1 << 20; // 1 MiB

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

    /// Upload a tar file to the guest and extract at dest_path.
    pub async fn upload_tar(
        &mut self,
        tar_path: &std::path::Path,
        dest_path: &str,
        container_id: Option<&str>,
        mkdir_parents: bool,
        overwrite: bool,
    ) -> BoxliteResult<()> {
        let dest = dest_path.to_string();
        let cid = container_id.unwrap_or_default().to_string();

        let file = File::open(tar_path)
            .await
            .map_err(|e| BoxliteError::Storage(format!("Failed to open tar file: {}", e)))?;

        // Stream chunks as they are read instead of buffering the entire file.
        // Bounded channel (capacity=4) limits peak memory to ~5 MiB.
        let (tx, rx) = tokio::sync::mpsc::channel::<UploadChunk>(4);

        let reader_handle = tokio::spawn(stream_file_chunks(
            file,
            dest,
            cid,
            mkdir_parents,
            overwrite,
            tx,
        ));

        let stream = ReceiverStream::new(rx);

        let upload_result = self.client.upload(stream).await;

        // Always join the reader task first — its error is the root cause when
        // both the reader and the gRPC call fail (e.g. read error causes the
        // stream to end, which causes the server to report failure).
        match reader_handle.await {
            Ok(Err(read_err)) => return Err(read_err),
            Err(join_err) => {
                return Err(BoxliteError::Internal(format!(
                    "Upload reader task failed: {}",
                    join_err
                )));
            }
            Ok(Ok(())) => {}
        }

        let response = upload_result.map_err(map_tonic_err)?.into_inner();

        if response.success {
            Ok(())
        } else {
            Err(BoxliteError::Internal(
                response.error.unwrap_or_else(|| "Upload failed".into()),
            ))
        }
    }

    /// Download a path from guest into a local tar file.
    pub async fn download_tar(
        &mut self,
        container_src: &str,
        container_id: Option<&str>,
        include_parent: bool,
        follow_symlinks: bool,
        tar_dest: &std::path::Path,
    ) -> BoxliteResult<()> {
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

        let mut file = File::create(tar_dest)
            .await
            .map_err(|e| BoxliteError::Storage(format!("Failed to create tar file: {}", e)))?;

        // Use explicit match for proper error handling
        loop {
            match stream.message().await {
                Ok(Some(chunk)) => {
                    file.write_all(&chunk.data).await.map_err(|e| {
                        BoxliteError::Storage(format!("Failed to write tar file: {}", e))
                    })?;
                }
                Ok(None) => break, // Stream ended
                Err(e) => return Err(map_tonic_err(e)),
            }
        }

        file.flush()
            .await
            .map_err(|e| BoxliteError::Storage(format!("Failed to flush tar file: {}", e)))?;

        Ok(())
    }
}

/// Read from `reader` in CHUNK_SIZE pieces and send each as an UploadChunk.
///
/// Only the first chunk carries `dest_path` and `container_id`; subsequent
/// chunks send empty strings so the receiver knows these from the initial
/// message.
async fn stream_file_chunks(
    mut reader: impl AsyncRead + Unpin + Send,
    mut dest_path: String,
    mut container_id: String,
    mkdir_parents: bool,
    overwrite: bool,
    tx: tokio::sync::mpsc::Sender<UploadChunk>,
) -> BoxliteResult<()> {
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut first = true;
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => return Ok(()),
            Ok(n) => {
                let chunk = UploadChunk {
                    dest_path: if first {
                        std::mem::take(&mut dest_path)
                    } else {
                        String::new()
                    },
                    container_id: if first {
                        std::mem::take(&mut container_id)
                    } else {
                        String::new()
                    },
                    data: buf[..n].to_vec(),
                    mkdir_parents,
                    overwrite,
                };
                first = false;
                if tx.send(chunk).await.is_err() {
                    return Err(BoxliteError::Internal(
                        "Upload stream closed before all data was sent".into(),
                    ));
                }
            }
            Err(e) => {
                return Err(BoxliteError::Storage(format!(
                    "Failed to read tar file: {}",
                    e
                )));
            }
        }
    }
}

fn map_tonic_err(err: tonic::Status) -> BoxliteError {
    BoxliteError::Internal(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tempfile::NamedTempFile;
    use tokio::io::ReadBuf;

    /// Helper: create a temp file with `size` bytes of repeating 0xAB.
    fn make_temp_file(size: usize) -> NamedTempFile {
        let mut tmp = NamedTempFile::new().unwrap();
        tmp.write_all(&vec![0xABu8; size]).unwrap();
        tmp.flush().unwrap();
        tmp
    }

    /// Reader that returns `fail_bytes` of data then an I/O error.
    struct FailingReader {
        remaining: usize,
    }

    impl AsyncRead for FailingReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.remaining == 0 {
                return Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "simulated disk failure",
                )));
            }
            let n = buf.remaining().min(self.remaining);
            buf.put_slice(&vec![0xCDu8; n]);
            self.remaining -= n;
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn test_stream_file_chunks_multi_chunk() {
        let tmp = make_temp_file(3 * CHUNK_SIZE); // 3 MiB → 3 chunks
        let file = File::open(tmp.path()).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<UploadChunk>(4);

        let handle = tokio::spawn(stream_file_chunks(
            file,
            "/dest".into(),
            "ctr1".into(),
            true,
            false,
            tx,
        ));

        let mut chunks = Vec::new();
        while let Some(chunk) = rx.recv().await {
            chunks.push(chunk);
        }
        handle.await.unwrap().unwrap();

        assert_eq!(chunks.len(), 3);
        // Only first chunk carries dest_path and container_id.
        assert_eq!(chunks[0].dest_path, "/dest");
        assert_eq!(chunks[0].container_id, "ctr1");
        assert!(chunks[1].dest_path.is_empty());
        assert!(chunks[1].container_id.is_empty());
        assert!(chunks[2].dest_path.is_empty());
        assert!(chunks[2].container_id.is_empty());
        // All chunks carry flags.
        for c in &chunks {
            assert!(c.mkdir_parents);
            assert!(!c.overwrite);
        }
        // Each full chunk is CHUNK_SIZE.
        assert_eq!(chunks[0].data.len(), CHUNK_SIZE);
        assert_eq!(chunks[1].data.len(), CHUNK_SIZE);
        assert_eq!(chunks[2].data.len(), CHUNK_SIZE);
    }

    #[tokio::test]
    async fn test_stream_file_chunks_single_chunk() {
        let tmp = make_temp_file(500); // 500 bytes → 1 chunk
        let file = File::open(tmp.path()).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<UploadChunk>(4);

        let handle = tokio::spawn(stream_file_chunks(
            file,
            "/single".into(),
            "c1".into(),
            true,
            true,
            tx,
        ));

        let mut chunks = Vec::new();
        while let Some(chunk) = rx.recv().await {
            chunks.push(chunk);
        }
        handle.await.unwrap().unwrap();

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].dest_path, "/single");
        assert_eq!(chunks[0].container_id, "c1");
        assert_eq!(chunks[0].data.len(), 500);
        assert!(chunks[0].mkdir_parents);
        assert!(chunks[0].overwrite);
    }

    #[tokio::test]
    async fn test_stream_file_chunks_partial_last_chunk() {
        let tmp = make_temp_file(CHUNK_SIZE + 100); // 1 MiB + 100 bytes → 2 chunks
        let file = File::open(tmp.path()).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<UploadChunk>(4);

        let handle = tokio::spawn(stream_file_chunks(
            file,
            "/dst".into(),
            String::new(),
            false,
            true,
            tx,
        ));

        let mut chunks = Vec::new();
        while let Some(chunk) = rx.recv().await {
            chunks.push(chunk);
        }
        handle.await.unwrap().unwrap();

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].data.len(), CHUNK_SIZE);
        assert_eq!(chunks[1].data.len(), 100);
    }

    #[tokio::test]
    async fn test_stream_file_chunks_empty_file() {
        let tmp = make_temp_file(0);
        let file = File::open(tmp.path()).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<UploadChunk>(4);

        let handle = tokio::spawn(stream_file_chunks(
            file,
            "/dst".into(),
            String::new(),
            false,
            false,
            tx,
        ));

        let mut chunks = Vec::new();
        while let Some(chunk) = rx.recv().await {
            chunks.push(chunk);
        }
        handle.await.unwrap().unwrap();

        assert!(chunks.is_empty());
    }

    #[tokio::test]
    async fn test_stream_file_chunks_receiver_dropped() {
        // When the receiver is dropped (simulating upload cancellation),
        // the reader should return an error indicating incomplete upload.
        let tmp = make_temp_file(10 * CHUNK_SIZE); // 10 MiB
        let file = File::open(tmp.path()).await.unwrap();
        let (tx, rx) = tokio::sync::mpsc::channel::<UploadChunk>(1);

        let handle = tokio::spawn(stream_file_chunks(
            file,
            "/dst".into(),
            String::new(),
            false,
            false,
            tx,
        ));

        // Drop receiver after reading one chunk.
        let mut rx = rx;
        let _first = rx.recv().await.unwrap();
        drop(rx);

        let result = handle.await.unwrap();
        assert!(result.is_err());
        match result.unwrap_err() {
            BoxliteError::Internal(msg) => {
                assert!(msg.contains("stream closed"), "got: {msg}");
            }
            other => panic!("Expected Internal error, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_stream_file_chunks_read_error() {
        // Simulate an I/O error after reading some data.
        let reader = FailingReader {
            remaining: CHUNK_SIZE,
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel::<UploadChunk>(4);

        let handle = tokio::spawn(stream_file_chunks(
            reader,
            "/dst".into(),
            String::new(),
            false,
            false,
            tx,
        ));

        // Consume whatever chunks arrive before the error.
        let mut chunks = Vec::new();
        while let Some(chunk) = rx.recv().await {
            chunks.push(chunk);
        }

        let result = handle.await.unwrap();
        assert!(result.is_err());
        match result.unwrap_err() {
            BoxliteError::Storage(msg) => {
                assert!(msg.contains("simulated disk failure"), "got: {msg}");
            }
            other => panic!("Expected Storage error, got: {other:?}"),
        }
        // Should have received the first chunk before the error.
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].data.len(), CHUNK_SIZE);
    }

    #[tokio::test]
    async fn test_stream_file_chunks_data_integrity() {
        // Write a recognisable pattern and verify it round-trips.
        let mut tmp = NamedTempFile::new().unwrap();
        let pattern: Vec<u8> = (0..=255u8).cycle().take(CHUNK_SIZE + 512).collect();
        tmp.write_all(&pattern).unwrap();
        tmp.flush().unwrap();

        let file = File::open(tmp.path()).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<UploadChunk>(4);

        let handle = tokio::spawn(stream_file_chunks(
            file,
            "/x".into(),
            String::new(),
            false,
            false,
            tx,
        ));

        let mut all_data = Vec::new();
        while let Some(chunk) = rx.recv().await {
            all_data.extend_from_slice(&chunk.data);
        }
        handle.await.unwrap().unwrap();

        assert_eq!(all_data, pattern);
    }

    #[tokio::test]
    async fn test_upload_tar_file_not_found() {
        // FilesInterface::upload_tar should return Storage error for missing file.
        // We can't fully run upload_tar without a gRPC server, but the file-open
        // check happens before any gRPC call.
        let bad_path = std::path::Path::new("/nonexistent/file.tar");

        // Create a dummy channel (won't be used since file open fails first).
        let channel = tonic::transport::Channel::from_static("http://[::1]:1").connect_lazy();
        let mut iface = FilesInterface::new(channel);

        let result = iface
            .upload_tar(bad_path, "/dest", None, false, false)
            .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        match &err {
            BoxliteError::Storage(msg) => {
                assert!(msg.contains("Failed to open tar file"), "got: {msg}");
            }
            other => panic!("Expected Storage error, got: {other:?}"),
        }
    }
}
