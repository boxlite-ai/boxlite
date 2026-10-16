//! Image handlers (`/v1/images`).
//!
//! These answer from `runtime.images()`, which on the embedded runtime `serve`
//! runs is the local image cache. `usage` counts a catalog against a limit, and
//! a cache has neither, so it responds `400 UnsupportedError`; so do alias
//! creation and deletion, since a cache keeps no catalog of aliases.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use boxlite::runtime::types::ImageDetail;

use super::super::types::{
    CreateAliasRequest, ImageAliasEventResponse, ImageDetailResponse, ImageInfoResponse,
    ImageUsageResponse, ImageVersionResponse, ListImagesResponse,
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
        Ok(detail) => Json(detail_response(detail)).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn create_image_alias(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(request): Json<CreateAliasRequest>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle
        .create_alias(&name, &request.alias, &request.digest)
        .await
    {
        Ok(detail) => (StatusCode::CREATED, Json(detail_response(detail))).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn delete_image_alias(
    State(state): State<Arc<AppState>>,
    Path((name, alias)): Path<(String, String)>,
) -> Response {
    let handle = match state.runtime.images() {
        Ok(h) => h,
        Err(e) => return error_from_boxlite(&e),
    };
    match handle.delete_alias(&name, &alias).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

/// An image in the box API's shape, for a read and for alias creation alike.
fn detail_response(detail: ImageDetail) -> ImageDetailResponse {
    ImageDetailResponse {
        name: detail.name,
        aliases: detail.aliases,
        curated: detail.curated,
        versions: detail
            .versions
            .into_iter()
            .map(|version| ImageVersionResponse {
                recorded_at: version.recorded_at.to_rfc3339(),
                last_used_at: version.last_used_at.map(|time| time.to_rfc3339()),
                upstream_missing_at: version.upstream_missing_at.map(|time| time.to_rfc3339()),
                digest: version.digest,
                size_bytes: version.size_bytes,
                source_ref: version.source_ref,
                aliases: version.aliases,
            })
            .collect(),
        history: detail
            .history
            .into_iter()
            .map(|event| ImageAliasEventResponse {
                recorded_at: event.recorded_at.to_rfc3339(),
                alias: event.alias,
                from_digest: event.from_digest,
                to_digest: event.to_digest,
                actor: event.actor,
            })
            .collect(),
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
    use boxlite::runtime::types::{ImageAliasEvent, ImageVersion};
    use chrono::{TimeZone, Utc};
    use serde_json::{Value, json};
    use tokio::sync::RwLock;

    use super::super::super::AppState;
    use super::{ImageDetail, detail_response, get_image, image_usage, list_images, remove_image};

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
                    "name": name, "aliases": ["v1"], "curated": true,
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
        // An upstream that predates alias history leaves those fields at their
        // defaults, and serve still names every one of them.
        assert_eq!(
            body,
            json!({
                "name": "quay.io/acme/app", "aliases": ["v1"], "curated": true,
                "versions": [{
                    "digest": "sha256:aa", "size_bytes": 42,
                    "source_ref": "quay.io/acme/app:v1",
                    "recorded_at": "2026-01-02T03:04:05+00:00",
                    "aliases": [], "last_used_at": null, "upstream_missing_at": null,
                }],
                "history": [],
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

    /// serve's body names each field a catalog's does, so a REST runtime
    /// reads a version's aliases and times, and the history, from serve too.
    #[test]
    fn a_detail_carries_version_aliases_times_and_the_history() {
        let day = |day| Utc.with_ymd_and_hms(2026, 9, day, 0, 0, 0).unwrap();
        let detail = ImageDetail {
            name: "quay.io/acme/app".to_string(),
            aliases: vec!["stable".to_string()],
            curated: false,
            versions: vec![ImageVersion {
                digest: "sha256:bb".to_string(),
                size_bytes: None,
                source_ref: "quay.io/acme/app:v2".to_string(),
                recorded_at: day(1),
                aliases: vec!["stable".to_string()],
                last_used_at: Some(day(2)),
                upstream_missing_at: None,
            }],
            history: vec![ImageAliasEvent {
                alias: "stable".to_string(),
                from_digest: Some("sha256:aa".to_string()),
                to_digest: "sha256:bb".to_string(),
                actor: None,
                recorded_at: day(3),
            }],
        };

        let body = serde_json::to_value(detail_response(detail)).unwrap();

        assert_eq!(
            body,
            json!({
                "name": "quay.io/acme/app",
                "aliases": ["stable"],
                "curated": false,
                "versions": [{
                    "digest": "sha256:bb",
                    "size_bytes": null,
                    "source_ref": "quay.io/acme/app:v2",
                    "recorded_at": "2026-09-01T00:00:00+00:00",
                    "aliases": ["stable"],
                    "last_used_at": "2026-09-02T00:00:00+00:00",
                    "upstream_missing_at": null,
                }],
                "history": [{
                    "alias": "stable",
                    "from_digest": "sha256:aa",
                    "to_digest": "sha256:bb",
                    "actor": null,
                    "recorded_at": "2026-09-03T00:00:00+00:00",
                }],
            })
        );
    }
}
