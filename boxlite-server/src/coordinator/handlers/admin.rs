//! Admin endpoints for worker management.
//!
//! These are coordinator-only endpoints (not part of the boxlite serve API).
//! Workers call these to register and send heartbeats.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, extract::Path};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::coordinator::state::CoordinatorState;
use crate::types::{WorkerCapacity, WorkerInfo, WorkerStatus, mint_worker_id, mint_worker_name};

// ── Request/Response Types ──

#[derive(Deserialize, ToSchema)]
pub struct RegisterWorkerRequest {
    /// Worker gRPC endpoint URL (e.g., "http://worker1:9100")
    pub url: String,
    /// Arbitrary labels for scheduling affinity
    #[serde(default)]
    pub labels: std::collections::HashMap<String, String>,
    /// Current worker capacity
    #[serde(default)]
    pub capacity: WorkerCapacity,
}

#[derive(Serialize, ToSchema)]
pub struct RegisterWorkerResponse {
    /// Assigned worker ID (12-char Base62)
    pub worker_id: String,
    /// Auto-generated human-readable name
    pub name: String,
}

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

#[derive(Deserialize, ToSchema)]
pub struct HeartbeatPayload {
    /// Updated worker capacity
    #[serde(default)]
    pub capacity: WorkerCapacity,
}

// ── Handlers ──

/// Register a new worker
///
/// Workers call this on startup to register with the coordinator.
#[utoipa::path(
    post,
    path = "/v1/admin/workers",
    request_body = RegisterWorkerRequest,
    responses(
        (status = 201, description = "Worker registered successfully", body = RegisterWorkerResponse),
        (status = 500, description = "Internal server error")
    ),
    tag = "Workers"
)]
pub async fn register_worker(
    State(state): State<Arc<CoordinatorState>>,
    Json(req): Json<RegisterWorkerRequest>,
) -> Response {
    let now = Utc::now();

    // Check if a worker with this URL already exists (re-registration after restart)
    let workers = match state.store.list_workers().await {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("Failed to list workers for re-registration check: {e}");
            return super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            );
        }
    };
    let existing = workers.into_iter().find(|w| w.url == req.url);

    let (worker_id, worker_name, registered_at) = match existing {
        Some(w) => {
            tracing::info!(worker_id = %w.id, name = %w.name, url = %req.url, "Worker re-registering (same URL)");
            (w.id, w.name, w.registered_at)
        }
        None => (mint_worker_id(), mint_worker_name(), now),
    };

    let worker = WorkerInfo {
        id: worker_id.clone(),
        name: worker_name.clone(),
        url: req.url,
        labels: req.labels,
        registered_at,
        last_heartbeat: now,
        status: WorkerStatus::Active,
        capacity: req.capacity,
    };

    match state.store.upsert_worker(&worker).await {
        Ok(()) => {
            tracing::info!(worker_id = %worker_id, name = %worker_name, url = %worker.url, "Worker registered");
            (
                StatusCode::CREATED,
                Json(RegisterWorkerResponse {
                    worker_id,
                    name: worker_name,
                }),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("Failed to register worker: {e}");
            super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            )
        }
    }
}

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

/// Send worker heartbeat
///
/// Workers call this periodically to report health and updated capacity.
#[utoipa::path(
    post,
    path = "/v1/admin/workers/{worker_id}/heartbeat",
    params(
        ("worker_id" = String, Path, description = "Worker ID")
    ),
    request_body = HeartbeatPayload,
    responses(
        (status = 200, description = "Heartbeat accepted"),
        (status = 500, description = "Internal server error")
    ),
    tag = "Workers"
)]
pub async fn worker_heartbeat(
    State(state): State<Arc<CoordinatorState>>,
    Path(worker_id): Path<String>,
    Json(req): Json<HeartbeatPayload>,
) -> Response {
    match state
        .store
        .update_worker_heartbeat(&worker_id, &req.capacity)
        .await
    {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to update heartbeat for {worker_id}: {e}");
            super::error::error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
                "InternalError",
            )
        }
    }
}
