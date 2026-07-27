//! Box CRUD and lifecycle handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::super::types::{CreateBoxRequest, ListBoxesResponse, RemoveQuery};
use super::super::{
    AppState, box_info_to_response, build_box_options, error_from_boxlite, error_response,
    get_or_fetch_box,
};

pub(in crate::commands::serve) async fn create_box(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateBoxRequest>,
) -> Response {
    let name = req.name.clone();
    let options = match build_box_options(&req) {
        Ok(options) => options,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                e.to_string(),
                "InvalidArgumentError",
                "invalid_argument",
            );
        }
    };

    let litebox = match state.runtime.create(options, name).await {
        Ok(b) => b,
        Err(e) => return error_from_boxlite(&e),
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
        Err(e) => error_from_boxlite(&e),
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
            "not_found",
        ),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn head_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    match state.runtime.get_info(&box_id).await {
        Ok(Some(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn start_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    // A box now stops *itself* when its main command exits, leaving a spent
    // handle — it holds the dead VM's LiveState and `BoxImpl::start` refuses it.
    // Drop a spent handle so a fresh one reboots from persisted state. A handle
    // that is still Running is kept, though: `run --url` attaches (which boots
    // the box) and only then calls `/start` to run its init, and dropping the
    // live VM between the two would strand the client's attach on a dead guest.
    {
        let mut boxes = state.boxes.write().await;
        let spent = boxes
            .get(&box_id)
            .is_some_and(|b| !b.info().status.is_active());
        if spent {
            boxes.remove(&box_id);
        }
    }

    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    if let Err(e) = litebox.start().await {
        return error_from_boxlite(&e);
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
        return error_from_boxlite(&e);
    }

    // stop() cancels the box's token, which invalidates this handle for good.
    // Keeping it cached would hand the next request a handle that answers every
    // call with "invalidated after stop()".
    state.boxes.write().await.remove(&box_id);

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
        Err(e) => error_from_boxlite(&e),
    }
}
