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

#[test]
#[ignore = "needs a VM and network; run make test:integration:agents"]
fn agents_on_a_rest_profile_report_unsupported() {
    let serve = common::serve::ServeChild::start();
    let created = serve.client(&["create", "--name", "cli-agent-rest", "alpine:latest"]);
    assert!(created.status.success(), "{created:?}");
    let output = serve.client(&["agent", "create", "cli-agent-rest", "--agent", "opencode"]);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("agents require a local runtime"),
        "{output:?}"
    );
    let removed = serve.client(&["rm", "--force", "cli-agent-rest"]);
    assert!(removed.status.success(), "{removed:?}");
    serve.wait_until_no_boxes();
}
