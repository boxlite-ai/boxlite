//! Integration tests for box lifecycle (create, list, get, remove, stop).

mod common;

use boxlite::BoxliteRuntime;
use boxlite::runtime::id::BoxID;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::runtime::types::BoxStatus;

// ============================================================================
// RUNTIME INITIALIZATION TESTS
// ============================================================================

#[tokio::test]
async fn runtime_initialization_creates_empty_list() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    assert!(runtime.list_info().await.unwrap().is_empty());
}

// ============================================================================
// BOX CREATION TESTS
// ============================================================================

#[tokio::test]
async fn create_generates_unique_ids() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let box1 = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box2 = runtime.create(common::alpine_opts(), None).await.unwrap();

    // IDs should be unique
    assert_ne!(box1.id(), box2.id());

    // IDs should be 12-char Base62 format
    assert_eq!(box1.id().as_str().len(), BoxID::FULL_LENGTH);
    assert_eq!(box2.id().as_str().len(), BoxID::FULL_LENGTH);

    // Cleanup
    box1.stop().await.unwrap();
    box2.stop().await.unwrap();
    runtime.remove(box1.id().as_str(), false).await.unwrap();
    runtime.remove(box2.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn create_stores_custom_options() {
    let options = BoxOptions {
        cpus: Some(4),
        memory_mib: Some(1024),
        ..common::alpine_opts()
    };

    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(options, None).await.unwrap();
    let box_id = handle.id().clone();

    let info = runtime.get_info(box_id.as_str()).await.unwrap().unwrap();

    // Verify metadata was stored correctly
    assert_eq!(info.cpus, 4);
    assert_eq!(info.memory_mib, 1024);
    assert!(info.created_at.timestamp() > 0);

    // Cleanup
    handle.stop().await.unwrap();
    runtime.remove(box_id.as_str(), false).await.unwrap();
}

// ============================================================================
// LIST TESTS
// ============================================================================

#[tokio::test]
async fn list_info_returns_all_boxes() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // Initially empty
    assert_eq!(runtime.list_info().await.unwrap().len(), 0);

    // Create two boxes
    let box1 = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box2 = runtime.create(common::alpine_opts(), None).await.unwrap();

    // List should show both boxes
    let boxes = runtime.list_info().await.unwrap();
    assert_eq!(boxes.len(), 2);

    let ids: Vec<&str> = boxes.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&box1.id().as_str()));
    assert!(ids.contains(&box2.id().as_str()));

    // Cleanup
    box1.stop().await.unwrap();
    box2.stop().await.unwrap();
    runtime.remove(box1.id().as_str(), false).await.unwrap();
    runtime.remove(box2.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn list_info_sorted_by_creation_time_newest_first() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // Create boxes (chrono has microsecond resolution — timestamps differ naturally)
    let box1 = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box2 = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box3 = runtime.create(common::alpine_opts(), None).await.unwrap();

    // List should be sorted newest first
    let boxes = runtime.list_info().await.unwrap();
    assert_eq!(boxes.len(), 3);
    assert_eq!(boxes[0].id, *box3.id()); // Newest
    assert_eq!(boxes[1].id, *box2.id());
    assert_eq!(boxes[2].id, *box1.id()); // Oldest

    // Cleanup - must stop handles before remove since they have is_shutdown flag
    let box1_id = box1.id().clone();
    let box2_id = box2.id().clone();
    let box3_id = box3.id().clone();
    box1.stop().await.unwrap();
    box2.stop().await.unwrap();
    box3.stop().await.unwrap();
    runtime.remove(box1_id.as_str(), false).await.unwrap();
    runtime.remove(box2_id.as_str(), false).await.unwrap();
    runtime.remove(box3_id.as_str(), false).await.unwrap();
}

// ============================================================================
// GET / EXISTS TESTS
// ============================================================================

#[tokio::test]
async fn get_info_returns_box_metadata() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();
    let box_id = handle.id().clone();

    // Get info from runtime - box is Configured after create() but not yet started
    let info = runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.id, box_id);
    assert_eq!(
        info.status,
        BoxStatus::Configured,
        "Expected Configured after create(), got {:?}",
        info.status
    );

    // Cleanup
    runtime.remove(box_id.as_str(), true).await.unwrap();
}

#[tokio::test]
async fn get_info_returns_none_for_nonexistent() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let missing = runtime.get_info("nonexistent-id").await.unwrap();
    assert!(missing.is_none());
}

#[tokio::test]
async fn exists_returns_true_for_existing_box() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();
    let box_id = handle.id().clone();

    assert!(runtime.exists(box_id.as_str()).await.unwrap());

    // Cleanup
    runtime.remove(box_id.as_str(), true).await.unwrap();
}

#[tokio::test]
async fn exists_returns_false_for_nonexistent() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    assert!(!runtime.exists("nonexistent-id").await.unwrap());
}

// ============================================================================
// REMOVE TESTS (BoxliteRuntime::remove)
// ============================================================================

#[tokio::test]
async fn remove_nonexistent_returns_not_found() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let result = runtime.remove("nonexistent-id", false).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "Expected NotFound error, got: {}",
        err
    );
}

#[tokio::test]
async fn remove_stopped_box_succeeds() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box_id = handle.id().clone();

    // Stop the box first
    handle.stop().await.unwrap();

    // Remove without force should succeed on stopped box
    runtime.remove(box_id.as_str(), false).await.unwrap();

    // Box should no longer exist
    assert!(!runtime.exists(box_id.as_str()).await.unwrap());
}

#[tokio::test]
async fn remove_active_without_force_fails() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();
    let box_id = handle.id().clone();

    // Start box so it becomes active.
    handle.start().await.unwrap();

    // Box should now be active.
    let info = runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert!(info.status.is_active());

    // Remove without force should fail
    let result = runtime.remove(box_id.as_str(), false).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("cannot remove active box"),
        "Expected active box error, got: {}",
        err
    );

    // Box should still exist
    assert!(runtime.exists(box_id.as_str()).await.unwrap());

    // Cleanup with force
    runtime.remove(box_id.as_str(), true).await.unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn remove_active_with_force_stops_and_removes() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();
    let box_id = handle.id().clone();

    // Start box so it becomes active.
    handle.start().await.unwrap();

    // Box should now be active.
    let info = runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert!(info.status.is_active());

    // Force remove should succeed
    runtime.remove(box_id.as_str(), true).await.unwrap();

    // Box should no longer exist
    assert!(!runtime.exists(box_id.as_str()).await.unwrap());
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn remove_deletes_box_from_database() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();
    let box_id = handle.id().clone();

    // Verify box exists before removal
    assert!(runtime.exists(box_id.as_str()).await.unwrap());

    // Force remove
    runtime.remove(box_id.as_str(), true).await.unwrap();

    // Box should no longer exist in database
    assert!(!runtime.exists(box_id.as_str()).await.unwrap());
}

// ============================================================================
// STOP TESTS
// ============================================================================

#[tokio::test]
async fn stop_marks_box_as_stopped() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box_id = handle.id().clone();

    // Start first so stop() transitions to Stopped.
    handle.start().await.unwrap();

    // Stop the box
    handle.stop().await.unwrap();

    // Status should be Stopped
    let info = runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Stopped);

    // Cleanup
    runtime.remove(box_id.as_str(), false).await.unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// LITEBOX INFO TESTS
// ============================================================================

#[tokio::test]
async fn litebox_info_returns_correct_metadata() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();
    let box_id = handle.id().clone();

    // Get info from runtime - box is Configured after create() but not yet started
    let info = runtime
        .get_info(box_id.as_str())
        .await
        .unwrap()
        .expect("info should be available");
    assert_eq!(info.id, box_id);
    assert_eq!(info.status, BoxStatus::Configured);
    assert_eq!(info.cpus, 2); // Default value
    assert_eq!(info.memory_mib, 512); // Default value

    // Cleanup
    runtime.remove(box_id.as_str(), true).await.unwrap();
}

// ============================================================================
// ISOLATION TESTS
// ============================================================================

#[tokio::test]
async fn multiple_runtimes_are_isolated() {
    let home1 = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime1 = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home1.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let home2 = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime2 = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home2.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let box1 = runtime1
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();
    let box2 = runtime2
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();

    // Each runtime should only see its own box
    assert_eq!(runtime1.list_info().await.unwrap().len(), 1);
    assert_eq!(runtime2.list_info().await.unwrap().len(), 1);

    assert_eq!(runtime1.list_info().await.unwrap()[0].id, *box1.id());
    assert_eq!(runtime2.list_info().await.unwrap()[0].id, *box2.id());

    // Cleanup
    runtime1.remove(box1.id().as_str(), true).await.unwrap();
    runtime2.remove(box2.id().as_str(), true).await.unwrap();
}

// ============================================================================
// PERSISTENCE TESTS
// ============================================================================

#[tokio::test]
async fn boxes_persist_across_runtime_restart() {
    // Persistence tests need their own home_dir to test restart behavior.
    // Use PerTestBoxHome::new() so the image cache is available for start().
    let home = boxlite_test_utils::home::PerTestBoxHome::new();

    let box_id: BoxID;

    // Create runtime and a box
    {
        let options = BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");
        let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
        box_id = litebox.id().clone();

        // Box should be in database
        let boxes = runtime.list_info().await.unwrap();
        assert_eq!(boxes.len(), 1);

        // Start then stop before "restart" so persisted state is Stopped.
        litebox.start().await.unwrap();
        litebox.stop().await.unwrap();
    }

    // Create new runtime with same home directory (simulates restart)
    {
        let options = BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");

        // Box should be recovered from database
        let boxes = runtime.list_info().await.unwrap();
        assert_eq!(boxes.len(), 1);

        // Status should be Stopped
        let status = &boxes[0].status;
        assert_eq!(status, &BoxStatus::Stopped);

        // Cleanup
        runtime.remove(box_id.as_str(), false).await.unwrap();
    }
}

#[tokio::test]
async fn multiple_boxes_persist_and_recover_without_lock_errors() {
    // Test that multiple boxes can be created, persisted, and recovered
    // without lock allocation errors during recovery.
    // Use PerTestBoxHome::new() so the image cache is available for start().
    let home = boxlite_test_utils::home::PerTestBoxHome::new();

    let box_ids: Vec<BoxID>;

    // Create multiple boxes (allocates locks)
    {
        let options = BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");

        // Create 3 boxes
        let litebox1 = runtime.create(common::alpine_opts(), None).await.unwrap();
        let litebox2 = runtime.create(common::alpine_opts(), None).await.unwrap();
        let litebox3 = runtime.create(common::alpine_opts(), None).await.unwrap();

        box_ids = vec![
            litebox1.id().clone(),
            litebox2.id().clone(),
            litebox3.id().clone(),
        ];

        // Start all boxes so stop() persists Stopped status.
        litebox1.start().await.unwrap();
        litebox2.start().await.unwrap();
        litebox3.start().await.unwrap();

        // Stop all boxes before runtime drops.
        litebox1.stop().await.unwrap();
        litebox2.stop().await.unwrap();
        litebox3.stop().await.unwrap();

        // Runtime drops here, simulating process exit
    }

    // Create new runtime with same home directory (simulates restart)
    // This should successfully recover all boxes without lock allocation errors
    {
        let options = BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime after restart");

        // All boxes should be recovered from database
        let boxes = runtime.list_info().await.unwrap();
        assert_eq!(boxes.len(), 3, "All boxes should be recovered");

        // Verify all box IDs are present
        let recovered_ids: Vec<&BoxID> = boxes.iter().map(|b| &b.id).collect();
        for box_id in &box_ids {
            assert!(
                recovered_ids.contains(&box_id),
                "Box {} should be recovered",
                box_id
            );
        }

        // All boxes should be in Stopped status
        for info in &boxes {
            assert_eq!(
                info.status,
                BoxStatus::Stopped,
                "Recovered box should be stopped"
            );
        }

        // Cleanup
        for box_id in &box_ids {
            runtime.remove(box_id.as_str(), false).await.unwrap();
        }
    }
}

// ============================================================================
// AUTO_REMOVE TESTS
// ============================================================================

#[tokio::test]
async fn auto_remove_default_is_true() {
    let options = BoxOptions::default();
    assert!(
        options.auto_remove,
        "auto_remove should default to true (like Docker --rm)"
    );
}

#[tokio::test]
async fn auto_remove_true_removes_box_on_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime
        .create(common::alpine_opts_auto(), None)
        .await
        .unwrap();
    let box_id = handle.id().clone();

    // Box should exist before stop
    assert!(runtime.exists(box_id.as_str()).await.unwrap());

    // Stop should auto-remove
    handle.stop().await.unwrap();

    // Box should no longer exist
    assert!(
        !runtime.exists(box_id.as_str()).await.unwrap(),
        "Box should be auto-removed when auto_remove=true"
    );
}

#[tokio::test]
async fn auto_remove_false_preserves_box_on_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box_id = handle.id().clone();

    // Start first so stop() transitions to Stopped.
    handle.start().await.unwrap();

    // Stop should NOT auto-remove
    handle.stop().await.unwrap();

    // Box should still exist
    assert!(
        runtime.exists(box_id.as_str()).await.unwrap(),
        "Box should be preserved when auto_remove=false"
    );

    // Status should be Stopped
    let info = runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Stopped);

    // Cleanup manually
    runtime.remove(box_id.as_str(), false).await.unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// DETACH TESTS
// ============================================================================

#[tokio::test]
async fn detach_default_is_false() {
    let options = BoxOptions::default();
    assert!(
        !options.detach,
        "detach should default to false (box tied to parent lifecycle)"
    );
}

#[tokio::test]
async fn detach_option_is_stored_in_box_config() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // Create box with detach=true
    let handle = runtime
        .create(
            BoxOptions {
                detach: true,
                ..common::alpine_opts()
            },
            None,
        )
        .await
        .unwrap();
    let box_id = handle.id().clone();

    // Note: detach is not exposed in BoxInfo, it's an internal option
    // that affects the shim subprocess behavior. We just verify the box
    // was created successfully with the option.
    assert!(runtime.exists(box_id.as_str()).await.unwrap());

    // Cleanup
    runtime.remove(box_id.as_str(), true).await.unwrap();
}
