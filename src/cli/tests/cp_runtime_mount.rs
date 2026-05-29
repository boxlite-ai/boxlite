//! `boxlite cp` into a running box's runtime mount (the tmpfs at `/tmp`).
//!
//! `/tmp` is a tmpfs mounted in the container's namespace, not part of the
//! persistent rootfs disk. Resolving the copy against the on-disk rootfs lands
//! the file *beneath* that tmpfs — invisible to the container (and the copy may
//! fail outright). The fix resolves a running container's paths through its
//! live mount namespace (`/proc/<init_pid>/root`), matching `docker cp`. This
//! test copies into `/tmp` and asserts the container actually sees it; without
//! the fix the `cat` finds nothing and the test fails.

mod common;

use std::fs;
use tempfile::TempDir;

fn cleanup(ctx: &common::TestContext, box_id: &str) {
    ctx.new_cmd()
        .args(["rm", "--force", box_id])
        .assert()
        .success();
}

#[test]
fn cp_into_tmpfs_tmp_is_visible_in_container() {
    let mut ctx = common::boxlite();
    let host = TempDir::new().expect("host temp dir");

    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let content = "into-the-tmpfs\n";
    let src = host.path().join("t.txt");
    fs::write(&src, content).unwrap();

    // Copy into the tmpfs at /tmp (a runtime mount, not the persistent rootfs).
    ctx.new_cmd()
        .args(["cp", src.to_str().unwrap(), &format!("{box_id}:/tmp/t.txt")])
        .assert()
        .success();

    // The container must see it at /tmp with the exact content — i.e. the copy
    // reached the live tmpfs, not the shadowed on-disk /tmp.
    ctx.new_cmd()
        .args(["exec", &box_id, "--", "cat", "/tmp/t.txt"])
        .assert()
        .success()
        .stdout(content);

    cleanup(&ctx, &box_id);
}
