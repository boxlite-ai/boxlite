//! Integration tests for the REST client against the reference server.
//!
//! These tests require:
//! 1. The `rest` feature enabled: `--features rest`
//! 2. A running reference server: `python openapi/reference-server/server.py --port 8080`
//! 3. The `--ignored` flag: tests are marked `#[ignore]` by default
//!
//! Run with:
//! ```bash
//! BOXLITE_REST_URL=http://localhost:8080 \
//!   cargo test -p boxlite --features rest --test rest_integration -- --ignored
//! ```

#![cfg(feature = "rest")]

use boxlite::{BoxCommand, BoxOptions, BoxliteRestOptions, BoxliteRuntime};

/// Create a REST-backed runtime pointing at the reference server.
fn rest_runtime() -> BoxliteRuntime {
    let url = std::env::var("BOXLITE_REST_URL").unwrap_or_else(|_| "http://localhost:8080".into());
    BoxliteRuntime::rest(
        BoxliteRestOptions::new(&url).with_credentials("test-client".into(), "test-secret".into()),
    )
    .expect("failed to create REST runtime")
}

// ── Auth ────────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_rest_auth() {
    // Simply creating the runtime and listing boxes exercises the OAuth2 flow.
    let rt = rest_runtime();
    // list_info exercises the full OAuth2 token acquisition + authenticated request flow.
    // If auth is broken, this will fail with an error.
    let _boxes = rt
        .list_info()
        .await
        .expect("list_info failed — auth broken?");
}

// ── Box CRUD ────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_rest_create_and_get_box() {
    let rt = rest_runtime();
    let opts = BoxOptions::default(); // alpine:latest

    let litebox = rt
        .create(opts, Some("test-create-get".into()))
        .await
        .expect("create failed");

    let id_str = litebox.id().to_string();
    assert!(!id_str.is_empty());

    // Retrieve by id
    let info = rt
        .get_info(&id_str)
        .await
        .expect("get_info failed")
        .expect("box not found after create");
    assert_eq!(info.id.to_string(), id_str);

    // Cleanup
    rt.remove(&id_str, true).await.ok();
}

#[tokio::test]
#[ignore]
async fn test_rest_list_boxes() {
    let rt = rest_runtime();
    let opts = BoxOptions::default();

    let litebox = rt
        .create(opts, Some("test-list".into()))
        .await
        .expect("create failed");
    let id_str = litebox.id().to_string();

    let list = rt.list_info().await.expect("list_info failed");
    assert!(
        list.iter().any(|b| b.id.to_string() == id_str),
        "created box not found in list"
    );

    rt.remove(&id_str, true).await.ok();
}

#[tokio::test]
#[ignore]
async fn test_rest_box_exists() {
    let rt = rest_runtime();
    let opts = BoxOptions::default();

    let litebox = rt
        .create(opts, Some("test-exists".into()))
        .await
        .expect("create failed");
    let id_str = litebox.id().to_string();

    assert!(
        rt.exists(&id_str).await.expect("exists check failed"),
        "box should exist"
    );

    assert!(
        !rt.exists("nonexistent-id-12345")
            .await
            .expect("exists check failed"),
        "non-existent box should not exist"
    );

    rt.remove(&id_str, true).await.ok();
}

// ── Lifecycle ───────────────────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_rest_start_stop_box() {
    let rt = rest_runtime();
    let opts = BoxOptions {
        auto_remove: false, // Keep box after stop so we can inspect status
        ..Default::default()
    };

    let litebox = rt
        .create(opts, Some("test-lifecycle".into()))
        .await
        .expect("create failed");
    let id_str = litebox.id().to_string();

    // Start
    litebox.start().await.expect("start failed");

    let info = rt
        .get_info(&id_str)
        .await
        .expect("get_info failed")
        .expect("box not found");
    assert_eq!(info.status.to_string(), "running");

    // Stop
    litebox.stop().await.expect("stop failed");

    let info = rt
        .get_info(&id_str)
        .await
        .expect("get_info failed")
        .expect("box not found");
    assert_eq!(info.status.to_string(), "stopped");

    rt.remove(&id_str, true).await.ok();
}

// ── Command Execution & SSE Streaming ───────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_rest_run_command_and_stream() {
    let rt = rest_runtime();
    let opts = BoxOptions::default();

    let litebox = rt
        .create(opts, Some("test-cmd".into()))
        .await
        .expect("create failed");
    let id_str = litebox.id().to_string();

    litebox.start().await.expect("start failed");

    // Run `echo hello` via the execution API
    let cmd = BoxCommand::new("echo").arg("hello");
    let mut handle = litebox.exec(cmd).await.expect("command execution failed");

    // Collect stdout
    let mut stdout_output = String::new();
    if let Some(mut stdout) = handle.stdout() {
        use tokio_stream::StreamExt;
        while let Some(chunk) = stdout.next().await {
            stdout_output.push_str(&chunk);
        }
    }

    // Wait for completion
    let result = handle.wait().await.expect("wait failed");
    assert_eq!(result.exit_code, 0, "echo should succeed with exit code 0");
    assert!(
        stdout_output.contains("hello"),
        "stdout should contain 'hello', got: {:?}",
        stdout_output
    );

    litebox.stop().await.ok();
    rt.remove(&id_str, true).await.ok();
}

// ── Remove ──────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_rest_remove_box() {
    let rt = rest_runtime();
    let opts = BoxOptions::default();

    let litebox = rt
        .create(opts, Some("test-remove".into()))
        .await
        .expect("create failed");
    let id_str = litebox.id().to_string();

    rt.remove(&id_str, true).await.expect("remove failed");

    // Verify gone
    let result = rt.get_info(&id_str).await.expect("get_info failed");
    assert!(result.is_none(), "box should be gone after remove");
}

// ── Metrics ─────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_rest_runtime_metrics() {
    let rt = rest_runtime();

    let metrics = rt.metrics().await.expect("metrics failed");
    // Sanity: metrics should deserialize without error and have valid values.
    // boxes_created_total is u64, so just verify the call succeeded.
    let _ = metrics.boxes_created_total();
    let _ = metrics.num_running_boxes();
}

// ── Not Found ───────────────────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_rest_not_found() {
    let rt = rest_runtime();

    let result = rt
        .get("does-not-exist-12345")
        .await
        .expect("get should not error for missing box");

    assert!(result.is_none(), "non-existent box should return None");
}
