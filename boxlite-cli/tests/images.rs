use predicates::prelude::*;

mod common;

#[test]
fn test_images_table_header() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .arg("images")
        .assert()
        .success()
        .stdout(predicate::str::contains("REPOSITORY"))
        .stdout(predicate::str::contains("TAG"))
        .stdout(predicate::str::contains("IMAGE ID"))
        .stdout(predicate::str::contains("CREATED"));
}

#[test]
fn test_images_list() {
    let ctx = common::boxlite();
    let _ = ctx.new_cmd().args(["pull", "alpine:latest"]).output();

    ctx.new_cmd()
        .arg("images")
        .assert()
        .success()
        .stdout(predicate::str::contains("alpine"))
        .stdout(predicate::str::contains("latest"));
}

#[test]
fn test_images_quiet() {
    let mut ctx = common::boxlite();

    // Quiet mode should show IDs only, no headers
    ctx.cmd
        .args(["images", "-q"])
        .assert()
        .success()
        .stdout(predicate::str::contains("REPOSITORY").not())
        .stdout(predicate::str::contains("TAG").not());
}

#[test]
fn test_images_format() {
    let mut ctx = common::boxlite();

    let assert = ctx
        .cmd
        .args(["images", "--format", "json"])
        .assert()
        .success();
    let output = assert.get_output();
    let stdout = std::str::from_utf8(&output.stdout).unwrap();
    assert!(stdout.starts_with('['));
    assert!(stdout.trim().ends_with(']'));

    assert!(stdout.contains("\"Repository\""));
    assert!(stdout.contains("\"Tag\""));
    assert!(stdout.contains("\"ID\""));
}

#[test]
fn test_images_yaml_format() {
    let mut ctx = common::boxlite();

    let assert = ctx
        .cmd
        .args(["images", "--format", "yaml"])
        .assert()
        .success();
    let output = assert.get_output();
    let stdout = std::str::from_utf8(&output.stdout).unwrap();

    // YAML start with array indicator
    assert!(stdout.starts_with('-') || stdout.trim().starts_with("[]"));

    assert!(stdout.contains("Repository:") || stdout.trim() == "[]");
    assert!(stdout.contains("Tag:") || stdout.trim() == "[]");
    assert!(stdout.contains("ID:") || stdout.trim() == "[]");
    assert!(stdout.contains("CreatedAt:") || stdout.trim() == "[]");
}
