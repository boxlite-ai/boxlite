use predicates::prelude::*;

mod common;

#[test]
fn test_start_configured() {
    let mut ctx = common::boxlite();
    let name = "start-configured";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd().args(["stop", name]).assert().success();

    ctx.new_cmd()
        .args(["start", name])
        .assert()
        .success()
        .stdout(predicate::str::contains(name));

    ctx.cleanup_box(name);
}

#[test]
fn test_start_running_idempotency() {
    let mut ctx = common::boxlite();
    let name = "start-idempotent";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd().args(["start", name]).assert().success();

    ctx.cleanup_box(name);
}

#[test]
fn test_start_unknown() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["start", "non-existent-box-id"]);
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}
