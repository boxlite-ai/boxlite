//! Health probe endpoints for the coordinator.
//!
//! These are unauthenticated endpoints for orchestrators (k8s liveness/readiness).

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

use crate::coordinator::state::CoordinatorState;
use crate::types::WorkerStatus;

#[derive(Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Serialize, ToSchema)]
pub struct ReadinessResponse {
    pub status: String,
    pub active_workers: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Liveness probe
///
/// Returns 200 if the coordinator process is running.
#[utoipa::path(
    get,
    path = "/v1/health",
    responses(
        (status = 200, description = "Coordinator is alive", body = HealthResponse),
    ),
    tag = "Health",
    security(())
)]
pub async fn liveness() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

/// Readiness probe
///
/// Returns 200 if the coordinator is ready to serve traffic.
/// Checks that the database is accessible and at least one active worker exists.
#[utoipa::path(
    get,
    path = "/v1/health/ready",
    responses(
        (status = 200, description = "Coordinator is ready", body = ReadinessResponse),
        (status = 503, description = "Coordinator is not ready", body = ReadinessResponse),
    ),
    tag = "Health",
    security(())
)]
pub async fn readiness(State(state): State<Arc<CoordinatorState>>) -> Response {
    let workers = match state.store.list_workers().await {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("Readiness check failed: {e}");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ReadinessResponse {
                    status: "not_ready".to_string(),
                    active_workers: 0,
                    reason: Some(format!("Database error: {e}")),
                }),
            )
                .into_response();
        }
    };

    let active_count = workers
        .iter()
        .filter(|w| w.status == WorkerStatus::Active)
        .count() as u32;

    if active_count == 0 {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ReadinessResponse {
                status: "not_ready".to_string(),
                active_workers: 0,
                reason: Some("No active workers".to_string()),
            }),
        )
            .into_response();
    }

    Json(ReadinessResponse {
        status: "ready".to_string(),
        active_workers: active_count,
        reason: None,
    })
    .into_response()
}
