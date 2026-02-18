#![cfg(target_os = "linux")]
//! Files service implementation.
//!
//! Provides tar-based upload/download between host and the single container
//! running inside the guest.

use crate::service::server::GuestServer;
use boxlite_shared::{
    files_server::Files, DownloadChunk, DownloadRequest, UploadChunk, UploadResponse,
};
use std::path::{Path, PathBuf};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};
use tracing::info;

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

        // Extract tar with mode-aware logic:
        // - FileToFile: single regular file in tar + dest not trailing '/' + dest not existing dir
        //   → use entry.unpack(dest) to write directly to dest path
        // - IntoDirectory: everything else → archive.unpack(dest) (current behavior)
        let dest = dest_root.clone();
        let dest_path_clone = dest_path.clone();
        let temp_clone = temp_path.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mode = determine_extraction_mode(&dest, &dest_path_clone, &temp_clone)?;

            match mode {
                ExtractionMode::FileToFile => {
                    if let Some(parent) = dest.parent() {
                        if mkdir_parents {
                            std::fs::create_dir_all(parent)
                                .map_err(|e| format!("failed to create parent dir: {}", e))?;
                        } else if !parent.exists() {
                            return Err(format!(
                                "parent directory of {} does not exist",
                                dest_path_clone
                            ));
                        }
                    }
                    if !overwrite && dest.exists() {
                        return Err("destination file exists and overwrite=false".into());
                    }
                    let tar_file = std::fs::File::open(&temp_clone)
                        .map_err(|e| format!("open temp: {}", e))?;
                    let mut archive = tar::Archive::new(tar_file);
                    let mut entries = archive
                        .entries()
                        .map_err(|e| format!("read entries: {}", e))?;
                    if let Some(entry) = entries.next() {
                        let mut entry = entry.map_err(|e| format!("read entry: {}", e))?;
                        entry
                            .unpack(&dest)
                            .map_err(|e| format!("unpack file: {}", e))?;
                    }
                }
                ExtractionMode::IntoDirectory => {
                    if !dest.exists() {
                        if mkdir_parents {
                            std::fs::create_dir_all(&dest)
                                .map_err(|e| format!("failed to create destination: {}", e))?;
                        } else {
                            return Err(format!("destination {} does not exist", dest_path_clone));
                        }
                    }
                    if !overwrite && dest.read_dir().ok().and_then(|mut r| r.next()).is_some() {
                        return Err("destination exists and overwrite=false".into());
                    }
                    let tar_file = std::fs::File::open(&temp_clone)
                        .map_err(|e| format!("open temp: {}", e))?;
                    let mut archive = tar::Archive::new(tar_file);
                    archive
                        .unpack(&dest)
                        .map_err(|e| format!("extract failed: {}", e))?;
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| Status::internal(format!("task join error: {}", e)))?
        .map_err(Status::internal)?;

        let _ = tokio::fs::remove_file(&temp_path).await;

        info!(
            dest = %dest_root.display(),
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
        if !src_path.exists() {
            return Err(Status::not_found("source path does not exist"));
        }

        // Build tar into temp file
        let temp_path =
            std::env::temp_dir().join(format!("boxlite-download-{}.tar", uuid::Uuid::new_v4()));

        let include_parent = req.include_parent;
        let follow_symlinks = req.follow_symlinks;

        let temp_path_block = temp_path.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let tar_file = std::fs::File::create(&temp_path_block)
                .map_err(|e| format!("create temp: {}", e))?;
            let mut builder = tar::Builder::new(tar_file);
            builder.follow_symlinks(follow_symlinks);

            if src_path.is_dir() {
                if include_parent {
                    let base = src_path
                        .file_name()
                        .map(|s| s.to_owned())
                        .unwrap_or_else(|| std::ffi::OsStr::new("root").to_owned());
                    append_dir_recursive(&mut builder, Path::new(""), &src_path, Some(base))?;
                } else {
                    append_dir_recursive(&mut builder, Path::new(""), &src_path, None)?;
                }
            } else {
                let name = src_path
                    .file_name()
                    .ok_or_else(|| "source file has no name".to_string())?;
                builder
                    .append_path_with_name(&src_path, name)
                    .map_err(|e| format!("append file: {}", e))?;
            }

            builder.finish().map_err(|e| format!("finish tar: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| Status::internal(format!("task join error: {}", e)))?
        .map_err(Status::internal)?;

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

/// Whether to extract as a single file or into a directory.
enum ExtractionMode {
    /// Destination is a file path — extract the single tar entry directly to it.
    FileToFile,
    /// Destination is a directory — extract all tar entries into it.
    IntoDirectory,
}

/// Inspect the destination path and tar contents to decide extraction mode.
///
/// Rules (evaluated in order):
/// 1. Trailing `/` in dest_path → directory mode
/// 2. Dest exists as a directory → directory mode
/// 3. Tar contains exactly one regular file → file-to-file mode
/// 4. Fallback → directory mode
fn determine_extraction_mode(
    dest: &Path,
    dest_path: &str,
    tar_path: &Path,
) -> Result<ExtractionMode, String> {
    if dest_path.ends_with('/') {
        return Ok(ExtractionMode::IntoDirectory);
    }
    if dest.is_dir() {
        return Ok(ExtractionMode::IntoDirectory);
    }
    let tar_file =
        std::fs::File::open(tar_path).map_err(|e| format!("open tar for inspection: {}", e))?;
    let mut archive = tar::Archive::new(tar_file);
    if let Ok(entries) = archive.entries() {
        let mut count = 0u32;
        let mut is_regular = false;
        for entry in entries {
            count += 1;
            if count > 1 {
                break;
            }
            if let Ok(e) = entry {
                is_regular = e.header().entry_type() == tar::EntryType::Regular;
            }
        }
        if count == 1 && is_regular {
            return Ok(ExtractionMode::FileToFile);
        }
    }
    Ok(ExtractionMode::IntoDirectory)
}

fn append_dir_recursive(
    builder: &mut tar::Builder<std::fs::File>,
    base: &Path,
    src: &Path,
    parent_override: Option<std::ffi::OsString>,
) -> Result<(), String> {
    let mut stack = vec![src.to_path_buf()];
    while let Some(path) = stack.pop() {
        let rel = path.strip_prefix(src).unwrap_or(&path).to_path_buf();

        let mut archive_path = base.to_path_buf();
        if let Some(ref parent) = parent_override {
            archive_path.push(parent);
        }
        archive_path.push(&rel);

        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("stat {}: {}", path.display(), e))?;

        if metadata.is_dir() {
            builder
                .append_dir(archive_path.clone(), &path)
                .map_err(|e| format!("append dir {}: {}", path.display(), e))?;
            for entry in std::fs::read_dir(&path)
                .map_err(|e| format!("read_dir {}: {}", path.display(), e))?
            {
                let entry = entry.map_err(|e| format!("readdir: {}", e))?;
                stack.push(entry.path());
            }
        } else if metadata.file_type().is_symlink() {
            // tar builder handles symlinks internally via append_path_with_name
            builder
                .append_path_with_name(&path, &archive_path)
                .map_err(|e| format!("append symlink {}: {}", path.display(), e))?;
        } else {
            builder
                .append_path_with_name(&path, &archive_path)
                .map_err(|e| format!("append file {}: {}", path.display(), e))?;
        }
    }
    Ok(())
}
