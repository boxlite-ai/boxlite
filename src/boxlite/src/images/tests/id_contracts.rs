use crate::images::{ImageManager, store::tests::seed_removable_build as seed_cached_build};
use crate::runtime::images::ImageHandle;
use crate::runtime::options::BoxliteOptions;
use crate::runtime::rt_impl::{LocalRuntime, RuntimeImpl};
use boxlite_shared::BoxliteError;
use std::sync::Arc;

const FIRST: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const SECOND: &str = "sha256:1222222222222222222222222222222222222222222222222222222222222222";

fn runtime() -> (Arc<RuntimeImpl>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: dir.path().to_path_buf(),
        ..Default::default()
    })
    .unwrap();
    (runtime, dir)
}

fn handle(runtime: &Arc<RuntimeImpl>) -> ImageHandle {
    ImageHandle::new(Arc::new(LocalRuntime(Arc::clone(runtime))), None)
}

async fn seed(images: &ImageManager, repository: &str, id: &str) {
    seed_cached_build(images.store(), &format!("{repository}@{id}"), id).await;
}

#[tokio::test]
async fn removal_resolves_full_and_short_ids_once_per_manifest() {
    let (runtime, _dir) = runtime();
    seed(&runtime.image_manager, "one.example/app", FIRST).await;
    seed(&runtime.image_manager, "two.example/app", FIRST).await;
    let images = handle(&runtime);
    for id in [FIRST, &FIRST[7..], "111111111111", "1"] {
        assert_eq!(
            images
                .resolve_ids(&[id.into()])
                .await
                .unwrap()
                .remove(0)
                .unwrap(),
            FIRST
        );
    }
    seed(&runtime.image_manager, "two.example/app", SECOND).await;
    let ids = [
        "1",
        "111",
        "f",
        "",
        "../",
        "sha256:1",
        "ABC",
        &"1".repeat(65),
    ]
    .map(str::to_string);
    let results = images.resolve_ids(&ids).await.unwrap();
    assert!(matches!(results[0], Err(BoxliteError::AmbiguousImageId(_))));
    assert_eq!(results[1].as_ref().unwrap(), FIRST);
    assert!(matches!(results[2], Err(BoxliteError::NotFound(_))));
    assert!(
        results[3..]
            .iter()
            .all(|result| matches!(result, Err(BoxliteError::InvalidArgument(_))))
    );
}

#[tokio::test]
async fn cache_consumers_retain_the_home_lock_after_runtime_drop() {
    let (runtime, dir) = runtime();
    let lease = runtime.image_manager.cache_lease().await;
    drop(runtime);
    let options = BoxliteOptions {
        home_dir: dir.path().to_path_buf(),
        ..Default::default()
    };
    assert!(RuntimeImpl::new_for_test(options.clone()).is_err());
    drop(lease);
    assert!(RuntimeImpl::new_for_test(options).is_ok());
}
