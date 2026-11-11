use super::*;

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
async fn local_sdk_checkpoint_management_is_unsupported() {
    let checkpoints = CheckpointHandle::new(None);
    let errors = [
        checkpoints
            .create("source", Some("base".into()))
            .await
            .unwrap_err(),
        checkpoints.list().await.unwrap_err(),
        checkpoints.get("base").await.unwrap_err(),
        checkpoints.remove("base", false).await.unwrap_err(),
        checkpoints.remove("base", true).await.unwrap_err(),
    ];
    for error in errors {
        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error}");
    }
}
