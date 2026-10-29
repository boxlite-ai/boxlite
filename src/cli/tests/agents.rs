//! Exercise real CLI dispatch without a runtime, credentials, or a guest VM.

use assert_cmd::Command;
use predicates::str::contains;

#[test]
fn agents_flat_targets_fail_before_runtime_setup() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("runtime-must-not-exist");
    let config = directory.path().join("missing-config.json");
    let cases: &[(&[&str], &str)] = &[
        (&["create", "box", "--agent", "coder"], "agents.create"),
        (&["create", "--agent", "coder", "box"], "agents.create"),
        (&["close", "box", "--agent", "agent"], "agent.close"),
        (&["send", "box", "--agent", "agent", "hello"], "agent.send"),
        (
            &["inspect", "box", "--agent", "agent", "--turn", "turn"],
            "turn.state",
        ),
        (&["events", "box", "--agent", "agent"], "agent.events"),
        (
            &["inspect", "box", "--agent", "agent", "--view", "requests"],
            "agent.requests",
        ),
        (
            &[
                "respond",
                "box",
                "--agent",
                "agent",
                "--request",
                "request",
                r#"{"type":"answer","text":"yes"}"#,
            ],
            "agent.respond",
        ),
        (&["inspect", "box", "--agent", "agent"], "agent.state"),
        (
            &["inspect", "box", "--agent", "agent", "--view", "config"],
            "agent.config",
        ),
        (
            &[
                "inspect",
                "box",
                "--agent",
                "agent",
                "--view",
                "capabilities",
            ],
            "agent.capabilities",
        ),
        (
            &["wait", "box", "--agent", "agent", "--turn", "turn"],
            "turn.wait",
        ),
        (
            &["events", "box", "--agent", "agent", "--turn", "turn"],
            "turn.events",
        ),
        (
            &[
                "steer", "box", "--agent", "agent", "--turn", "turn", "use Rust",
            ],
            "turn.steer",
        ),
        (
            &["interrupt", "box", "--agent", "agent", "--turn", "turn"],
            "turn.interrupt",
        ),
    ];
    for (args, operation) in cases {
        Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .env_clear()
            .arg("--home")
            .arg(&home)
            .arg("--config")
            .arg(&config)
            .args(["--url", "not-a-valid-url", "agent"])
            .args(*args)
            .assert()
            .code(1)
            .stdout("")
            .stderr(contains(format!("{operation} is not implemented")));
        assert!(!home.exists(), "{operation} created runtime state");
    }
}

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
