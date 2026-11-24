mod common;

use boxlite::net::CompleteOutboundPolicy;
use boxlite::{BoxOptions, BoxStatus, BoxliteOptions, BoxliteRuntime, ExportOptions};
use serde_json::Value;

#[tokio::test]
async fn local_import_keeps_complete_outbound_policy() {
    let source_home = common::boxlite();
    let import_home = common::boxlite_bare();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: source_home.home.clone(),
        image_registries: boxlite_test_utils::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let policy = CompleteOutboundPolicy {
        allow_net: vec!["api.example.test:443".into()],
        deny_net: Some(vec!["denied.example.test".into()]),
        ..Default::default()
    };
    let source = runtime
        .create_with_complete_outbound_policy(
            BoxOptions {
                auto_delete: Some(0),
                detach: true,
                ..Default::default()
            },
            None,
            policy,
        )
        .await
        .unwrap();
    source.start().await.unwrap();
    source.stop().await.unwrap();
    let source_id = source.id().to_string();
    let source = runtime.get(&source_id).await.unwrap().unwrap();
    let captured = source
        .network()
        .outbound_policy_status()
        .await
        .unwrap()
        .persisted
        .unwrap();
    let archive = source
        .export(
            ExportOptions::default(),
            &source_home.home.join("copy.boxlite"),
        )
        .await
        .unwrap();

    let output = import_home
        .new_cmd()
        .arg("import")
        .arg(archive.path())
        .assert()
        .success();
    let id = std::str::from_utf8(&output.get_output().stdout)
        .unwrap()
        .trim();
    assert_ne!(id, source_id);
    let output = import_home
        .new_cmd()
        .args(["inspect", "--outbound-policy", id])
        .assert()
        .success();
    let info: Value = serde_json::from_slice(&output.get_output().stdout).unwrap();
    let persisted = &info[0]["OutboundPolicy"]["persisted"];
    assert_eq!(
        info[0]["Status"],
        serde_json::to_value(BoxStatus::Stopped).unwrap()
    );
    assert_eq!(
        persisted["policy"],
        serde_json::to_value(captured.policy).unwrap()
    );
    assert_eq!(
        persisted["admission"],
        serde_json::to_value(captured.admission).unwrap()
    );
    assert_ne!(
        persisted["revision"],
        serde_json::to_value(captured.revision).unwrap()
    );

    import_home.new_cmd().args(["start", id]).assert().success();
    let output = import_home
        .new_cmd()
        .args(["inspect", "--outbound-policy", id])
        .assert()
        .success();
    let info: Value = serde_json::from_slice(&output.get_output().stdout).unwrap();
    let live = &info[0]["OutboundPolicy"];
    assert_eq!(live["application_state"], "confirmed", "readback: {live}");
    assert_eq!(&live["observed"]["snapshot"], persisted);
    import_home.cleanup_box(id);
}
