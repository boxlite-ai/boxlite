//! Box CRUD and lifecycle handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::super::types::{CreateBoxRequest, ListBoxesResponse, RemoveQuery};
use super::super::{
    AppState, box_info_to_response, build_box_options, classify_boxlite_error, error_response,
    get_or_fetch_box,
};

pub(in crate::commands::serve) async fn create_box(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateBoxRequest>,
) -> Response {
    let name = req.name.clone();
    let options = build_box_options(&req);

    let litebox = match state.runtime.create(options, name).await {
        Ok(b) => b,
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            return error_response(status, e.to_string(), etype);
        }
    };

    let info = litebox.info();
    let box_id = info.id.to_string();
    let resp = box_info_to_response(&info);

    state.boxes.write().await.insert(box_id, Arc::new(litebox));

    (StatusCode::CREATED, Json(resp)).into_response()
}

pub(in crate::commands::serve) async fn list_boxes(State(state): State<Arc<AppState>>) -> Response {
    match state.runtime.list_info().await {
        Ok(infos) => {
            let boxes = infos.iter().map(box_info_to_response).collect();
            Json(ListBoxesResponse { boxes }).into_response()
        }
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn get_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    match state.runtime.get_info(&box_id).await {
        Ok(Some(info)) => Json(box_info_to_response(&info)).into_response(),
        Ok(None) => error_response(
            StatusCode::NOT_FOUND,
            format!("box not found: {box_id}"),
            "NotFoundError",
        ),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn head_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    match state.runtime.get_info(&box_id).await {
        Ok(Some(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn start_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    if let Err(e) = litebox.start().await {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    let info = litebox.info();
    Json(box_info_to_response(&info)).into_response()
}

pub(in crate::commands::serve) async fn stop_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    if let Err(e) = litebox.stop().await {
        let (status, etype) = classify_boxlite_error(&e);
        return error_response(status, e.to_string(), etype);
    }

    let info = litebox.info();
    Json(box_info_to_response(&info)).into_response()
}

pub(in crate::commands::serve) async fn remove_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Query(query): Query<RemoveQuery>,
) -> Response {
    state.boxes.write().await.remove(&box_id);
    let force = query.force.unwrap_or(true);

    match state.runtime.remove(&box_id, force).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}
