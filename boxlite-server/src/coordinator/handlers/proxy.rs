//! Proxy handlers — translate REST requests to gRPC calls to the correct worker.

use std::sync::Arc;

use super::error::{error_response, grpc_to_http_error};
use super::types::{
    self, BoxMetrics, CreateBoxRequest, CreateSnapshotRequest, ExecutionInfo, ListBoxesResponse,
    ListImagesResponse, ListSnapshotsResponse, PullImageRequest, RemoveQuery, ResizeRequest,
    RestBoxResponse, RestExecRequest, RestExecResponse, RuntimeMetrics, SandboxCapabilities,
    SandboxConfig, SignalRequest, Snapshot, TokenResponse,
};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use futures::StreamExt;

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
// Auth, Config (local)
// ============================================================================

/// Exchange client credentials for an access token.
#[utoipa::path(
    post,
    path = "/v1/oauth/tokens",
    request_body = types::TokenRequest,
    responses(
        (status = 200, description = "Token issued", body = TokenResponse),
        (status = 401, description = "Invalid credentials", body = super::error::ErrorResponse),
    ),
    tag = "Authentication",
    security()
)]
pub async fn oauth_token() -> Response {
    Json(TokenResponse {
        access_token: "boxlite-coordinator-token".to_string(),
        token_type: "bearer".to_string(),
        expires_in: 86400,
        scope: None,
    })
    .into_response()
}

/// Get server configuration and capabilities.
#[utoipa::path(
    get,
    path = "/v1/config",
    responses(
        (status = 200, description = "Server configuration", body = SandboxConfig),
    ),
    tag = "Configuration",
    security()
)]
pub async fn get_config() -> Response {
    Json(SandboxConfig {
        defaults: None,
        overrides: None,
        capabilities: Some(SandboxCapabilities {
            max_cpus: None,
            max_memory_mib: None,
            max_disk_size_gb: None,
            max_boxes_per_prefix: None,
            max_concurrent_executions: None,
            file_transfer_max_bytes: None,
            exec_timeout_max_seconds: None,
            tty_enabled: Some(true),
            streaming_enabled: Some(true),
            snapshots_enabled: Some(true),
            clone_enabled: Some(true),
            export_enabled: Some(true),
            supported_security_presets: None,
            idempotency_key_lifetime: None,
        }),
    })
    .into_response()
}

// ============================================================================
// Box Handlers (REST -> gRPC)
// ============================================================================

/// Create a new sandbox box.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
    ),
    request_body = CreateBoxRequest,
    responses(
        (status = 201, description = "Box created", body = types::RestBoxResponse),
        (status = 400, description = "Invalid request", body = super::error::ErrorResponse),
        (status = 409, description = "Conflict", body = super::error::ErrorResponse),
        (status = 422, description = "Unprocessable entity", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn create_box(
    State(state): State<Arc<CoordinatorState>>,
    Path(prefix): Path<String>,
    Json(req): Json<CreateBoxRequest>,
) -> Response {
    tracing::info!(prefix = %prefix, "Creating box");
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
                namespace: prefix.clone(),
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

/// List boxes in a namespace.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("pageSize" = Option<u32>, Query, description = "Maximum number of results per page"),
        ("pageToken" = Option<String>, Query, description = "Opaque pagination token"),
        ("status" = Option<String>, Query, description = "Filter by box status"),
    ),
    responses(
        (status = 200, description = "List of boxes", body = ListBoxesResponse),
    ),
    tag = "Boxes",
)]
pub async fn list_boxes(
    State(state): State<Arc<CoordinatorState>>,
    Path(prefix): Path<String>,
) -> Response {
    tracing::info!(prefix = %prefix, "Listing boxes");

    let namespace_mappings = match state.store.list_box_mappings_by_namespace(&prefix).await {
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

    Json(ListBoxesResponse {
        boxes: all_boxes,
        next_page_token: None,
    })
    .into_response()
}

/// Get box details.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes/{box_id}",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier (ULID or name)"),
    ),
    responses(
        (status = 200, description = "Box details", body = types::RestBoxResponse),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn get_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((prefix, box_id)): Path<(String, String)>,
) -> Response {
    tracing::debug!(prefix = %prefix, box_id = %box_id, "Getting box");
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

/// Check if a box exists.
#[utoipa::path(
    head,
    path = "/v1/{prefix}/boxes/{box_id}",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier (ULID or name)"),
    ),
    responses(
        (status = 204, description = "Box exists"),
        (status = 404, description = "Box not found"),
    ),
    tag = "Boxes",
)]
pub async fn head_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((prefix, box_id)): Path<(String, String)>,
) -> Response {
    tracing::debug!(prefix = %prefix, box_id = %box_id, "Head box");
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match client.get_box(proto::GetBoxRequest { box_id }).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Remove a box.
#[utoipa::path(
    delete,
    path = "/v1/{prefix}/boxes/{box_id}",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier (ULID or name)"),
        ("force" = Option<bool>, Query, description = "Force removal even if running"),
    ),
    responses(
        (status = 204, description = "Box removed"),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
        (status = 409, description = "Box state conflict", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn remove_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((prefix, box_id)): Path<(String, String)>,
    axum::extract::Query(query): axum::extract::Query<RemoveQuery>,
) -> Response {
    tracing::info!(prefix = %prefix, box_id = %box_id, "Removing box");
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

/// Start a box.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/start",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier (ULID or name)"),
    ),
    responses(
        (status = 200, description = "Box started", body = types::RestBoxResponse),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
        (status = 409, description = "Box state conflict", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn start_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((prefix, box_id)): Path<(String, String)>,
) -> Response {
    tracing::info!(prefix = %prefix, box_id = %box_id, "Starting box");
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client.start_box(proto::StartBoxRequest { box_id }).await {
        Ok(resp) => Json(proto_to_rest(resp.into_inner())).into_response(),
        Err(status) => grpc_to_http_error(status),
    }
}

/// Stop a box.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/stop",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier (ULID or name)"),
    ),
    request_body(content = Option<types::StopBoxRequest>, description = "Optional stop parameters"),
    responses(
        (status = 200, description = "Box stopped", body = types::RestBoxResponse),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
        (status = 409, description = "Box state conflict", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn stop_box(
    State(state): State<Arc<CoordinatorState>>,
    Path((prefix, box_id)): Path<(String, String)>,
) -> Response {
    tracing::info!(prefix = %prefix, box_id = %box_id, "Stopping box");
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
// Snapshot / Clone / Export / Import Stubs
// ============================================================================

/// Create a snapshot.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/snapshots",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
    ),
    request_body = CreateSnapshotRequest,
    responses(
        (status = 201, description = "Snapshot created", body = Snapshot),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
        (status = 409, description = "Box state conflict", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn create_snapshot(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id)): Path<(String, String)>,
    Json(_req): Json<CreateSnapshotRequest>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Snapshots not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// List snapshots for a box.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes/{box_id}/snapshots",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
    ),
    responses(
        (status = 200, description = "List of snapshots", body = ListSnapshotsResponse),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn list_snapshots(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id)): Path<(String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Snapshots not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Get snapshot details.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes/{box_id}/snapshots/{snapshot_name}",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("snapshot_name" = String, Path, description = "Snapshot name"),
    ),
    responses(
        (status = 200, description = "Snapshot details", body = Snapshot),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn get_snapshot(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id, _snapshot_name)): Path<(String, String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Snapshots not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Remove a snapshot.
#[utoipa::path(
    delete,
    path = "/v1/{prefix}/boxes/{box_id}/snapshots/{snapshot_name}",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("snapshot_name" = String, Path, description = "Snapshot name"),
    ),
    responses(
        (status = 204, description = "Snapshot removed"),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
        (status = 409, description = "State conflict", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn remove_snapshot(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id, _snapshot_name)): Path<(String, String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Snapshots not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Restore a snapshot.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/snapshots/{snapshot_name}/restore",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("snapshot_name" = String, Path, description = "Snapshot name"),
    ),
    responses(
        (status = 204, description = "Snapshot restored"),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
        (status = 409, description = "State conflict", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn restore_snapshot(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id, _snapshot_name)): Path<(String, String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Snapshots not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Clone a box.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/clone",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
    ),
    request_body = types::CloneBoxRequest,
    responses(
        (status = 201, description = "Box cloned", body = types::RestBoxResponse),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
        (status = 409, description = "State conflict", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn clone_box(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id)): Path<(String, String)>,
    Json(_req): Json<types::CloneBoxRequest>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Clone not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Export a box.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/export",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
    ),
    responses(
        (status = 200, description = "Box archive (binary)", content_type = "application/octet-stream"),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn export_box(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id)): Path<(String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Export not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Import a box from an archive.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/import",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("name" = Option<String>, Query, description = "Name for the imported box"),
    ),
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    responses(
        (status = 201, description = "Box imported", body = types::RestBoxResponse),
        (status = 400, description = "Invalid archive", body = super::error::ErrorResponse),
    ),
    tag = "Boxes",
)]
pub async fn import_box(
    State(_state): State<Arc<CoordinatorState>>,
    Path(_prefix): Path<String>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Import not yet implemented via coordinator",
        "UnsupportedError",
    )
}

// ============================================================================
// Execution Handlers (REST -> gRPC)
// ============================================================================

/// Start a command execution.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/exec",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
    ),
    request_body = types::RestExecRequest,
    responses(
        (status = 201, description = "Execution started", body = types::RestExecResponse),
        (status = 400, description = "Invalid request", body = super::error::ErrorResponse),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
        (status = 409, description = "Box not running", body = super::error::ErrorResponse),
    ),
    tag = "Execution",
)]
pub async fn start_execution(
    State(state): State<Arc<CoordinatorState>>,
    Path((prefix, box_id)): Path<(String, String)>,
    Json(req): Json<RestExecRequest>,
) -> Response {
    tracing::debug!(prefix = %prefix, box_id = %box_id, "Starting execution");
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

/// Interactive TTY session via WebSocket.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes/{box_id}/exec/tty",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("command" = String, Query, description = "Command to run"),
        ("args" = Option<Vec<String>>, Query, description = "Command arguments"),
        ("cols" = Option<u32>, Query, description = "Terminal columns"),
        ("rows" = Option<u32>, Query, description = "Terminal rows"),
    ),
    responses(
        (status = 101, description = "WebSocket upgrade"),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
    ),
    tag = "Execution",
)]
pub async fn exec_tty(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id)): Path<(String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "TTY WebSocket not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Get execution status.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("exec_id" = String, Path, description = "Execution identifier"),
    ),
    responses(
        (status = 200, description = "Execution status", body = ExecutionInfo),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
    ),
    tag = "Execution",
)]
pub async fn get_execution(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id, exec_id)): Path<(String, String, String)>,
) -> Response {
    Json(ExecutionInfo {
        execution_id: exec_id,
        status: "running".to_string(),
        exit_code: None,
        started_at: None,
        duration_ms: None,
        error_message: None,
    })
    .into_response()
}

/// Stream execution output via SSE.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/output",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("exec_id" = String, Path, description = "Execution identifier"),
    ),
    responses(
        (status = 200, description = "SSE event stream", content_type = "text/event-stream"),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
    ),
    tag = "Execution",
)]
pub async fn stream_output(
    State(state): State<Arc<CoordinatorState>>,
    Path((_prefix, box_id, exec_id)): Path<(String, String, String)>,
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

/// Send stdin data to an execution.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/input",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("exec_id" = String, Path, description = "Execution identifier"),
    ),
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    responses(
        (status = 204, description = "Input sent"),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
        (status = 409, description = "Execution not running", body = super::error::ErrorResponse),
    ),
    tag = "Execution",
)]
pub async fn send_input(
    State(state): State<Arc<CoordinatorState>>,
    Path((_prefix, box_id, exec_id)): Path<(String, String, String)>,
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

/// Send a signal to an execution.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/signal",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("exec_id" = String, Path, description = "Execution identifier"),
    ),
    request_body = SignalRequest,
    responses(
        (status = 204, description = "Signal sent"),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
        (status = 409, description = "Execution not running", body = super::error::ErrorResponse),
    ),
    tag = "Execution",
)]
pub async fn send_signal(
    State(state): State<Arc<CoordinatorState>>,
    Path((_prefix, box_id, exec_id)): Path<(String, String, String)>,
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

/// Resize a TTY execution.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/resize",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("exec_id" = String, Path, description = "Execution identifier"),
    ),
    request_body = ResizeRequest,
    responses(
        (status = 204, description = "Resized"),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
        (status = 409, description = "Execution not running", body = super::error::ErrorResponse),
    ),
    tag = "Execution",
)]
pub async fn resize_tty(
    State(state): State<Arc<CoordinatorState>>,
    Path((_prefix, box_id, exec_id)): Path<(String, String, String)>,
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
// Files Stubs
// ============================================================================

/// Upload files to a box.
#[utoipa::path(
    put,
    path = "/v1/{prefix}/boxes/{box_id}/files",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("path" = String, Query, description = "Destination path inside the box"),
        ("overwrite" = Option<bool>, Query, description = "Overwrite existing files"),
    ),
    request_body(content = Vec<u8>, content_type = "application/x-tar"),
    responses(
        (status = 204, description = "Files uploaded"),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
        (status = 409, description = "Box not running", body = super::error::ErrorResponse),
    ),
    tag = "Files",
)]
pub async fn upload_files(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id)): Path<(String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "File transfer not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Download files from a box.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes/{box_id}/files",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
        ("path" = String, Query, description = "Path inside the box to download"),
        ("follow_symlinks" = Option<bool>, Query, description = "Follow symbolic links"),
    ),
    responses(
        (status = 200, description = "File archive (tar)", content_type = "application/x-tar"),
        (status = 404, description = "Not found", body = super::error::ErrorResponse),
        (status = 409, description = "Box not running", body = super::error::ErrorResponse),
    ),
    tag = "Files",
)]
pub async fn download_files(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _box_id)): Path<(String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "File transfer not yet implemented via coordinator",
        "UnsupportedError",
    )
}

// ============================================================================
// Metrics
// ============================================================================

/// Get aggregate runtime metrics.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/metrics",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
    ),
    responses(
        (status = 200, description = "Runtime metrics", body = RuntimeMetrics),
    ),
    tag = "Metrics",
)]
pub async fn runtime_metrics(
    State(state): State<Arc<CoordinatorState>>,
    Path(prefix): Path<String>,
) -> Response {
    tracing::debug!(prefix = %prefix, "Fetching runtime metrics");
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

    let mut total = RuntimeMetrics {
        boxes_created_total: 0,
        boxes_failed_total: 0,
        boxes_stopped_total: 0,
        num_running_boxes: 0,
        total_commands_executed: 0,
        total_exec_errors: 0,
    };

    for worker in workers.iter().filter(|w| w.status == WorkerStatus::Active) {
        match grpc_client(&worker.url).await {
            Ok(mut client) => {
                match client
                    .get_metrics(proto::GetMetricsRequest { box_id: None })
                    .await
                {
                    Ok(resp) => {
                        let m = resp.into_inner();
                        total.boxes_created_total += m.boxes_created_total;
                        total.boxes_failed_total += m.boxes_failed_total;
                        total.boxes_stopped_total += m.boxes_stopped_total;
                        total.num_running_boxes += m.num_running_boxes;
                        total.total_commands_executed += m.total_commands_executed;
                        total.total_exec_errors += m.total_exec_errors;
                    }
                    Err(e) => tracing::warn!(worker_id = %worker.id, "Failed to get metrics: {e}"),
                }
            }
            Err(_) => tracing::warn!(worker_id = %worker.id, "Worker unreachable for metrics"),
        }
    }

    Json(total).into_response()
}

/// Get per-box metrics.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/boxes/{box_id}/metrics",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("box_id" = String, Path, description = "Box identifier"),
    ),
    responses(
        (status = 200, description = "Box metrics", body = BoxMetrics),
        (status = 404, description = "Box not found", body = super::error::ErrorResponse),
    ),
    tag = "Metrics",
)]
pub async fn get_box_metrics(
    State(state): State<Arc<CoordinatorState>>,
    Path((_prefix, box_id)): Path<(String, String)>,
) -> Response {
    let mut client = match client_for_box(&state, &box_id).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match client
        .get_metrics(proto::GetMetricsRequest {
            box_id: Some(box_id),
        })
        .await
    {
        Ok(resp) => {
            let m = resp.into_inner();
            // Proto BoxMetrics doesn't carry boot_timing yet; populate from
            // the optional box_metrics field when present.
            let bm = m.box_metrics.unwrap_or_default();
            Json(BoxMetrics {
                commands_executed_total: bm.commands_executed_total,
                exec_errors_total: bm.exec_errors_total,
                bytes_sent_total: bm.bytes_sent_total,
                bytes_received_total: bm.bytes_received_total,
                cpu_percent: bm.cpu_percent,
                memory_bytes: bm.memory_bytes,
                network_bytes_sent: bm.network_bytes_sent,
                network_bytes_received: bm.network_bytes_received,
                network_tcp_connections: bm.network_tcp_connections,
                network_tcp_errors: bm.network_tcp_errors,
                boot_timing: None,
            })
            .into_response()
        }
        Err(status) => grpc_to_http_error(status),
    }
}

// ============================================================================
// Images Stubs
// ============================================================================

/// Pull an image from a registry.
#[utoipa::path(
    post,
    path = "/v1/{prefix}/images/pull",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
    ),
    request_body = PullImageRequest,
    responses(
        (status = 200, description = "Image pulled", body = types::ImageInfo),
        (status = 422, description = "Pull failed", body = super::error::ErrorResponse),
    ),
    tag = "Images",
)]
pub async fn pull_image(
    State(_state): State<Arc<CoordinatorState>>,
    Path(_prefix): Path<String>,
    Json(_req): Json<PullImageRequest>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Image management not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// List cached images.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/images",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("pageSize" = Option<u32>, Query, description = "Maximum number of results per page"),
        ("pageToken" = Option<String>, Query, description = "Opaque pagination token"),
    ),
    responses(
        (status = 200, description = "List of images", body = ListImagesResponse),
    ),
    tag = "Images",
)]
pub async fn list_images(
    State(_state): State<Arc<CoordinatorState>>,
    Path(_prefix): Path<String>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Image management not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Get image details.
#[utoipa::path(
    get,
    path = "/v1/{prefix}/images/{image_id}",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("image_id" = String, Path, description = "Image manifest digest"),
    ),
    responses(
        (status = 200, description = "Image details", body = types::ImageInfo),
        (status = 404, description = "Image not found", body = super::error::ErrorResponse),
    ),
    tag = "Images",
)]
pub async fn get_image(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _image_id)): Path<(String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Image management not yet implemented via coordinator",
        "UnsupportedError",
    )
}

/// Check if an image is cached.
#[utoipa::path(
    head,
    path = "/v1/{prefix}/images/{image_id}",
    params(
        ("prefix" = String, Path, description = "Organization or workspace identifier"),
        ("image_id" = String, Path, description = "Image manifest digest"),
    ),
    responses(
        (status = 204, description = "Image exists"),
        (status = 404, description = "Image not found"),
    ),
    tag = "Images",
)]
pub async fn image_exists(
    State(_state): State<Arc<CoordinatorState>>,
    Path((_prefix, _image_id)): Path<(String, String)>,
) -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        "Image management not yet implemented via coordinator",
        "UnsupportedError",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_proto_to_rest_full_fields() {
        let proto_resp = proto::BoxResponse {
            box_id: "01ABC".into(),
            name: Some("mybox".into()),
            status: "running".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            updated_at: "2024-01-01T00:01:00Z".into(),
            pid: Some(1234),
            image: "python:3.11".into(),
            cpus: 4,
            memory_mib: 1024,
            labels: HashMap::from([("env".into(), "prod".into())]),
        };
        let rest = proto_to_rest(proto_resp);
        assert_eq!(rest.box_id, "01ABC");
        assert_eq!(rest.name.as_deref(), Some("mybox"));
        assert_eq!(rest.status, "running");
        assert_eq!(rest.pid, Some(1234));
        assert_eq!(rest.cpus, 4);
        assert_eq!(rest.memory_mib, 1024);
        assert_eq!(rest.labels["env"], "prod");
    }

    #[test]
    fn test_proto_to_rest_optional_none() {
        let proto_resp = proto::BoxResponse {
            box_id: "01XYZ".into(),
            name: None,
            status: "stopped".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            updated_at: "2024-01-01T00:00:00Z".into(),
            pid: None,
            image: "alpine".into(),
            cpus: 1,
            memory_mib: 128,
            labels: HashMap::new(),
        };
        let rest = proto_to_rest(proto_resp);
        assert!(rest.name.is_none());
        assert!(rest.pid.is_none());
    }

    #[test]
    fn test_proto_to_rest_empty_labels() {
        let proto_resp = proto::BoxResponse {
            box_id: "01".into(),
            name: None,
            status: "configured".into(),
            created_at: String::new(),
            updated_at: String::new(),
            pid: None,
            image: "alpine".into(),
            cpus: 1,
            memory_mib: 128,
            labels: HashMap::new(),
        };
        let rest = proto_to_rest(proto_resp);
        assert!(rest.labels.is_empty());
    }
}
