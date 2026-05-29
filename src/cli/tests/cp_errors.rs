//! `boxlite cp` rejection paths: the guest must refuse an unsafe or impossible
//! copy instead of silently mis-resolving it.
//!
//! Each test runs against an otherwise-valid running box and a valid host file,
//! so the *only* fault is the path under test — a copy that still fails (with
//! the guard's own message) therefore exercises that specific guard, not some
//! unrelated setup error. The happy paths live in `cp.rs` / `cp_runtime_mount.rs`.

mod common;

use predicates::prelude::*;
use std::fs;
use tempfile::TempDir;

fn cleanup(ctx: &common::TestContext, box_id: &str) {
    ctx.new_cmd()
        .args(["rm", "--force", box_id])
        .assert()
        .success();
}

fn start_box(ctx: &mut common::TestContext) -> String {
    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A destination path containing `..` must be rejected — copying must not be
/// able to escape the container rootfs / live mount namespace.
#[test]
fn cp_into_rejects_parent_dir_traversal() {
    let mut ctx = common::boxlite();
    let host = TempDir::new().expect("host temp dir");
    let box_id = start_box(&mut ctx);

    let src = host.path().join("payload.txt");
    fs::write(&src, "payload\n").unwrap();

    // Valid box, valid host file — the only fault is the `..` in the dest.
    ctx.new_cmd()
        .args([
            "cp",
            src.to_str().unwrap(),
            &format!("{box_id}:/root/../escape.txt"),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("must not contain"));

    cleanup(&ctx, &box_id);
}

/// Copying *out* a path that does not exist inside the box must fail loudly
/// (a not-found error), not produce an empty or partial host file.
#[test]
fn cp_out_of_missing_source_fails() {
    let mut ctx = common::boxlite();
    let host = TempDir::new().expect("host temp dir");
    let box_id = start_box(&mut ctx);

    let dst = host.path().join("out.txt");
    ctx.new_cmd()
        .args([
            "cp",
            &format!("{box_id}:/root/does-not-exist.txt"),
            dst.to_str().unwrap(),
        ])
        .assert()
        .failure()
        .stderr(
            predicate::str::contains("does not exist").or(predicate::str::contains("not found")),
        );

    assert!(
        !dst.exists(),
        "no host file should be created when the box source is missing"
    );

    cleanup(&ctx, &box_id);
}
