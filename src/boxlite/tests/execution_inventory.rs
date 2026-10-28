//! Live inventory and independent control against a real guest.
mod common;

use boxlite::runtime::options::BoxliteOptions;
use boxlite::{AttachOptions, BoxCommand, BoxStatus, BoxliteRuntime};
use std::time::Duration;

#[tokio::test]
async fn live_inventory_includes_init_and_recovers_controls_without_reader() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    assert!(handle.list_executions().await.unwrap().is_empty());
    assert_eq!(handle.info().await.unwrap().status, BoxStatus::Configured);
    handle.start().await.unwrap();
    let first = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();
    let second = handle
        .exec(BoxCommand::new("sleep").arg("3600").tty(true))
        .await
        .unwrap();
    let live = handle.list_executions().await.unwrap();
    let main = live
        .iter()
        .find(|info| info.is_main)
        .expect("init must be discoverable");
    assert_ne!(main.execution_id, handle.id().as_str());
    assert!(main.pid > 0 && main.started_at > 0);
    assert_eq!(live.iter().filter(|info| !info.is_main).count(), 2);
    let info = live
        .iter()
        .find(|info| &info.execution_id == first.id())
        .unwrap();
    assert_eq!(info.argv, ["sleep", "3600"]);
    assert!(!info.tty);
    assert!(
        live.iter()
            .find(|info| &info.execution_id == second.id())
            .unwrap()
            .tty
    );

    let recovered = handle.get_execution(first.id()).await.unwrap();
    assert_eq!(recovered.id(), first.id());
    recovered.kill().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), recovered.wait())
        .await
        .unwrap()
        .unwrap();
    let live = handle.list_executions().await.unwrap();
    assert!(!live.iter().any(|info| &info.execution_id == first.id()));
    assert!(live.iter().any(|info| &info.execution_id == second.id()));
    assert!(live.iter().any(|info| info.is_main));

    // Drop the original eager output pump's receivers, then acquire a fresh
    // reader for the same guest ID without spawning another process.
    let second_id = second.id().clone();
    drop(second);
    let attached = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match handle
                .attach(AttachOptions::execution(second_id.clone()).read_only())
                .await
            {
                Ok(attached) => break attached,
                Err(boxlite::BoxliteError::AlreadyExists(_)) => tokio::task::yield_now().await,
                Err(error) => panic!("reattach failed: {error}"),
            }
        }
    })
    .await
    .expect("dropping receivers must release the guest reader lease");
    assert_eq!(attached.id(), &second_id);
    attached.kill().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), attached.wait())
        .await
        .unwrap()
        .unwrap();
    handle.stop().await.unwrap();
    assert!(handle.list_executions().await.unwrap().is_empty());
    assert_eq!(handle.info().await.unwrap().status, BoxStatus::Stopped);
    assert!(
        handle
            .attach(AttachOptions::execution(second_id))
            .await
            .is_err()
    );
    assert_eq!(handle.info().await.unwrap().status, BoxStatus::Stopped);
    runtime.remove(handle.id().as_str(), true).await.unwrap();
}
