//! gRPC WorkerService implementation.
//!
//! Each RPC wraps a BoxliteRuntime / LiteBox call directly.

use futures::StreamExt;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::RwLock;
use tonic::{Request, Response, Status, Streaming};

use boxlite::runtime::options::{NetworkConfig, NetworkMode};
use boxlite::{
    BoxArchive, BoxCommand, BoxInfo, BoxOptions, BoxliteRuntime, CloneOptions, CopyOptions,
    ExecStdin, Execution, ExportOptions, LiteBox, NetworkSpec, RootfsSpec, Secret, SnapshotInfo,
    SnapshotOptions,
};

use crate::proto;
use crate::proto::worker_service_server::WorkerService;

/// Shared state for the gRPC worker service.
pub struct WorkerServiceImpl {
    pub runtime: BoxliteRuntime,
    boxes: RwLock<HashMap<String, Arc<LiteBox>>>,
    executions: Arc<RwLock<HashMap<String, ActiveExecution>>>,
}

struct ActiveExecution {
    execution: Execution,
    stdin: tokio::sync::Mutex<Option<ExecStdin>>,
    started_at: std::time::Instant,
    status: Arc<RwLock<ExecStatus>>,
}

#[derive(Clone, Debug)]
enum ExecStatus {
    Running,
    Completed {
        exit_code: i32,
        duration: std::time::Duration,
    },
    Failed {
        error: String,
        duration: std::time::Duration,
    },
}

impl WorkerServiceImpl {
    pub fn new(runtime: BoxliteRuntime) -> Self {
        Self {
            runtime,
            boxes: RwLock::new(HashMap::new()),
            executions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    async fn get_or_fetch_box(&self, box_id: &str) -> Result<Arc<LiteBox>, Status> {
        if let Some(b) = self.boxes.read().await.get(box_id) {
            return Ok(Arc::clone(b));
        }
        match self.runtime.get(box_id).await {
            Ok(Some(b)) => {
                let id = b.info().id.to_string();
                let arc = Arc::new(b);
                self.boxes.write().await.insert(id, Arc::clone(&arc));
                Ok(arc)
            }
            Ok(None) => Err(Status::not_found(format!("box not found: {box_id}"))),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }
}

fn box_info_to_proto(info: &BoxInfo) -> proto::BoxResponse {
    proto::BoxResponse {
        box_id: info.id.to_string(),
        name: info.name.clone(),
        status: info.status.as_str().to_string(),
        created_at: info.created_at.to_rfc3339(),
        updated_at: info.last_updated.to_rfc3339(),
        pid: info.pid,
        image: info.image.clone(),
        cpus: info.cpus as u32,
        memory_mib: info.memory_mib,
        labels: info.labels.clone(),
    }
}

fn snapshot_info_to_proto(info: &SnapshotInfo) -> proto::SnapshotResponse {
    proto::SnapshotResponse {
        id: info.id.clone(),
        box_id: info.box_id.clone(),
        name: info.name.clone(),
        created_at: info.created_at,
        container_disk_bytes: info.disk_info.container_disk_bytes,
        size_bytes: info.disk_info.size_bytes,
    }
}

fn image_info_to_proto(info: &boxlite::runtime::types::ImageInfo) -> proto::ImageProtoResponse {
    proto::ImageProtoResponse {
        reference: info.reference.clone(),
        repository: info.repository.clone(),
        tag: info.tag.clone(),
        id: info.id.clone(),
        cached_at: info.cached_at.to_rfc3339(),
        size_bytes: info.size.map(|b| b.0),
    }
}

#[allow(clippy::result_large_err)]
fn build_box_options(req: &proto::CreateBoxRequest) -> Result<BoxOptions, Status> {
    let rootfs = if let Some(ref path) = req.rootfs_path {
        RootfsSpec::RootfsPath(path.clone())
    } else {
        RootfsSpec::Image(
            req.image
                .clone()
                .unwrap_or_else(|| "alpine:latest".to_string()),
        )
    };
    let env: Vec<(String, String)> = req
        .env
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let network = match &req.network {
        Some(network) => {
            let mode = network
                .mode
                .parse::<NetworkMode>()
                .map_err(|e| Status::invalid_argument(e.to_string()))?;
            NetworkSpec::try_from(NetworkConfig {
                mode,
                allow_net: network.allow_net.clone(),
            })
            .map_err(|e| Status::invalid_argument(e.to_string()))?
        }
        None => NetworkSpec::default(),
    };
    let secrets = req
        .secrets
        .iter()
        .map(|secret| Secret {
            name: secret.name.clone(),
            value: secret.value.clone(),
            hosts: secret.hosts.clone(),
            placeholder: secret
                .placeholder
                .clone()
                .unwrap_or_else(|| format!("<BOXLITE_SECRET:{}>", secret.name)),
        })
        .collect();
    Ok(BoxOptions {
        rootfs,
        cpus: req.cpus.map(|c| c as u8),
        memory_mib: req.memory_mib,
        disk_size_gb: req.disk_size_gb,
        working_dir: req.working_dir.clone(),
        env,
        network,
        entrypoint: if req.entrypoint.is_empty() {
            None
        } else {
            Some(req.entrypoint.clone())
        },
        cmd: if req.cmd.is_empty() {
            None
        } else {
            Some(req.cmd.clone())
        },
        user: req.user.clone(),
        secrets,
        auto_remove: req.auto_remove,
        detach: req.detach,
        ..Default::default()
    })
}

fn build_box_command(req: &proto::ExecRequest) -> BoxCommand {
    let mut cmd = BoxCommand::new(&req.command).args(req.args.iter().map(String::as_str));
    for (k, v) in &req.env {
        cmd = cmd.env(k, v);
    }
    if let Some(ref wd) = req.working_dir {
        cmd = cmd.working_dir(wd);
    }
    if req.tty {
        cmd = cmd.tty(true);
    }
    if let Some(secs) = req.timeout_seconds {
        cmd = cmd.timeout(std::time::Duration::from_secs_f64(secs));
    }
    cmd
}

type GrpcResult<T> = Result<Response<T>, Status>;

#[tonic::async_trait]
impl WorkerService for WorkerServiceImpl {
    // ========================================================================
    // Box Lifecycle
    // ========================================================================

    async fn create_box(
        &self,
        request: Request<proto::CreateBoxRequest>,
    ) -> GrpcResult<proto::BoxResponse> {
        let req = request.into_inner();
        let name = req.name.clone();
        let options = build_box_options(&req)?;

        let litebox = self
            .runtime
            .create(options, name)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let info = litebox.info();
        let box_id = info.id.to_string();
        let resp = box_info_to_proto(&info);
        self.boxes.write().await.insert(box_id, Arc::new(litebox));
        Ok(Response::new(resp))
    }

    async fn get_box(
        &self,
        request: Request<proto::GetBoxRequest>,
    ) -> GrpcResult<proto::BoxResponse> {
        let box_id = &request.into_inner().box_id;
        match self.runtime.get_info(box_id).await {
            Ok(Some(info)) => Ok(Response::new(box_info_to_proto(&info))),
            Ok(None) => Err(Status::not_found(format!("box not found: {box_id}"))),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn list_boxes(
        &self,
        _request: Request<proto::ListBoxesRequest>,
    ) -> GrpcResult<proto::ListBoxesResponse> {
        let infos = self
            .runtime
            .list_info()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::ListBoxesResponse {
            boxes: infos.iter().map(box_info_to_proto).collect(),
        }))
    }

    async fn remove_box(
        &self,
        request: Request<proto::RemoveBoxRequest>,
    ) -> GrpcResult<proto::RemoveBoxResponse> {
        let req = request.into_inner();
        self.boxes.write().await.remove(&req.box_id);
        self.runtime
            .remove(&req.box_id, req.force)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::RemoveBoxResponse {}))
    }

    async fn start_box(
        &self,
        request: Request<proto::StartBoxRequest>,
    ) -> GrpcResult<proto::BoxResponse> {
        let box_id = &request.into_inner().box_id;
        let litebox = self.get_or_fetch_box(box_id).await?;
        litebox
            .start()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(box_info_to_proto(&litebox.info())))
    }

    async fn stop_box(
        &self,
        request: Request<proto::StopBoxRequest>,
    ) -> GrpcResult<proto::BoxResponse> {
        let box_id = &request.into_inner().box_id;
        let litebox = self.get_or_fetch_box(box_id).await?;
        litebox
            .stop()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        // Remove stale handle from cache so next start gets a fresh one
        self.boxes.write().await.remove(box_id);
        // Return fresh info from runtime
        match self.runtime.get_info(box_id).await {
            Ok(Some(info)) => Ok(Response::new(box_info_to_proto(&info))),
            _ => Ok(Response::new(box_info_to_proto(&litebox.info()))),
        }
    }

    // ========================================================================
    // Snapshots
    // ========================================================================

    async fn create_snapshot(
        &self,
        request: Request<proto::CreateSnapshotRequest>,
    ) -> GrpcResult<proto::SnapshotResponse> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;
        let info = litebox
            .snapshots()
            .create(SnapshotOptions {}, &req.name)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(snapshot_info_to_proto(&info)))
    }

    async fn list_snapshots(
        &self,
        request: Request<proto::ListSnapshotsRequest>,
    ) -> GrpcResult<proto::ListSnapshotsResponse> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;
        let snapshots = litebox
            .snapshots()
            .list()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::ListSnapshotsResponse {
            snapshots: snapshots.iter().map(snapshot_info_to_proto).collect(),
        }))
    }

    async fn get_snapshot(
        &self,
        request: Request<proto::GetSnapshotRequest>,
    ) -> GrpcResult<proto::SnapshotResponse> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;
        match litebox
            .snapshots()
            .get(&req.name)
            .await
            .map_err(|e| Status::internal(e.to_string()))?
        {
            Some(info) => Ok(Response::new(snapshot_info_to_proto(&info))),
            None => Err(Status::not_found(format!(
                "snapshot not found: {}",
                req.name
            ))),
        }
    }

    async fn remove_snapshot(
        &self,
        request: Request<proto::RemoveSnapshotRequest>,
    ) -> GrpcResult<proto::RemoveSnapshotResponse> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;
        litebox
            .snapshots()
            .remove(&req.name)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::RemoveSnapshotResponse {}))
    }

    async fn restore_snapshot(
        &self,
        request: Request<proto::RestoreSnapshotRequest>,
    ) -> GrpcResult<proto::RestoreSnapshotResponse> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;
        litebox
            .snapshots()
            .restore(&req.name)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::RestoreSnapshotResponse {}))
    }

    // ========================================================================
    // Clone / Export / Import
    // ========================================================================

    async fn clone_box(
        &self,
        request: Request<proto::CloneBoxProtoRequest>,
    ) -> GrpcResult<proto::BoxResponse> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;
        let cloned = litebox
            .clone_box(CloneOptions {}, req.name)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let info = cloned.info();
        let box_id = info.id.to_string();
        let resp = box_info_to_proto(&info);
        self.boxes.write().await.insert(box_id, Arc::new(cloned));
        Ok(Response::new(resp))
    }

    type ExportBoxStream =
        Pin<Box<dyn futures::Stream<Item = Result<proto::ExportChunk, Status>> + Send + 'static>>;

    async fn export_box(
        &self,
        request: Request<proto::ExportBoxProtoRequest>,
    ) -> GrpcResult<Self::ExportBoxStream> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;

        let tmp_dir = tempfile::tempdir()
            .map_err(|e| Status::internal(format!("Failed to create temp dir: {e}")))?;
        let archive_dir = tmp_dir.path().to_path_buf();

        let _archive = litebox
            .export(ExportOptions {}, &archive_dir)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        // Find the archive file in the temp dir
        let archive_path = find_archive_file(&archive_dir)
            .map_err(|e| Status::internal(format!("No archive file found: {e}")))?;

        let data = tokio::fs::read(&archive_path)
            .await
            .map_err(|e| Status::internal(format!("Failed to read archive: {e}")))?;

        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move {
            let _tmp_dir = tmp_dir; // Keep alive until streaming is done
            for chunk_data in data.chunks(65536) {
                if tx
                    .send(Ok(proto::ExportChunk {
                        data: chunk_data.to_vec(),
                        done: false,
                    }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            let _ = tx
                .send(Ok(proto::ExportChunk {
                    data: Vec::new(),
                    done: true,
                }))
                .await;
        });

        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }

    async fn import_box(
        &self,
        request: Request<Streaming<proto::ImportChunk>>,
    ) -> GrpcResult<proto::BoxResponse> {
        let mut stream = request.into_inner();
        let tmp_file = tempfile::NamedTempFile::new()
            .map_err(|e| Status::internal(format!("Failed to create temp file: {e}")))?;
        let tmp_path = tmp_file.path().to_path_buf();

        let mut name: Option<String> = None;
        let mut file = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| Status::internal(format!("Failed to open temp file: {e}")))?;

        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if name.is_none() {
                name = chunk.name;
            }
            if !chunk.data.is_empty() {
                file.write_all(&chunk.data)
                    .await
                    .map_err(|e| Status::internal(format!("Failed to write temp file: {e}")))?;
            }
            if chunk.done {
                break;
            }
        }
        file.flush()
            .await
            .map_err(|e| Status::internal(format!("Failed to flush temp file: {e}")))?;
        drop(file);

        let archive = BoxArchive::new(&tmp_path);
        let litebox = self
            .runtime
            .import_box(archive, name)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let info = litebox.info();
        let box_id = info.id.to_string();
        let resp = box_info_to_proto(&info);
        self.boxes.write().await.insert(box_id, Arc::new(litebox));
        Ok(Response::new(resp))
    }

    // ========================================================================
    // File Transfer
    // ========================================================================

    async fn upload_files(
        &self,
        request: Request<Streaming<proto::FileChunk>>,
    ) -> GrpcResult<proto::UploadFilesResponse> {
        let mut stream = request.into_inner();
        let tmp_file = tempfile::NamedTempFile::new()
            .map_err(|e| Status::internal(format!("Failed to create temp file: {e}")))?;
        let tmp_path = tmp_file.path().to_path_buf();

        let mut box_id: Option<String> = None;
        let mut dest_path: Option<String> = None;
        let mut file = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| Status::internal(format!("Failed to open temp file: {e}")))?;

        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if box_id.is_none() {
                box_id = chunk.box_id;
                dest_path = chunk.path;
            }
            if !chunk.data.is_empty() {
                file.write_all(&chunk.data)
                    .await
                    .map_err(|e| Status::internal(format!("Failed to write: {e}")))?;
            }
            if chunk.done {
                break;
            }
        }
        file.flush()
            .await
            .map_err(|e| Status::internal(format!("Failed to flush: {e}")))?;
        drop(file);

        let box_id = box_id.ok_or_else(|| Status::invalid_argument("missing box_id in chunks"))?;
        let dest =
            dest_path.ok_or_else(|| Status::invalid_argument("missing path in first chunk"))?;

        let litebox = self.get_or_fetch_box(&box_id).await?;
        litebox
            .copy_into(&tmp_path, &dest, CopyOptions::default())
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(proto::UploadFilesResponse {}))
    }

    type DownloadFilesStream =
        Pin<Box<dyn futures::Stream<Item = Result<proto::FileChunk, Status>> + Send + 'static>>;

    async fn download_files(
        &self,
        request: Request<proto::DownloadFilesRequest>,
    ) -> GrpcResult<Self::DownloadFilesStream> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;

        let tmp_dir = tempfile::tempdir()
            .map_err(|e| Status::internal(format!("Failed to create temp dir: {e}")))?;
        let host_dst = tmp_dir.path().to_path_buf();

        litebox
            .copy_out(&req.path, &host_dst, CopyOptions::default())
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        // Tar the output directory and stream it
        let tar_data = tar_directory(&host_dst)
            .map_err(|e| Status::internal(format!("Failed to create tar: {e}")))?;

        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move {
            let _tmp_dir = tmp_dir;
            for chunk_data in tar_data.chunks(65536) {
                if tx
                    .send(Ok(proto::FileChunk {
                        data: chunk_data.to_vec(),
                        done: false,
                        box_id: None,
                        path: None,
                    }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            let _ = tx
                .send(Ok(proto::FileChunk {
                    data: Vec::new(),
                    done: true,
                    box_id: None,
                    path: None,
                }))
                .await;
        });

        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }

    // ========================================================================
    // Images
    // ========================================================================

    async fn pull_image(
        &self,
        request: Request<proto::PullImageProtoRequest>,
    ) -> GrpcResult<proto::ImageProtoResponse> {
        let req = request.into_inner();
        let images = self
            .runtime
            .images()
            .map_err(|e| Status::internal(e.to_string()))?;
        let _obj = images
            .pull(&req.reference)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        // After pull, list images and find the one we just pulled
        let all = images
            .list()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        let info = all
            .iter()
            .find(|i| i.reference == req.reference || i.id == req.reference)
            .or_else(|| all.last())
            .ok_or_else(|| Status::internal("Image pulled but not found in cache"))?;
        Ok(Response::new(image_info_to_proto(info)))
    }

    async fn list_images(
        &self,
        _request: Request<proto::ListImagesProtoRequest>,
    ) -> GrpcResult<proto::ListImagesProtoResponse> {
        let images = self
            .runtime
            .images()
            .map_err(|e| Status::internal(e.to_string()))?;
        let all = images
            .list()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::ListImagesProtoResponse {
            images: all.iter().map(image_info_to_proto).collect(),
        }))
    }

    async fn get_image(
        &self,
        request: Request<proto::GetImageRequest>,
    ) -> GrpcResult<proto::ImageProtoResponse> {
        let req = request.into_inner();
        let images = self
            .runtime
            .images()
            .map_err(|e| Status::internal(e.to_string()))?;
        let all = images
            .list()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        let info = all
            .iter()
            .find(|i| i.id == req.id)
            .ok_or_else(|| Status::not_found(format!("image not found: {}", req.id)))?;
        Ok(Response::new(image_info_to_proto(info)))
    }

    // ========================================================================
    // Execution
    // ========================================================================

    async fn exec(&self, request: Request<proto::ExecRequest>) -> GrpcResult<proto::ExecResponse> {
        let req = request.into_inner();
        let litebox = self.get_or_fetch_box(&req.box_id).await?;
        let cmd = build_box_command(&req);

        let mut execution = litebox
            .exec(cmd)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let stdin = execution.stdin();
        let exec_id = execution.id().clone();
        let status = Arc::new(RwLock::new(ExecStatus::Running));

        self.executions.write().await.insert(
            exec_id.clone(),
            ActiveExecution {
                execution,
                stdin: tokio::sync::Mutex::new(stdin),
                started_at: std::time::Instant::now(),
                status,
            },
        );

        Ok(Response::new(proto::ExecResponse {
            execution_id: exec_id,
        }))
    }

    async fn get_execution(
        &self,
        request: Request<proto::GetExecutionRequest>,
    ) -> GrpcResult<proto::ExecutionProtoResponse> {
        let req = request.into_inner();
        let executions = self.executions.read().await;
        let active = executions.get(&req.execution_id).ok_or_else(|| {
            Status::not_found(format!("execution not found: {}", req.execution_id))
        })?;

        let status = active.status.read().await;
        let (status_str, exit_code, duration_ms, error_message) = match &*status {
            ExecStatus::Running => ("running".to_string(), None, None, None),
            ExecStatus::Completed {
                exit_code,
                duration,
            } => (
                "completed".to_string(),
                Some(*exit_code),
                Some(duration.as_millis() as u64),
                None,
            ),
            ExecStatus::Failed { error, duration } => (
                "killed".to_string(),
                Some(-1),
                Some(duration.as_millis() as u64),
                Some(error.clone()),
            ),
        };

        Ok(Response::new(proto::ExecutionProtoResponse {
            execution_id: req.execution_id,
            status: status_str,
            exit_code,
            started_at: None,
            duration_ms,
            error_message,
        }))
    }

    type StreamOutputStream =
        Pin<Box<dyn futures::Stream<Item = Result<proto::OutputChunk, Status>> + Send + 'static>>;

    async fn stream_output(
        &self,
        request: Request<proto::StreamOutputRequest>,
    ) -> GrpcResult<Self::StreamOutputStream> {
        let req = request.into_inner();

        let (mut execution, exec_status) = {
            let executions = self.executions.read().await;
            let active = executions.get(&req.execution_id).ok_or_else(|| {
                Status::not_found(format!("execution not found: {}", req.execution_id))
            })?;
            (active.execution.clone(), Arc::clone(&active.status))
        };

        let stdout = execution.stdout();
        let stderr = execution.stderr();

        let (tx, rx) = tokio::sync::mpsc::channel::<Result<proto::OutputChunk, Status>>(64);

        if let Some(mut out) = stdout {
            let tx_out = tx.clone();
            tokio::spawn(async move {
                while let Some(line) = out.next().await {
                    let chunk = proto::OutputChunk {
                        output_type: proto::OutputType::Stdout as i32,
                        data: line.into_bytes(),
                        done: false,
                        exit_code: None,
                    };
                    if tx_out.send(Ok(chunk)).await.is_err() {
                        break;
                    }
                }
            });
        }

        if let Some(mut err_stream) = stderr {
            let tx_err = tx.clone();
            tokio::spawn(async move {
                while let Some(line) = err_stream.next().await {
                    let chunk = proto::OutputChunk {
                        output_type: proto::OutputType::Stderr as i32,
                        data: line.into_bytes(),
                        done: false,
                        exit_code: None,
                    };
                    if tx_err.send(Ok(chunk)).await.is_err() {
                        break;
                    }
                }
            });
        }

        // Wait for exit, send final chunk, update status
        let executions_ref = Arc::clone(&self.executions);
        let exec_id = req.execution_id.clone();
        let started_at = {
            let executions = self.executions.read().await;
            executions
                .get(&exec_id)
                .map(|a| a.started_at)
                .unwrap_or_else(std::time::Instant::now)
        };

        tokio::spawn(async move {
            let result = execution.wait().await;
            let duration = started_at.elapsed();
            let exit_code = match &result {
                Ok(r) => {
                    *exec_status.write().await = ExecStatus::Completed {
                        exit_code: r.exit_code,
                        duration,
                    };
                    r.exit_code
                }
                Err(e) => {
                    *exec_status.write().await = ExecStatus::Failed {
                        error: e.to_string(),
                        duration,
                    };
                    -1
                }
            };
            let _ = tx
                .send(Ok(proto::OutputChunk {
                    output_type: proto::OutputType::Stdout as i32,
                    data: Vec::new(),
                    done: true,
                    exit_code: Some(exit_code),
                }))
                .await;

            // Remove execution after process exits
            executions_ref.write().await.remove(&exec_id);
        });

        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }

    async fn send_input(
        &self,
        request: Request<proto::SendInputRequest>,
    ) -> GrpcResult<proto::SendInputResponse> {
        let req = request.into_inner();
        let executions = self.executions.read().await;
        let active = executions.get(&req.execution_id).ok_or_else(|| {
            Status::not_found(format!("execution not found: {}", req.execution_id))
        })?;

        let mut stdin_guard = active.stdin.lock().await;
        if let Some(ref mut stdin) = *stdin_guard
            && !req.data.is_empty()
        {
            stdin
                .write_all(&req.data)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;
        }
        Ok(Response::new(proto::SendInputResponse {}))
    }

    async fn send_signal(
        &self,
        request: Request<proto::SendSignalRequest>,
    ) -> GrpcResult<proto::SendSignalResponse> {
        let req = request.into_inner();
        let executions = self.executions.read().await;
        let active = executions.get(&req.execution_id).ok_or_else(|| {
            Status::not_found(format!("execution not found: {}", req.execution_id))
        })?;
        active
            .execution
            .signal(req.signal)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::SendSignalResponse {}))
    }

    async fn resize_tty(
        &self,
        request: Request<proto::ResizeTtyRequest>,
    ) -> GrpcResult<proto::ResizeTtyResponse> {
        let req = request.into_inner();
        let executions = self.executions.read().await;
        let active = executions.get(&req.execution_id).ok_or_else(|| {
            Status::not_found(format!("execution not found: {}", req.execution_id))
        })?;
        active
            .execution
            .resize_tty(req.rows, req.cols)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::ResizeTtyResponse {}))
    }

    // ========================================================================
    // Health & Metrics
    // ========================================================================

    async fn get_metrics(
        &self,
        request: Request<proto::GetMetricsRequest>,
    ) -> GrpcResult<proto::MetricsResponse> {
        let req = request.into_inner();

        if let Some(ref box_id) = req.box_id {
            let litebox = self.get_or_fetch_box(box_id).await?;
            let m = litebox
                .metrics()
                .await
                .map_err(|e| Status::internal(e.to_string()))?;
            return Ok(Response::new(proto::MetricsResponse {
                box_metrics: Some(proto::BoxMetrics {
                    commands_executed_total: m.commands_executed_total,
                    exec_errors_total: m.exec_errors_total,
                    bytes_sent_total: m.bytes_sent_total,
                    bytes_received_total: m.bytes_received_total,
                    cpu_percent: m.cpu_percent,
                    memory_bytes: m.memory_bytes,
                    network_bytes_sent: m.network_bytes_sent,
                    network_bytes_received: m.network_bytes_received,
                    network_tcp_connections: m.network_tcp_connections,
                    network_tcp_errors: m.network_tcp_errors,
                }),
                ..Default::default()
            }));
        }

        let m = self
            .runtime
            .metrics()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(proto::MetricsResponse {
            boxes_created_total: m.boxes_created_total(),
            boxes_failed_total: m.boxes_failed_total(),
            boxes_stopped_total: m.boxes_stopped_total(),
            num_running_boxes: m.num_running_boxes(),
            total_commands_executed: m.total_commands_executed(),
            total_exec_errors: m.total_exec_errors(),
            box_metrics: None,
        }))
    }

    async fn heartbeat(
        &self,
        _request: Request<proto::HeartbeatRequest>,
    ) -> GrpcResult<proto::HeartbeatResponse> {
        Ok(Response::new(proto::HeartbeatResponse { accepted: true }))
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// Find the first archive file in a directory (export creates `.boxlite` files).
fn find_archive_file(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("no files in export directory".to_string())
}

/// Create a tar archive from a directory, returning the bytes in memory.
fn tar_directory(dir: &std::path::Path) -> Result<Vec<u8>, std::io::Error> {
    let mut builder = tar::Builder::new(Vec::new());
    builder.append_dir_all(".", dir)?;
    builder.finish()?;
    builder.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_build_box_options_maps_network_and_secrets() {
        let req = proto::CreateBoxRequest {
            name: Some("test-box".into()),
            image: Some("alpine:latest".into()),
            rootfs_path: None,
            cpus: Some(2),
            memory_mib: Some(512),
            disk_size_gb: Some(10),
            working_dir: Some("/workspace".into()),
            env: HashMap::from([("FOO".into(), "bar".into())]),
            entrypoint: vec!["/bin/sh".into()],
            cmd: vec!["-lc".into(), "echo hi".into()],
            user: Some("1000:1000".into()),
            auto_remove: true,
            detach: false,
            network: Some(proto::NetworkSpec {
                mode: "enabled".into(),
                allow_net: vec!["api.openai.com".into()],
            }),
            secrets: vec![proto::CreateBoxSecret {
                name: "openai".into(),
                value: "sk-test".into(),
                hosts: vec!["api.openai.com".into()],
                placeholder: None,
            }],
        };

        let opts = build_box_options(&req).unwrap();
        assert!(matches!(
            opts.network,
            NetworkSpec::Enabled { ref allow_net } if allow_net == &vec!["api.openai.com".to_string()]
        ));
        assert_eq!(opts.secrets.len(), 1);
        assert_eq!(opts.secrets[0].placeholder, "<BOXLITE_SECRET:openai>");
        assert_eq!(opts.secrets[0].hosts, vec!["api.openai.com"]);
    }

    #[test]
    fn test_build_box_options_maps_disabled_network() {
        let req = proto::CreateBoxRequest {
            name: None,
            image: Some("alpine:latest".into()),
            rootfs_path: None,
            cpus: None,
            memory_mib: None,
            disk_size_gb: None,
            working_dir: None,
            env: HashMap::new(),
            entrypoint: Vec::new(),
            cmd: Vec::new(),
            user: None,
            auto_remove: false,
            detach: false,
            network: Some(proto::NetworkSpec {
                mode: "disabled".into(),
                allow_net: Vec::new(),
            }),
            secrets: Vec::new(),
        };

        let opts = build_box_options(&req).unwrap();
        assert!(matches!(opts.network, NetworkSpec::Disabled));
        assert!(opts.secrets.is_empty());
    }

    #[test]
    fn test_build_box_options_rejects_disabled_network_allow_net() {
        let req = proto::CreateBoxRequest {
            name: None,
            image: Some("alpine:latest".into()),
            rootfs_path: None,
            cpus: None,
            memory_mib: None,
            disk_size_gb: None,
            working_dir: None,
            env: HashMap::new(),
            entrypoint: Vec::new(),
            cmd: Vec::new(),
            user: None,
            auto_remove: false,
            detach: false,
            network: Some(proto::NetworkSpec {
                mode: "disabled".into(),
                allow_net: vec!["example.com".into()],
            }),
            secrets: Vec::new(),
        };

        let err = build_box_options(&req).unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[test]
    fn test_snapshot_info_to_proto() {
        let info = SnapshotInfo {
            id: "snap-01".into(),
            box_id: "box-01".into(),
            name: "v1".into(),
            created_at: 1700000000,
            disk_info: boxlite::DiskInfo {
                base_path: "/tmp/snap".into(),
                container_disk_bytes: 2048,
                size_bytes: 4096,
            },
        };
        let proto = snapshot_info_to_proto(&info);
        assert_eq!(proto.id, "snap-01");
        assert_eq!(proto.box_id, "box-01");
        assert_eq!(proto.name, "v1");
        assert_eq!(proto.created_at, 1700000000);
        assert_eq!(proto.container_disk_bytes, 2048);
        assert_eq!(proto.size_bytes, 4096);
    }

    #[test]
    fn test_image_info_to_proto() {
        use boxlite::runtime::types::Bytes;
        let info = boxlite::runtime::types::ImageInfo {
            reference: "docker.io/library/alpine:latest".into(),
            repository: "docker.io/library/alpine".into(),
            tag: "latest".into(),
            id: "sha256:abc123".into(),
            cached_at: chrono::Utc::now(),
            size: Some(Bytes(150_000_000)),
        };
        let proto = image_info_to_proto(&info);
        assert_eq!(proto.reference, "docker.io/library/alpine:latest");
        assert_eq!(proto.tag, "latest");
        assert_eq!(proto.size_bytes, Some(150_000_000));
    }

    #[test]
    fn test_image_info_to_proto_no_size() {
        let info = boxlite::runtime::types::ImageInfo {
            reference: "alpine:latest".into(),
            repository: "alpine".into(),
            tag: "latest".into(),
            id: "sha256:def".into(),
            cached_at: chrono::Utc::now(),
            size: None,
        };
        let proto = image_info_to_proto(&info);
        assert!(proto.size_bytes.is_none());
    }

    #[test]
    fn test_exec_status_transitions() {
        let status = ExecStatus::Running;
        assert!(matches!(status, ExecStatus::Running));

        let completed = ExecStatus::Completed {
            exit_code: 0,
            duration: std::time::Duration::from_millis(500),
        };
        if let ExecStatus::Completed {
            exit_code,
            duration,
        } = completed
        {
            assert_eq!(exit_code, 0);
            assert_eq!(duration.as_millis(), 500);
        }

        let failed = ExecStatus::Failed {
            error: "timeout".into(),
            duration: std::time::Duration::from_secs(30),
        };
        if let ExecStatus::Failed { error, duration } = failed {
            assert_eq!(error, "timeout");
            assert_eq!(duration.as_secs(), 30);
        }
    }
}
