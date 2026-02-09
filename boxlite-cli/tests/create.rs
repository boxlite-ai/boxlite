use predicates::prelude::*;

mod common;

#[test]
fn test_create_basic() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .arg("create")
        .arg("alpine:latest")
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^[0-9A-HJ-NP-Z]{26}\n$").unwrap());
}

#[test]
fn test_create_named() {
    let mut ctx = common::boxlite();
    let name = "create-named";
    ctx.cmd
        .arg("create")
        .arg("--name")
        .arg(name)
        .arg("alpine:latest")
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^[0-9A-HJ-NP-Z]{26}\n$").unwrap());

    ctx.new_cmd()
        .arg("create")
        .arg("--name")
        .arg(name)
        .arg("alpine:latest")
        .assert()
        .failure()
        .stderr(predicate::str::contains("already exists"));

    ctx.cleanup_box(name);
}

#[test]
fn test_create_resources() {
    let mut ctx = common::boxlite();
    let name = "create-resources";

    ctx.cmd
        .arg("create")
        .arg("--name")
        .arg(name)
        .arg("--cpus")
        .arg("1")
        .arg("--memory")
        .arg("128")
        .arg("--env")
        .arg("TEST_VAR=1")
        .arg("--workdir")
        .arg("/tmp")
        .arg("alpine:latest")
        .assert()
        .success();

    ctx.cleanup_box(name);
}

// ============================================================================
// Publish (-p / --publish) Tests
// ============================================================================

#[test]
fn test_create_with_publish_success() {
    let mut ctx = common::boxlite();
    let name = "create-publish";

    ctx.cmd
        .args([
            "create",
            "--name",
            name,
            "-p",
            "19000:9000",
            "alpine:latest",
        ])
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^[0-9A-HJ-NP-Z]{26}\n$").unwrap());

    ctx.cleanup_box(name);
}

#[test]
fn test_create_with_publish_invalid_format() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["create", "-p", "not-a-port", "alpine:latest"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("invalid"));
}

// ============================================================================
// Volume (-v / --volume) Tests
// ============================================================================

#[test]
fn test_create_with_volume_success() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();

    let mut ctx = common::boxlite();
    let name = "create-volume";
    ctx.cmd
        .args([
            "create",
            "--name",
            name,
            "-v",
            &format!("{}:/data", path.to_str().unwrap()),
            "alpine:latest",
        ])
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^[0-9A-HJ-NP-Z]{26}\n$").unwrap());

    ctx.cleanup_box(name);
}

#[test]
fn test_create_with_volume_invalid_format() {
    // Relative box path is invalid for anonymous volume
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["create", "-v", "data", "alpine:latest"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("absolute"));
}
