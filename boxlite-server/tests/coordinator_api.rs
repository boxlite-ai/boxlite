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
    assert_eq!(body["token_type"].as_str().unwrap(), "bearer");
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

// ============================================================================
// Stub endpoints return 501 with correct error format
// ============================================================================

/// Helper to verify a stub returns 501 with UnsupportedError body.
async fn assert_stub_501(app: &axum::Router, method: &str, uri: &str) {
    assert_stub_501_with_body(app, method, uri, None).await;
}

/// Helper to verify a stub returns 501, with an optional custom JSON body.
async fn assert_stub_501_with_body(
    app: &axum::Router,
    method: &str,
    uri: &str,
    json_body: Option<&str>,
) {
    let mut builder = Request::builder().method(method).uri(uri);
    if method == "POST" || method == "PUT" {
        builder = builder.header("content-type", "application/json");
    }
    let body = if let Some(b) = json_body {
        Body::from(b.to_string())
    } else if method == "POST" || method == "PUT" {
        Body::from("{}")
    } else {
        Body::empty()
    };
    let req = builder.body(body).unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    assert_eq!(
        status,
        StatusCode::NOT_IMPLEMENTED,
        "{method} {uri}: expected 501, got {status}"
    );

    if method != "HEAD" {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"]["type"], "UnsupportedError");
        assert_eq!(json["error"]["code"], 501);
    }
}

#[tokio::test]
async fn test_stub_create_snapshot_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501_with_body(
        &app,
        "POST",
        "/v1/default/boxes/box1/snapshots",
        Some(r#"{"name": "snap1"}"#),
    )
    .await;
}

#[tokio::test]
async fn test_stub_list_snapshots_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "GET", "/v1/default/boxes/box1/snapshots").await;
}

#[tokio::test]
async fn test_stub_get_snapshot_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "GET", "/v1/default/boxes/box1/snapshots/snap1").await;
}

#[tokio::test]
async fn test_stub_remove_snapshot_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "DELETE", "/v1/default/boxes/box1/snapshots/snap1").await;
}

#[tokio::test]
async fn test_stub_restore_snapshot_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(
        &app,
        "POST",
        "/v1/default/boxes/box1/snapshots/snap1/restore",
    )
    .await;
}

#[tokio::test]
async fn test_stub_clone_box_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "POST", "/v1/default/boxes/box1/clone").await;
}

#[tokio::test]
async fn test_stub_export_box_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "POST", "/v1/default/boxes/box1/export").await;
}

#[tokio::test]
async fn test_stub_import_box_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "POST", "/v1/default/boxes/import").await;
}

#[tokio::test]
async fn test_stub_upload_files_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "PUT", "/v1/default/boxes/box1/files").await;
}

#[tokio::test]
async fn test_stub_download_files_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "GET", "/v1/default/boxes/box1/files").await;
}

#[tokio::test]
async fn test_stub_exec_tty_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "GET", "/v1/default/boxes/box1/exec/tty").await;
}

#[tokio::test]
async fn test_stub_pull_image_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501_with_body(
        &app,
        "POST",
        "/v1/default/images/pull",
        Some(r#"{"reference": "alpine:latest"}"#),
    )
    .await;
}

#[tokio::test]
async fn test_stub_list_images_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "GET", "/v1/default/images").await;
}

#[tokio::test]
async fn test_stub_get_image_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "GET", "/v1/default/images/sha256:abc").await;
}

#[tokio::test]
async fn test_stub_image_exists_returns_501() {
    let (app, _tmp) = test_app();
    assert_stub_501(&app, "HEAD", "/v1/default/images/sha256:abc").await;
}

// ============================================================================
// Box handler error paths (no workers, box not found)
// ============================================================================

#[tokio::test]
async fn test_get_box_not_found() {
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
async fn test_get_execution_stub_response() {
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/default/boxes/anybox/executions/exec-123")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["execution_id"], "exec-123");
    assert_eq!(body["status"], "running");
}

#[tokio::test]
async fn test_start_execution_box_not_found() {
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

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
    let (app, _tmp) = test_app();

    let req = Request::builder()
        .method("GET")
        .uri("/v1/config")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_json(&app, req).await;
    assert_eq!(status, StatusCode::OK);
    // Capabilities should be present with boolean fields
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
    let (app, _tmp) = test_app();

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

// ============================================================================
// Route existence (new routes are wired, not 404)
// ============================================================================

#[tokio::test]
async fn test_new_routes_are_wired() {
    let (app, _tmp) = test_app();

    // These routes should return 501 (stub handlers), verifying they are wired.
    // Routes that proxy to workers (e.g., box metrics) return 404 from the handler
    // when the box doesn't exist — that's tested separately.
    let routes = [
        ("GET", "/v1/default/boxes/box1/snapshots"),
        ("POST", "/v1/default/boxes/box1/clone"),
        ("POST", "/v1/default/boxes/box1/export"),
        ("POST", "/v1/default/boxes/import"),
        ("PUT", "/v1/default/boxes/box1/files"),
        ("GET", "/v1/default/boxes/box1/files"),
        ("GET", "/v1/default/boxes/box1/exec/tty"),
        ("GET", "/v1/default/images"),
    ];

    for (method, uri) in routes {
        let mut builder = Request::builder().method(method).uri(uri);
        if method == "POST" || method == "PUT" {
            builder = builder.header("content-type", "application/json");
        }
        let body = if method == "POST" || method == "PUT" {
            Body::from("{}")
        } else {
            Body::empty()
        };
        let req = builder.body(body).unwrap();

        let response = app.clone().oneshot(req).await.unwrap();
        assert_ne!(
            response.status(),
            StatusCode::NOT_FOUND,
            "Route {method} {uri} returned 404 — not wired in router"
        );
    }
}
