//! Real OpenCode comparison across native SDK callers and the Rust agent API.

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
        .expect("native acceptance output missing JSON");
    serde_json::from_str(line).unwrap()
}

#[test]
#[ignore = "requires a VM and BOXLITE_TEST_OPENCODE_BINARY"]
fn c_opencode_vm_matches_rust() {
    let program = std::env::var("BOXLITE_C_AGENT_VM_BIN").expect("set BOXLITE_C_AGENT_VM_BIN");
    compare_vm_callers(&[("C", program)]);
}

#[test]
#[ignore = "requires a VM, OpenCode and compiled C/Go acceptance callers"]
fn go_opencode_vm_matches_rust() {
    let c = std::env::var("BOXLITE_C_AGENT_VM_BIN").expect("set BOXLITE_C_AGENT_VM_BIN");
    let go = std::env::var("BOXLITE_GO_AGENT_VM_BIN").expect("set BOXLITE_GO_AGENT_VM_BIN");
    compare_vm_callers(&[("C", c), ("GO", go)]);
}

fn compare_vm_callers(programs: &[(&str, String)]) {
    let binary = std::env::var(opencode::BINARY_ENV).expect("set BOXLITE_TEST_OPENCODE_BINARY");
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
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
    let rust_result = boxlite::agents::records::result(&rust_result);
    for (label, program) in programs {
        let caller_home = boxlite_test_utils::home::PerTestBoxHome::new();
        let mut command = std::process::Command::new(program);
        if *label == "GO" {
            command.args(["-test.run=^TestGoAgentVMDriver$", "-test.v", "--"]);
        }
        let output = command
            .arg(&binary)
            .arg(&config)
            .arg(&caller_home.path)
            .arg(&registry.host)
            .output()
            .expect("run compiled native agent acceptance");
        assert!(
            output.status.success(),
            "{label} acceptance failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let actual_event = json_line(&stdout, &format!("{label}_EVENT="));
        let actual_result = json_line(&stdout, &format!("{label}_RESULT="));
        let actual_turn = json_line(&stdout, &format!("{label}_TURN="));
        let actual_config = json_line(&stdout, &format!("{label}_CONFIG="));
        let actual_capabilities = json_line(&stdout, &format!("{label}_CAPABILITIES="));
        assert_eq!(actual_config["model"], "fake/fake-model");
        assert!(
            actual_capabilities["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|op| op == "agent.send")
        );
        for key in ["status", "outcome", "text", "data", "artifacts", "error"] {
            assert_eq!(actual_result[key], rust_result[key], "result field {key}");
        }
        let mut actual_usage = actual_result["usage"].clone();
        let mut rust_usage = rust_result["usage"].clone();
        for usage in [&mut actual_usage, &mut rust_usage] {
            if let Some(entries) = usage.as_array_mut() {
                for entry in entries {
                    let id = entry.as_object_mut().unwrap().remove("message_id").unwrap();
                    assert!(!id.as_str().unwrap().is_empty());
                }
            }
        }
        assert_eq!(
            actual_usage, rust_usage,
            "usage apart from per-session message IDs"
        );
        assert_eq!(actual_result["turn_id"], actual_turn["id"]);
        assert_eq!(actual_event["kind"], rust_event.kind);
        assert_eq!(
            actual_event["turn_id"].as_str() == actual_turn["id"].as_str(),
            rust_event.turn_id.as_deref() == Some(rust_turn_id.as_str())
        );
        assert_eq!(
            actual_event["turn_id"].is_null(),
            rust_event.turn_id.is_none()
        );
        eprintln!(
            "{label}/Rust match: result fields, normalized usage, first-event kind and turn association"
        );
    }
}
