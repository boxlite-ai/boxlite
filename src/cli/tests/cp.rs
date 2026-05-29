//! Integration tests for the `boxlite cp` CLI command (host ↔ box file copy).
//!
//! Exercises the binary end-to-end: `cp` into a running box, confirm the file
//! actually landed at the target path with the right content (by `exec cat`
//! inside the box), then `cp` it back out and compare byte-for-byte. The lib
//! API (`LiteBox::copy_into/out`) has its own coverage in `tests/copy.rs`; this
//! guards the CLI argument parsing + `BOX:PATH` plumbing on top of it.

mod common;

use std::fs;
use tempfile::TempDir;

fn cleanup(ctx: &common::TestContext, box_id: &str) {
    ctx.new_cmd()
        .args(["rm", "--force", box_id])
        .assert()
        .success();
}

/// One box, two round-trips (text + binary). Each: `cp` in → `exec cat`/compare
/// inside the box (proves the file reached the target path with intact content)
/// → `cp` out → compare the host copy against the original.
#[test]
fn test_cp_roundtrip_lands_file_and_preserves_content() {
    let mut ctx = common::boxlite();
    let host = TempDir::new().expect("host temp dir");

    // Start a long-lived box to copy in/out of.
    ctx.cmd.args(["run", "-d", "alpine:latest", "sleep", "300"]);
    let output = ctx.cmd.assert().success().get_output().clone();
    let box_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // ── Text file ────────────────────────────────────────────────────────
    let content = "hello from boxlite cp\nsecond line\n";
    let src = host.path().join("input.txt");
    fs::write(&src, content).unwrap();

    // copy in: host → box
    ctx.new_cmd()
        .args([
            "cp",
            src.to_str().unwrap(),
            &format!("{box_id}:/root/input.txt"),
        ])
        .assert()
        .success();

    // The file must exist at the target path inside the box with exact content
    // — read it back via the box's own filesystem, not the host's.
    ctx.new_cmd()
        .args(["exec", &box_id, "--", "cat", "/root/input.txt"])
        .assert()
        .success()
        .stdout(content);

    // copy out: box → host, then compare to the original bytes.
    let text_out = host.path().join("output.txt");
    ctx.new_cmd()
        .args([
            "cp",
            &format!("{box_id}:/root/input.txt"),
            text_out.to_str().unwrap(),
        ])
        .assert()
        .success();
    assert_eq!(
        fs::read_to_string(&text_out).unwrap(),
        content,
        "round-tripped text file must match the original"
    );

    // ── Binary fidelity (all 256 byte values) ────────────────────────────
    let data: Vec<u8> = (0..=255).collect();
    let bin_src = host.path().join("blob.bin");
    fs::write(&bin_src, &data).unwrap();

    ctx.new_cmd()
        .args([
            "cp",
            bin_src.to_str().unwrap(),
            &format!("{box_id}:/root/blob.bin"),
        ])
        .assert()
        .success();

    let bin_out = host.path().join("blob-out.bin");
    ctx.new_cmd()
        .args([
            "cp",
            &format!("{box_id}:/root/blob.bin"),
            bin_out.to_str().unwrap(),
        ])
        .assert()
        .success();
    assert_eq!(
        fs::read(&bin_out).unwrap(),
        data,
        "round-tripped binary must be byte-identical"
    );

    cleanup(&ctx, &box_id);
}
