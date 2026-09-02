//! Box CRUD and lifecycle handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::super::types::{CreateBoxRequest, ListBoxesResponse, RemoveQuery};
use super::super::{
    AppState, build_box_options, error_from_boxlite, error_response, get_or_fetch_box,
};

pub(in crate::commands::serve) async fn create_box(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateBoxRequest>,
) -> Response {
    let name = req.name.clone();
    // The wire body is untrusted input, and `build_box_options` no longer hands
    // these fields to the engine — so the engine's own rejection of an invalid
    // pair no longer stands behind them. Validate here, at the boundary, or
    // serve would accept and enforce `auto_delete <= auto_stop`, which the
    // contract forbids and the cloud refuses.
    let requested = boxlite::BoxLifecyclePolicy {
        auto_stop: req.auto_stop.unwrap_or(0),
        auto_delete: req.auto_delete.unwrap_or(0),
        auto_resume: req.auto_resume.unwrap_or(true),
    };
    if let Err(e) = requested.validate() {
        return error_response(
            StatusCode::BAD_REQUEST,
            e.to_string(),
            "InvalidArgumentError",
            "invalid_argument",
        );
    }

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

    let info = match litebox.info().await {
        Ok(info) => info,
        Err(e) => return error_from_boxlite(&e),
    };
    let box_id = info.id.to_string();
    // `build_box_options` deliberately withholds both deadlines from the
    // runtime, so this is the only record of them. Stored before the response is
    // built, so `box_response` reads back the policy the caller asked for.
    state
        .set_lifecycle(
            &box_id,
            crate::commands::serve::LifecyclePolicy {
                auto_stop: requested.auto_stop,
                auto_delete: requested.auto_delete,
            },
        )
        .await;
    let resp = state.box_response(&info).await;

    state.boxes.write().await.insert(box_id, Arc::new(litebox));

    (StatusCode::CREATED, Json(resp)).into_response()
}

pub(in crate::commands::serve) async fn list_boxes(State(state): State<Arc<AppState>>) -> Response {
    match state.runtime.list_info().await {
        Ok(infos) => {
            let mut boxes = Vec::with_capacity(infos.len());
            for info in &infos {
                boxes.push(state.box_response(info).await);
            }
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
        Ok(Some(info)) => Json(state.box_response(&info).await).into_response(),
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
    match state.runtime.exists(&box_id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
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
    let cached = state.boxes.read().await.get(&box_id).cloned();
    if let Some(cached) = cached {
        let info = match cached.info().await {
            Ok(info) => info,
            Err(e) => return error_from_boxlite(&e),
        };
        if !info.status.is_active() {
            let mut boxes = state.boxes.write().await;
            if boxes
                .get(&box_id)
                .is_some_and(|current| Arc::ptr_eq(current, &cached))
            {
                boxes.remove(&box_id);
            }
        }
    }

    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    if let Err(e) = litebox.start().await {
        return error_from_boxlite(&e);
    }

    let info = match litebox.info().await {
        Ok(info) => info,
        Err(e) => return error_from_boxlite(&e),
    };
    Json(state.box_response(&info).await).into_response()
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

    let info = match litebox.info().await {
        Ok(info) => info,
        Err(e) => return error_from_boxlite(&e),
    };
    Json(state.box_response(&info).await).into_response()
}

pub(in crate::commands::serve) async fn remove_box(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Query(query): Query<RemoveQuery>,
) -> Response {
    state.boxes.write().await.remove(&box_id);
    let force = query.force.unwrap_or(true);

    // Resolved before the box is gone, because the deadline is filed under the
    // box's own id while the request may name it by a user-defined name. A
    // remove-by-name that forgot only the spelling it was given would leak the
    // id-keyed deadline for the life of the process — `retain_known_boxes`
    // prunes the idle clock but deliberately never touches this map.
    // A failure here is not fatal to the delete, but it is not free either: the
    // fallback is exactly the leak this resolution exists to prevent.
    let canonical = match state.runtime.get_info(&box_id).await {
        Ok(info) => info.map(|info| info.id.to_string()),
        Err(error) => {
            tracing::warn!(
                box_id = %box_id,
                %error,
                "could not resolve box id before removal; a deadline filed under \
                 another spelling will be left behind"
            );
            None
        }
    };

    match state.runtime.remove(&box_id, force).await {
        Ok(()) => {
            // Drop the deadline and idle clock with the box, or both maps keep
            // an entry per deleted box for the lifetime of the process.
            state.forget_box(&box_id).await;
            if let Some(canonical) = canonical.filter(|id| id != &box_id) {
                state.forget_box(&canonical).await;
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => error_from_boxlite(&e),
    }
}
