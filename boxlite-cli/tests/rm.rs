use predicates::prelude::*;

mod common;

#[test]
fn test_rm_non_existent() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["rm", "non-existent-box-id"]);
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}

#[test]
fn test_rm_stopped_box() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "-d", "alpine:latest", "true"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    assert!(!id.is_empty(), "Failed to get box ID");

    let mut rm_cmd = ctx.new_cmd();
    rm_cmd.args(["rm", &id]);
    rm_cmd
        .assert()
        .success()
        .stdout(predicate::str::contains(&id));

    let mut check_cmd = ctx.new_cmd();
    check_cmd.args(["rm", &id]);
    check_cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}

#[test]
#[ignore = "Relies on cross-process running state that is not reliably persisted yet"]
fn test_rm_running_box_needs_force() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "100"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let mut rm_cmd = ctx.new_cmd();
    rm_cmd.args(["rm", &id]);
    rm_cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("running"));

    let mut force_rm = ctx.new_cmd();
    force_rm.args(["rm", "-f", &id]);
    force_rm
        .assert()
        .success()
        .stdout(predicate::str::contains(&id));
}

#[test]
fn test_rm_multiple_boxes() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "-d", "alpine:latest", "true"]);
    let out1 = ctx.cmd.assert().success().get_output().clone();
    let id1 = String::from_utf8_lossy(&out1.stdout).trim().to_string();

    let mut cmd2 = ctx.new_cmd();
    cmd2.args(["run", "-d", "alpine:latest", "true"]);
    let out2 = cmd2.assert().success().get_output().clone();
    let id2 = String::from_utf8_lossy(&out2.stdout).trim().to_string();

    let mut rm_cmd = ctx.new_cmd();
    rm_cmd.args(["rm", &id1, &id2]);
    rm_cmd
        .assert()
        .success()
        .stdout(predicate::str::contains(&id1))
        .stdout(predicate::str::contains(&id2));
}

#[test]
fn test_rm_partial_failure() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["run", "-d", "alpine:latest", "true"]);
    let out = ctx.cmd.assert().success().get_output().clone();
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();

    let mut rm_cmd = ctx.new_cmd();
    rm_cmd.args(["rm", &id, "non-existent-one"]);

    rm_cmd
        .assert()
        .failure()
        .stdout(predicate::str::contains(&id))
        .stderr(predicate::str::contains("not found"));
}
