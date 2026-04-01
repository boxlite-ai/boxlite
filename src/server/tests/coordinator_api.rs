//! Integration tests for the coordinator REST API.
//!
//! Tests admin endpoints (worker management), health probes,
//! local endpoints (oauth, config), and metrics — all without requiring
//! a running worker or VM.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tower::ServiceExt;

use boxlite_server::coordinator::build_router;
use boxlite_server::coordinator::state::CoordinatorState;
use boxlite_server::scheduler::LeastLoadedScheduler;
use boxlite_server::store::StateStore;
use boxlite_server::store::sqlite::SqliteStateStore;
use boxlite_server::types::{BoxMapping, WorkerCapacity, WorkerInfo, WorkerStatus};

/// Build a test coordinator app with a temp SQLite database.
fn test_app() -> (axum::Router, Arc<dyn StateStore>, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("test.db");
    let store = SqliteStateStore::open(&db_path).unwrap();
    let store: Arc<dyn StateStore> = Arc::new(store);
    let state = Arc::new(CoordinatorState {
        store: store.clone(),
        scheduler: Arc::new(LeastLoadedScheduler),
    });
    (build_router(state), store, tmp)
}

/// Insert a test worker directly into the store.
async fn insert_worker(store: &dyn StateStore, id: &str, url: &str) -> WorkerInfo {
    let worker = WorkerInfo {
        id: id.to_string(),
        name: format!("test-worker-{id}"),
        url: url.to_string(),
        labels: HashMap::new(),
        registered_at: Utc::now(),
        last_heartbeat: Utc::now(),
        status: WorkerStatus::Active,
        capacity: WorkerCapacity {
            max_boxes: 10,
            available_cpus: 4,
            available_memory_mib: 8192,
            running_boxes: 0,
        },
    };
    store.upsert_worker(&worker).await.unwrap();
    worker
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
// List Workers
// ============================================================================

#[tokio::test]
async fn test_list_workers_empty() {
    let (app, _store, _tmp) = test_app();

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
async fn test_list_workers_returns_all() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;
    insert_worker(&*store, "w2", "http://worker2:9100").await;

    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    let workers = body["workers"].as_array().unwrap();
    assert_eq!(workers.len(), 2);

    for w in workers {
        assert_eq!(w["status"].as_str().unwrap(), "active");
    }
}

// ============================================================================
// Get Worker
// ============================================================================

#[tokio::test]
async fn test_get_worker() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;

    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers/w1")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], "w1");
    assert_eq!(body["url"], "http://worker1:9100");
    assert_eq!(body["status"], "active");
    assert!(body["capacity"].is_object());
    assert!(body["registered_at"].is_string());
    assert!(body["last_heartbeat"].is_string());
}

#[tokio::test]
async fn test_get_worker_not_found() {
    let (app, _store, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers/nonexistent")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

// ============================================================================
// Remove Worker
// ============================================================================

#[tokio::test]
async fn test_remove_worker() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;

    let req = Request::builder()
        .method("DELETE")
        .uri("/v1/admin/workers/w1")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    // Verify it's gone
    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers")
        .body(Body::empty())
        .unwrap();
    let (_, body) = send_json(&app, req).await;
    assert_eq!(body["workers"].as_array().unwrap().len(), 0);
}

// ============================================================================
// Update Worker Status
// ============================================================================

#[tokio::test]
async fn test_update_worker_status_to_draining() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;

    let req = Request::builder()
        .method("PATCH")
        .uri("/v1/admin/workers/w1/status")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"status": "draining"}"#))
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "draining");
    assert_eq!(body["id"], "w1");
}

#[tokio::test]
async fn test_update_worker_status_back_to_active() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;
    store
        .update_worker_status("w1", WorkerStatus::Draining)
        .await
        .unwrap();

    let req = Request::builder()
        .method("PATCH")
        .uri("/v1/admin/workers/w1/status")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"status": "active"}"#))
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "active");
}

#[tokio::test]
async fn test_update_worker_status_invalid() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;

    let req = Request::builder()
        .method("PATCH")
        .uri("/v1/admin/workers/w1/status")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"status": "removed"}"#))
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["type"], "ValidationError");
}

#[tokio::test]
async fn test_update_worker_status_not_found() {
    let (app, _store, _tmp) = test_app();

    let req = Request::builder()
        .method("PATCH")
        .uri("/v1/admin/workers/nonexistent/status")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"status": "draining"}"#))
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

// ============================================================================
// Get Worker By Box
// ============================================================================

#[tokio::test]
async fn test_get_worker_by_box() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;
    store
        .insert_box_mapping(&BoxMapping {
            box_id: "box-123".to_string(),
            worker_id: "w1".to_string(),
            namespace: "default".to_string(),
            created_at: Utc::now(),
        })
        .await
        .unwrap();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers/by-box/box-123")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], "w1");
    assert_eq!(body["url"], "http://worker1:9100");
}

#[tokio::test]
async fn test_get_worker_by_box_not_found() {
    let (app, _store, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/admin/workers/by-box/nonexistent")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

// ============================================================================
// Health Probes
// ============================================================================

#[tokio::test]
async fn test_health_liveness() {
    let (app, _store, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn test_health_readiness_no_workers() {
    let (app, _store, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/health/ready")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "not_ready");
    assert_eq!(body["active_workers"], 0);
    assert!(body["reason"].is_string());
}

#[tokio::test]
async fn test_health_readiness_with_active_worker() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;

    let req = Request::builder()
        .method("GET")
        .uri("/v1/health/ready")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ready");
    assert_eq!(body["active_workers"], 1);
    assert!(body["reason"].is_null()); // omitted when ready
}

#[tokio::test]
async fn test_health_readiness_draining_worker_not_counted() {
    let (app, store, _tmp) = test_app();

    insert_worker(&*store, "w1", "http://worker1:9100").await;
    store
        .update_worker_status("w1", WorkerStatus::Draining)
        .await
        .unwrap();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/health/ready")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "not_ready");
    assert_eq!(body["active_workers"], 0);
}

// ============================================================================
// OAuth & Config (local endpoints)
// ============================================================================

#[tokio::test]
async fn test_oauth_token() {
    let (app, _store, _tmp) = test_app();

    let req = Request::builder()
        .method("POST")
        .uri("/v1/oauth/tokens")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["access_token"].is_string());
    assert_eq!(body["token_type"].as_str().unwrap(), "bearer");
}

#[tokio::test]
async fn test_config_capabilities() {
    let (app, _store, _tmp) = test_app();

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
}

// ============================================================================
// Metrics (aggregated, no workers → zero values)
// ============================================================================

#[tokio::test]
async fn test_metrics_no_workers() {
    let (app, _store, _tmp) = test_app();

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
    let (app, _store, _tmp) = test_app();

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
    assert!(response.status().is_client_error() || response.status().is_server_error());
}

// ============================================================================
// Swagger UI
// ============================================================================

#[tokio::test]
async fn test_swagger_ui_accessible() {
    let (app, _store, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/swagger-ui/")
        .body(Body::empty())
        .unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    assert!(
        response.status() == StatusCode::OK || response.status() == StatusCode::MOVED_PERMANENTLY
    );
}

#[tokio::test]
async fn test_openapi_spec_accessible() {
    let (app, _store, _tmp) = test_app();

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

// ============================================================================
// Snapshot error paths (box not found → 404)
// ============================================================================

#[tokio::test]
async fn test_create_snapshot_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/snapshots")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"name": "snap1"}"#))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_list_snapshots_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/nonexistent/snapshots")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_get_snapshot_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/nonexistent/snapshots/snap1")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_remove_snapshot_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("DELETE")
        .uri("/v1/default/boxes/nonexistent/snapshots/snap1")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_restore_snapshot_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/snapshots/snap1/restore")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

// ============================================================================
// Clone / Export error paths (box not found → 404)
// ============================================================================

#[tokio::test]
async fn test_clone_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/clone")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_export_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/export")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

// ============================================================================
// Import error path (no workers → 503)
// ============================================================================

#[tokio::test]
async fn test_import_box_no_workers() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/import")
        .header("content-type", "application/octet-stream")
        .body(Body::from(vec![0u8; 100]))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"]["message"].is_string());
}

// ============================================================================
// File transfer error paths (box not found → 404)
// ============================================================================

#[tokio::test]
async fn test_upload_files_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("PUT")
        .uri("/v1/default/boxes/nonexistent/files?path=/tmp")
        .header("content-type", "application/x-tar")
        .body(Body::from(vec![0u8; 10]))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_download_files_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/nonexistent/files?path=/tmp")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

// ============================================================================
// TTY WebSocket
// ============================================================================

#[tokio::test]
async fn test_exec_tty_requires_websocket_upgrade() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/anybox/exec/tty")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_exec_tty_route_accepts_query_params() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/anybox/exec/tty?command=sh&cols=120&rows=40")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

// ============================================================================
// Image error paths (no workers → 503)
// ============================================================================

#[tokio::test]
async fn test_pull_image_no_workers() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/images/pull")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"reference": "alpine:latest"}"#))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"]["message"].is_string());
}

#[tokio::test]
async fn test_list_images_no_workers() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/images")
        .body(Body::empty())
        .unwrap();
    let (status, _) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn test_get_image_no_workers() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/images/sha256:abc")
        .body(Body::empty())
        .unwrap();
    let (status, _) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn test_image_exists_no_workers() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("HEAD")
        .uri("/v1/default/images/sha256:abc")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

// ============================================================================
// Box handler error paths (no workers, box not found)
// ============================================================================

#[tokio::test]
async fn test_get_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/nonexistent")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
    assert_eq!(body["error"]["code"], 404);
}

#[tokio::test]
async fn test_head_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("HEAD")
        .uri("/v1/default/boxes/nonexistent")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_remove_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("DELETE")
        .uri("/v1/default/boxes/nonexistent")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_start_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/start")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_stop_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/stop")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_list_boxes_empty() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["boxes"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_create_box_no_workers_error_format() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({"image": "alpine:latest"}).to_string(),
        ))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"]["message"].is_string());
    assert_eq!(body["error"]["code"], 503);
}

// ============================================================================
// Execution handler error paths
// ============================================================================

#[tokio::test]
async fn test_get_execution_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/nonexistent/executions/exec-123")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_start_execution_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/exec")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::json!({"command": "ls"}).to_string()))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_send_signal_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/executions/exec-1/signal")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::json!({"signal": 9}).to_string()))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_resize_tty_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/executions/exec-1/resize")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({"cols": 80, "rows": 24}).to_string(),
        ))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_send_input_box_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/default/boxes/nonexistent/executions/exec-1/input")
        .header("content-type", "application/octet-stream")
        .body(Body::from("hello"))
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

// ============================================================================
// Metrics error paths
// ============================================================================

#[tokio::test]
async fn test_box_metrics_not_found() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/nonexistent/metrics")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["type"], "NotFoundError");
}

#[tokio::test]
async fn test_runtime_metrics_all_fields_zero() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/metrics")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["boxes_created_total"], 0);
    assert_eq!(body["boxes_failed_total"], 0);
    assert_eq!(body["boxes_stopped_total"], 0);
    assert_eq!(body["num_running_boxes"], 0);
    assert_eq!(body["total_commands_executed"], 0);
    assert_eq!(body["total_exec_errors"], 0);
}

// ============================================================================
// Config / Auth response shape
// ============================================================================

#[tokio::test]
async fn test_config_response_full_shape() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("GET")
        .uri("/v1/config")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::OK);
    let caps = &body["capabilities"];
    assert!(caps.is_object());
    assert_eq!(caps["tty_enabled"], true);
    assert_eq!(caps["streaming_enabled"], true);
    assert_eq!(caps["snapshots_enabled"], true);
    assert_eq!(caps["clone_enabled"], true);
    assert_eq!(caps["export_enabled"], true);
}

#[tokio::test]
async fn test_oauth_token_response_shape() {
    let (app, _store, _tmp) = test_app();
    let req = Request::builder()
        .method("POST")
        .uri("/v1/oauth/tokens")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["access_token"].is_string());
    assert_eq!(body["token_type"], "bearer");
    assert!(body["expires_in"].is_number());
    assert!(body["expires_in"].as_u64().unwrap() > 0);
}
