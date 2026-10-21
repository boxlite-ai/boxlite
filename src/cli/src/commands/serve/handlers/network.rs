use super::super::{AppState, error_from_boxlite, get_or_fetch_box};
use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
    response::{IntoResponse, Response},
};
use boxlite::runtime::options::{InboundNetworkConfig, OutboundNetworkConfig};
use std::sync::Arc;

// `Response` is wide enough to trip clippy's `result_large_err`; see
// `get_active_for_box` in executions.rs.
#[allow(clippy::result_large_err)]
fn policy_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    body.map(|Json(policy)| policy).map_err(|error| {
        error_from_boxlite(&boxlite::BoxliteError::InvalidArgument(error.body_text()))
    })
}

pub(in crate::commands::serve) async fn set_inbound(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    body: Result<Json<InboundNetworkConfig>, JsonRejection>,
) -> Response {
    let config = match policy_body(body) {
        Ok(config) => config,
        Err(error) => return error,
    };
    let handle = match get_or_fetch_box(&state, &box_id).await {
        Ok(handle) => handle,
        Err(error) => return error,
    };
    match handle.network().update_inbound(config.clone()).await {
        Ok(()) => Json(config).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn set_outbound(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    body: Result<Json<OutboundNetworkConfig>, JsonRejection>,
) -> Response {
    let config = match policy_body(body) {
        Ok(config) => config,
        Err(error) => return error,
    };
    let handle = match get_or_fetch_box(&state, &box_id).await {
        Ok(handle) => handle,
        Err(error) => return error,
    };
    match handle.network().update_outbound(config.clone()).await {
        Ok(()) => Json(config).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}
