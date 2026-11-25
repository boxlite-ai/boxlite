//! Real OpenCode comparison between a compiled C caller and Rust agent API.

#[path = "../../../../../src/boxlite/tests/common/opencode.rs"]
mod opencode;

use boxlite::agents::{AgentCreateOptions, AgentEventsOptions, AgentSendOptions, AgentWaitOptions};
use boxlite::{BoxCommand, BoxOptions, BoxliteOptions, BoxliteRuntime, CopyOptions, RootfsSpec};
use futures::StreamExt;
use std::time::Duration;

fn json_line(output: &str, prefix: &str) -> serde_json::Value {
    let line = output
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .expect("C acceptance output missing JSON");
    serde_json::from_str(line).unwrap()
}

#[test]
#[ignore = "requires a VM and BOXLITE_TEST_OPENCODE_BINARY"]
fn c_opencode_vm_matches_rust() {
    let binary = std::env::var(opencode::BINARY_ENV).expect("set BOXLITE_TEST_OPENCODE_BINARY");
    let c_program = std::env::var("BOXLITE_C_AGENT_VM_BIN").expect("set BOXLITE_C_AGENT_VM_BIN");
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let c_home = boxlite_test_utils::home::PerTestBoxHome::new();
    let tokio_rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let (port, _model_log) = tokio_rt.block_on(opencode::start_fake_model());
    let config = home.path.join("opencode.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&opencode::provider_config(port)).unwrap(),
    )
    .unwrap();
    let registry = boxlite_test_utils::registry::local_registry().search_registry();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: vec![registry.clone()],
        ..Default::default()
    })
    .unwrap();
    let (rust_event, rust_result, rust_turn_id) = tokio_rt.block_on(async {
        let sandbox = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("debian:bookworm-slim".into()),
                    auto_delete: Some(0),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        sandbox.start().await.unwrap();
        sandbox
            .copy_into(&binary, "/usr/local/bin/opencode", CopyOptions::default())
            .await
            .unwrap();
        let execution = sandbox
            .exec(BoxCommand::new("sh").args([
                "-c",
                "chmod 755 /usr/local/bin/opencode && mkdir -p /root/.config/opencode",
            ]))
            .await
            .unwrap();
        assert_eq!(execution.wait().await.unwrap().exit_code, 0);
        sandbox
            .copy_into(
                &config,
                "/root/.config/opencode/opencode.json",
                CopyOptions::default(),
            )
            .await
            .unwrap();
        let mut create = AgentCreateOptions::default();
        create.config.model = Some("fake/fake-model".into());
        let agent = sandbox.agents().create("opencode", create).await.unwrap();
        let mut events = agent.events(AgentEventsOptions::default()).await.unwrap();
        let turn = agent
            .send("hello", AgentSendOptions::default())
            .await
            .unwrap();
        let id = turn.state().unwrap().id;
        let result = turn
            .wait(AgentWaitOptions {
                timeout: Some(Duration::from_secs(120)),
            })
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(30), events.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        sandbox.stop().await.unwrap();
        (first, result, id)
    });
    tokio_rt.block_on(runtime.shutdown(Some(30))).unwrap();
    let output = std::process::Command::new(c_program)
        .arg(&binary)
        .arg(&config)
        .arg(&c_home.path)
        .arg(&registry.host)
        .output()
        .expect("run compiled C agent acceptance");
    assert!(
        output.status.success(),
        "C acceptance failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let c_event = json_line(&stdout, "C_EVENT=");
    let c_result = json_line(&stdout, "C_RESULT=");
    let c_turn = json_line(&stdout, "C_TURN=");
    let c_config = json_line(&stdout, "C_CONFIG=");
    let c_capabilities = json_line(&stdout, "C_CAPABILITIES=");
    assert_eq!(c_config["model"], "fake/fake-model");
    assert!(
        c_capabilities["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op == "agent.send")
    );
    let rust_result: serde_json::Value =
        serde_json::from_str(boxlite::agents::records::result(&rust_result).get()).unwrap();
    for key in ["status", "outcome", "text", "data", "artifacts", "error"] {
        assert_eq!(c_result[key], rust_result[key], "result field {key}");
    }
    let mut c_usage = c_result["usage"].clone();
    let mut rust_usage = rust_result["usage"].clone();
    for usage in [&mut c_usage, &mut rust_usage] {
        if let Some(entries) = usage.as_array_mut() {
            for entry in entries {
                let id = entry.as_object_mut().unwrap().remove("message_id").unwrap();
                assert!(!id.as_str().unwrap().is_empty());
            }
        }
    }
    assert_eq!(
        c_usage, rust_usage,
        "usage apart from per-session message IDs"
    );
    assert_eq!(c_result["turn_id"], c_turn["id"]);
    assert_eq!(c_event["kind"], rust_event.kind);
    assert_eq!(
        c_event["turn_id"].as_str() == c_turn["id"].as_str(),
        rust_event.turn_id.as_deref() == Some(rust_turn_id.as_str())
    );
    assert_eq!(c_event["turn_id"].is_null(), rust_event.turn_id.is_none());
}
