use super::*;

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/outbound/bootstrap-v1.json"
    )))
    .unwrap()
}

#[test]
fn outbound_bootstrap_shim_extracts_identity_and_retains_provisioning_policy() {
    let wire = fixture();
    let (spec, revision) = parse_config(&wire.to_string()).unwrap();
    assert_eq!(
        revision.unwrap().as_str(),
        wire["outbound_revision"].as_str().unwrap()
    );
    let network = spec.network_backend_spec.unwrap();
    assert!(network.outbound_disabled);
    assert!(network.allow_net.is_empty());
    assert_eq!(spec.box_id, "outbound-bootstrap");
}

#[test]
fn outbound_bootstrap_shim_accepts_legacy_messages_and_rejects_bad_metadata() {
    let mut wire = fixture();
    wire.as_object_mut().unwrap().remove("outbound_revision");
    assert!(parse_config(&wire.to_string()).unwrap().1.is_none());
    wire["outbound_revision"] = serde_json::Value::Null;
    assert!(parse_config(&wire.to_string()).unwrap().1.is_none());
    for token in [
        serde_json::json!(""),
        serde_json::json!("bad token"),
        serde_json::json!("a".repeat(129)),
        serde_json::json!(7),
        serde_json::json!({"revision":"rev-a"}),
    ] {
        wire["outbound_revision"] = token;
        assert!(
            parse_config(&wire.to_string())
                .unwrap_err()
                .to_string()
                .contains("Invalid outbound bootstrap revision")
        );
    }
}
