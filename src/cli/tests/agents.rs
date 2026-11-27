//! CLI dispatch for `boxlite agent`: parsing and completion without a VM, and
//! ignored real-VM tests that drive OpenCode through separate CLI processes.

mod common;
#[path = "../../boxlite/tests/common/opencode.rs"]
mod opencode;

use assert_cmd::Command;
use predicates::str::contains;
use serde_json::Value;
use std::time::Duration;

#[test]
fn agents_binary_help_works_and_malformed_input_is_a_usage_error() {
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env_clear()
        .args(["agent", "steer", "--help"])
        .assert()
        .success()
        .stdout(contains("Steer this turn without creating another turn"));
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env_clear()
        .args(["agent", "create", "--help"])
        .assert()
        .success()
        .stdout(contains("--agent <IMPLEMENTATION>"));
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env_clear()
        .args([
            "agent",
            "create",
            "box",
            "--agent",
            "coder",
            "--agent-config",
            "not-json",
        ])
        .assert()
        .code(2)
        .stdout("");
}

#[test]
fn agents_invalid_target_combinations_are_usage_errors() {
    let cases: &[&[&str]] = &[
        &["create", "box"],
        &["create", "box", "--agent"],
        &["create", "--agent", "coder"],
        &["create", "box", "coder"],
        &["create", "box", "--agent", "coder", "extra"],
        &["create", "box", "--agent", "coder", "--name", "worker"],
        &["send", "box", "hello"],
        &["send", "box", "--session", "agent", "hello"],
        &["steer", "box", "--agent", "agent", "hello"],
        &["respond", "box", "--agent", "agent", "{}"],
        &[
            "inspect", "box", "--agent", "agent", "--turn", "turn", "--view", "config",
        ],
        &["inspect", "box", "--agent", "agent", "--view", "unknown"],
        &["agent", "send", "box", "agent", "hello"],
        &["turn", "wait", "box", "agent", "turn"],
        &["get", "box", "agent"],
    ];
    for args in cases {
        Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .env_clear()
            .arg("agent")
            .args(*args)
            .assert()
            .code(2)
            .stdout("");
    }
}

#[test]
fn agents_fish_completion_uses_command_paths_not_message_words() {
    // Fish is optional for building the CLI; exercise its interpreter when installed.
    match std::process::Command::new("fish").arg("--version").output() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("Fish is not installed; skipping the shell interpreter check");
            return;
        }
        result => assert!(result.expect("start Fish").status.success()),
    }
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("boxlite.fish");
    let completion = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env_clear()
        .args(["completion", "fish"])
        .assert()
        .success();
    std::fs::write(&script, &completion.get_output().stdout).unwrap();
    for (input, expected, forbidden) in [
        ("boxlite agent ", "steer", "exec"),
        ("boxlite --context send agent ", "steer", "exec"),
        ("boxlite agent --context wait ", "steer", "exec"),
        ("boxlite --profile send agent ", "steer", "exec"),
        ("boxlite agent --profile wait ", "steer", "exec"),
        ("boxlite agent create box --", "--agent", "--name"),
        (
            "boxlite agent create box --agent wait --",
            "--agent-config",
            "--timeout-seconds",
        ),
        (
            "boxlite agent send box --agent AGENT text --",
            "--mode",
            "--session",
        ),
        (
            "boxlite agent wait box --agent agent --turn turn --",
            "--timeout-seconds",
            "--mode",
        ),
        (
            "boxlite agent send wait --agent AGENT wait --",
            "--mode",
            "--timeout-seconds",
        ),
        (
            "boxlite --profile wait agent --url https://example.test send turn --agent AGENT wait --",
            "--mode",
            "--timeout-seconds",
        ),
        (
            "boxlite agent --profile send wait box --agent AGENT --turn TURN --",
            "--timeout-seconds",
            "--mode",
        ),
    ] {
        let output = std::process::Command::new("fish")
            .args(["--no-config", "-c", "set -g fish_complete_path; source $argv[1]; or exit 1; complete --do-complete $argv[2]", "--"])
            .arg(&script).arg(input).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output = String::from_utf8(output.stdout).unwrap();
        let suggestions: Vec<_> = output
            .lines()
            .map(|line| line.split('\t').next().unwrap())
            .collect();
        assert!(
            suggestions.contains(&expected),
            "missing {expected} for {input}: {output}"
        );
        assert!(
            !suggestions.contains(&forbidden),
            "unexpected {forbidden} for {input}: {output}"
        );
    }
}

/// A detached Box with OpenCode and a provider config for the fake model, set
/// up through the CLI so later `boxlite agent` processes find it running.
fn opencode_box(ctx: &common::TestContext, name: &str, model_port: u16) {
    let binary = std::env::var(opencode::BINARY_ENV)
        .unwrap_or_else(|_| panic!("set {}", opencode::BINARY_ENV));
    ctx.new_cmd()
        .args([
            "create",
            "--name",
            name,
            "debian:bookworm-slim",
            "sleep",
            "infinity",
        ])
        .assert()
        .success();
    ctx.new_cmd().args(["start", name]).assert().success();
    let config = ctx.home.join("opencode.json");
    std::fs::write(&config, opencode::provider_config(model_port).to_string()).unwrap();
    ctx.new_cmd()
        .args(["exec", name, "--", "mkdir", "-p", "/root/.config/opencode"])
        .assert()
        .success();
    ctx.new_cmd()
        .arg("cp")
        .arg(&binary)
        .arg(format!("{name}:/usr/local/bin/opencode"))
        .assert()
        .success();
    ctx.new_cmd()
        .arg("cp")
        .arg(&config)
        .arg(format!("{name}:/root/.config/opencode/opencode.json"))
        .assert()
        .success();
    ctx.new_cmd()
        .args([
            "exec",
            name,
            "--",
            "chmod",
            "755",
            "/usr/local/bin/opencode",
        ])
        .assert()
        .success();
}

/// Run `boxlite agent ARGS` and parse its single JSON record.
fn agent_json(ctx: &common::TestContext, args: &[&str]) -> Value {
    let output = ctx
        .new_cmd()
        .timeout(Duration::from_secs(180))
        .arg("agent")
        .args(args)
        .assert()
        .success();
    serde_json::from_slice(&output.get_output().stdout).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; run make test:integration:agents"]
async fn agents_drive_opencode_across_cli_processes() {
    let (model_port, _log) = opencode::start_fake_model().await;
    let ctx = common::boxlite();
    let name = "cli-agent";
    opencode_box(&ctx, name, model_port);

    let created = agent_json(
        &ctx,
        &[
            "create",
            name,
            "--agent",
            "opencode",
            "--agent-config",
            r#"{"model":"fake/fake-model"}"#,
        ],
    );
    let agent_id = created["id"].as_str().unwrap().to_owned();
    assert!(agent_id.starts_with("ses_"), "{created}");

    let turn = agent_json(&ctx, &["send", name, "--agent", &agent_id, "hello"]);
    let turn_id = turn["id"].as_str().unwrap().to_owned();
    assert_eq!(turn["agent_id"], agent_id.as_str());
    let result = agent_json(
        &ctx,
        &[
            "wait",
            name,
            "--agent",
            &agent_id,
            "--turn",
            &turn_id,
            "--timeout-seconds",
            "120",
        ],
    );
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(result["text"], "pong: hello", "{result}");
    let inspected = agent_json(
        &ctx,
        &["inspect", name, "--agent", &agent_id, "--turn", &turn_id],
    );
    assert_eq!(inspected["status"], "completed", "{inspected}");
    let config = agent_json(
        &ctx,
        &["inspect", name, "--agent", &agent_id, "--view", "config"],
    );
    assert_eq!(config["model"], "fake/fake-model", "{config}");

    ctx.cleanup_box(name);
}

#[test]
#[ignore = "needs a VM and network; run make test:integration:agents"]
fn agents_reach_the_local_runtime_and_report_a_box_without_opencode() {
    let ctx = common::boxlite();
    let name = "cli-agent-missing";
    ctx.new_cmd()
        .args([
            "create",
            "--name",
            name,
            "debian:bookworm-slim",
            "sleep",
            "infinity",
        ])
        .assert()
        .success();
    ctx.new_cmd().args(["start", name]).assert().success();
    ctx.new_cmd()
        .timeout(Duration::from_secs(180))
        .args(["agent", "create", name, "--agent", "opencode"])
        .assert()
        .code(1)
        .stdout("")
        .stderr(contains("must provide OpenCode 2.2.2"));
    ctx.cleanup_box(name);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; run make test:integration:agents"]
async fn agents_over_rest_drive_opencode() {
    use boxlite::agents::{
        AgentCreateOptions, AgentEventsOptions, AgentSendOptions, AgentWaitOptions,
    };
    use futures::StreamExt;

    let (model_port, _) = opencode::start_fake_model().await;
    let name = "cli-agent-rest";
    let ctx = common::boxlite();
    opencode_box(&ctx, name, model_port);
    let serve = common::serve::ServeChild::start_for_home(&ctx.home);

    let runtime =
        boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(serve.url())).unwrap();
    let sandbox = runtime.get(name).await.unwrap().unwrap();
    let agent = sandbox
        .agents()
        .create(
            "opencode",
            AgentCreateOptions {
                config: boxlite::agents::AgentConfig {
                    model: Some("fake/fake-model".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        agent.config().unwrap().model.as_deref(),
        Some("fake/fake-model")
    );
    assert!(
        agent
            .capabilities()
            .unwrap()
            .operations
            .iter()
            .any(|op| op == "agent.send")
    );
    assert!(matches!(
        agent.state(),
        Err(boxlite::BoxliteError::Unsupported(_))
    ));
    assert!(matches!(
        agent.requests().await,
        Err(boxlite::BoxliteError::Unsupported(_))
    ));
    let mut events = agent.events(AgentEventsOptions::default()).await.unwrap();
    let turn = agent
        .send("hello", AgentSendOptions::default())
        .await
        .unwrap();
    let turn_id = turn.state().unwrap().id;
    let result = turn
        .wait(AgentWaitOptions {
            timeout: Some(Duration::from_secs(120)),
        })
        .await
        .unwrap();
    assert_eq!(result.text.as_deref(), Some("pong: hello"));
    assert_eq!(result.turn_id, turn_id);
    let event = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let event = events.next().await.unwrap().unwrap();
            if event.kind == "session.inbox.enqueued" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(event.turn_id.as_deref(), Some(turn_id.as_str()));
    assert_eq!(
        agent.get_turn(&turn_id).await.unwrap().state().unwrap().id,
        turn_id
    );
    assert!(matches!(
        agent.close(Default::default()).await,
        Err(boxlite::BoxliteError::Unsupported(_))
    ));
    drop(events);
    let removed = serve.client(&["rm", "--force", name]);
    assert!(removed.status.success(), "{removed:?}");
    serve.wait_until_no_boxes();
}

/// Compare native and remote handles using the same input and real OpenCode.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; run make test:integration:agents"]
async fn agents_over_rest_match_local_rust() {
    use boxlite::agents::{
        self, AgentCreateOptions, AgentEventsOptions, AgentResponse, AgentSendOptions,
        AgentWaitOptions,
    };
    use futures::StreamExt;

    async fn observe(sandbox: &boxlite::LiteBox) -> (Value, Value, Value, Value, String, bool) {
        let agent = sandbox
            .agents()
            .create(
                "opencode",
                AgentCreateOptions {
                    config: agents::AgentConfig {
                        model: Some("fake/fake-model".into()),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let agent_id = agent.id().to_owned();
        assert!(!agent_id.is_empty());
        let config = agents::records::config(&agent.config().unwrap());
        let capabilities = agents::records::capabilities(&agent.capabilities().unwrap());
        let reopened = sandbox.agents().get(&agent_id).await.unwrap();
        assert_eq!(reopened.id(), agent_id);
        assert_eq!(agents::records::config(&reopened.config().unwrap()), config);
        assert_eq!(
            agents::records::capabilities(&reopened.capabilities().unwrap()),
            capabilities
        );
        assert!(matches!(
            agent.state(),
            Err(boxlite::BoxliteError::Unsupported(_))
        ));
        assert!(matches!(
            agent.requests().await,
            Err(boxlite::BoxliteError::Unsupported(_))
        ));

        let mut events = agent.events(AgentEventsOptions::default()).await.unwrap();
        let turn = agent
            .send("hello", AgentSendOptions::default())
            .await
            .unwrap();
        let turn_id = turn.state().unwrap().id;
        assert!(!turn_id.is_empty());
        let result = turn
            .wait(AgentWaitOptions {
                timeout: Some(Duration::from_secs(120)),
            })
            .await
            .unwrap();
        assert_eq!(result.turn_id, turn_id);
        let first = tokio::time::timeout(Duration::from_secs(30), events.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first.agent_id, agent_id);
        let event_names_turn = first.turn_id.as_deref() == Some(turn_id.as_str());
        let fetched = reopened.get_turn(&turn_id).await.unwrap().state().unwrap();
        assert_eq!(fetched.id, turn_id);
        assert_eq!(fetched.agent_id, agent_id);
        assert_eq!(fetched.result.as_ref().unwrap().turn_id, turn_id);
        assert!(matches!(
            agent.close(Default::default()).await,
            Err(boxlite::BoxliteError::Unsupported(_))
        ));
        assert!(matches!(
            turn.steer("adjust", Default::default()).await,
            Err(boxlite::BoxliteError::Unsupported(_))
        ));
        assert!(matches!(
            turn.interrupt(Default::default()).await,
            Err(boxlite::BoxliteError::Unsupported(_))
        ));
        assert!(matches!(
            agent
                .respond(
                    "request",
                    AgentResponse::Permission { approved: false },
                    Default::default()
                )
                .await,
            Err(boxlite::BoxliteError::Unsupported(_))
        ));
        assert!(matches!(
            turn.events(Default::default()).await,
            Err(boxlite::BoxliteError::Unsupported(_))
        ));

        fn normalized_result(mut value: Value, turn_id: &str) -> Value {
            let object = value.as_object_mut().unwrap();
            assert_eq!(object.remove("turn_id").unwrap(), turn_id);
            if let Some(entries) = object.get_mut("usage").and_then(Value::as_array_mut) {
                for entry in entries {
                    let id = entry.as_object_mut().unwrap().remove("message_id").unwrap();
                    assert!(!id.as_str().unwrap().is_empty());
                }
            }
            value
        }
        let result = serde_json::from_str(agents::records::result(&result).get()).unwrap();
        let result = normalized_result(result, &turn_id);
        let mut snapshot: Value =
            serde_json::from_str(agents::records::turn_state(&fetched).get()).unwrap();
        let object = snapshot.as_object_mut().unwrap();
        assert_eq!(object.remove("id").unwrap(), turn_id);
        assert_eq!(object.remove("agent_id").unwrap(), agent_id);
        let snapshot_result = object.remove("result").unwrap();
        object.insert(
            "result".into(),
            normalized_result(snapshot_result, &turn_id),
        );
        (
            config,
            capabilities,
            result,
            snapshot,
            first.kind,
            event_names_turn,
        )
    }

    let (model_port, _) = opencode::start_fake_model().await;
    let local = common::boxlite();
    opencode_box(&local, "local-agent", model_port);
    let runtime = boxlite::BoxliteRuntime::new(boxlite::BoxliteOptions {
        home_dir: local.home.clone(),
        ..Default::default()
    })
    .unwrap();
    let sandbox = runtime.get("local-agent").await.unwrap().unwrap();
    let native = observe(&sandbox).await;
    drop(sandbox);
    runtime.shutdown(Some(30)).await.unwrap();
    drop(runtime);
    local.cleanup_box("local-agent");

    let remote = common::boxlite();
    opencode_box(&remote, "remote-agent", model_port);
    let serve = common::serve::ServeChild::start_for_home(&remote.home);
    let runtime =
        boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(serve.url())).unwrap();
    let sandbox = runtime.get("remote-agent").await.unwrap().unwrap();
    let transported = observe(&sandbox).await;
    assert_eq!(native.0, transported.0, "agent configuration");
    assert_eq!(native.1, transported.1, "agent capabilities");
    assert_eq!(native.2, transported.2, "turn result");
    assert_eq!(native.3, transported.3, "turn snapshot");
    assert_eq!(native.4, transported.4, "first event kind");
    assert_eq!(native.5, transported.5, "first event turn association");
    let removed = serve.client(&["rm", "--force", "remote-agent"]);
    assert!(removed.status.success(), "{removed:?}");
    serve.wait_until_no_boxes();
}
