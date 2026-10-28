//! Exercise real CLI dispatch without a runtime, credentials, or a guest VM.

use assert_cmd::Command;
use predicates::str::contains;

#[test]
fn agents_flat_targets_fail_before_runtime_setup() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("runtime-must-not-exist");
    let config = directory.path().join("missing-config.json");
    let cases: &[(&[&str], &str)] = &[
        (&["create", "box", "coder"], "agents.create"),
        (&["close", "box", "--session", "session"], "session.close"),
        (
            &["send", "box", "--session", "session", "hello"],
            "session.send",
        ),
        (
            &["inspect", "box", "--session", "session", "--turn", "turn"],
            "turn.state",
        ),
        (&["events", "box", "--session", "session"], "session.events"),
        (
            &[
                "inspect",
                "box",
                "--session",
                "session",
                "--view",
                "requests",
            ],
            "session.requests",
        ),
        (
            &[
                "respond",
                "box",
                "--session",
                "session",
                "--request",
                "request",
                r#"{"type":"answer","text":"yes"}"#,
            ],
            "session.respond",
        ),
        (&["inspect", "box", "--session", "session"], "session.state"),
        (
            &["inspect", "box", "--session", "session", "--view", "config"],
            "session.config",
        ),
        (
            &[
                "inspect",
                "box",
                "--session",
                "session",
                "--view",
                "capabilities",
            ],
            "session.capabilities",
        ),
        (
            &["wait", "box", "--session", "session", "--turn", "turn"],
            "turn.wait",
        ),
        (
            &["events", "box", "--session", "session", "--turn", "turn"],
            "turn.events",
        ),
        (
            &[
                "steer",
                "box",
                "--session",
                "session",
                "--turn",
                "turn",
                "use Rust",
            ],
            "turn.steer",
        ),
        (
            &["interrupt", "box", "--session", "session", "--turn", "turn"],
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
        .args([
            "agent",
            "create",
            "box",
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
        &["send", "box", "hello"],
        &["steer", "box", "--session", "session", "hello"],
        &["respond", "box", "--session", "session", "{}"],
        &[
            "inspect",
            "box",
            "--session",
            "session",
            "--turn",
            "turn",
            "--view",
            "config",
        ],
        &[
            "inspect",
            "box",
            "--session",
            "session",
            "--view",
            "unknown",
        ],
        &["session", "send", "box", "session", "hello"],
        &["turn", "wait", "box", "session", "turn"],
        &["get", "box", "session"],
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
        ("boxlite --profile send agent ", "steer", "exec"),
        ("boxlite agent --profile wait ", "steer", "exec"),
        (
            "boxlite agent wait box --session session --turn turn --",
            "--timeout-seconds",
            "--mode",
        ),
        (
            "boxlite agent send wait --session SESSION wait --",
            "--mode",
            "--timeout-seconds",
        ),
        (
            "boxlite --profile wait agent --url https://example.test send turn --session SESSION wait --",
            "--mode",
            "--timeout-seconds",
        ),
        (
            "boxlite agent --profile send wait box --session SESSION --turn TURN --",
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
