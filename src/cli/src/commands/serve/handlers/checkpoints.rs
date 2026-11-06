//! Local serve composes the same managed disk archives as the embedded SDK.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};

use super::super::types::{
    CheckpointBoxRequest, CreateBoxRequest, CreateCheckpointRequest, RecoverCheckpointRequest,
    RemoveQuery,
};
use super::super::{AppState, error_from_boxlite};

#[allow(clippy::result_large_err)]
fn checkpoint_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    body.map(|Json(request)| request)
        .map_err(|error| invalid_request(error.body_text()))
}

fn invalid_request(message: String) -> Response {
    error_from_boxlite(&boxlite::BoxliteError::InvalidArgument(message))
}

pub(in crate::commands::serve) async fn create(
    State(state): State<Arc<AppState>>,
    body: Result<Json<CreateCheckpointRequest>, JsonRejection>,
) -> Response {
    let request = match checkpoint_body(body) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state
        .runtime
        .checkpoints()
        .create(&request.source_box_id, request.name)
        .await
    {
        Ok(info) => (StatusCode::CREATED, Json(info)).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn list(State(state): State<Arc<AppState>>) -> Response {
    match state.runtime.checkpoints().list().await {
        Ok(infos) => Json(serde_json::json!({"checkpoints": infos})).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn get(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Response {
    match state.runtime.checkpoints().get(&key).await {
        Ok(info) => Json(info).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn remove(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Query(query): Query<RemoveQuery>,
) -> Response {
    match state
        .runtime
        .checkpoints()
        .remove(&key, query.force.unwrap_or(false))
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn create_box(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    // Select by the discriminator before decoding: invalid checkpoint options
    // must never fall through to ordinary image creation.
    if body.get("checkpoint_id").is_some() {
        match serde_json::from_value::<CheckpointBoxRequest>(body) {
            Err(error) => invalid_request(error.to_string()),
            Ok(request) => {
                match state
                    .runtime
                    .checkpoints()
                    .create_box(&request.checkpoint_id, request.name)
                    .await
                {
                    Ok(bx) => box_response(&state, bx, StatusCode::CREATED).await,
                    Err(error) => error_from_boxlite(&error),
                }
            }
        }
    } else {
        match serde_json::from_value::<CreateBoxRequest>(body) {
            Ok(request) => super::boxes::create_box(State(state), Json(request)).await,
            // Keep the pre-checkpoint image endpoint's deserialization status.
            Err(error) => (StatusCode::UNPROCESSABLE_ENTITY, error.to_string()).into_response(),
        }
    }
}

pub(in crate::commands::serve) async fn recover_box(
    State(state): State<Arc<AppState>>,
    Path(target): Path<String>,
    body: Result<Json<RecoverCheckpointRequest>, JsonRejection>,
) -> Response {
    let request = match checkpoint_body(body) {
        Ok(request) => request,
        Err(error) => return error,
    };
    let old_id = match state.runtime.get_info(&target).await {
        Ok(info) => info.map(|info| info.id.to_string()),
        Err(error) => return error_from_boxlite(&error),
    };
    let result = state
        .runtime
        .checkpoints()
        .recover_box(&request.checkpoint_id, &target)
        .await;
    // An old handle is invalid after replacement, including an import failure
    // after removal. Evict it even on failure; a surviving box is fetched anew.
    state
        .boxes
        .write()
        .await
        .retain(|key, bx| key != &target && old_id.as_deref() != Some(bx.id().as_ref()));
    if let Some(id) = old_id
        && matches!(state.runtime.get_info(&id).await, Ok(None))
    {
        state.forget_box(&id).await;
        state.forget_box(&target).await;
    }
    match result {
        Ok(bx) => box_response(&state, bx, StatusCode::OK).await,
        Err(error) => error_from_boxlite(&error),
    }
}

async fn box_response(state: &AppState, bx: boxlite::LiteBox, status: StatusCode) -> Response {
    match bx.info().await {
        Ok(info) => {
            let response = state.box_response(&info).await;
            state
                .boxes
                .write()
                .await
                .insert(info.id.to_string(), Arc::new(bx));
            (status, Json(response)).into_response()
        }
        Err(error) => error_from_boxlite(&error),
    }
}
