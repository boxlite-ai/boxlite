use predicates::prelude::*;

mod common;

fn create_volume(ctx: &common::TestContext, name: &str) -> String {
    let output = ctx
        .new_cmd()
        .args(["volume", "create", "--name", name])
        .output()
        .expect("run volume create");
    assert!(output.status.success(), "volume create failed: {output:?}");
    String::from_utf8(output.stdout)
        .expect("volume id is UTF-8")
        .trim()
        .to_owned()
}

#[test]
fn local_volume_complete_lifecycle() {
    let ctx = common::boxlite_bare();
    let id = create_volume(&ctx, "workspace");

    ctx.new_cmd()
        .args([
            "run",
            "--rm",
            "-v",
            "workspace:/workspace",
            "alpine:latest",
            "sh",
            "-c",
            "mkdir -p /workspace/team/backend /workspace/sibling; echo subdata > /workspace/team/backend/result.txt; echo secret > /workspace/sibling/secret.txt",
        ])
        .assert()
        .success();

    ctx.new_cmd()
        .args([
            "run",
            "--rm",
            "--mount",
            "type=volume,source=workspace,target=/workspace,readonly,sub_path=team/backend",
            "alpine:latest",
            "sh",
            "-c",
            "cat /workspace/result.txt; test ! -e /workspace/sibling; test ! -e /workspace/team; ! echo change > /workspace/result.txt",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("subdata"));

    ctx.new_cmd()
        .args(["list", "--quiet"])
        .assert()
        .success()
        .stdout(predicate::str::is_empty());
    ctx.new_cmd().args(["volume", "rm", &id]).assert().success();
    ctx.new_cmd()
        .args(["volume", "get", &id])
        .assert()
        .failure();
}

#[test]
fn local_volume_rejects_duplicate_mounts() {
    let ctx = common::boxlite_bare();
    create_volume(&ctx, "workspace");

    ctx.new_cmd()
        .args([
            "run",
            "--rm",
            "-v",
            "workspace:/one",
            "-v",
            "workspace:/two",
            "alpine:latest",
            "true",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("mounted more than once"));
}

#[test]
fn local_volume_remove_waits_for_last_holder() {
    let ctx = common::boxlite_bare();
    let id = create_volume(&ctx, "workspace");
    ctx.new_cmd()
        .args([
            "create",
            "--name",
            "volume-holder",
            "-v",
            "workspace:/workspace",
            "alpine:latest",
        ])
        .assert()
        .success();

    ctx.new_cmd()
        .args(["volume", "rm", &id])
        .assert()
        .failure()
        .stderr(predicate::str::contains("still referenced"));

    ctx.cleanup_box("volume-holder");
    ctx.new_cmd().args(["volume", "rm", &id]).assert().success();
}
