use predicates::prelude::*;

mod common;

#[test]
fn test_restart_running() {
    let mut ctx = common::boxlite();
    let name = "restart-running";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd()
        .args(["restart", name])
        .assert()
        .success()
        .stdout(predicate::str::contains(name));

    ctx.cleanup_box(name);
}

#[test]
fn test_restart_stopped() {
    let mut ctx = common::boxlite();
    let name = "restart-stopped";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd().args(["stop", name]).assert().success();

    // Stopped -> Running
    ctx.new_cmd()
        .args(["restart", name])
        .assert()
        .success()
        .stdout(predicate::str::contains(name));

    ctx.cleanup_box(name);
}

#[test]
fn test_restart_unknown() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["restart", "non-existent-boxlite-id"]);
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}
