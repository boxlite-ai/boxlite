use super::*;

#[test]
fn outbound_bootstrap_ffi_serializes_private_revision_without_changing_public_config() {
    let wire: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/outbound/bootstrap-v1.json"
    )))
    .unwrap();
    let revision: crate::net::OutboundRevision =
        serde_json::from_value(wire["outbound_revision"].clone()).unwrap();
    let config = GvproxyConfig::new("/tmp/boxlite-bootstrap/net.sock".into());
    let original = serde_json::to_value(&config).unwrap();
    let legacy: serde_json::Value =
        serde_json::from_str(&serialize_config(&config, None, &[], None).unwrap()).unwrap();
    assert_eq!(legacy, original);
    let mut seeded: serde_json::Value =
        serde_json::from_str(&serialize_config(&config, Some(&revision), &[], None).unwrap())
            .unwrap();
    assert_eq!(
        seeded
            .as_object_mut()
            .unwrap()
            .remove("outbound_revision")
            .unwrap(),
        wire["outbound_revision"]
    );
    assert_eq!(seeded, original);
}

#[tokio::test]
async fn outbound_bootstrap_real_bridge_restores_identity_and_enforces_cas() {
    use crate::net::gvproxy::{GvproxyBackend, GvproxyInstance};
    use crate::net::{
        NetworkBackend, NetworkBackendConfig, OutboundApplicationState, OutboundReplaceOutcome,
        OutboundReplacement, OutboundSnapshot,
    };
    use crate::runtime::options::{NetworkMode, OutboundNetworkConfig};

    let dir = tempfile::Builder::new()
        .prefix("bl-boot-")
        .tempdir_in("/tmp")
        .unwrap();
    let config = NetworkBackendConfig {
        outbound_disabled: true,
        socket_path: dir.path().join("net.sock"),
        allow_net: vec![],
        secrets: vec![],
        ca_dir: dir.path().to_path_buf(),
        rate_limit: Default::default(),
    };
    let backend = GvproxyBackend::from_config(&config);
    let spec = backend.spec();
    let revision = crate::net::OutboundRevision::parse("restored-revision").unwrap();
    let control = crate::net::gvproxy::control_socket_path(&config.socket_path);
    for round in 0..2 {
        let (instance, _) = GvproxyInstance::from_config_with_revision(&spec, &revision).unwrap();
        let observed = backend.outbound_snapshot().await.unwrap();
        assert_eq!(
            observed.application_state,
            OutboundApplicationState::Confirmed
        );
        assert_eq!(observed.snapshot.revision, revision);
        assert_eq!(observed.snapshot.policy.mode, NetworkMode::Disabled);
        let candidate = OutboundSnapshot {
            policy: OutboundNetworkConfig::default(),
            revision: crate::net::OutboundRevision::parse(format!("applied-{round}")).unwrap(),
        };
        let replacement = OutboundReplacement::new(revision.clone(), candidate.clone()).unwrap();
        assert_eq!(
            backend
                .replace_outbound_snapshot(&replacement)
                .await
                .unwrap(),
            OutboundReplaceOutcome::Applied
        );
        let stale = OutboundReplacement::new(
            revision.clone(),
            OutboundSnapshot {
                policy: OutboundNetworkConfig {
                    mode: NetworkMode::Disabled,
                    ..Default::default()
                },
                revision: crate::net::OutboundRevision::parse(format!("stale-{round}")).unwrap(),
            },
        )
        .unwrap();
        assert_eq!(
            backend.replace_outbound_snapshot(&stale).await.unwrap(),
            OutboundReplaceOutcome::PreconditionFailed
        );
        assert_eq!(
            backend.outbound_snapshot().await.unwrap().snapshot,
            candidate
        );
        drop(instance);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while config.socket_path.exists() || control.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("gvproxy socket cleanup completed before restart");
    }
}
