//! `boxlite logs` returns the container's exec stdout (not the VM/agent
//! console). Pins the user-visible contract introduced by the per-box
//! `container.log` tee in `service::exec::tee`.

use predicates::prelude::*;

mod common;

/// Default: `boxlite logs <box>` shows what the box's command printed.
/// On `main` (no tee) this asserts on `console.log` instead and the
/// marker is absent — the file is a VM/agent trace dump. With the tee
/// in place the marker appears.
#[test]
fn boxlite_logs_shows_container_stdout() {
    let mut ctx = common::boxlite();
    let name = "logs-tee";
    ctx.cmd
        .args([
            "run",
            "-d",
            "--name",
            name,
            "alpine:latest",
            "sh",
            "-c",
            "echo MARK_LOGS_TEE_OK; sleep 60",
        ])
        .assert()
        .success();

    // Give the box a beat to actually print + tee to fsync.
    std::thread::sleep(std::time::Duration::from_secs(2));

    ctx.new_cmd()
        .args(["logs", name])
        .assert()
        .success()
        .stdout(predicate::str::contains("MARK_LOGS_TEE_OK"));

    ctx.cleanup_box(name);
}

/// `--vm` still returns the VM/agent console (the pre-tee behavior is
/// not lost — operators who need to see kernel boot / guest agent
/// tracing can still get it). The marker we wrote via the container
/// would NOT appear here, but the guest agent's tracing lines do.
#[test]
fn boxlite_logs_vm_flag_shows_guest_agent_console() {
    let mut ctx = common::boxlite();
    let name = "logs-vm";
    ctx.cmd
        .args([
            "run",
            "-d",
            "--name",
            name,
            "alpine:latest",
            "sh",
            "-c",
            "echo MARK_LOGS_VM_OK; sleep 60",
        ])
        .assert()
        .success();
    std::thread::sleep(std::time::Duration::from_secs(2));

    // `--vm` reads the VM/agent console. The guest agent always logs
    // its startup banner — a stable substring to assert on without
    // coupling to whatever the user's command printed.
    ctx.new_cmd()
        .args(["logs", "--vm", name])
        .assert()
        .success()
        .stdout(predicate::str::contains("BoxLite Guest Agent"));

    ctx.cleanup_box(name);
}
