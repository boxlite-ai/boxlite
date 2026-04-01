//! Files service interface.
//!
//! Provides tar-based upload/download to the guest container rootfs.

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
        let dest = dest_path.to_string();
        let cid = container_id.unwrap_or_default().to_string();

        // Read entire tar file and build chunks
        // Note: For very large files, consider streaming with async_stream crate
        let mut file = File::open(tar_path)
            .await
            .map_err(|e| BoxliteError::Storage(format!("Failed to open tar file: {}", e)))?;

        let mut chunks = Vec::new();
        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut first = true;

        loop {
            match file.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = UploadChunk {
                        dest_path: if first { dest.clone() } else { String::new() },
                        container_id: cid.clone(),
                        data: buf[..n].to_vec(),
                        mkdir_parents,
                        overwrite,
                    };
                    first = false;
                    chunks.push(chunk);
                }
                Err(e) => {
                    return Err(BoxliteError::Storage(format!(
                        "Failed to read tar file: {}",
                        e
                    )));
                }
            }
        }

        // Use futures::stream::iter for the upload stream
        let stream = futures::stream::iter(chunks);

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

fn map_tonic_err(err: tonic::Status) -> BoxliteError {
    BoxliteError::Internal(err.to_string())
}
