use predicates::prelude::*;

mod common;

#[test]
fn test_rm_single() {
    let mut ctx = common::boxlite();
    let name = "rm-boxlite";

    ctx.cmd
        .args(["create", "--name", name, "alpine:latest"])
        .assert()
        .success();

    ctx.new_cmd()
        .args(["rm", name])
        .assert()
        .success()
        .stdout(predicate::str::contains(name));
}

#[test]
fn test_rm_force_running() {
    let mut ctx = common::boxlite();
    let name = "rm-boxlite-force";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"])
        .assert()
        .success();

    ctx.new_cmd().args(["rm", name]).assert().failure();

    ctx.new_cmd()
        .args(["rm", "--force", name])
        .assert()
        .success()
        .stdout(predicate::str::contains(name));
}

#[test]
fn test_rm_all_requires_confirmation() {
    let mut ctx = common::boxlite();

    ctx.cmd
        .args([
            "create",
            "--name",
            "rm-all-boxlite-confirm-1",
            "alpine:latest",
        ])
        .assert()
        .success();

    // rm --all without -f should prompt for confirmation
    // Answering "n" should NOT remove the box
    ctx.new_cmd()
        .args(["rm", "--all"])
        .write_stdin("n\n")
        .assert()
        .success()
        .stderr(predicate::str::contains("Are you sure"));

    // Box should still exist
    ctx.new_cmd()
        .args(["list", "-a"])
        .assert()
        .success()
        .stdout(predicate::str::contains("rm-all-boxlite-confirm-1")); // box exists

    ctx.new_cmd()
        .args(["rm", "-f", "rm-all-boxlite-confirm-1"])
        .assert()
        .success();
}

#[test]
fn test_rm_all_with_confirmation() {
    let mut ctx = common::boxlite();

    ctx.cmd
        .args(["create", "--name", "rm-all-box-yes-1", "alpine:latest"])
        .assert()
        .success();

    // rm --all with "y" confirmation should remove all boxes
    ctx.new_cmd()
        .args(["rm", "--all"])
        .write_stdin("y\n")
        .assert()
        .success()
        .stderr(predicate::str::contains("Are you sure"));

    // Box should be removed
    ctx.new_cmd()
        .args(["list", "-a"])
        .assert()
        .success()
        .stdout(predicate::str::contains("rm-all-box-yes-1").not());
}

#[test]
fn test_rm_all_force_skips_confirmation() {
    let mut ctx = common::boxlite();

    ctx.cmd
        .args(["create", "--name", "rm-all-box-force-1", "alpine:latest"])
        .assert()
        .success();

    ctx.new_cmd()
        .args(["create", "--name", "rm-all-box-force-2", "alpine:latest"])
        .assert()
        .success();

    // rm -fa should skip confirmation and remove all
    ctx.new_cmd()
        .args(["rm", "-fa"])
        .assert()
        .success()
        .stderr(predicate::str::contains("Are you sure").not());

    ctx.new_cmd()
        .args(["list", "-a", "-q"])
        .assert()
        .success()
        .stdout(predicate::str::is_empty());
}

#[test]
fn test_rm_unknown() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["rm", "non-existent-box-id"]);
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}
