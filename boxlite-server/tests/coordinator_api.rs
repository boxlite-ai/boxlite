//! Integration tests for the coordinator REST API.
//!
//! Tests admin endpoints (worker registration, heartbeat, removal),
//! local endpoints (oauth, config), and metrics — all without requiring
//! a running worker or VM.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

use boxlite_server::coordinator::build_router;
use boxlite_server::coordinator::state::CoordinatorState;
use boxlite_server::scheduler::LeastLoadedScheduler;
use boxlite_server::store::StateStore;
use boxlite_server::store::sqlite::SqliteStateStore;

/// Build a test coordinator app with a temp SQLite database.
fn test_app() -> (axum::Router, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("test.db");
    let store = SqliteStateStore::open(&db_path).unwrap();
    let state = Arc::new(CoordinatorState {
        store: Arc::new(store) as Arc<dyn StateStore>,
        scheduler: Arc::new(LeastLoadedScheduler),
    });
    (build_router(state), tmp)
}

/// Helper: send a request and return (status, body as JSON).
async fn send_json(app: &axum::Router, req: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    (status, json)
}

// ============================================================================
// Worker Registration
// ============================================================================

#[tokio::test]
async fn test_register_worker() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("POST")
        .uri("/v1/admin/workers")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({
                "url": "http://worker1:9100",
                "capacity": {
                    "max_boxes": 10,
                    "available_cpus": 4,
                    "available_memory_mib": 8192,
                    "running_boxes": 0
                }
            })
            .to_string(),
        ))
        .unwrap();

    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::CREATED);
    assert!(body["worker_id"].is_string());
    assert!(body["name"].is_string());
    // ID should be 12-char Base62
    assert_eq!(body["worker_id"].as_str().unwrap().len(), 12);
}

#[tokio::test]
async fn test_register_worker_reregistration_preserves_id() {
    let (app, _tmp) = test_app();

    // Register first time
    let req = Request::builder()
        .method("POST")
        .uri("/v1/admin/workers")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({"url": "http://worker1:9100"}).to_string(),
        ))
        .unwrap();
    let (_, first) = send_json(&app, req).await;
    let first_id = first["worker_id"].as_str().unwrap().to_string();
    let first_name = first["name"].as_str().unwrap().to_string();

    // Re-register with same URL
    let req = Request::builder()
        .method("POST")
        .uri("/v1/admin/workers")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({"url": "http://worker1:9100"}).to_string(),
        ))
        .unwrap();
    let (status, second) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::CREATED);
    // Same URL should reuse existing worker ID and name
    assert_eq!(second["worker_id"].as_str().unwrap(), first_id);
    assert_eq!(second["name"].as_str().unwrap(), first_name);
}

// ============================================================================
// List Workers
// ============================================================================

#[tokio::test]
async fn test_list_workers_empty() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["workers"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn test_list_workers_after_registration() {
    let (app, _tmp) = test_app();

    // Register two workers
    for url in ["http://worker1:9100", "http://worker2:9100"] {
        let req = Request::builder()
            .method("POST")
            .uri("/v1/admin/workers")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::json!({"url": url}).to_string()))
            .unwrap();
        let (status, _) = send_json(&app, req).await;
        assert_eq!(status, StatusCode::CREATED);
    }

    // List
    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    let workers = body["workers"].as_array().unwrap();
    assert_eq!(workers.len(), 2);

    // All workers should be active
    for w in workers {
        assert_eq!(w["status"].as_str().unwrap(), "active");
    }
}

// ============================================================================
// Remove Worker
// ============================================================================

#[tokio::test]
async fn test_remove_worker() {
    let (app, _tmp) = test_app();

    // Register
    let req = Request::builder()
        .method("POST")
        .uri("/v1/admin/workers")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({"url": "http://worker1:9100"}).to_string(),
        ))
        .unwrap();
    let (_, body) = send_json(&app, req).await;
    let worker_id = body["worker_id"].as_str().unwrap().to_string();

    // Remove
    let req = Request::builder()
        .method("DELETE")
        .uri(format!("/v1/admin/workers/{worker_id}"))
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    // Verify it's gone from list
    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers")
        .body(Body::empty())
        .unwrap();
    let (_, body) = send_json(&app, req).await;
    assert_eq!(body["workers"].as_array().unwrap().len(), 0);
}

// ============================================================================
// Worker Heartbeat
// ============================================================================

#[tokio::test]
async fn test_worker_heartbeat_updates_capacity() {
    let (app, _tmp) = test_app();

    // Register
    let req = Request::builder()
        .method("POST")
        .uri("/v1/admin/workers")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({"url": "http://worker1:9100"}).to_string(),
        ))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::CREATED, "register failed: {body}");
    let worker_id = body["worker_id"].as_str().unwrap().to_string();

    // Heartbeat with updated capacity
    let req = Request::builder()
        .method("POST")
        .uri(format!("/v1/admin/workers/{worker_id}/heartbeat"))
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({
                "capacity": {
                    "max_boxes": 10,
                    "available_cpus": 2,
                    "available_memory_mib": 4096,
                    "running_boxes": 3
                }
            })
            .to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // Verify updated running_boxes in list
    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers")
        .body(Body::empty())
        .unwrap();
    let (_, body) = send_json(&app, req).await;
    let workers = body["workers"].as_array().unwrap();
    assert_eq!(workers[0]["running_boxes"].as_u64().unwrap(), 3);
}

// ============================================================================
// OAuth & Config (local endpoints)
// ============================================================================

#[tokio::test]
async fn test_oauth_token() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("POST")
        .uri("/v1/oauth/tokens")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["access_token"].is_string());
    assert_eq!(body["token_type"].as_str().unwrap(), "Bearer");
}

#[tokio::test]
async fn test_config_capabilities() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/config")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["capabilities"]["snapshots_enabled"], true);
    assert_eq!(body["capabilities"]["clone_enabled"], true);
    assert_eq!(body["capabilities"]["export_enabled"], true);
    assert_eq!(body["capabilities"]["import_enabled"], true);
}

// ============================================================================
// Metrics (aggregated, no workers → zero values)
// ============================================================================

#[tokio::test]
async fn test_metrics_no_workers() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/metrics")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["num_running_boxes"], 0);
}

// ============================================================================
// Box proxy routes return error without workers
// ============================================================================

#[tokio::test]
async fn test_create_box_without_workers_returns_error() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({
                "image": "alpine:latest"
            })
            .to_string(),
        ))
        .unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    // Should fail since no workers are registered
    assert!(response.status().is_client_error() || response.status().is_server_error());
}

// ============================================================================
// Swagger UI
// ============================================================================

#[tokio::test]
async fn test_swagger_ui_accessible() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/swagger-ui/")
        .body(Body::empty())
        .unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    // Swagger UI should return 200 or redirect
    assert!(
        response.status() == StatusCode::OK || response.status() == StatusCode::MOVED_PERMANENTLY
    );
}

#[tokio::test]
async fn test_openapi_spec_accessible() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/api-docs/openapi.json")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["openapi"].is_string());
    assert!(body["paths"].is_object());
}
