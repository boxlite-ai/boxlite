#![cfg(target_os = "linux")]
//! Files service implementation.
//!
//! Provides tar-based upload/download between host and the single container
//! running inside the guest.

use crate::service::server::GuestServer;
use boxlite_shared::{
    files_server::Files, DownloadChunk, DownloadRequest, UploadChunk, UploadResponse,
};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};
use tracing::{info, warn};

const CHUNK_SIZE: usize = 1 << 20; // 1 MiB
const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB safety cap

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

        // Overwrite / mkdir flags
        let mkdir_parents = first.mkdir_parents;
        let overwrite = first.overwrite;

        // Temp file to hold tar stream
        let temp_path =
            std::env::temp_dir().join(format!("boxlite-upload-{}.tar", uuid::Uuid::new_v4()));
        let mut file = File::create(&temp_path)
            .await
            .map_err(|e| Status::internal(format!("failed to create temp file: {}", e)))?;

        // write first data chunk if present
        let mut total: u64 = 0;
        if !first.data.is_empty() {
            total += first.data.len() as u64;
            if total > MAX_UPLOAD_BYTES {
                return Err(Status::resource_exhausted("upload too large"));
            }
            file.write_all(&first.data)
                .await
                .map_err(|e| Status::internal(format!("failed to write temp file: {}", e)))?;
        }

        // stream remaining chunks
        while let Some(chunk) = stream.message().await? {
            let len = chunk.data.len() as u64;
            total += len;
            if total > MAX_UPLOAD_BYTES {
                return Err(Status::resource_exhausted("upload too large"));
            }
            file.write_all(&chunk.data)
                .await
                .map_err(|e| Status::internal(format!("failed to write temp file: {}", e)))?;
        }

        file.flush()
            .await
            .map_err(|e| Status::internal(format!("failed to flush temp file: {}", e)))?;

        // Extract tar using shared logic
        // The original dest_path may have trailing '/' indicating directory mode,
        // but the resolved rootfs path won't. Use force_directory in that case.
        let force_directory = dest_path.ends_with('/');
        boxlite_shared::tar::unpack(
            temp_path.clone(),
            dest_root.path.clone(),
            boxlite_shared::tar::UnpackContext {
                overwrite,
                mkdir_parents,
                force_directory,
            },
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        let _ = tokio::fs::remove_file(&temp_path).await;

        info!(
            dest = %dest_root.path.display(),
            bytes = total,
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
        if !src_path.path.exists() {
            return Err(Status::not_found("source path does not exist"));
        }

        // Build tar into temp file
        let temp_path =
            std::env::temp_dir().join(format!("boxlite-download-{}.tar", uuid::Uuid::new_v4()));

        let include_parent = req.include_parent;
        let follow_symlinks = req.follow_symlinks;

        boxlite_shared::tar::pack(
            src_path.path.clone(),
            temp_path.clone(),
            boxlite_shared::tar::PackContext {
                follow_symlinks,
                include_parent,
            },
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        // Stream file contents
        let (tx, rx) = mpsc::channel::<Result<DownloadChunk, Status>>(4);
        tokio::spawn(async move {
            let mut file = match File::open(&temp_path).await {
                Ok(f) => f,
                Err(e) => {
                    let _ = tx
                        .send(Err(Status::internal(format!(
                            "open temp tar failed: {}",
                            e
                        ))))
                        .await;
                    return;
                }
            };
            let mut buf = vec![0u8; CHUNK_SIZE];
            loop {
                match file.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx
                            .send(Ok(DownloadChunk {
                                data: buf[..n].to_vec(),
                            }))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(Err(Status::internal(format!(
                                "read temp tar failed: {}",
                                e
                            ))))
                            .await;
                        break;
                    }
                }
            }
            let _ = tokio::fs::remove_file(&temp_path).await;
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
    fn container_rootfs(&self, container_id: &str, path: &str) -> Result<ContainerPath, Status> {
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

        // For a running container, resolve through its live mount namespace so
        // paths under runtime mounts (the tmpfs at /tmp, /run, /dev/shm) reach
        // what the container actually sees — matching `docker cp`. Touching the
        // on-disk rootfs dir instead lands *beneath* those mounts: invisible to
        // the container, or rejected.
        //
        // Open `/proc/<pid>/root` once, now, and resolve relative to that open
        // handle (`/proc/self/fd/<n>`) rather than re-deriving the `/proc/<pid>`
        // path at write time. The open follows the magic symlink immediately, so
        // a PID recycled between this check and the tar I/O can't redirect the
        // copy into another process's namespace; the handle lives in the
        // returned `ContainerPath` until the copy completes.
        if let Some(pid) = self.container_init_pid(container_id) {
            let root = std::fs::File::open(format!("/proc/{pid}/root")).map_err(|e| {
                Status::failed_precondition(format!(
                    "container {container_id} is running (init pid {pid}) but its \
                     mount-namespace root is unavailable: {e}"
                ))
            })?;
            let path = PathBuf::from(format!("/proc/self/fd/{}", root.as_raw_fd())).join(&rel);
            return Ok(ContainerPath {
                path,
                _root_pin: Some(root),
            });
        }

        // Not running: no runtime mounts exist, so the on-disk rootfs is the
        // correct target (offline copy to a stopped box).
        let rootfs = self.layout.shared().container(container_id).rootfs_dir();
        Ok(ContainerPath {
            path: rootfs.join(rel),
            _root_pin: None,
        })
    }

    /// PID of the container's init process when it is running, used to resolve
    /// copy paths through its live mount namespace (`/proc/<pid>/root`).
    /// `None` when the container isn't running. A failure to read the
    /// libcontainer state is logged and also yields `None` (callers fall back
    /// to the on-disk rootfs): a running container always has loadable state, so
    /// a read error means we can no longer tell it's running, and silently
    /// landing the copy beneath a runtime mount would be an invisible drop.
    fn container_init_pid(&self, container_id: &str) -> Option<i32> {
        use libcontainer::container::{Container as LibContainer, ContainerStatus};
        let state_path = self
            .layout
            .container_state_dir(container_id)
            .join(container_id);
        match LibContainer::load(state_path) {
            Ok(container) if matches!(container.status(), ContainerStatus::Running) => {
                container.pid().map(|p| p.as_raw())
            }
            Ok(_) => None,
            Err(e) => {
                warn!(
                    container_id = %container_id,
                    error = %e,
                    "failed to load container state for copy; falling back to on-disk rootfs"
                );
                None
            }
        }
    }
}

/// A resolved copy path plus an optional pin that keeps it valid for the
/// duration of a pack/unpack. For a running container the path points through
/// `/proc/self/fd/<n>`, where the held handle is the container's
/// mount-namespace root captured at resolve time — see [`GuestServer::container_rootfs`].
struct ContainerPath {
    path: PathBuf,
    _root_pin: Option<std::fs::File>,
}
