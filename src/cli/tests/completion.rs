//! Tests for shell completion generation (`boxlite completion bash|zsh|fish`).
//! Verifies that each shell gets a non-empty script containing all visible subcommands.
//! Expected subcommands are derived from `boxlite --help` so adding/removing commands
//! does not require updating this file.

use assert_cmd::Command;
use predicates::prelude::*;
use rstest::rstest;

/// Minimum number of visible subcommands in `boxlite --help`. Bump when adding a new visible subcommand.
const MIN_VISIBLE_SUBCOMMANDS: usize = 13;

fn boxlite_cmd() -> Command {
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
}

/// Returns visible subcommand names by parsing `boxlite --help` (Commands: section).
/// Skips "help". Hidden subcommands (e.g. completion) do not appear in help, so they are not included.
/// This test assumes clap's help output keeps the "Commands:" section format stable.
fn visible_subcommand_names() -> Vec<String> {
    let assert = boxlite_cmd().arg("--help").assert().success();
    let stdout = std::str::from_utf8(&assert.get_output().stdout).unwrap();
    let mut names = Vec::new();
    let mut in_commands = false;
    for line in stdout.lines() {
        if line.trim() == "Commands:" {
            in_commands = true;
            continue;
        }
        if in_commands {
            if line.trim().is_empty() || line.starts_with("Options:") {
                break;
            }
            // Lines like "  run      Run a box" or "  ls       List boxes (alias)"
            if let Some(first) = line.split_whitespace().next()
                && first != "help"
            {
                names.push(first.to_string());
            }
        }
    }
    assert!(
        names.contains(&"run".to_string()),
        "parsed subcommands should include 'run'; boxlite --help format may have changed"
    );
    // If clap's help format changes, parsing may return too few items; enforce minimum known count
    assert!(
        names.len() >= MIN_VISIBLE_SUBCOMMANDS,
        "parsed {} subcommands from --help, expected at least {}; help format may have changed",
        names.len(),
        MIN_VISIBLE_SUBCOMMANDS
    );
    names
}

#[rstest]
#[case("bash")]
#[case("zsh")]
#[case("fish")]
fn completion_exits_success(#[case] shell: &str) {
    boxlite_cmd().args(["completion", shell]).assert().success();
}

#[rstest]
#[case("bash")]
#[case("zsh")]
#[case("fish")]
fn completion_output_non_empty(#[case] shell: &str) {
    let assert = boxlite_cmd().args(["completion", shell]).assert().success();
    let stdout = std::str::from_utf8(&assert.get_output().stdout).unwrap();
    assert!(
        !stdout.trim().is_empty(),
        "{} completion script must not be empty",
        shell
    );
}

#[rstest]
#[case("bash")]
#[case("zsh")]
#[case("fish")]
fn completion_contains_subcommands(#[case] shell: &str) {
    let expected = visible_subcommand_names();
    assert!(
        !expected.is_empty(),
        "help should list at least one subcommand"
    );
    let assert = boxlite_cmd().args(["completion", shell]).assert().success();
    let stdout = std::str::from_utf8(&assert.get_output().stdout).unwrap();
    for sub in &expected {
        assert!(
            stdout.contains(sub),
            "{} completion script must contain subcommand '{}' (from --help)",
            shell,
            sub
        );
    }
}

#[test]
fn completion_invalid_shell_fails() {
    boxlite_cmd()
        .args(["completion", "invalid"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("invalid"));
}

#[test]
fn completion_not_shown_in_help() {
    let assert = boxlite_cmd().arg("--help").assert().success();
    let stdout = std::str::from_utf8(&assert.get_output().stdout).unwrap();
    assert!(
        !stdout.contains("completion"),
        "completion subcommand should be hidden from --help"
    );
}
