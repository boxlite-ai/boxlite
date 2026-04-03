use predicates::prelude::*;

mod common;

#[test]
fn test_pull_basic() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["pull", "alpine:latest"]);
    ctx.cmd.assert().success();
}

#[test]
fn test_pull_without_tag() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["pull", "alpine"]);
    ctx.cmd.assert().success();
}

#[test]
fn test_pull_quiet() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["pull", "-q", "alpine:latest"]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::is_empty().not())
        .stdout(predicate::function(|s: &str| s.lines().count() <= 2));
}

#[test]
fn test_pull_nonexistent() {
    let mut ctx = common::boxlite();
    ctx.cmd.timeout(std::time::Duration::from_secs(30));
    ctx.cmd.args(["pull", "nonexistent/image:doesnotexist"]);
    ctx.cmd.assert().failure().stderr(
        predicate::str::contains("failed to pull")
            .or(predicate::str::contains("not found"))
            .or(predicate::str::contains("manifest unknown"))
            .or(predicate::str::contains("unauthorized")),
    );
}

#[test]
fn test_pull_idempotent() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["pull", "alpine:latest"]);
    ctx.cmd.assert().success();

    let mut cmd2 = ctx.new_cmd();
    cmd2.args(["pull", "alpine:latest"]);
    cmd2.assert().success();
}

#[test]
fn test_pull_progress() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["pull", "python:alpine"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        stderr.contains("Pulling")
            || stderr.contains("Downloading")
            || stderr.contains("blob")
            || stderr.contains("Using cached image")
            || stdout.contains("Pulled: python:alpine"),
        "expected progress output on stderr or a cached pull summary on stdout, got stdout={stdout:?} stderr={stderr:?}"
    );
}

#[test]
fn test_pull_with_full_registry_name() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["pull", "docker.io/library/alpine:latest"]);
    ctx.cmd.assert().success();

    let mut cmd2 = ctx.new_cmd();
    cmd2.args(["pull", "quay.io/libpod/alpine:latest"]);
    cmd2.assert().success();
}
