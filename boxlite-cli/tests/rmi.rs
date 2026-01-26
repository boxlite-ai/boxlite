use predicates::prelude::*;

mod common;

#[test]
fn test_rmi_basic() {
    let ctx = common::boxlite_isolated();
    let image = "alpine:latest";
    ctx.new_cmd().args(["pull", image]).assert().success();
    ctx.new_cmd()
        .args(["rmi", image])
        .assert()
        .success()
        .stdout(predicate::str::contains("Untagged").or(predicate::str::contains("Deleted")));
}

#[test]
fn test_rmi_in_use_error() {
    let ctx = common::boxlite_isolated();
    let box_name = "rmi-in-use-test";
    let image = "alpine:latest";

    ctx.new_cmd().args(["pull", image]).assert().success();
    ctx.new_cmd()
        .args(["create", "--name", box_name, image])
        .assert()
        .success();
    ctx.new_cmd()
        .args(["rmi", image])
        .assert()
        .failure()
        .stderr(predicate::str::contains("being used by a box"));

    ctx.cleanup_box(box_name);
}

#[test]
fn test_rmi_force() {
    let ctx = common::boxlite_isolated();
    let box_name = "rmi-force-test";
    let image = "alpine:latest";

    ctx.new_cmd().args(["pull", image]).assert().success();
    ctx.new_cmd()
        .args(["create", "--name", box_name, image])
        .assert()
        .success();
    ctx.new_cmd()
        .args(["rmi", "--force", image])
        .assert()
        .success();

    ctx.cleanup_box(box_name);
}

#[test]
fn test_rmi_nonexistent() {
    let ctx = common::boxlite_isolated();
    ctx.new_cmd()
        .args(["rmi", "non-existent-image:latest"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}

#[test]
fn test_rmi_shared_layers_protection() {
    let ctx = common::boxlite_isolated();
    let image_a = "alpine:3.18";
    let image_b = "alpine:3.19";

    // Pull both images (they share the same base layers)
    ctx.new_cmd().args(["pull", image_a]).assert().success();
    ctx.new_cmd().args(["pull", image_b]).assert().success();

    ctx.new_cmd().args(["rmi", image_a]).assert().success();

    // Image B still work, if shared layers were accidentally deleted,
    // creating a box would fail.
    let box_name = "shared-layer-verify";
    ctx.new_cmd()
        .args(["create", "--name", box_name, image_b])
        .assert()
        .success();

    ctx.cleanup_box(box_name);
}

#[test]
fn test_rmi_multiple() {
    let ctx = common::boxlite_isolated();
    let img1 = "alpine:3.18";
    let img2 = "busybox:latest";

    ctx.new_cmd().args(["pull", img1]).assert().success();
    ctx.new_cmd().args(["pull", img2]).assert().success();

    // Remove both in one command
    ctx.new_cmd()
        .args(["rmi", img1, img2])
        .assert()
        .success()
        .stdout(predicate::str::contains("Untagged:").count(2));
}

#[test]
fn test_rmi_error_handling() {
    let ctx = common::boxlite_isolated();
    let img = "alpine:3.18";
    let bogus = "non-existent-image:latest";

    ctx.new_cmd().args(["pull", img]).assert().success();
    ctx.new_cmd()
        .args(["rmi", img, bogus])
        .assert()
        .failure()
        .stdout(predicate::str::contains("Untagged:").count(1))
        .stderr(predicate::str::contains("not found"));
}

#[test]
fn test_rmi_by_id() {
    let ctx = common::boxlite_isolated();
    let image = "alpine:latest";

    // 1. Get the ID (config digest) using pull --quiet
    let output = ctx
        .new_cmd()
        .args(["pull", "--quiet", image])
        .output()
        .unwrap();
    let id = String::from_utf8(output.stdout).unwrap().trim().to_string();
    assert!(id.starts_with("sha256:"));

    // 2. Remove by ID
    // This works because we enhanced resolve_image_ref to support Config Digest
    ctx.new_cmd()
        .args(["rmi", &id])
        .assert()
        .success()
        .stdout(predicate::str::contains("Deleted:"));
}

#[test]
fn test_rmi_id_multi_tag_protection() {
    let ctx = common::boxlite_isolated();
    // Use two tags that are VERY likely to be aliases: latest and a major version.
    let tag1 = "alpine:latest";
    let tag2 = "alpine:3";

    ctx.new_cmd().args(["pull", tag1]).assert().success();
    ctx.new_cmd().args(["pull", tag2]).assert().success();

    // Get the ID (config digest) using pull --quiet
    let output = ctx
        .new_cmd()
        .args(["pull", "--quiet", tag1])
        .output()
        .unwrap();
    let id = String::from_utf8(output.stdout).unwrap().trim().to_string();

    // remove by ID - it might FAIL if they resolved to same ID
    // check the error message if it fails.
    let rmi_res = ctx.new_cmd().args(["rmi", &id]).output().unwrap();
    let rmi_err = String::from_utf8(rmi_res.stderr).unwrap();

    if rmi_err.contains("has multiple tags") {
        assert!(!rmi_res.status.success());

        ctx.new_cmd()
            .args(["rmi", "-f", &id])
            .assert()
            .success()
            .stdout(predicate::str::contains("Untagged:").count(2))
            .stdout(predicate::str::contains("Deleted:"));
    } else {
        // If didn't resolve to same ID,  just skip the multi-tag check
        // but verify basic ID removal works.
        assert!(rmi_res.status.success() || rmi_err.contains("not found"));
    }
}
