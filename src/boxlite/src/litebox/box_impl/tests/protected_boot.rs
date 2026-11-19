use super::*;
use crate::litebox::protected_boot::{
    ProtectedBootKey, ProtectedBootOutcome, ProtectedBootRequest,
};
use crate::net::{OutboundReplacement, OutboundRevision, OutboundSnapshot};
use crate::runtime::options::{NetworkMode, NetworkSpec, OutboundNetworkConfig};

#[tokio::test]
async fn protected_boot_retirement_refuses_normal_box_without_changing_egress() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .unwrap();
    let bx = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let key = ProtectedBootKey {
        runner_id: OutboundRevision::fresh(),
        attempt_id: OutboundRevision::fresh(),
        registration_id: OutboundRevision::fresh(),
        registration_revision: OutboundRevision::fresh(),
        policy: bx.network().outbound_snapshot().await.unwrap(),
    };
    let before = key.policy.clone();
    let retirement = bx.retire_protected_boot(key).await;

    assert!(!bx.has_protected_boot().await.unwrap());
    assert_eq!(bx.network().outbound_snapshot().await.unwrap(), before);
    assert!(matches!(retirement, Err(BoxliteError::InvalidState(_))));
}

#[tokio::test]
async fn protected_boot_retirement_survives_handle_reopen_and_blocks_replay() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .unwrap();
    let bx = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                network: NetworkSpec::Disabled,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let id = bx.id().clone();
    let stale = runtime.box_manager.update_box(&id).unwrap();
    let key = ProtectedBootKey {
        runner_id: OutboundRevision::fresh(),
        attempt_id: OutboundRevision::fresh(),
        registration_id: OutboundRevision::fresh(),
        registration_revision: OutboundRevision::parse("7").unwrap(),
        policy: OutboundSnapshot {
            policy: OutboundNetworkConfig::default(),
            revision: OutboundRevision::fresh(),
        },
    };
    let receipt = bx.retire_protected_boot(key.clone()).await.unwrap();
    assert_eq!(receipt.outcome, ProtectedBootOutcome::Retired);
    assert_eq!(receipt.epoch, None);
    runtime.box_manager.save_box(&id, &stale).unwrap();
    drop(bx);
    let bx = runtime.get(id.as_str()).await.unwrap().unwrap();
    assert!(bx.has_protected_boot().await.unwrap());
    assert_eq!(bx.protected_boot_receipt(&key).await.unwrap(), receipt);
    let error = bx
        .bootstrap_protected(ProtectedBootRequest {
            key,
            scheme: "https".into(),
            host: "proxy.example.com".into(),
            port: 443,
            doh_url: "https://resolver.example.com/dns-query".into(),
            doh_address: "1.1.1.1:443".parse().unwrap(),
            credential: None,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("attempt is retired"));
    assert!(
        bx.start()
            .await
            .unwrap_err()
            .to_string()
            .contains("requires an exact protected launch")
    );
    let policy = OutboundNetworkConfig::default();
    let before = bx.network().outbound_snapshot().await.unwrap();
    assert_eq!(before.policy.mode, NetworkMode::Disabled);
    let replacement = OutboundReplacement::new(
        before.revision.clone(),
        OutboundSnapshot {
            policy: policy.clone(),
            revision: OutboundRevision::fresh(),
        },
    )
    .unwrap();
    assert!(
        bx.network()
            .update_outbound(policy)
            .await
            .unwrap_err()
            .to_string()
            .contains("complete authorized route")
    );
    assert!(
        bx.network()
            .replace_outbound_snapshot(replacement)
            .await
            .unwrap_err()
            .to_string()
            .contains("complete authorized route")
    );
    assert_eq!(bx.network().outbound_snapshot().await.unwrap(), before);
    assert_eq!(
        runtime.box_manager.update_box(&id).unwrap().status,
        BoxStatus::Configured
    );
}
