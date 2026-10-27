//! Exercise real CLI dispatch without a runtime, credentials, or a guest VM.

use assert_cmd::Command;
use predicates::str::contains;

#[test]
fn agents_p0_all_operations_fail_before_runtime_setup() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("runtime-must-not-exist");
    let config = directory.path().join("missing-config.json");
    let cases: &[(&[&str], &str)] = &[
        (&["create", "box", "coder"], "agents.create"),
        (&["get", "box", "session"], "agents.get"),
        (&["session", "close", "box", "session"], "session.close"),
        (
            &["session", "send", "box", "session", "hello"],
            "session.send",
        ),
        (
            &["session", "get-turn", "box", "session", "turn"],
            "session.get_turn",
        ),
        (&["session", "events", "box", "session"], "session.events"),
        (
            &["session", "requests", "box", "session"],
            "session.requests",
        ),
        (
            &[
                "session",
                "respond",
                "box",
                "session",
                "request",
                r#"{"type":"answer","text":"yes"}"#,
            ],
            "session.respond",
        ),
        (&["session", "state", "box", "session"], "session.state"),
        (&["session", "config", "box", "session"], "session.config"),
        (
            &["session", "capabilities", "box", "session"],
            "session.capabilities",
        ),
        (&["turn", "wait", "box", "session", "turn"], "turn.wait"),
        (&["turn", "events", "box", "session", "turn"], "turn.events"),
        (
            &["turn", "steer", "box", "session", "turn", "use Rust"],
            "turn.steer",
        ),
        (
            &["turn", "interrupt", "box", "session", "turn"],
            "turn.interrupt",
        ),
        (&["turn", "state", "box", "session", "turn"], "turn.state"),
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
fn agents_p0_binary_help_works_and_malformed_input_is_a_usage_error() {
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env_clear()
        .args(["agent", "turn", "steer", "--help"])
        .assert()
        .success()
        .stdout(contains("not implemented"));
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
fn agents_p0_fish_completion_uses_command_paths_not_message_words() {
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
        (
            "boxlite agent turn wait box session turn --",
            "--timeout-seconds",
            "--mode",
        ),
        (
            "boxlite agent session send turn SESSION wait --",
            "--mode",
            "--timeout-seconds",
        ),
        (
            "boxlite --profile turn agent --url https://example.test session send turn SESSION wait --",
            "--mode",
            "--timeout-seconds",
        ),
        (
            "boxlite agent --profile session turn --profile send wait box SESSION TURN --",
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
        let flags: Vec<_> = output
            .lines()
            .map(|line| line.split('\t').next().unwrap())
            .collect();
        assert!(
            flags.contains(&expected),
            "missing {expected} for {input}: {output}"
        );
        assert!(
            !flags.contains(&forbidden),
            "unexpected {forbidden} for {input}: {output}"
        );
    }
}
