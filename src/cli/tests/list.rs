use predicates::prelude::*;

mod common;

#[test]
fn test_list_empty_or_header() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .arg("list")
        .assert()
        .success()
        .stdout(predicate::str::contains("ID"))
        .stdout(predicate::str::contains("IMAGE"))
        .stdout(predicate::str::contains("STATUS"))
        .stdout(predicate::str::contains("CREATED"))
        .stdout(predicate::str::contains("NAMES"));
}

#[test]
fn test_list_json_format() {
    let mut ctx = common::boxlite();
    let name = "list-json-test";

    // Create a box to ensure we have output
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    let output = ctx
        .new_cmd()
        .args(["list", "-a", "--format", "json"])
        .output()
        .unwrap();

    let stdout = String::from_utf8(output.stdout).unwrap();

    // Verify it's valid JSON
    assert!(stdout.trim().starts_with('['));
    assert!(stdout.trim().ends_with(']'));

    // Verify Docker-compatible PascalCase keys
    assert!(stdout.contains("\"ID\""));
    assert!(stdout.contains("\"Image\""));
    assert!(stdout.contains("\"Status\""));
    assert!(stdout.contains("\"CreatedAt\""));
    assert!(stdout.contains("\"Names\""));

    // Verify content
    assert!(stdout.contains("alpine:latest"));
    assert!(stdout.contains("Configured"));

    ctx.cleanup_box(name);
}

#[test]
fn test_list_yaml_format() {
    let mut ctx = common::boxlite();
    let name = "list-yaml-test";

    // Create a box
    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    let output = ctx
        .new_cmd()
        .args(["list", "-a", "--format", "yaml"])
        .output()
        .unwrap();

    let stdout = String::from_utf8(output.stdout).unwrap();

    // Verify Docker-compatible PascalCase keys
    assert!(stdout.contains("ID:"));
    assert!(stdout.contains("Image:"));
    assert!(stdout.contains("Status:"));
    assert!(stdout.contains("CreatedAt:"));
    assert!(stdout.contains("Names:"));

    ctx.cleanup_box(name);
}

#[test]
fn test_list_lifecycle() {
    let mut ctx = common::boxlite();
    let name = "list-lifecycle";

    let _ = ctx
        .cmd
        .args(["create", "--name", name, "alpine:latest"])
        .output();

    ctx.new_cmd()
        .arg("list")
        .assert()
        .success()
        .stdout(predicate::str::contains(name).not());

    ctx.new_cmd()
        .args(["list", "-a"])
        .assert()
        .success()
        .stdout(predicate::str::contains(name))
        .stdout(predicate::str::contains("Configured"));

    ctx.cleanup_box(name);
}

#[test]
fn test_list_alias_ls() {
    let mut ctx = common::boxlite();
    ctx.cmd.arg("ls").assert().success();
}
