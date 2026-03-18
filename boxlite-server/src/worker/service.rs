//! gRPC WorkerService implementation.
//!
//! Each RPC wraps a BoxliteRuntime / LiteBox call directly.

use futures::StreamExt;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::RwLock;
use tonic::{Request, Response, Status};

use boxlite::{
    BoxCommand, BoxInfo, BoxOptions, BoxliteRuntime, ExecStdin, Execution, LiteBox, RootfsSpec,
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
    #[allow(dead_code)]
    started_at: std::time::Instant,
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

fn build_box_options(req: &proto::CreateBoxRequest) -> BoxOptions {
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
    BoxOptions {
        rootfs,
        cpus: req.cpus.map(|c| c as u8),
        memory_mib: req.memory_mib,
        disk_size_gb: req.disk_size_gb,
        working_dir: req.working_dir.clone(),
        env,
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
        auto_remove: req.auto_remove,
        detach: req.detach,
        ..Default::default()
    }
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
    // -- Box Lifecycle --

    async fn create_box(
        &self,
        request: Request<proto::CreateBoxRequest>,
    ) -> GrpcResult<proto::BoxResponse> {
        let req = request.into_inner();
        let name = req.name.clone();
        let options = build_box_options(&req);

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
        Ok(Response::new(box_info_to_proto(&litebox.info())))
    }

    // -- Execution --

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

        self.executions.write().await.insert(
            exec_id.clone(),
            ActiveExecution {
                execution,
                stdin: tokio::sync::Mutex::new(stdin),
                started_at: std::time::Instant::now(),
            },
        );

        Ok(Response::new(proto::ExecResponse {
            execution_id: exec_id,
        }))
    }

    type StreamOutputStream =
        Pin<Box<dyn futures::Stream<Item = Result<proto::OutputChunk, Status>> + Send + 'static>>;

    async fn stream_output(
        &self,
        request: Request<proto::StreamOutputRequest>,
    ) -> GrpcResult<Self::StreamOutputStream> {
        let req = request.into_inner();

        // Clone the execution instead of removing it from the HashMap.
        // This keeps stdin/signal/resize accessible for interactive TTY sessions.
        let mut execution = {
            let executions = self.executions.read().await;
            let active = executions.get(&req.execution_id).ok_or_else(|| {
                Status::not_found(format!("execution not found: {}", req.execution_id))
            })?;
            active.execution.clone()
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

        // Wait for exit, send final chunk, then clean up
        let executions_ref = Arc::clone(&self.executions);
        let exec_id = req.execution_id.clone();
        tokio::spawn(async move {
            let result = execution.wait().await;
            let exit_code = match result {
                Ok(r) => r.exit_code,
                Err(_) => -1,
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

    // -- Health & Metrics --

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
