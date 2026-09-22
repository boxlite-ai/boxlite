//! SSH control shares the operation resolver so AutoResume cannot be bypassed.
use super::super::{AppState, error_from_boxlite, get_or_resume_box};
use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
    response::{IntoResponse, Response},
};
use std::sync::Arc;

pub(in crate::commands::serve) async fn configure(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    config: Result<Json<boxlite::SshConfig>, JsonRejection>,
) -> Response {
    let config = match config {
        Ok(Json(config)) => config,
        Err(_) => {
            return error_from_boxlite(&boxlite::BoxliteError::InvalidArgument(
                "invalid SSH configuration JSON".into(),
            ));
        }
    };
    let sandbox = match get_or_resume_box(&state, &box_id).await {
        Ok(b) => b,
        Err(response) => return response,
    };
    match sandbox.ssh().configure(config).await {
        Ok(status) => Json(status).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn status(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let sandbox = match get_or_resume_box(&state, &box_id).await {
        Ok(b) => b,
        Err(response) => return response,
    };
    match sandbox.ssh().status().await {
        Ok(status) => Json(status).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn disable(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let sandbox = match get_or_resume_box(&state, &box_id).await {
        Ok(b) => b,
        Err(response) => return response,
    };
    match sandbox.ssh().disable().await {
        Ok(status) => Json(status).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}
