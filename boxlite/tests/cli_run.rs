use assert_cmd::Command;
use predicates::prelude::*;

#[test]
fn test_help() {
    let mut cmd = Command::cargo_bin("boxlite").unwrap();
    cmd.arg("--help");
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("Usage"));
}

#[test]
fn test_version() {
    let mut cmd = Command::cargo_bin("boxlite").unwrap();
    cmd.arg("--version");
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("boxlite")); // Output format: "boxlite <version>"
}

#[test]
fn test_invalid_command() {
    let mut cmd = Command::cargo_bin("boxlite").unwrap();
    cmd.arg("nonexistent-command");
    cmd.assert()
        .failure() // Should fail with exit code 1 or 2
        .stderr(predicate::str::contains("unrecognized subcommand"));
}

#[test]
fn test_run_invalid_image() {
    // Isolate test environment
    let temp_dir = tempfile::TempDir::new().unwrap();
    let home_path = temp_dir.path().to_str().unwrap();

    let mut cmd = Command::cargo_bin("boxlite").unwrap();
    // Pass --home to avoid locking ~/.boxlite
    cmd.args(&[
        "--home",
        home_path,
        "run",
        "nonexistent-image:latest",
        "echo",
        "hi",
    ]);

    // It might take a moment to initialize
    cmd.timeout(std::time::Duration::from_secs(10));

    cmd.assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}

#[test]
fn test_run_tty_error_in_pipe() {
    // This tests the TTY robustness feature we added.
    // We pipe input to `boxlite run -t` which should fail because stdin is not a TTY.

    let mut cmd = Command::cargo_bin("boxlite").unwrap();
    cmd.args(&["run", "--tty", "alpine:latest"]);

    // Simulate non-TTY input by writing to stdin
    cmd.write_stdin("ls\n");

    cmd.assert()
        .failure()
        .stderr(predicate::str::contains("input device is not a TTY"));
}
