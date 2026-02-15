//! Integration tests for runtime shutdown behavior.
//!
//! These tests verify the public API behavior of shutdown operations
//! through `BoxliteRuntime` — the full delegation chain from public API
//! through `RuntimeBackend` trait to `RuntimeImpl`.
//!
//! Test categories:
//! - Async shutdown: idempotency, token cancellation
//! - Shutdown across runtimes: independent isolation

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use tempfile::TempDir;

// ============================================================================
// TEST FIXTURES
// ============================================================================

/// Test context with isolated runtime and automatic cleanup.
struct TestContext {
    runtime: BoxliteRuntime,
    _temp_dir: TempDir,
}

impl TestContext {
    fn new() -> Self {
        // Use /tmp directly to avoid macOS's long temp paths that exceed SUN_LEN
        // for Unix socket paths (limited to ~104 chars)
        let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
        let options = BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");
        Self {
            runtime,
            _temp_dir: temp_dir,
        }
    }
}

// ============================================================================
// SHUTDOWN IDEMPOTENCY
// ============================================================================

/// Calling shutdown() twice should succeed (second call is no-op).
#[tokio::test]
async fn shutdown_is_idempotent() {
    let ctx = TestContext::new();

    let result1 = ctx.runtime.shutdown(None).await;
    assert!(result1.is_ok());

    let result2 = ctx.runtime.shutdown(None).await;
    assert!(result2.is_ok());
}

/// Shutdown with explicit timeout should succeed.
#[tokio::test]
async fn shutdown_with_timeout() {
    let ctx = TestContext::new();

    let result = ctx.runtime.shutdown(Some(5)).await;
    assert!(result.is_ok());
}

/// Shutdown with no boxes should complete immediately.
#[tokio::test]
async fn shutdown_empty_runtime() {
    let ctx = TestContext::new();

    let result = ctx.runtime.shutdown(None).await;
    assert!(result.is_ok());
}

// ============================================================================
// RUNTIME ISOLATION
// ============================================================================

/// Shutting down one runtime should not affect another.
#[tokio::test]
async fn shutdown_does_not_affect_other_runtimes() {
    let ctx1 = TestContext::new();
    let ctx2 = TestContext::new();

    // Shutdown runtime 1
    ctx1.runtime.shutdown(None).await.unwrap();

    // Runtime 2 should still be operational (list_info works)
    let result = ctx2.runtime.list_info().await;
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

/// Read-only operations still work after shutdown (DB is intact).
/// Only box creation/start should fail.
#[tokio::test]
async fn read_operations_work_after_shutdown() {
    let ctx = TestContext::new();

    ctx.runtime.shutdown(None).await.unwrap();

    // list_info is a read-only query — should still work
    let result = ctx.runtime.list_info().await;
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

// ============================================================================
// DROP BEHAVIOR
// ============================================================================

/// Runtime drop releases the lock, allowing a new runtime on the same directory.
#[test]
fn drop_releases_lock() {
    let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
    let dir_path = temp_dir.path().to_path_buf();

    // Create and drop a runtime
    {
        let options = BoxliteOptions {
            home_dir: dir_path.clone(),
            image_registries: vec![],
        };
        let _rt = BoxliteRuntime::new(options).unwrap();
    } // Drop fires here

    // Should be able to create a new runtime on the same directory
    let options2 = BoxliteOptions {
        home_dir: dir_path,
        image_registries: vec![],
    };
    let _rt2 = BoxliteRuntime::new(options2).unwrap();
}

/// Cloned runtimes share the same state — shutting down one affects clones.
/// Both see the same shutdown token, so double-shutdown via clone is safe.
#[tokio::test]
async fn cloned_runtime_shares_shutdown_state() {
    let ctx = TestContext::new();
    let clone = ctx.runtime.clone();

    // Shutdown via clone
    clone.shutdown(None).await.unwrap();

    // Second shutdown via original should be a no-op
    let result = ctx.runtime.shutdown(None).await;
    assert!(
        result.is_ok(),
        "Second shutdown via original should succeed as no-op"
    );
}

// ============================================================================
// TIMEOUT EDGE VALUES
// ============================================================================

/// Various timeout values should all succeed on empty runtime without panicking.
#[tokio::test]
async fn shutdown_timeout_edge_values() {
    // Some(0) — zero timeout
    let ctx = TestContext::new();
    assert!(ctx.runtime.shutdown(Some(0)).await.is_ok());

    // Some(-1) — infinite timeout
    let ctx = TestContext::new();
    assert!(ctx.runtime.shutdown(Some(-1)).await.is_ok());

    // Some(30) — explicit 30s
    let ctx = TestContext::new();
    assert!(ctx.runtime.shutdown(Some(30)).await.is_ok());

    // Some(-5) — negative value
    let ctx = TestContext::new();
    assert!(ctx.runtime.shutdown(Some(-5)).await.is_ok());
}

// ============================================================================
// CONCURRENT SHUTDOWN SAFETY
// ============================================================================

/// Multiple concurrent shutdown() calls should all succeed without panic or deadlock.
#[tokio::test]
async fn concurrent_shutdown_is_safe() {
    let ctx = TestContext::new();

    // Clone runtime 4 times and call shutdown concurrently
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let rt = ctx.runtime.clone();
            tokio::spawn(async move { rt.shutdown(None).await })
        })
        .collect();

    let results = futures::future::join_all(handles).await;

    // All should succeed (one cancels token, rest are idempotent no-ops)
    for (i, result) in results.iter().enumerate() {
        let inner = result.as_ref().expect("task should not panic");
        assert!(inner.is_ok(), "shutdown #{i} should succeed: {:?}", inner);
    }
}

// ============================================================================
// POST-SHUTDOWN REJECTION
// ============================================================================

/// Creating a box after shutdown should fail with a clear error.
#[tokio::test]
async fn create_after_shutdown_is_rejected() {
    let ctx = TestContext::new();

    ctx.runtime.shutdown(None).await.unwrap();

    let result = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("test:latest".into()),
                ..Default::default()
            },
            Some("test-box".into()),
        )
        .await;

    match result {
        Err(e) => {
            let err_msg = e.to_string();
            assert!(
                err_msg.contains("shut down"),
                "Error should mention 'shut down': {err_msg}"
            );
        }
        Ok(_) => panic!("create should fail after shutdown"),
    }
}
