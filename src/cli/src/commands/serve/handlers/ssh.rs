//! Guest SSH control handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use boxlite::SshConfig;

use super::super::{
    AppState, error_from_boxlite, error_response, get_or_fetch_box, get_or_resume_box,
};

/// A rejected body never repeats serde's message, which can quote secret values.
const INVALID_CONFIG: &str = "invalid SSH configuration";

/// Replace SSH configuration. The guest restarts the listener on every accepted
/// request, so this handler issues exactly one operation and never retries it.
pub(in crate::commands::serve) async fn configure_ssh(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    body: Result<Json<SshConfig>, JsonRejection>,
) -> Response {
    let Json(config) = match body {
        Ok(body) => body,
        Err(_) => return invalid_config(),
    };

    let litebox = match get_or_resume_box(&state, &box_id).await {
        Ok(litebox) => litebox,
        Err(response) => return response,
    };

    match litebox.ssh().configure(config).await {
        Ok(status) => Json(status).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

/// Observe SSH state without starting the VM or its main command.
pub(in crate::commands::serve) async fn status_ssh(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(litebox) => litebox,
        Err(response) => return response,
    };

    match litebox.ssh().status().await {
        Ok(status) => Json(status).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

/// Disable SSH idempotently without starting the VM or its main command.
pub(in crate::commands::serve) async fn disable_ssh(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(litebox) => litebox,
        Err(response) => return response,
    };

    match litebox.ssh().disable().await {
        Ok(status) => Json(status).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

fn invalid_config() -> Response {
    error_response(
        StatusCode::BAD_REQUEST,
        INVALID_CONFIG,
        "InvalidArgumentError",
        "invalid_argument",
    )
}
