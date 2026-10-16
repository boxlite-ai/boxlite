//! Image handlers (`/v1/images`).
//!
//! These answer from `runtime.images()`, which on the embedded runtime `serve`
//! runs is the local image cache. `usage` counts a catalog against a limit, and
//! a cache has neither, so it responds `400 UnsupportedError`.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::super::types::{
    ImageDetailResponse, ImageInfoResponse, ImageUsageResponse, ImageVersionResponse,
    ListImagesResponse,
};
use super::super::{AppState, error_from_boxlite};

pub(in crate::commands::serve) async fn list_images(
    State(state): State<Arc<AppState>>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.list().await {
        Ok(images) => {
            let images = images
                .into_iter()
                .map(|image| ImageInfoResponse {
                    cached_at: image.cached_at.to_rfc3339(),
                    size_bytes: image.size.map(|size| size.0),
                    reference: image.reference,
                    repository: image.repository,
                    tag: image.tag,
                    id: image.id,
                })
                .collect();
            Json(ListImagesResponse { images }).into_response()
        }
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn get_image(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.get(&name).await {
        Ok(detail) => Json(ImageDetailResponse {
            name: detail.name,
            tags: detail.tags,
            curated: detail.curated,
            versions: detail
                .versions
                .into_iter()
                .map(|version| ImageVersionResponse {
                    recorded_at: version.recorded_at.to_rfc3339(),
                    digest: version.digest,
                    size_bytes: version.size_bytes,
                    source_ref: version.source_ref,
                })
                .collect(),
        })
        .into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn remove_image(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.remove(&name).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn image_usage(
    State(state): State<Arc<AppState>>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.usage().await {
        Ok(usage) => Json(ImageUsageResponse {
            count: usage.count,
            limit: usage.limit,
            known_bytes: usage.known_bytes,
        })
        .into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

#[cfg(test)]
mod tests {
    //! `serve` runs a local runtime, and only a registry pull fills its cache.
    //! The handlers read `runtime.images()` on any runtime, so these give them
    //! a REST runtime whose upstream answers with fixed rows, and check how
    //! each answer reaches the wire.

    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::extract::{Path, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::{delete, get};
    use boxlite::BoxliteRuntime;
    use serde_json::{Value, json};
    use tokio::sync::RwLock;

    use super::super::super::AppState;
    use super::{get_image, image_usage, list_images, remove_image};

    /// Handler state whose runtime is a REST client of `upstream`.
    async fn state_over(upstream: Router) -> State<Arc<AppState>> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let _ = axum::serve(listener, upstream).await;
        });
        State(Arc::new(AppState {
            runtime: BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(url))
                .expect("rest runtime"),
            boxes: RwLock::new(HashMap::new()),
            executions: RwLock::new(HashMap::new()),
            api_key: None,
            lifecycle: RwLock::new(HashMap::new()),
            last_activity: RwLock::new(HashMap::new()),
        }))
    }

    /// An upstream answering `GET path` with `body`.
    fn answering(path: &str, body: Value) -> Router {
        Router::new().route(
            path,
            get(move || {
                let body = body.clone();
                async move { axum::Json(body) }
            }),
        )
    }

    async fn read(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        if bytes.is_empty() {
            return (status, Value::Null);
        }
        (status, serde_json::from_slice(&bytes).expect("JSON body"))
    }

    #[tokio::test]
    async fn list_answers_each_row_with_its_time_in_rfc3339() {
        let state = state_over(answering(
            "/v1/images",
            json!({"images": [{
                "reference": "quay.io/acme/app:v1", "repository": "quay.io/acme/app",
                "tag": "v1", "id": "sha256:aa", "cached_at": "2026-01-02T03:04:05Z",
                "size_bytes": 42,
            }]}),
        ))
        .await;

        let (status, body) = read(list_images(state).await).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({"images": [{
                "reference": "quay.io/acme/app:v1", "repository": "quay.io/acme/app",
                "tag": "v1", "id": "sha256:aa", "cached_at": "2026-01-02T03:04:05+00:00",
                "size_bytes": 42,
            }]})
        );
    }

    /// The name reaches the runtime whole, slashes and all, and every version
    /// comes back.
    #[tokio::test]
    async fn get_answers_every_version_of_the_name_asked_for() {
        let upstream = Router::new().route(
            "/v1/images/{name}",
            get(|Path(name): Path<String>| async move {
                axum::Json(json!({
                    "name": name, "tags": ["v1"], "curated": true,
                    "versions": [{
                        "digest": "sha256:aa", "size_bytes": 42,
                        "source_ref": format!("{name}:v1"),
                        "recorded_at": "2026-01-02T03:04:05Z",
                    }],
                }))
            }),
        );
        let state = state_over(upstream).await;

        let (status, body) = read(get_image(state, Path("quay.io/acme/app".into())).await).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "name": "quay.io/acme/app", "tags": ["v1"], "curated": true,
                "versions": [{
                    "digest": "sha256:aa", "size_bytes": 42,
                    "source_ref": "quay.io/acme/app:v1",
                    "recorded_at": "2026-01-02T03:04:05+00:00",
                }],
            })
        );
    }

    #[tokio::test]
    async fn remove_answers_no_content_once_the_runtime_removed_the_name() {
        let removed = Arc::new(Mutex::new(Vec::<String>::new()));
        let upstream = Router::new().route(
            "/v1/images/{name}",
            delete({
                let removed = Arc::clone(&removed);
                move |Path(name): Path<String>| async move {
                    removed.lock().unwrap().push(name);
                    StatusCode::NO_CONTENT
                }
            }),
        );
        let state = state_over(upstream).await;

        let (status, body) = read(remove_image(state, Path("quay.io/acme/app".into())).await).await;

        assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
        assert_eq!(*removed.lock().unwrap(), ["quay.io/acme/app"]);
    }

    /// A refusal keeps its kind on the wire: an image a box still boots from
    /// is a conflict, naming the box, not a server fault.
    #[tokio::test]
    async fn a_remove_the_runtime_refuses_answers_with_its_status_and_reason() {
        let upstream = Router::new().route(
            "/v1/images/{name}",
            delete(|| async {
                let refusal = json!({"error": {
                    "message": "in use by box b1", "type": "InvalidStateError",
                    "code": "invalid_state",
                }});
                (StatusCode::CONFLICT, axum::Json(refusal)).into_response()
            }),
        );
        let state = state_over(upstream).await;

        let (status, body) = read(remove_image(state, Path("quay.io/acme/app".into())).await).await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["type"], "InvalidStateError");
        assert_eq!(body["error"]["code"], "invalid_state");
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("b1"), "{body}");
    }

    #[tokio::test]
    async fn usage_answers_count_limit_and_known_bytes() {
        let usage = json!({"count": 3, "limit": 20, "known_bytes": 4096});
        let state = state_over(answering("/v1/images/usage", usage.clone())).await;

        let (status, body) = read(image_usage(state).await).await;

        assert_eq!((status, body), (StatusCode::OK, usage));
    }
}
