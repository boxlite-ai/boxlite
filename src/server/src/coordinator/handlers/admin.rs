//! Admin endpoints for worker management.
//!
//! These are coordinator-only REST endpoints for platform operators and
//! dashboards. Workers communicate with the coordinator via gRPC, not REST.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, extract::Path};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::coordinator::state::CoordinatorState;
use crate::types::{WorkerCapacity, WorkerStatus};

// ── Request/Response Types ──

#[derive(Serialize, ToSchema)]
pub struct WorkerListResponse {
    pub workers: Vec<WorkerSummary>,
}

#[derive(Serialize, ToSchema)]
pub struct WorkerSummary {
    pub id: String,
    pub name: String,
    pub url: String,
    /// One of: active, draining, unreachable, removed
    pub status: String,
    pub running_boxes: u32,
    pub last_heartbeat: String,
}

/// Full worker details returned by get and update endpoints.
#[derive(Serialize, ToSchema)]
pub struct WorkerDetail {
    pub id: String,
    pub name: String,
    pub url: String,
    pub labels: std::collections::HashMap<String, String>,
    pub status: String,
    pub capacity: WorkerCapacity,
    pub registered_at: String,
    pub last_heartbeat: String,
}

#[derive(Deserialize, ToSchema)]
pub struct UpdateWorkerStatusRequest {
    /// Target status. Only "active" and "draining" are allowed.
    pub status: String,
}

// ── Handlers ──

/// List all workers
///
/// Returns all registered workers with their current status and capacity.
#[utoipa::path(
    get,
    path = "/v1/admin/workers",
    responses(
        (status = 200, description = "List of workers", body = WorkerListResponse),
        (status = 500, description = "Internal server error")
    ),
    tag = "Workers"
)]
pub async fn list_workers(State(state): State<Arc<CoordinatorState>>) -> Response {
    match state.store.list_workers().await {
        Ok(workers) => {
            let summaries: Vec<WorkerSummary> = workers
                .iter()
                .map(|w| WorkerSummary {
                    id: w.id.clone(),
                    name: w.name.clone(),
                    url: w.url.clone(),
                    status: w.status.as_str().to_string(),
                    running_boxes: w.capacity.running_boxes,
                    last_heartbeat: w.last_heartbeat.to_rfc3339(),
                })
                .collect();
            Json(WorkerListResponse { workers: summaries }).into_response()
        }
        Err(e) => {
            tracing::error!("Failed to list workers: {e}");
            super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            )
        }
    }
}

/// Get a worker by ID
///
/// Returns full details for a single worker.
#[utoipa::path(
    get,
    path = "/v1/admin/workers/{worker_id}",
    params(
        ("worker_id" = String, Path, description = "Worker ID (12-char Base62)")
    ),
    responses(
        (status = 200, description = "Worker details", body = WorkerDetail),
        (status = 404, description = "Worker not found"),
        (status = 500, description = "Internal server error")
    ),
    tag = "Workers"
)]
pub async fn get_worker(
    State(state): State<Arc<CoordinatorState>>,
    Path(worker_id): Path<String>,
) -> Response {
    match state.store.get_worker(&worker_id).await {
        Ok(Some(w)) => Json(WorkerDetail {
            id: w.id,
            name: w.name,
            url: w.url,
            labels: w.labels,
            status: w.status.as_str().to_string(),
            capacity: w.capacity,
            registered_at: w.registered_at.to_rfc3339(),
            last_heartbeat: w.last_heartbeat.to_rfc3339(),
        })
        .into_response(),
        Ok(None) => super::error::error_response(
            StatusCode::NOT_FOUND,
            format!("Worker not found: {worker_id}"),
            "NotFoundError",
        ),
        Err(e) => {
            tracing::error!("Failed to get worker {worker_id}: {e}");
            super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            )
        }
    }
}

/// Remove a worker
///
/// Removes a worker and all its box mappings (cascade delete).
#[utoipa::path(
    delete,
    path = "/v1/admin/workers/{worker_id}",
    params(
        ("worker_id" = String, Path, description = "Worker ID to remove")
    ),
    responses(
        (status = 204, description = "Worker removed"),
        (status = 500, description = "Internal server error")
    ),
    tag = "Workers"
)]
pub async fn remove_worker(
    State(state): State<Arc<CoordinatorState>>,
    Path(worker_id): Path<String>,
) -> Response {
    match state.store.remove_worker(&worker_id).await {
        Ok(()) => {
            tracing::info!(worker_id = %worker_id, "Worker removed");
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to remove worker {worker_id}: {e}");
            super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            )
        }
    }
}

/// Update worker status
///
/// Set a worker's status. Only `active` and `draining` transitions are allowed.
#[utoipa::path(
    patch,
    path = "/v1/admin/workers/{worker_id}/status",
    params(
        ("worker_id" = String, Path, description = "Worker ID")
    ),
    request_body = UpdateWorkerStatusRequest,
    responses(
        (status = 200, description = "Status updated", body = WorkerDetail),
        (status = 400, description = "Invalid status transition"),
        (status = 404, description = "Worker not found"),
        (status = 500, description = "Internal server error")
    ),
    tag = "Workers"
)]
pub async fn update_worker_status(
    State(state): State<Arc<CoordinatorState>>,
    Path(worker_id): Path<String>,
    Json(req): Json<UpdateWorkerStatusRequest>,
) -> Response {
    let new_status = match req.status.as_str() {
        "active" => WorkerStatus::Active,
        "draining" => WorkerStatus::Draining,
        other => {
            return super::error::error_response(
                StatusCode::BAD_REQUEST,
                format!(
                    "Invalid status: \"{other}\". Only \"active\" and \"draining\" are allowed."
                ),
                "ValidationError",
            );
        }
    };

    // Check worker exists
    let worker = match state.store.get_worker(&worker_id).await {
        Ok(Some(w)) => w,
        Ok(None) => {
            return super::error::error_response(
                StatusCode::NOT_FOUND,
                format!("Worker not found: {worker_id}"),
                "NotFoundError",
            );
        }
        Err(e) => {
            tracing::error!("Failed to get worker {worker_id}: {e}");
            return super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            );
        }
    };

    if let Err(e) = state
        .store
        .update_worker_status(&worker_id, new_status)
        .await
    {
        tracing::error!("Failed to update worker {worker_id} status: {e}");
        return super::error::error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            e.to_string(),
            "InternalError",
        );
    }

    tracing::info!(worker_id = %worker_id, status = %new_status, "Worker status updated");

    Json(WorkerDetail {
        id: worker.id,
        name: worker.name,
        url: worker.url,
        labels: worker.labels,
        status: new_status.as_str().to_string(),
        capacity: worker.capacity,
        registered_at: worker.registered_at.to_rfc3339(),
        last_heartbeat: worker.last_heartbeat.to_rfc3339(),
    })
    .into_response()
}

/// Find worker for a box
///
/// Look up which worker owns a given box.
#[utoipa::path(
    get,
    path = "/v1/admin/workers/by-box/{box_id}",
    params(
        ("box_id" = String, Path, description = "Box ID to look up")
    ),
    responses(
        (status = 200, description = "Worker that owns this box", body = WorkerDetail),
        (status = 404, description = "Box not routed to any worker"),
        (status = 500, description = "Internal server error")
    ),
    tag = "Workers"
)]
pub async fn get_worker_by_box(
    State(state): State<Arc<CoordinatorState>>,
    Path(box_id): Path<String>,
) -> Response {
    // Look up box → worker mapping
    let mapping = match state.store.get_box_mapping(&box_id).await {
        Ok(Some(m)) => m,
        Ok(None) => {
            return super::error::error_response(
                StatusCode::NOT_FOUND,
                format!("Box not routed to any worker: {box_id}"),
                "NotFoundError",
            );
        }
        Err(e) => {
            tracing::error!("Failed to get box mapping for {box_id}: {e}");
            return super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            );
        }
    };

    // Look up the worker
    match state.store.get_worker(&mapping.worker_id).await {
        Ok(Some(w)) => Json(WorkerDetail {
            id: w.id,
            name: w.name,
            url: w.url,
            labels: w.labels,
            status: w.status.as_str().to_string(),
            capacity: w.capacity,
            registered_at: w.registered_at.to_rfc3339(),
            last_heartbeat: w.last_heartbeat.to_rfc3339(),
        })
        .into_response(),
        Ok(None) => super::error::error_response(
            StatusCode::NOT_FOUND,
            format!(
                "Worker {} no longer exists for box {box_id}",
                mapping.worker_id
            ),
            "NotFoundError",
        ),
        Err(e) => {
            tracing::error!("Failed to get worker {}: {e}", mapping.worker_id);
            super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            )
        }
    }
}
