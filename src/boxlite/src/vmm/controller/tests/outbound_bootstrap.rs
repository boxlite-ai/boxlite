use super::*;

fn write_probe(directory: &std::path::Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join("test-shim");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

#[tokio::test]
async fn outbound_bootstrap_probe_requires_one_complete_successful_reply() {
    let directory = tempfile::tempdir().unwrap();
    let shim = write_probe(
        directory.path(),
        r#"test "$(cat)" = '{"outbound_policy_probe":1}' || exit 3
printf '%s\n' '{"admission":true,"deny":false,"port":true,"capacity":false}'"#,
    );
    let reply = probe_outbound_capabilities_at(shim).await.unwrap();
    assert!(reply.admission && reply.port && !reply.deny && !reply.capacity);

    for body in [
        r#"printf '%s' '{"admission":true}'"#,
        r#"printf '%s' '{"admission":true,"deny":false,"port":true,"capacity":false}'; exit 1"#,
        r#"printf '%4097s' ' '"#,
    ] {
        let shim = write_probe(directory.path(), body);
        assert!(probe_outbound_capabilities_at(shim).await.is_err());
    }
}

#[tokio::test]
async fn outbound_bootstrap_probe_reaps_child_on_caller_cancellation() {
    use std::time::Duration;
    let directory = tempfile::tempdir().unwrap();
    let shim = write_probe(
        directory.path(),
        r#"cat >/dev/null
printf '%s' "$$" > "${0%/*}/child.pid"
exec sleep 30"#,
    );
    let probe = tokio::spawn(probe_outbound_capabilities_at(shim));
    let pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(file) = tokio::fs::read_to_string(directory.path().join("child.pid")).await
                && let Ok(pid) = file.parse::<u32>()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(crate::util::is_process_alive(pid));
    probe.abort();
    let _ = probe.await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while crate::util::is_process_alive(pid) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("cancelled bootstrap probe must reap the child");
}

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
