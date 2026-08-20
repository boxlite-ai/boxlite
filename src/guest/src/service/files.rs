#![cfg(target_os = "linux")]
//! Files service implementation.
//!
//! Provides tar-based upload/download between host and the single container
//! running inside the guest.

use crate::service::server::GuestServer;
use boxlite_shared::{
    files_server::Files, DownloadChunk, DownloadRequest, UploadChunk, UploadResponse,
};
use futures::StreamExt;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};
use tracing::info;

#[tonic::async_trait]
impl Files for GuestServer {
    async fn upload(
        &self,
        request: Request<Streaming<UploadChunk>>,
    ) -> Result<Response<UploadResponse>, Status> {
        let mut stream = request.into_inner();

        // First chunk must carry dest_path (and optional container_id)
        let first = stream
            .message()
            .await?
            .ok_or_else(|| Status::invalid_argument("empty upload stream"))?;

        let dest_path = first.dest_path.clone();
        if dest_path.is_empty() {
            return Err(Status::invalid_argument(
                "dest_path is required in first chunk",
            ));
        }
        let container_id = self
            .resolve_container_id(first.container_id.as_str())
            .await
            .map_err(Status::failed_precondition)?;

        // Build absolute dest root under container rootfs
        let dest_root = self.container_rootfs(&container_id, &dest_path)?;

        // Overwrite / mkdir flags + archive shape hint (first chunk only)
        let mkdir_parents = first.mkdir_parents;
        let overwrite = first.overwrite;
        let is_directory = first.is_directory;

        // The original dest_path may have trailing '/' indicating directory
        // mode, but the resolved rootfs path won't. Use force_directory then.
        let force_directory = dest_path.ends_with('/');

        // Stream the tar bytes (first chunk's data + the remaining chunks)
        // straight into the unpacker without staging a temp file.
        let first_data = first.data;
        let rest = stream.map(|r| {
            r.map(|c| c.data)
                .map_err(|e| std::io::Error::other(e.message()))
        });
        let bytes = futures::stream::once(async move {
            Ok::<Vec<u8>, std::io::Error>(first_data)
        })
        .chain(rest);

        boxlite_shared::tar::unpack_stream(
            Box::pin(bytes),
            dest_root.clone(),
            boxlite_shared::tar::UnpackContext {
                overwrite,
                mkdir_parents,
                force_directory,
                is_directory,
            },
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        info!(
            dest = %dest_root.display(),
            container_id = %container_id,
            "upload completed"
        );

        Ok(Response::new(UploadResponse {
            success: true,
            error: None,
        }))
    }

    type DownloadStream = ReceiverStream<Result<DownloadChunk, Status>>;

    async fn download(
        &self,
        request: Request<DownloadRequest>,
    ) -> Result<Response<Self::DownloadStream>, Status> {
        let req = request.into_inner();
        if req.src_path.is_empty() {
            return Err(Status::invalid_argument("src_path is required"));
        }
        let container_id = self
            .resolve_container_id(req.container_id.as_str())
            .await
            .map_err(Status::failed_precondition)?;

        let src_path = self.container_rootfs(&container_id, &req.src_path)?;
        if !src_path.exists() {
            return Err(Status::not_found("source path does not exist"));
        }

        let include_parent = req.include_parent;
        let follow_symlinks = req.follow_symlinks;

        // Stream the packed tar straight into the gRPC stream — no temp file.
        let (tx, rx) = mpsc::channel::<Result<DownloadChunk, Status>>(4);
        tokio::spawn(async move {
            let (is_directory, mut stream) = match boxlite_shared::tar::pack_stream(
                src_path,
                boxlite_shared::tar::PackContext {
                    follow_symlinks,
                    include_parent,
                },
            )
            .await
            {
                Ok(x) => x,
                Err(e) => {
                    let _ = tx.send(Err(Status::internal(e.to_string()))).await;
                    return;
                }
            };

            let mut first = true;
            while let Some(chunk) = stream.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(e) => {
                        let _ = tx.send(Err(Status::internal(e.to_string()))).await;
                        return;
                    }
                };
                let dc = DownloadChunk {
                    data,
                    is_directory: if first { Some(is_directory) } else { None },
                };
                first = false;
                if tx.send(Ok(dc)).await.is_err() {
                    // Receiver dropped → client aborted.
                    return;
                }
            }
        });

        info!(
            src = %req.src_path,
            container_id = %container_id,
            "download started"
        );

        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

impl GuestServer {
    async fn resolve_container_id(&self, requested: &str) -> Result<String, String> {
        if !requested.is_empty() {
            return Ok(requested.to_string());
        }

        let containers = self.containers.lock().await;
        if containers.len() == 1 {
            if let Some((id, _)) = containers.iter().next() {
                return Ok(id.clone());
            }
        }
        Err("container_id required when multiple containers present".into())
    }

    #[allow(clippy::result_large_err)]
    fn container_rootfs(&self, container_id: &str, path: &str) -> Result<PathBuf, Status> {
        let guest_layout = self.layout.shared().container(container_id);
        let rootfs = guest_layout.rootfs_dir();

        let path_obj = Path::new(path);
        if path_obj
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(Status::invalid_argument("path must not contain .."));
        }

        let rel = if path_obj.is_absolute() {
            path_obj.strip_prefix("/").unwrap_or(path_obj).to_path_buf()
        } else {
            path_obj.to_path_buf()
        };

        Ok(rootfs.join(rel))
    }
}
