//! Files service interface.
//!
//! Provides tar-based upload/download to the guest container rootfs.

use boxlite_shared::{
    BoxTarStream, BoxliteError, BoxliteResult, DownloadRequest, FilesClient, UploadChunk,
};
use futures::StreamExt;
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
                        source_is_dir: None,
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

    /// Upload a tar byte stream to the guest and extract at `dest_path`.
    ///
    /// `source_is_dir` is the archive shape (dir tree vs single file); `None`
    /// when the caller cannot tell — the guest then peeks the tar to decide
    /// extraction mode. It is attached to the first chunk only.
    pub async fn upload_tar_stream<S>(
        &mut self,
        tar: S,
        dest_path: &str,
        container_id: Option<&str>,
        mkdir_parents: bool,
        overwrite: bool,
        source_is_dir: Option<bool>,
    ) -> BoxliteResult<()>
    where
        S: futures::Stream<Item = std::io::Result<Vec<u8>>> + Send + 'static,
    {
        let dest = dest_path.to_string();
        let cid = container_id.unwrap_or_default().to_string();

        // tonic client-streaming yields the message directly (no per-item
        // `Result`); a mid-stream error is signalled by ending the stream, and
        // the guest reports the failure in `UploadResponse`.
        let stream = async_stream::stream! {
            futures::pin_mut!(tar);
            let mut first = true;
            while let Some(item) = tar.next().await {
                match item {
                    Ok(data) => {
                        yield UploadChunk {
                            dest_path: if first { dest.clone() } else { String::new() },
                            container_id: cid.clone(),
                            data,
                            mkdir_parents,
                            overwrite,
                            source_is_dir: if first { source_is_dir } else { None },
                        };
                        first = false;
                    }
                    Err(_) => break,
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
    /// Returns the stream plus the archive-shape hint read from the guest's
    /// first chunk. `None` means the guest predates the hint (older peer).
    pub async fn download_tar_stream(
        &mut self,
        container_src: &str,
        container_id: Option<&str>,
        include_parent: bool,
        follow_symlinks: bool,
    ) -> BoxliteResult<(BoxTarStream, Option<bool>)> {
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

        let first = stream.message().await.map_err(map_tonic_err)?;
        let source_is_dir = first.as_ref().and_then(|c| c.source_is_dir);
        let mut first_data = first.map(|c| c.data);

        let out = async_stream::stream! {
            if let Some(data) = first_data.take().filter(|d| !d.is_empty()) {
                yield Ok(data);
            }
            loop {
                match stream.message().await {
                    Ok(Some(chunk)) => {
                        if !chunk.data.is_empty() {
                            yield Ok(chunk.data);
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        yield Err(std::io::Error::other(e));
                        break;
                    }
                }
            }
        };

        Ok((Box::pin(out), source_is_dir))
    }
}

/// Preserve the guest's error class instead of flattening it to `Internal`.
///
/// The guest rejects bad requests with real gRPC codes — an unreachable
/// destination, a missing source, a malformed path, a payload over its size
/// cap. Collapsing all of them into `Internal` turned every one into a 500 and
/// buried the reason inside a `status: …` string, which is exactly how a caller
/// ends up thinking a deliberate refusal was a server fault.
///
/// The arms are the complete set of codes `boxlite-guest`'s files service
/// emits; anything else is genuinely unclassified and stays a server fault.
fn map_tonic_err(err: tonic::Status) -> BoxliteError {
    let message = err.message().to_owned();
    match err.code() {
        tonic::Code::FailedPrecondition => BoxliteError::Unsupported(message),
        tonic::Code::InvalidArgument => BoxliteError::InvalidArgument(message),
        tonic::Code::NotFound => BoxliteError::NotFound(message),
        tonic::Code::ResourceExhausted => BoxliteError::ResourceExhausted(message),
        _ => BoxliteError::Internal(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::Status;

    /// A destination the guest cannot reach is the caller's problem, not the
    /// server's — it must not arrive as a 500.
    #[test]
    fn unreachable_destination_maps_to_unsupported() {
        let error = map_tonic_err(Status::failed_precondition(
            "/tmp/x is under the container's '/tmp' mount",
        ));

        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert_eq!(error.http().0, 400);
    }

    #[test]
    fn missing_source_maps_to_not_found() {
        let error = map_tonic_err(Status::not_found("source path does not exist"));

        assert!(matches!(error, BoxliteError::NotFound(_)));
        assert_eq!(error.http().0, 404);
    }

    #[test]
    fn malformed_path_maps_to_invalid_argument() {
        let error = map_tonic_err(Status::invalid_argument("path must not contain .."));

        assert!(matches!(error, BoxliteError::InvalidArgument(_)));
        assert_eq!(error.http().0, 400);
    }

    /// The guest caps an upload at 512 MiB and says so with `ResourceExhausted`.
    /// Flattened to `Internal` it reaches the caller as a 500 — the server
    /// blaming itself for a payload the caller chose.
    #[test]
    fn oversized_upload_maps_to_resource_exhausted() {
        let error = map_tonic_err(Status::resource_exhausted("upload too large"));

        assert!(
            matches!(error, BoxliteError::ResourceExhausted(_)),
            "{error:?}"
        );
        assert_eq!(error.http().0, 429);
    }

    /// Anything the guest did not classify stays a server fault, and keeps the
    /// full status text so the code is not lost.
    #[test]
    fn unclassified_status_stays_internal() {
        let error = map_tonic_err(Status::internal("failed to create temp file"));

        assert!(matches!(error, BoxliteError::Internal(_)));
        assert_eq!(error.http().0, 500);
    }

    /// The message must survive the remap — a refusal that arrives without the
    /// mount name in it is useless to the caller.
    #[test]
    fn refusal_message_survives_the_remap() {
        let error = map_tonic_err(Status::failed_precondition(
            "/tmp/x is under the container's '/tmp' mount",
        ));

        assert!(error.to_string().contains("'/tmp' mount"), "{error}");
    }
}
