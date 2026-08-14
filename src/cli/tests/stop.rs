use predicates::prelude::*;

mod common;

// Host-side tree reaping is a Linux mechanism — it walks the host `/proc` and
// signals a PID namespace's init — so `jailer`'s reap helpers are all
// `#[cfg(target_os = "linux")]` and no-op elsewhere. The reproducer and its
// helpers below are gated to match: on macOS they would read a host `/proc`
// that does not exist and fail for a reason unrelated to the bug. Every other
// `/proc` read in this suite goes through `exec` into the (always Linux) guest,
// which is why nothing else here needs a gate.
#[cfg(target_os = "linux")]
use nix::sys::signal::{Signal, kill};
#[cfg(target_os = "linux")]
use nix::unistd::Pid;
#[cfg(target_os = "linux")]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

/// `stop` must reap the box's WHOLE host-side process tree, not just the
/// recorded launcher pid.
///
/// A detached box's tree is `outer bwrap (launcher = shim.pid) -> inner bwrap
/// (PID-ns init) -> shim / 'libkrun VM'`. `graceful_stop` signals only the
/// launcher; the whole-tree reap relies on `cgroup.kill`, which no-ops on a
/// rootless host with no cgroup delegation (WSL2, CI, no-systemd). Without a
/// non-cgroup fallback the inner bwrap + libkrun VM survive, holding
/// `disk.qcow2` — the leak this guards against.
///
/// Note: the recorded `shim.pid` is the launcher, which `graceful_stop` DOES
/// kill, so the existing `live_shim_pids` leak-check can't see this — the test
/// captures the tree by box id instead. It reliably fails pre-fix only on hosts
/// with no cgroup delegation (where cgroup reap can't stand in); with the fix it
/// passes everywhere.
#[cfg(target_os = "linux")]
#[test]
fn stop_reaps_whole_box_tree_not_just_launcher() {
    let mut ctx = common::boxlite();
    let name = "reap-tree";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    let box_id = single_box_id(&ctx.home);
    // Snapshot the box's process tree WHILE it runs (bwrap x2 + shim/VM).
    let tree = box_processes(&box_id);
    assert!(
        tree.len() >= 2,
        "expected the box's process tree (outer+inner bwrap, shim/VM) for id {box_id}, got {tree:?}"
    );

    // Self-contained cleanup floor: on a pre-fix RED run the survivors assert
    // below panics *before* `cleanup_box`, and `TestContext::drop` then runs
    // `rm --force`, which re-enters the same non-reaping stop path under test —
    // leaking the very libkrun VM the assert just caught. This floor SIGKILLs the
    // captured tree directly (never via boxlite) so the reproducer cleans up after
    // itself. Fires only on panic: on the leak path the survivors are still alive
    // so their pids are current, avoiding any SIGKILL of a recycled pid.
    let _floor = KillFloor(tree.clone());

    // The leak is physically reproducible ONLY where `cgroup.kill` can't stand in
    // for the fallback — i.e. no cgroup delegation. On a delegated host the
    // pre-fix code already reaps the tree via the box's cgroup, so this test would
    // pass even with the fallback reverted (false confidence). Skip there rather
    // than assert for the wrong reason.
    if cgroup_reap_effective(&tree) {
        eprintln!(
            "SKIP stop_reaps_whole_box_tree_not_just_launcher: box {box_id} is in a delegated \
             boxlite cgroup, so cgroup.kill reaps the tree regardless of the no-cgroup fallback — \
             the leak is unreproducible here. Run on a host with no cgroup delegation (WSL2 \
             /init.scope, CI, no-systemd) to exercise the fallback."
        );
        ctx.cleanup_box(name);
        return;
    }

    ctx.new_cmd().args(["stop", name]).assert().success();

    // Every process in the captured tree must die. Pre-fix, the inner bwrap +
    // libkrun VM leak past `stop` on hosts without cgroup delegation.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut survivors = tree.clone();
    while Instant::now() < deadline {
        survivors.retain(|&pid| pid_alive(pid));
        if survivors.is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }

    assert!(
        survivors.is_empty(),
        "stop leaked box processes {survivors:?} for id {box_id}: the inner pid-ns \
         tree outlived the launcher because cgroup reap no-oped and nothing else \
         reaped it"
    );

    ctx.cleanup_box(name);
}

/// The single 12-char box id directory under `<home>/boxes`.
#[cfg(target_os = "linux")]
fn single_box_id(home: &Path) -> String {
    std::fs::read_dir(home.join("boxes"))
        .expect("boxes dir")
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .find(|n| n.len() == 12 && n.chars().all(|c| c.is_ascii_alphanumeric()))
        .expect("exactly one box id dir")
}

/// Pids whose `/proc/<pid>/cmdline` mentions this box id — the bwrap launcher,
/// the inner bwrap, and the shim/libkrun VM all carry it in their argv/paths.
/// Independent of the fix's own tree walk, so the assertion isn't tautological.
#[cfg(target_os = "linux")]
fn box_processes(box_id: &str) -> Vec<u32> {
    let mut pids = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return pids;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        if let Ok(cmdline) = std::fs::read(entry.path().join("cmdline"))
            && String::from_utf8_lossy(&cmdline).contains(box_id)
        {
            pids.push(pid);
        }
    }
    pids
}

/// Alive = `/proc/<pid>` exists and the process is not a zombie.
#[cfg(target_os = "linux")]
fn pid_alive(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        // state is the field right after the last ')': "pid (comm) STATE ppid ..."
        Ok(stat) => stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().next())
            .is_some_and(|state| state != "Z"),
        Err(_) => false,
    }
}

/// SIGKILLs a captured pid set on drop — but only when the test is unwinding, so
/// it runs exactly on the leak (assert-panicked) path where the box processes are
/// still alive. Independent of `boxlite stop`/`rm`, so a pre-fix red run can't
/// orphan the leaked VM through the same buggy path it's testing.
#[cfg(target_os = "linux")]
struct KillFloor(Vec<u32>);

#[cfg(target_os = "linux")]
impl Drop for KillFloor {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }
        for &pid in &self.0 {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
        }
    }
}

/// True if the box's processes sit in a boxlite cgroup subtree — meaning this
/// host has cgroup delegation, so `cgroup.kill` reaps the whole tree and the
/// no-cgroup fallback is not the mechanism under test. cgroup v2 reports the
/// process's cgroup as a single `0::/<path>` line in `/proc/<pid>/cgroup`; a box
/// that boxlite could place in its own cgroup shows a `/boxlite/` component
/// there, whereas the fallback's target hosts leave the box in the caller's
/// cgroup (e.g. `/init.scope`). Reads only, no side effects.
#[cfg(target_os = "linux")]
fn cgroup_reap_effective(pids: &[u32]) -> bool {
    pids.iter().any(|&pid| {
        std::fs::read_to_string(format!("/proc/{pid}/cgroup")).is_ok_and(|cg| {
            cg.lines().any(|line| {
                line.strip_prefix("0::")
                    .is_some_and(|path| path.contains("/boxlite/"))
            })
        })
    })
}

#[test]
fn test_stop_running() {
    let mut ctx = common::boxlite();
    let name = "stop-running";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd()
        .args(["stop", name])
        .assert()
        .success()
        .stdout(predicate::str::contains(name));

    ctx.cleanup_box(name);
}

#[test]
fn test_stop_stopped_idempotency() {
    let mut ctx = common::boxlite();
    let name = "stop-idempotent";

    ctx.cmd
        .args(["run", "-d", "--name", name, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd().args(["stop", name]).assert().success();

    ctx.new_cmd().args(["stop", name]).assert().success();

    ctx.cleanup_box(name);
}

#[test]
fn test_stop_multiple() {
    let mut ctx = common::boxlite();
    let box1 = "stop-multi-1";
    let box2 = "stop-multi-2";

    ctx.cmd
        .args(["run", "-d", "--name", box1, "alpine:latest", "sleep", "300"]);
    ctx.cmd.assert().success();

    ctx.new_cmd()
        .args(["run", "-d", "--name", box2, "alpine:latest", "sleep", "300"])
        .assert()
        .success();

    // Stop both at once
    ctx.new_cmd()
        .args(["stop", box1, box2])
        .assert()
        .success()
        .stdout(predicate::str::contains(box1))
        .stdout(predicate::str::contains(box2));

    ctx.cleanup_boxes(&[box1, box2]);
}

#[test]
fn test_stop_unknown() {
    let mut ctx = common::boxlite();
    ctx.cmd.args(["stop", "non-existent-box-id"]);
    ctx.cmd
        .assert()
        .failure()
        .stderr(predicate::str::contains("not found"));
}
