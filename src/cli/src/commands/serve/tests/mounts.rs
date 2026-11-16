//! No-VM mount route boundaries.
//!
//! What needs a real VM — the delivery flow, the lazy detach, `detaching`
//! convergence — is covered by the KVM suite. Here we pin the routing
//! contract that is checkable without one: the `target` query parameter is
//! mandatory on the `by-target` routes, and runtime failures surface as the
//! shared error body rather than a hang or a panic.

use axum::extract::Path;
use axum::extract::Query;

use super::super::handlers::mounts::{add_mount, get_mount, remove_mount};
use super::super::types::CreateMountRequest;
use super::*;

async fn status_of(response: Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = if body.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    (status, body)
}

#[tokio::test]
async fn by_target_routes_reject_a_missing_target_query() {
    let state = Arc::new(lifecycle_state());
    let empty: HashMap<String, String> = HashMap::new();

    let (status, body) = status_of(
        get_mount(
            State(state.clone()),
            Path("box-1".to_string()),
            Query(empty.clone()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_argument");

    let (status, body) =
        status_of(remove_mount(State(state), Path("box-1".to_string()), Query(empty)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_argument");
}

#[tokio::test]
async fn by_target_routes_reject_an_empty_target_query() {
    let state = Arc::new(lifecycle_state());
    let mut query = HashMap::new();
    query.insert("target".to_string(), String::new());

    let (status, _) = status_of(
        get_mount(
            State(state.clone()),
            Path("box-1".to_string()),
            Query(query.clone()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) =
        status_of(remove_mount(State(state), Path("box-1".to_string()), Query(query)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_unreachable_runtime_surfaces_the_shared_error_body() {
    // lifecycle_state points the REST runtime at a port nothing listens on,
    // so every box lookup fails; the handlers must map that, not hang.
    let state = Arc::new(lifecycle_state());

    let (status, body) = status_of(
        add_mount(
            State(state.clone()),
            Path("box-1".to_string()),
            Json(CreateMountRequest {
                source: "/host/a".to_string(),
                target: "/box/a".to_string(),
                read_only: false,
            }),
        )
        .await,
    )
    .await;
    assert!(status.is_server_error(), "got {status}");
    assert!(
        !body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .is_empty()
    );

    let (status, _) = status_of(
        remove_mount(
            State(state),
            Path("box-1".to_string()),
            Query(HashMap::from([(
                "target".to_string(),
                "/box/a".to_string(),
            )])),
        )
        .await,
    )
    .await;
    assert!(status.is_server_error(), "got {status}");
}
