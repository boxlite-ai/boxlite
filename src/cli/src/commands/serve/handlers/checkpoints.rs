//! Local serve composes the same managed disk archives as the embedded SDK.

use std::sync::Arc;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use super::super::types::{
    CreateCheckpointRequest, ImportCheckpointRequest, ImportQuery, RemoveQuery,
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
    let source = match state.runtime.get_info(&request.source_box_id).await {
        Ok(Some(info)) => info,
        Ok(None) => {
            return error_from_boxlite(&boxlite::BoxliteError::NotFound(request.source_box_id));
        }
        Err(error) => return error_from_boxlite(&error),
    };
    let checkpoint_operation = state
        .checkpoint_operation(source.id.as_ref(), source.name.as_deref())
        .await;
    // A named source may have been replaced while its operation lock was busy.
    let source = match state.runtime.get_info(&request.source_box_id).await {
        Ok(Some(info)) => {
            state
                .bind_checkpoint_operation(&checkpoint_operation, &info)
                .await;
            info.id.to_string()
        }
        Ok(None) => {
            return error_from_boxlite(&boxlite::BoxliteError::NotFound(request.source_box_id));
        }
        Err(error) => return error_from_boxlite(&error),
    };
    if !state.lifecycle_of(&source).await.is_empty() {
        return invalid_request("Disable auto_stop and auto_delete before capturing a local checkpoint; their deadlines cannot be preserved in the archive".into());
    }
    match state
        .runtime
        .checkpoints()
        .create(&source, request.name)
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

pub(in crate::commands::serve) async fn import_box(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ImportQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let media_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("application/octet-stream")
        .trim();
    if media_type.eq_ignore_ascii_case("application/octet-stream") {
        return super::advanced::import_box(State(state), Query(query), body).await;
    }
    if !media_type.eq_ignore_ascii_case("application/json") {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected JSON or a .boxlite archive",
        )
            .into_response();
    }
    if query.name.is_some() {
        return invalid_request("JSON import accepts name in the body only".into());
    }
    let request: ImportCheckpointRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return invalid_request(error.to_string()),
    };
    if request.name.is_some() && request.box_id.is_some() {
        return invalid_request("name and box_id are mutually exclusive".into());
    }
    let Some(target) = request.box_id else {
        return match state
            .runtime
            .checkpoints()
            .import_box(&request.checkpoint_id, request.name, None)
            .await
        {
            Ok(bx) => box_response(&state, bx, StatusCode::CREATED, None).await,
            Err(error) => error_from_boxlite(&error),
        };
    };
    // A second named replacement must resolve the result of the first one,
    // otherwise it evicts the original ID while leaving the intermediate handle.
    let info = match state.runtime.get_info(&target).await {
        Ok(info) => info,
        Err(error) => return error_from_boxlite(&error),
    };
    // Missing targets may still have a durable failed import to resume. Keep
    // their supplied ID/name serialized and let the runtime decide existence.
    let replacement = state
        .checkpoint_operation(
            info.as_ref()
                .map_or(target.as_str(), |info| info.id.as_ref()),
            info.as_ref()
                .map_or(Some(target.as_str()), |info| info.name.as_deref()),
        )
        .await;
    let old_id = match state.runtime.get_info(&target).await {
        Ok(Some(info)) => {
            state.bind_checkpoint_operation(&replacement, &info).await;
            Some(info.id.to_string())
        }
        Ok(None) => None,
        Err(error) => return error_from_boxlite(&error),
    };
    let result = state
        .runtime
        .checkpoints()
        .import_box(&request.checkpoint_id, None, Some(&target))
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
        Ok(bx) => box_response(&state, bx, StatusCode::OK, Some(&replacement)).await,
        Err(error) => error_from_boxlite(&error),
    }
}

async fn box_response(
    state: &AppState,
    bx: boxlite::LiteBox,
    status: StatusCode,
    operation: Option<&tokio::sync::OwnedMutexGuard<()>>,
) -> Response {
    match bx.info().await {
        Ok(info) => {
            if let Some(operation) = operation {
                state.bind_checkpoint_operation(operation, &info).await;
            }
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
