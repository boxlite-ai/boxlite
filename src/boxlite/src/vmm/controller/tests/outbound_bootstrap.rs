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
