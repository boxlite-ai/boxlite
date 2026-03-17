//! Proxy handlers — translate REST requests to gRPC calls to the correct worker.

use std::sync::Arc;

use super::error::{error_response, grpc_to_http_error};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use futures::StreamExt;
use serde::{Deserialize, Serialize};

use crate::coordinator::state::CoordinatorState;
use crate::proto;
use crate::proto::worker_service_client::WorkerServiceClient;
use crate::types::{BoxMapping, ScheduleRequest, WorkerStatus};

// ============================================================================
// gRPC Client Helper
// ============================================================================

async fn grpc_client(
    worker_url: &str,
) -> Result<WorkerServiceClient<tonic::transport::Channel>, Response> {
    WorkerServiceClient::connect(worker_url.to_string())
        .await
        .map_err(|e| {
            tracing::error!("Failed to connect to worker {worker_url}: {e}");
            error_response(
                StatusCode::BAD_GATEWAY,
                format!("Worker unreachable: {e}"),
                "ProxyError",
            )
        })
}

async fn client_for_box(
    state: &CoordinatorState,
    box_id: &str,
) -> Result<WorkerServiceClient<tonic::transport::Channel>, Response> {
    let mapping = state
        .store
        .get_box_mapping(box_id)
        .await
        .map_err(|e| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            )
        })?
        .ok_or_else(|| {
            error_response(
                StatusCode::NOT_FOUND,
                format!("box not found: {box_id}"),
                "NotFoundError",
            )
        })?;

    let worker = state
        .store
        .get_worker(&mapping.worker_id)
        .await
        .map_err(|e| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            )
        })?
        .ok_or_else(|| {
            error_response(
                StatusCode::BAD_GATEWAY,
                "Worker not found in registry",
                "ProxyError",
            )
        })?;

    if worker.status != WorkerStatus::Active {
        return Err(error_response(
            StatusCode::BAD_GATEWAY,
            "Worker is not active",
            "ProxyError",
        ));
    }

    grpc_client(&worker.url).await
}

// ============================================================================
// Wire Types (REST JSON)
// ============================================================================

#[derive(Deserialize)]
pub struct CreateBoxRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    rootfs_path: Option<String>,
    #[serde(default)]
    cpus: Option<u8>,
    #[serde(default)]
    memory_mib: Option<u32>,
    #[serde(default)]
    disk_size_gb: Option<u64>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    entrypoint: Option<Vec<String>>,
    #[serde(default)]
    cmd: Option<Vec<String>>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    auto_remove: Option<bool>,
    #[serde(default)]
    detach: Option<bool>,
}

#[derive(Serialize)]
struct RestBoxResponse {
    box_id: String,
    name: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    pid: Option<u32>,
    image: String,
    cpus: u32,
    memory_mib: u32,
    labels: std::collections::HashMap<String, String>,
}

#[derive(Serialize)]
struct ListBoxesResponse {
    boxes: Vec<RestBoxResponse>,
}

#[derive(Deserialize)]
pub struct RestExecRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    timeout_seconds: Option<f64>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    tty: bool,
}

#[derive(Serialize)]
struct RestExecResponse {
    execution_id: String,
}

#[derive(Deserialize)]
pub struct RemoveQuery {
    #[serde(default)]
    force: Option<bool>,
}

#[derive(Deserialize)]
pub struct SignalRequest {
    signal: i32,
}

#[derive(Deserialize)]
pub struct ResizeRequest {
    cols: u32,
    rows: u32,
}

// ============================================================================
// Helpers
// ============================================================================

fn proto_to_rest(resp: proto::BoxResponse) -> RestBoxResponse {
    RestBoxResponse {
        box_id: resp.box_id,
        name: resp.name,
        status: resp.status,
        created_at: resp.created_at,
        updated_at: resp.updated_at,
        pid: resp.pid,
        image: resp.image,
        cpus: resp.cpus,
        memory_mib: resp.memory_mib,
        labels: resp.labels,
    }
}

// ============================================================================
// Box Handlers (REST -> gRPC)
// ============================================================================

pub async fn create_box(
    State(state): State<Arc<CoordinatorState>>,
    Path(namespace): Path<String>,
    Json(req): Json<CreateBoxRequest>,
) -> Response {
    tracing::info!(namespace = %namespace, "Creating box in namespace");
    let schedule_req = ScheduleRequest {
        cpus: req.cpus,
        memory_mib: req.memory_mib,
    };

    let worker = match state
        .scheduler
        .select_worker(state.store.as_ref(), &schedule_req)
        .await
    {
        Ok(w) => w,
        Err(e) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                e.to_string(),
                "NoWorkersAvailable",
            );
        }
    };

    let mut client = match grpc_client(&worker.url).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    let grpc_req = proto::CreateBoxRequest {
        name: req.name,
        image: req.image,
        rootfs_path: req.rootfs_path,
        cpus: req.cpus.map(|c| c as u32),
        memory_mib: req.memory_mib,
        disk_size_gb: req.disk_size_gb,
        working_dir: req.working_dir,
        env: req.env.unwrap_or_default(),
        entrypoint: req.entrypoint.unwrap_or_default(),
        cmd: req.cmd.unwrap_or_default(),
        user: req.user,
        auto_remove: req.auto_remove.unwrap_or(false),
        detach: req.detach.unwrap_or(true),
    };

    match client.create_box(grpc_req).await {
        Ok(resp) => {
            let resp = resp.into_inner();
            let mapping = BoxMapping {
                box_id: resp.box_id.clone(),
                worker_id: worker.id.clone(),
                namespace: namespace.clone(),
                created_at: chrono::Utc::now(),
            };
            if let Err(e) = state.store.insert_box_mapping(&mapping).await {
                tracing::error!("Failed to record box mapping: {e}");
            }
            tracing::info!(box_id = %resp.box_id, worker_id = %worker.id, "Box created on worker");
            (StatusCode::CREATED, Json(proto_to_rest(resp))).into_response()
        }
        Err(status) => grpc_to_http_error(status),
    }
}

pub async fn list_boxes(
    State(state): State<Arc<CoordinatorState>>,
    Path(namespace): Path<String>,
) -> Response {
    tracing::info!(namespace = %namespace, "Listing boxes in namespace");

    // Get box IDs that belong to this namespace
    let namespace_mappings = match state.store.list_box_mappings_by_namespace(&namespace).await {
        Ok(m) => m,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            );
        }
    };
    let namespace_box_ids: std::collections::HashSet<String> =
        namespace_mappings.into_iter().map(|m| m.box_id).collect();

    let workers = match state.store.list_workers().await {
        Ok(w) => w,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            );
        }
    };

    let mut all_boxes = Vec::new();
    for worker in workers.iter().filter(|w| w.status == WorkerStatus::Active) {
        match grpc_client(&worker.url).await {
            Ok(mut client) => match client.list_boxes(proto::ListBoxesRequest {}).await {
                Ok(resp) => {
                    for b in resp.into_inner().boxes {
                        if namespace_box_ids.contains(&b.box_id) {
                            all_boxes.push(proto_to_rest(b));
                        }
                    }
                }
                Err(e) => tracing::warn!(worker_id = %worker.id, "Failed to list boxes: {e}"),
            },
            Err(_) => tracing::warn!(worker_id = %worker.id, "Worker unreachable during list"),
        }
    }

    Json(ListBoxesResponse { boxes: all_boxes }).into_response()
}

pub async fn get_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((namespace, box_id)): Path<(String, String)>,
) -> Response {
    tracing::debug!(namespace = %namespace, box_id = %box_id, "Getting box");
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client
        .get_box(proto::GetBoxRequest {
            box_id: box_id.clone(),
        })
        .await
    {
        Ok(resp) => Json(proto_to_rest(resp.into_inner())).into_response(),
        Err(status) => grpc_to_http_error(status),
    }
}

pub async fn head_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((namespace, box_id)): Path<(String, String)>,
) -> Response {
    tracing::debug!(namespace = %namespace, box_id = %box_id, "Head box");
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match client.get_box(proto::GetBoxRequest { box_id }).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

pub async fn remove_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((namespace, box_id)): Path<(String, String)>,
    axum::extract::Query(query): axum::extract::Query<RemoveQuery>,
) -> Response {
    tracing::info!(namespace = %namespace, box_id = %box_id, "Removing box");
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client
        .remove_box(proto::RemoveBoxRequest {
            box_id: box_id.clone(),
            force: query.force.unwrap_or(true),
        })
        .await
    {
        Ok(_) => {
            let _ = state.store.remove_box_mapping(&box_id).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(status) => grpc_to_http_error(status),
    }
}

pub async fn start_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((namespace, box_id)): Path<(String, String)>,
) -> Response {
    tracing::info!(namespace = %namespace, box_id = %box_id, "Starting box");
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client.start_box(proto::StartBoxRequest { box_id }).await {
        Ok(resp) => Json(proto_to_rest(resp.into_inner())).into_response(),
        Err(status) => grpc_to_http_error(status),
    }
}

pub async fn stop_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((namespace, box_id)): Path<(String, String)>,
) -> Response {
    tracing::info!(namespace = %namespace, box_id = %box_id, "Stopping box");
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client.stop_box(proto::StopBoxRequest { box_id }).await {
        Ok(resp) => Json(proto_to_rest(resp.into_inner())).into_response(),
        Err(status) => grpc_to_http_error(status),
    }
}

// ============================================================================
// Execution Handlers (REST -> gRPC)
// ============================================================================

pub async fn start_execution(
    State(state): State<Arc<CoordinatorState>>,
    Path((namespace, box_id)): Path<(String, String)>,
    Json(req): Json<RestExecRequest>,
) -> Response {
    tracing::debug!(namespace = %namespace, box_id = %box_id, "Starting execution");
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client
        .exec(proto::ExecRequest {
            box_id,
            command: req.command,
            args: req.args,
            env: req.env.unwrap_or_default(),
            working_dir: req.working_dir,
            tty: req.tty,
            timeout_seconds: req.timeout_seconds,
        })
        .await
    {
        Ok(resp) => (
            StatusCode::CREATED,
            Json(RestExecResponse {
                execution_id: resp.into_inner().execution_id,
            }),
        )
            .into_response(),
        Err(status) => grpc_to_http_error(status),
    }
}

pub async fn get_execution(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_namespace, _box_id, exec_id)): Path<(String, String, String)>,
) -> Response {
    Json(serde_json::json!({"execution_id": exec_id, "status": "running"})).into_response()
}

/// GET .../output — gRPC server-stream -> SSE
pub async fn stream_output(
    State(state): State<Arc<CoordinatorState>>,
    Path((_namespace, box_id, exec_id)): Path<(String, String, String)>,
) -> Response {
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    let grpc_stream = match client
        .stream_output(proto::StreamOutputRequest {
            box_id,
            execution_id: exec_id,
        })
        .await
    {
        Ok(resp) => resp.into_inner(),
        Err(status) => return grpc_to_http_error(status),
    };

    let b64 = base64::engine::general_purpose::STANDARD;
    let stream = async_stream::stream! {
        let mut stream = grpc_stream;
        while let Some(result) = stream.next().await {
            match result {
                Ok(chunk) => {
                    if chunk.done {
                        let exit_data = serde_json::json!({
                            "exit_code": chunk.exit_code.unwrap_or(-1),
                            "duration_ms": 0,
                        }).to_string();
                        yield Ok::<_, std::convert::Infallible>(
                            Event::default().event("exit").data(exit_data)
                        );
                        break;
                    }
                    let event_type = if chunk.output_type == proto::OutputType::Stderr as i32 {
                        "stderr"
                    } else {
                        "stdout"
                    };
                    let encoded = b64.encode(&chunk.data);
                    let data = serde_json::json!({"data": encoded}).to_string();
                    yield Ok(Event::default().event(event_type).data(data));
                }
                Err(e) => {
                    tracing::error!("gRPC stream error: {e}");
                    break;
                }
            }
        }
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

pub async fn send_input(
    State(state): State<Arc<CoordinatorState>>,
    Path((_namespace, box_id, exec_id)): Path<(String, String, String)>,
    body: axum::body::Bytes,
) -> Response {
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client
        .send_input(proto::SendInputRequest {
            box_id,
            execution_id: exec_id,
            data: body.to_vec(),
        })
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(status) => grpc_to_http_error(status),
    }
}

pub async fn send_signal(
    State(state): State<Arc<CoordinatorState>>,
    Path((_namespace, box_id, exec_id)): Path<(String, String, String)>,
    Json(req): Json<SignalRequest>,
) -> Response {
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client
        .send_signal(proto::SendSignalRequest {
            box_id,
            execution_id: exec_id,
            signal: req.signal,
        })
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(status) => grpc_to_http_error(status),
    }
}

pub async fn resize_tty(
    State(state): State<Arc<CoordinatorState>>,
    Path((_namespace, box_id, exec_id)): Path<(String, String, String)>,
    Json(req): Json<ResizeRequest>,
) -> Response {
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client
        .resize_tty(proto::ResizeTtyRequest {
            box_id,
            execution_id: exec_id,
            cols: req.cols,
            rows: req.rows,
        })
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(status) => grpc_to_http_error(status),
    }
}

// ============================================================================
// Auth, Config, Metrics (local or aggregated)
// ============================================================================

pub async fn oauth_token() -> Response {
    Json(serde_json::json!({
        "access_token": "boxlite-coordinator-token",
        "token_type": "Bearer",
        "expires_in": 86400
    }))
    .into_response()
}

pub async fn get_config() -> Response {
    Json(serde_json::json!({
        "capabilities": {
            "snapshots_enabled": true,
            "clone_enabled": true,
            "export_enabled": true,
            "import_enabled": true
        }
    }))
    .into_response()
}

pub async fn runtime_metrics(
    State(state): State<Arc<CoordinatorState>>,
    Path(namespace): Path<String>,
) -> Response {
    tracing::debug!(namespace = %namespace, "Fetching runtime metrics");
    let workers = match state.store.list_workers().await {
        Ok(w) => w,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            );
        }
    };

    let mut total = serde_json::json!({
        "boxes_created_total": 0u64,
        "boxes_failed_total": 0u64,
        "boxes_stopped_total": 0u64,
        "num_running_boxes": 0u64,
        "total_commands_executed": 0u64,
        "total_exec_errors": 0u64,
    });

    for worker in workers.iter().filter(|w| w.status == WorkerStatus::Active) {
        match grpc_client(&worker.url).await {
            Ok(mut client) => {
                match client
                    .get_metrics(proto::GetMetricsRequest { box_id: None })
                    .await
                {
                    Ok(resp) => {
                        let m = resp.into_inner();
                        for (key, val) in [
                            ("boxes_created_total", m.boxes_created_total),
                            ("boxes_failed_total", m.boxes_failed_total),
                            ("boxes_stopped_total", m.boxes_stopped_total),
                            ("num_running_boxes", m.num_running_boxes),
                            ("total_commands_executed", m.total_commands_executed),
                            ("total_exec_errors", m.total_exec_errors),
                        ] {
                            if let Some(t) = total[key].as_u64() {
                                total[key] = serde_json::json!(t + val);
                            }
                        }
                    }
                    Err(e) => tracing::warn!(worker_id = %worker.id, "Failed to get metrics: {e}"),
                }
            }
            Err(_) => tracing::warn!(worker_id = %worker.id, "Worker unreachable for metrics"),
        }
    }

    Json(total).into_response()
}
