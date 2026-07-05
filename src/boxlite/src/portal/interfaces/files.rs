//! Files service interface.
//!
//! Provides tar-based upload/download to the guest container rootfs.

use std::io;
use std::sync::{Arc, Mutex};

use boxlite_shared::{BoxliteError, BoxliteResult, DownloadRequest, FilesClient, UploadChunk};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
        let file = File::open(tar_path)
            .await
            .map_err(|e| BoxliteError::Storage(format!("Failed to open tar file: {}", e)))?;

        let read_error = Arc::new(Mutex::new(None));
        let outbound = upload_chunks(
            file,
            UploadChunkFields {
                dest_path: dest_path.to_string(),
                container_id: container_id.unwrap_or_default().to_string(),
                mkdir_parents,
                overwrite,
            },
            Arc::clone(&read_error),
        );

        let upload_result = self.client.upload(outbound).await;

        if let Some(e) = read_error.lock().expect("read error mutex poisoned").take() {
            return Err(BoxliteError::Storage(format!(
                "Failed to read tar file during upload: {e}"
            )));
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

struct UploadChunkFields {
    dest_path: String,
    container_id: String,
    mkdir_parents: bool,
    overwrite: bool,
}

fn upload_chunks(
    mut file: File,
    fields: UploadChunkFields,
    read_error: Arc<Mutex<Option<io::Error>>>,
) -> impl futures::Stream<Item = UploadChunk> + Send + 'static {
    async_stream::stream! {
        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut is_first_chunk = true;

        loop {
            let n = match file.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    *read_error.lock().expect("read error mutex poisoned") = Some(e);
                    break;
                }
            };

            yield UploadChunk {
                dest_path: if is_first_chunk {
                    fields.dest_path.clone()
                } else {
                    String::new()
                },
                container_id: fields.container_id.clone(),
                data: buf[..n].to_vec(),
                mkdir_parents: fields.mkdir_parents,
                overwrite: fields.overwrite,
            };

            is_first_chunk = false;
        }
    }
}

fn map_tonic_err(err: tonic::Status) -> BoxliteError {
    BoxliteError::Internal(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[tokio::test]
    async fn upload_chunks_records_source_read_errors() {
        let dir = tempfile::tempdir().unwrap();
        let file = File::open(dir.path()).await.unwrap();
        let read_error = Arc::new(Mutex::new(None));
        let mut stream = Box::pin(upload_chunks(
            file,
            UploadChunkFields {
                dest_path: "/workspace".to_string(),
                container_id: "container-1".to_string(),
                mkdir_parents: true,
                overwrite: false,
            },
            Arc::clone(&read_error),
        ));

        assert!(stream.next().await.is_none());
        assert!(
            read_error
                .lock()
                .expect("read error mutex poisoned")
                .is_some()
        );
    }

    #[tokio::test]
    async fn upload_chunks_streams_file_with_metadata_only_on_first_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("payload.tar");
        let payload = vec![b'a'; CHUNK_SIZE + 7];
        tokio::fs::write(&tar_path, &payload).await.unwrap();

        let file = File::open(&tar_path).await.unwrap();
        let mut stream = Box::pin(upload_chunks(
            file,
            UploadChunkFields {
                dest_path: "/workspace".to_string(),
                container_id: "container-1".to_string(),
                mkdir_parents: true,
                overwrite: false,
            },
            Arc::new(Mutex::new(None)),
        ));

        let mut received = Vec::new();
        let mut chunk_index = 0;
        while let Some(chunk) = stream.next().await {
            if chunk_index == 0 {
                assert_eq!(chunk.dest_path, "/workspace");
                assert_eq!(chunk.container_id, "container-1");
                assert!(chunk.mkdir_parents);
                assert!(!chunk.overwrite);
            } else {
                assert_eq!(chunk.dest_path, "");
                assert_eq!(chunk.container_id, "container-1");
            }
            received.extend_from_slice(&chunk.data);
            chunk_index += 1;
        }

        assert!(chunk_index > 0);
        assert_eq!(received, payload);
    }
}
