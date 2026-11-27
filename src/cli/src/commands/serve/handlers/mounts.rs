//! Directory declarations use the same handle as embedded clients. The runtime
//! owns source authorization and delivery, including each subsequent start.

use std::sync::Arc;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use boxlite::experimental::{ExperimentalFeature, ExperimentalFeatures};
use boxlite::{BoxliteError, MountHandle, MountRequest};
use percent_encoding::percent_decode_str;

use super::super::types::ListMountsResponse;
use super::super::{AppState, error_from_boxlite, get_or_fetch_box};

fn target(uri: &Uri) -> Result<String, &'static str> {
    let mut values = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            percent_decode_str(key).eq(*b"target").then_some(value)
        });
    let value = match (values.next(), values.next()) {
        (Some(value), None) if !value.is_empty() => value,
        _ => return Err("expected one nonempty 'target' query parameter"),
    };
    // Decode form spaces without replacing invalid UTF-8 in a container path.
    let mut bytes = Vec::with_capacity(value.len());
    for (index, part) in value.split('+').enumerate() {
        if index != 0 {
            bytes.push(b' ');
        }
        bytes.extend(percent_decode_str(part));
    }
    String::from_utf8(bytes).map_err(|_| "mount target must be valid UTF-8")
}

fn invalid_request(message: &str) -> Response {
    error_from_boxlite(&BoxliteError::InvalidArgument(message.into()))
}

async fn with_mounts<T: IntoResponse>(
    state: &AppState,
    box_id: &str,
    operation: impl AsyncFnOnce(MountHandle) -> Result<T, BoxliteError>,
) -> Response {
    let handle = match get_or_fetch_box(state, box_id).await {
        Ok(handle) => handle,
        Err(response) => return response,
    };
    match operation(handle.mount()).await {
        Ok(value) => value.into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn add(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    body: Result<Json<MountRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return invalid_request("expected a mount source, target and optional read_only flag");
    };
    with_mounts(&state, &box_id, async move |mount| {
        Ok((StatusCode::CREATED, Json(mount.add(request).await?)))
    })
    .await
}

pub(in crate::commands::serve) async fn list(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    with_mounts(&state, &box_id, async |mount| {
        Ok(Json(ListMountsResponse {
            mounts: mount.list().await?,
        }))
    })
    .await
}

pub(in crate::commands::serve) async fn get(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    uri: Uri,
) -> Response {
    let target = match target(&uri) {
        Ok(target) => target,
        Err(message) => return invalid_request(message),
    };
    with_mounts(&state, &box_id, async move |mount| {
        mount.get(target).await.map(Json)
    })
    .await
}

pub(in crate::commands::serve) async fn remove(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    uri: Uri,
) -> Response {
    let target = match target(&uri) {
        Ok(target) => target,
        Err(message) => return invalid_request(message),
    };
    with_mounts(&state, &box_id, async move |mount| {
        mount.remove(target).await?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

pub(super) fn enabled(features: &ExperimentalFeatures) -> bool {
    cfg!(all(target_os = "linux", target_arch = "x86_64"))
        && features.is_enabled(ExperimentalFeature::NativeVmm)
}

pub(in crate::commands::serve) async fn require_enabled(request: Request, next: Next) -> Response {
    if request
        .extensions()
        .get::<ExperimentalFeatures>()
        .is_some_and(enabled)
    {
        return next.run(request).await;
    }
    error_from_boxlite(&BoxliteError::Unsupported(
        "runtime directory mounts require BOXLITE_EXPERIMENTAL=native-vmm on a Linux x86_64 server"
            .into(),
    ))
}
