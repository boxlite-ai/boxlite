use super::*;

#[test]
fn outbound_bootstrap_keeps_public_spec_shape_and_adds_private_identity() {
    let wire: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/outbound/bootstrap-v1.json"
    )))
    .unwrap();
    let spec: InstanceSpec = serde_json::from_value(wire.clone()).unwrap();
    let revision: crate::net::OutboundRevision =
        serde_json::from_value(wire["outbound_revision"].clone()).unwrap();
    let public = serde_json::to_value(&spec).unwrap();
    let legacy: serde_json::Value =
        serde_json::from_str(&serialize_shim_config(&spec, None).unwrap()).unwrap();
    assert_eq!(legacy, public, "existing launch requests changed shape");
    assert!(public.get("outbound_revision").is_none());
    let mut seeded: serde_json::Value =
        serde_json::from_str(&serialize_shim_config(&spec, Some(&revision)).unwrap()).unwrap();
    assert_eq!(
        seeded
            .as_object_mut()
            .unwrap()
            .remove("outbound_revision")
            .unwrap(),
        wire["outbound_revision"]
    );
    assert_eq!(seeded, public);
    assert_eq!(seeded["network_backend_spec"]["outbound_disabled"], true);
}

#[test]
fn outbound_bootstrap_protected_wire_requires_route_and_policy() {
    use crate::net::{
        OutboundRevision, OutboundSnapshot,
        gvproxy::{ManagedProxyCredential, ManagedProxyIdentity, ManagedProxyRoute},
    };
    use crate::vmm::shim_launch::{ShimNetworkLaunch, decode_launch};

    let spec: InstanceSpec = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/outbound/bootstrap-v1.json"
    )))
    .unwrap();
    let network = ProtectedNetworkLaunch {
        policy: OutboundSnapshot {
            policy: Default::default(),
            revision: OutboundRevision::fresh(),
        },
        route: ManagedProxyRoute {
            binding: ManagedProxyIdentity {
                registration_id: OutboundRevision::parse("reg-one").unwrap(),
                registration_revision: OutboundRevision::parse("7").unwrap(),
                epoch: OutboundRevision::fresh(),
            },
            scheme: "https".into(),
            host: "proxy.example.com".into(),
            port: 443,
            doh_url: "https://resolver.example.com/dns-query".into(),
            doh_address: "1.1.1.1:443".parse().unwrap(),
            credential: Some(ManagedProxyCredential {
                username: "test-user".into(),
                password: "secret-proof-credential".into(),
            }),
        },
    };
    let wire = encode_protected_launch(&spec, &network).unwrap();
    assert!(
        serde_json::from_str::<InstanceSpec>(&wire).is_err(),
        "a legacy shim must reject the protected record"
    );
    let (instance, ShimNetworkLaunch::Protected(decoded)) = decode_launch(&wire).unwrap() else {
        panic!("expected protected launch");
    };
    assert!(instance.network_backend_spec.unwrap().outbound_disabled);
    assert_eq!(decoded.policy, network.policy);
    assert_eq!(decoded.route.binding, network.route.binding);
    assert_eq!(
        decoded.route.credential.as_ref().unwrap().password,
        "secret-proof-credential"
    );
    assert!(!format!("{decoded:?}").contains("secret-proof-credential"));

    let json: serde_json::Value = serde_json::from_str(&wire).unwrap();
    for removed in ["route", "policy"] {
        let mut incomplete = json.clone();
        incomplete.as_object_mut().unwrap().remove(removed);
        let error = decode_launch(&incomplete.to_string()).unwrap_err();
        assert!(error.to_string().contains("Invalid protected shim launch"));
        assert!(!error.to_string().contains("secret-proof-credential"));
    }
    assert!(decode_launch(&format!("{wire} {{}}")).is_err());
}
