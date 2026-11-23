use super::*;

const LEGACY_CHECKPOINT: &str = r#"{"id":"checkpoint","name":"backup","source_box_id":"source","created_at":"2026-01-01T00:00:00Z","size_bytes":512,"state":"ready"}"#;

#[tokio::test]
async fn invalid_checkpoint_arguments_are_rejected_before_backend_dispatch() {
    // A valid request would reach this absent backend and return Unsupported.
    // InvalidArgument therefore also establishes the validation order.
    let checkpoints = CheckpointHandle::new(None);
    for source in ["", "source\0suffix"] {
        assert!(matches!(
            checkpoints.create(source, None).await,
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
    for key in ["", "-leading", "bad/key", "nul\0suffix", &"a".repeat(129)] {
        assert!(matches!(
            checkpoints.get(key).await,
            Err(BoxliteError::InvalidArgument(_))
        ));
        assert!(matches!(
            checkpoints.remove(key, false).await,
            Err(BoxliteError::InvalidArgument(_))
        ));
        assert!(matches!(
            checkpoints.create("source", Some(key.into())).await,
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
    // Boundary names pass validation and reach the backend capability check.
    for name in ["a".to_owned(), "a".repeat(128), "A0._-".to_owned()] {
        assert!(matches!(
            checkpoints.create("source", Some(name)).await,
            Err(BoxliteError::Unsupported(_))
        ));
    }
}

#[tokio::test]
async fn create_with_options_validates_arguments_before_backend_dispatch() {
    let checkpoints = CheckpointHandle::new(None);
    for (source, name, kind) in [
        ("", None, None),
        ("source\0suffix", None, Some(CheckpointKind::Disk)),
        ("source", Some("bad/name"), Some(CheckpointKind::Full)),
        ("source", None, Some(CheckpointKind::Unknown)),
    ] {
        assert!(matches!(
            checkpoints
                .create_with_options(source, name.map(str::to_owned), CheckpointOptions { kind })
                .await,
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
}

#[tokio::test]
async fn create_with_options_reports_unsupported_on_local_runtime() {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = crate::BoxliteRuntime::new_for_test(crate::BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .unwrap();
    let checkpoints = runtime.checkpoints();
    for kind in [None, Some(CheckpointKind::Disk), Some(CheckpointKind::Full)] {
        let error = checkpoints
            .create_with_options("source", Some("backup".into()), CheckpointOptions { kind })
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            BoxliteError::Unsupported(message) if message == UNSUPPORTED_ON_LOCAL
        ));
    }
}

#[test]
fn checkpoint_info_preserves_legacy_json_shape() {
    let legacy = serde_json::from_str::<serde_json::Value>(LEGACY_CHECKPOINT).unwrap();
    let info: CheckpointInfo = serde_json::from_str(LEGACY_CHECKPOINT).unwrap();
    assert_eq!(info.kind, CheckpointKind::Disk);
    assert_eq!(info.memory_size_bytes, None);
    assert_eq!(serde_json::to_value(&info).unwrap(), legacy);
}

#[test]
fn checkpoint_info_round_trips_full_kind_and_zero_memory_size() {
    let mut full: serde_json::Value = serde_json::from_str(LEGACY_CHECKPOINT).unwrap();
    full["kind"] = serde_json::json!("full");
    full["memory_size_bytes"] = serde_json::json!(0);
    let info: CheckpointInfo = serde_json::from_value(full.clone()).unwrap();
    assert_eq!(info.kind, CheckpointKind::Full);
    assert_eq!(info.memory_size_bytes, Some(0));
    assert_eq!(serde_json::to_value(&info).unwrap(), full);
}

#[test]
fn checkpoint_info_accepts_future_kinds() {
    let mut future: serde_json::Value = serde_json::from_str(LEGACY_CHECKPOINT).unwrap();
    future["kind"] = serde_json::json!("future_mode");
    let info: CheckpointInfo = serde_json::from_value(future).unwrap();
    assert_eq!(info.kind, CheckpointKind::Unknown);
    assert_eq!(info.memory_size_bytes, None);
}
