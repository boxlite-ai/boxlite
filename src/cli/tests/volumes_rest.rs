//! Managed volume lifecycle over a real `boxlite serve` process.

mod common;

use boxlite::{BoxliteError, BoxliteRestOptions, BoxliteRuntime};
use common::serve::ServeChild;

#[tokio::test]
async fn volume_crud_over_rest() {
    let serve = ServeChild::start();
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(serve.url())).expect("REST runtime");
    let volumes = runtime.volumes().expect("volume capability");

    let created = volumes.create(Some("server-data")).await.unwrap();
    assert_eq!(created.name, "server-data");

    let listed = volumes.list().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);
    assert_eq!(listed[0].name, created.name);
    assert_eq!(listed[0].created_at, created.created_at);

    let fetched = volumes.get(&created.id).await.unwrap();
    assert_eq!(fetched.id, created.id);
    assert_eq!(fetched.name, created.name);
    assert_eq!(fetched.created_at, created.created_at);

    let invalid_id = volumes.get("missing-volume").await.unwrap_err();
    assert!(
        matches!(invalid_id, BoxliteError::InvalidArgument(_)),
        "expected InvalidArgument for a non-UUID id, got {invalid_id:?}"
    );

    let missing = volumes
        .get("00000000-0000-0000-0000-000000000000")
        .await
        .unwrap_err();
    assert!(
        matches!(missing, BoxliteError::NotFound(_)),
        "expected NotFound, got {missing:?}"
    );

    volumes.remove(&created.id, false).await.unwrap();
    let removed = volumes.get(&created.id).await.unwrap_err();
    assert!(
        matches!(removed, BoxliteError::NotFound(_)),
        "expected NotFound after removal, got {removed:?}"
    );
    assert!(volumes.list().await.unwrap().is_empty());
}
