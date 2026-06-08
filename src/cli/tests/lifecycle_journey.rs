//! End-to-end "user journey" suite for the box lifecycle.
//!
//! These tests exercise the verbs a user actually types — `pull`, `run`,
//! `exec`, `cp`, `inspect`, `ps`, `logs`, `stats`, `stop`, `start`, `restart`,
//! `rm` — *stringing them together* rather than testing each in isolation.
//! The centerpiece (`box_full_user_journey_birth_to_death`) walks one named
//! box through birth → work → revival → death and asserts that observable
//! state survives each transition. The rest are focused gap-fills: `cp`,
//! `logs`, `stats`, and a small set of negative-path checks have no
//! `src/cli/tests/` coverage on `main` today.

use predicates::prelude::*;
use std::io::Write;
use tempfile::NamedTempFile;

mod common;

/// One named box, walked through every state transition a user touches, with
/// observable state asserted via the next verb the user would type
/// (`inspect`, `ps`, `exec cat`). A failed composition between two verbs
/// surfaces here — single-verb tests can't catch that.
#[test]
fn box_full_user_journey_birth_to_death() {
    let mut ctx = common::boxlite();
    let name = "journey";

    // ── BIRTH ───────────────────────────────────────────────────────────
    // Explicit pull first: even when cached, the pull path itself is part
    // of a fresh user's first session and must be idempotent.
    ctx.cmd.args(["pull", "alpine:latest"]);
    ctx.cmd.assert().success();

    ctx.new_cmd()
        .args([
            "run",
            "-d",
            "--name",
            name,
            "alpine:latest",
            "sleep",
            "3600",
        ])
        .assert()
        .success();

    // Observable post-birth: appears in `ps` and is Running.
    ctx.new_cmd()
        .arg("ps")
        .assert()
        .success()
        .stdout(predicate::str::contains(name))
        .stdout(predicate::str::contains("Running"));

    // ── WORK ────────────────────────────────────────────────────────────
    ctx.new_cmd()
        .args(["exec", name, "--", "echo", "alive"])
        .assert()
        .success()
        .stdout("alive\n");

    // cp host → box, into a persistent rootfs path. /tmp would land in the
    // tmpfs hidden by the on-disk rootfs (the #628 fix surface) — staying
    // on /root keeps this test focused on the long-stable cp path.
    let host_payload = b"lifecycle-journey-payload\n";
    let mut tmp_in = NamedTempFile::new().expect("tempfile");
    tmp_in.write_all(host_payload).expect("write tempfile");
    let host_in = tmp_in.path().to_string_lossy().to_string();
    ctx.new_cmd()
        .args(["cp", &host_in, &format!("{name}:/root/payload.txt")])
        .assert()
        .success();

    // The next verb the user would type to verify the file landed.
    ctx.new_cmd()
        .args(["exec", name, "--", "cat", "/root/payload.txt"])
        .assert()
        .success()
        .stdout(predicate::str::contains("lifecycle-journey-payload"));

    // Mutate in-box, then cp back out and confirm bytes.
    ctx.new_cmd()
        .args([
            "exec",
            name,
            "--",
            "sh",
            "-c",
            "echo echoed-from-box > /root/echoed.txt",
        ])
        .assert()
        .success();

    let out_dir = tempfile::tempdir().expect("tempdir");
    let host_out = out_dir.path().join("echoed.txt");
    ctx.new_cmd()
        .args([
            "cp",
            &format!("{name}:/root/echoed.txt"),
            &host_out.to_string_lossy(),
        ])
        .assert()
        .success();
    let read_back = std::fs::read_to_string(&host_out).expect("read cp-out");
    assert!(
        read_back.contains("echoed-from-box"),
        "cp from box returned wrong content: {read_back:?}"
    );

    // stats single snapshot (no --stream).
    ctx.new_cmd().args(["stats", name]).assert().success();

    // ── REVIVAL (stop → start → restart) ────────────────────────────────
    ctx.new_cmd().args(["stop", name]).assert().success();

    // After stop, inspect's JSON must report `"Running": false` (the value,
    // not the field name — the field is always present).
    ctx.new_cmd()
        .args(["inspect", name])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"Running\": false"));

    // Start again — the file we cp'd in BEFORE the stop must persist. This
    // is the rootfs-survives-stop/start invariant the user actually depends on.
    ctx.new_cmd().args(["start", name]).assert().success();
    ctx.new_cmd()
        .args(["exec", name, "--", "cat", "/root/payload.txt"])
        .assert()
        .success()
        .stdout(predicate::str::contains("lifecycle-journey-payload"));

    // restart (single round-trip; transitions handled internally).
    ctx.new_cmd().args(["restart", name]).assert().success();

    // ── DEATH ───────────────────────────────────────────────────────────
    // Force-rm a running box (skips the explicit stop a user might forget).
    ctx.new_cmd()
        .args(["rm", "--force", name])
        .assert()
        .success();

    // The box is gone — inspect must fail.
    ctx.new_cmd().args(["inspect", name]).assert().failure();
}

/// cp host→box→host round-trip with a binary payload (all 256 byte values).
/// `main` has no `cp` test today (cp.rs / cp_runtime_mount.rs live only on
/// the #628 branch). Stays on /root to keep this orthogonal to #628.
#[test]
fn cp_roundtrip_persistent_path_binary_fidelity() {
    let mut ctx = common::boxlite();
    let name = "cp-rt";
    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "120"])
        .assert()
        .success();

    let mut payload: Vec<u8> = (0u8..=255).collect();
    payload.extend_from_slice(b"\n");
    let mut tmp_in = NamedTempFile::new().unwrap();
    tmp_in.write_all(&payload).unwrap();

    ctx.new_cmd()
        .args([
            "cp",
            &tmp_in.path().to_string_lossy(),
            &format!("{name}:/root/blob"),
        ])
        .assert()
        .success();

    let out_dir = tempfile::tempdir().unwrap();
    let host_out = out_dir.path().join("blob");
    ctx.new_cmd()
        .args([
            "cp",
            &format!("{name}:/root/blob"),
            &host_out.to_string_lossy(),
        ])
        .assert()
        .success();
    let read_back = std::fs::read(&host_out).expect("read cp-out");
    assert_eq!(
        read_back, payload,
        "binary cp round-trip mangled or truncated bytes"
    );
    ctx.cleanup_box(name);
}

/// **SURFACED GAP** — `boxlite logs` currently returns the **VM/guest agent
/// console** (kernel + guest agent tracing: zygote spawn, tmpfs mounts,
/// network configuration), NOT the container's stdout/stderr. So a box
/// that runs `echo MARK_LOGS_42; sleep 60` never shows the marker through
/// `logs`, even though every Docker user would expect it.
///
/// Source: `src/cli/src/commands/logs.rs` reads `box_layout.console_output_path()`
/// — the VM console.log file — directly. There is no separate capture of
/// the container PID-1 stdout.
///
/// Ignored so this PR doesn't break CI; the assertion below is what `logs`
/// **should** do. When the gap is fixed (route container stdout into the
/// log file, or surface it via a separate flag), remove `#[ignore]`.
#[test]
#[ignore = "boxlite logs surfaces guest console, not container stdout — see doc"]
fn logs_captures_box_stdout() {
    let mut ctx = common::boxlite();
    let name = "logs-cap";
    ctx.cmd
        .args([
            "run",
            "-d",
            "--name",
            name,
            "alpine:latest",
            "sh",
            "-c",
            "echo MARK_LOGS_42; sleep 60",
        ])
        .assert()
        .success();
    // Give the box a beat to actually print.
    std::thread::sleep(std::time::Duration::from_secs(2));
    ctx.new_cmd()
        .args(["logs", name])
        .assert()
        .success()
        .stdout(predicate::str::contains("MARK_LOGS_42"));
    ctx.cleanup_box(name);
}

/// `stats` (single snapshot, --format json) for a Running box must return a
/// parseable JSON object.
#[test]
fn stats_json_snapshot_for_running_box() {
    let mut ctx = common::boxlite();
    let name = "stats-cap";
    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "60"])
        .assert()
        .success();
    let out = ctx
        .new_cmd()
        .args(["stats", "--format", "json", name])
        .assert()
        .success()
        .get_output()
        .clone();
    let body = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        body.trim_start().starts_with('{') || body.trim_start().starts_with('['),
        "stats --format json did not produce JSON: {body:?}"
    );
    ctx.cleanup_box(name);
}

/// Negative-path checks along the user journey that aren't asserted as a
/// composed flow elsewhere on `main`.
#[test]
fn error_paths_along_the_journey() {
    let mut ctx = common::boxlite();
    let name = "err-journey";
    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "60"])
        .assert()
        .success();

    // rm without --force on a running box must fail (safety guarantee).
    ctx.new_cmd().args(["rm", name]).assert().failure();

    // operations on a non-existent box must fail cleanly (not panic).
    ctx.new_cmd()
        .args(["start", "nonexistent-box-xyz"])
        .assert()
        .failure();
    ctx.new_cmd()
        .args(["stop", "nonexistent-box-xyz"])
        .assert()
        .failure();
    ctx.new_cmd()
        .args(["inspect", "nonexistent-box-xyz"])
        .assert()
        .failure();
    ctx.new_cmd()
        .args(["logs", "nonexistent-box-xyz"])
        .assert()
        .failure();

    // Cleanup with --force (still running).
    ctx.new_cmd()
        .args(["rm", "--force", name])
        .assert()
        .success();
}
