use predicates::prelude::*;
use std::net::TcpListener;

mod common;

fn reserve_host_port() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral host port");
    let port = listener
        .local_addr()
        .expect("read ephemeral host port")
        .port();
    (listener, port)
}

#[test]
fn test_create_basic() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .arg("create")
        .arg("alpine:latest")
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^[0-9A-Za-z]{12}\n$").unwrap());
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
        .stdout(predicate::str::is_match(r"^[0-9A-Za-z]{12}\n$").unwrap());

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
    let (port_guard, host_port) = reserve_host_port();
    let publish = format!("{host_port}:9000");

    ctx.cmd.args([
        "create",
        "--name",
        name,
        "-p",
        publish.as_str(),
        "alpine:latest",
    ]);
    drop(port_guard);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^[0-9A-Za-z]{12}\n$").unwrap());

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
        .stdout(predicate::str::is_match(r"^[0-9A-Za-z]{12}\n$").unwrap());

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
