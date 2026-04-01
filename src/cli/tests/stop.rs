use predicates::prelude::*;

mod common;

#[test]
fn test_stop_running() {
    let mut ctx = common::boxlite();
    let name = "stop-running";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd()
        .args(["stop", name])
        .assert()
        .success()
        .stdout(predicate::str::contains(name));

    ctx.cleanup_box(name);
}

#[test]
fn test_stop_stopped_idempotency() {
    let mut ctx = common::boxlite();
    let name = "stop-idempotent";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd().args(["stop", name]).assert().success();

    ctx.new_cmd().args(["stop", name]).assert().success();

    ctx.cleanup_box(name);
}

#[test]
fn test_stop_multiple() {
    let mut ctx = common::boxlite();
    let box1 = "stop-multi-1";
    let box2 = "stop-multi-2";

    ctx.cmd
        .args(["run", "-d", "--name", box1, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd()
        .args(["run", "-d", "--name", box2, "alpine:latest", "sleep", "300"])
        .assert()
        .success();

    // Stop both at once
    ctx.new_cmd()
        .args(["stop", box1, box2])
        .assert()
        .success()
        .stdout(predicate::str::contains(box1))
        .stdout(predicate::str::contains(box2));

    ctx.cleanup_boxes(&[box1, box2]);
}

#[test]
fn test_stop_unknown() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["stop", "non-existent-box-id"]);
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}
