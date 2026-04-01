//! Integration tests for runtime shutdown behavior.
//!
//! These tests verify the public API behavior of shutdown operations
//! through `BoxliteRuntime` — the full delegation chain from public API
//! through `RuntimeBackend` trait to `RuntimeImpl`.
//!
//! Test categories:
//! - Async shutdown: idempotency, token cancellation
//! - Shutdown across runtimes: independent isolation

mod common;

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};

// ============================================================================
// SHUTDOWN IDEMPOTENCY
// ============================================================================

/// Calling shutdown() twice should succeed (second call is no-op).
#[tokio::test]
async fn shutdown_is_idempotent() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let result1 = runtime.shutdown(None).await;
    assert!(result1.is_ok());

    let result2 = runtime.shutdown(None).await;
    assert!(result2.is_ok());
}

/// Shutdown with explicit timeout should succeed.
#[tokio::test]
async fn shutdown_with_timeout() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let result = runtime.shutdown(Some(5)).await;
    assert!(result.is_ok());
}

/// Shutdown with no boxes should complete immediately.
#[tokio::test]
async fn shutdown_empty_runtime() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let result = runtime.shutdown(None).await;
    assert!(result.is_ok());
}

// ============================================================================
// RUNTIME ISOLATION
// ============================================================================

/// Shutting down one runtime should not affect another.
#[tokio::test]
async fn shutdown_does_not_affect_other_runtimes() {
    let home1 = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime1 = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home1.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let home2 = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime2 = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home2.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // Shutdown runtime 1
    runtime1.shutdown(None).await.unwrap();

    // Runtime 2 should still be operational (list_info works)
    let result = runtime2.list_info().await;
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

/// Read-only operations still work after shutdown (DB is intact).
/// Only box creation/start should fail.
#[tokio::test]
async fn read_operations_work_after_shutdown() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    runtime.shutdown(None).await.unwrap();

    // list_info is a read-only query — should still work
    let result = runtime.list_info().await;
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

// ============================================================================
// DROP BEHAVIOR
// ============================================================================

/// Runtime drop releases the lock, allowing a new runtime on the same directory.
#[test]
fn drop_releases_lock() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");

    // Create and drop a runtime
    {
        let options = BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        };
        let _rt = BoxliteRuntime::new(options).unwrap();
    } // Drop fires here

    // Should be able to create a new runtime on the same directory
    let options2 = BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    };
    let _rt2 = BoxliteRuntime::new(options2).unwrap();
}

/// Cloned runtimes share the same state — shutting down one affects clones.
/// Both see the same shutdown token, so double-shutdown via clone is safe.
#[tokio::test]
async fn cloned_runtime_shares_shutdown_state() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let clone = runtime.clone();

    // Shutdown via clone
    clone.shutdown(None).await.unwrap();

    // Second shutdown via original should be a no-op
    let result = runtime.shutdown(None).await;
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
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    assert!(runtime.shutdown(Some(0)).await.is_ok());

    // Some(-1) — infinite timeout
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    assert!(runtime.shutdown(Some(-1)).await.is_ok());

    // Some(30) — explicit 30s
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    assert!(runtime.shutdown(Some(30)).await.is_ok());

    // Some(-5) — negative value
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    assert!(runtime.shutdown(Some(-5)).await.is_ok());
}

// ============================================================================
// CONCURRENT SHUTDOWN SAFETY
// ============================================================================

/// Multiple concurrent shutdown() calls should all succeed without panic or deadlock.
#[tokio::test]
async fn concurrent_shutdown_is_safe() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // Clone runtime 4 times and call shutdown concurrently
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let rt = runtime.clone();
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
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    runtime.shutdown(None).await.unwrap();

    let result = runtime
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
