//! CLI integration coverage for the step-2 volume gate.
//!
//! Boxlite no longer accepts host bind mounts (`-v /host:/guest`).
//! Only `-v /guest_path` (anonymous, ephemeral) and
//! `-v <name>:/guest_path` (named, persistent) are allowed. Anything
//! starting with `/` and followed by another `:` segment is the
//! legacy bind-mount shape and the parser rejects it before any
//! runtime touches the volume.
//!
//! Tests below bracket the new semantics:
//!
//!   1. `host_bind_mount_rejected` — side B (parser accepts). Reverting
//!      the leading-`/` reject branch in `cli::parse_volume_spec`
//!      flips this red; the legacy form would proceed to attempt a
//!      box launch.
//!
//!   2. `anonymous_volume_accepted` — side A. `-v /data` succeeds (in
//!      the sense that the rejection message is NOT emitted; whether
//!      the VM actually boots is out of scope for a parser test).
//!
//!   3. `named_volume_accepted` — side A. `-v myvol:/data` succeeds
//!      without the rejection message.

mod common;

use predicates::prelude::*;

#[test]
fn host_bind_mount_rejected() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "-v",
        "/etc:/host_etc",
        "alpine:latest",
        "true",
    ]);

    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "host bind mounts (`-v /host:/guest`) are not supported",
        ))
        .stderr(predicate::str::contains("named volume"))
        .stderr(predicate::str::contains("anonymous"));
}

#[test]
fn anonymous_volume_accepted() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "-v", "/data", "alpine:latest", "true"]);

    // We don't assert exit code — actually booting a VM is out of
    // scope for the parser test, and on CI without KVM this would
    // fail for unrelated reasons. The contract this test pins is:
    // anon syntax must NOT surface the bind-mount rejection.
    ctx.cmd
        .assert()
        .stderr(predicate::str::contains("host bind mounts").not());
}

#[test]
fn named_volume_accepted() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "-v", "myvol:/data", "alpine:latest", "true"]);

    ctx.cmd
        .assert()
        .stderr(predicate::str::contains("host bind mounts").not())
        .stderr(predicate::str::contains("named volume").not());
}
