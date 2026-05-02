//! Integration tests for structured image registry configuration.

mod common;

use boxlite::runtime::options::BoxliteOptions;
use boxlite::{BoxliteRuntime, ImageRegistry};
use common::home::PerTestBoxHome;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structured_image_registries_pull_unqualified_image() {
    let home = PerTestBoxHome::isolated_in("/tmp");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap();

    let images = runtime.images().unwrap();
    let result = images.pull("alpine:latest").await.unwrap();
    let list = images.list().await.unwrap();

    assert_eq!(result.reference(), "alpine:latest");
    assert!(result.config_digest().starts_with("sha256:"));
    assert!(result.layer_count() > 0);
    assert!(
        list.iter()
            .any(|image| image.repository.contains("alpine") && image.tag == "latest")
    );

    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[test]
fn structured_image_registries_validate_at_runtime_start() {
    let home = PerTestBoxHome::isolated_in("/tmp");
    let result = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path,
        image_registries: vec![ImageRegistry::https("https://registry.local")],
    });

    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("host[:port]"));
}
