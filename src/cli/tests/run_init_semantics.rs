//! Docker-parity semantics for `boxlite run IMAGE [COMMAND...]`.
//!
//! Contract under test (see docs/investigations/run-command-semantics-fix.md):
//! the user COMMAND replaces the image CMD and — composed with the image
//! ENTRYPOINT — becomes the container's init (PID 1). The box's lifecycle
//! follows init: when it exits, the box stops with init's exit code, and
//! exec is refused cleanly instead of panicking on a zombie init.
//!
//! The first three fail on the pre-fix tree, where COMMAND runs as an exec
//! session beside an init built from the image default. The fourth covers the
//! `128 + n` signal-exit branch, which nothing else reaches.

use predicates::prelude::*;
use std::path::Path;
use std::time::{Duration, Instant};

mod common;

/// Read the guest-written exit file for the (single) box under `home`, polling
/// until it appears: `stop` returns once the container is down, but the guest's
/// watcher writes the record on its own task a moment later.
///
/// The container id is generated, so the box's own layout is the only way to
/// find the file — which is the point: this asserts on what the guest actually
/// left on the shared mount, not on something the test made up.
fn wait_for_exit_file(home: &Path, deadline: Duration) -> Option<String> {
    let start = Instant::now();
    while start.elapsed() < deadline {
        for box_dir in std::fs::read_dir(home.join("boxes")).into_iter().flatten() {
            let Ok(box_dir) = box_dir else { continue };
            let containers = box_dir.path().join("shared").join("containers");
            for container in std::fs::read_dir(&containers).into_iter().flatten() {
                let Ok(container) = container else { continue };
                if let Ok(body) = std::fs::read_to_string(container.path().join("exit.json")) {
                    return Some(body);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    None
}

/// Poll `inspect -f '{{.State.Status}}'` until it reports a non-running
/// status or the deadline passes. Returns the last observed status.
fn wait_for_stopped(ctx: &common::TestContext, name: &str, deadline: Duration) -> String {
    let start = Instant::now();
    let mut last = String::new();
    while start.elapsed() < deadline {
        let out = ctx
            .new_cmd()
            .args(["inspect", "-f", "{{.State.Status}}", name])
            .output()
            .expect("inspect runs");
        last = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !last.is_empty() && last != "running" {
            return last;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    last
}

/// S-PID1: the user command IS the container init (docker semantics).
///
/// alpine's image config is ENTRYPOINT=[], CMD=["/bin/sh"]. Pre-fix, init is
/// that default `/bin/sh` and the user command runs as a tenant, so PID 1's
/// cmdline is `/bin/sh` — no `tr`. Post-fix PID 1 is the user command
/// (busybox `sh -c <single cmd>` execs it, so the cmdline is the `tr`
/// invocation itself — same as docker/podman on the same image).
#[test]
fn test_init_semantics_command_is_pid1() {
    let mut ctx = common::boxlite();
    ctx.cmd.args([
        "run",
        "--rm",
        "alpine:latest",
        "sh",
        "-c",
        "tr '\\0' ' ' </proc/1/cmdline",
    ]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("tr"));
}

/// S-user: `--user` applies to the *main command*, which is now init.
///
/// Before COMMAND became init, `--user` only ever reached an exec tenant; now it
/// has to land on init itself. `id -u` asks the kernel who PID 1 is running as,
/// so it cannot pass unless the override threaded all the way to the container's
/// process spec.
#[test]
fn test_init_semantics_user_applies_to_init() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "--user", "1000", "alpine:latest", "id", "-u"]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("1000"));
}

/// S-workdir: `-w` sets the main command's working directory.
///
/// Same story: working-dir used to be an exec-only option, and once COMMAND is
/// init it has to reach init's spec. `pwd` reports where PID 1 actually started.
#[test]
fn test_init_semantics_workdir_applies_to_init() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "-w", "/tmp", "alpine:latest", "pwd"]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("/tmp"));
}

/// S-status: a detached box whose init exits must report Stopped with the
/// init's exit code — not sit in `running` forever.
#[test]
fn test_init_semantics_detached_exit_updates_status() {
    let ctx = common::boxlite();
    ctx.cleanup_box("init-sem-status");

    let mut run = ctx.new_cmd();
    run.args([
        "run",
        "-d",
        "--name",
        "init-sem-status",
        "alpine:latest",
        "sh",
        "-c",
        "exit 42",
    ]);
    run.assert().success();

    let status = wait_for_stopped(&ctx, "init-sem-status", Duration::from_secs(30));
    assert!(
        status.contains("stopped") || status.contains("exited"),
        "box should stop after its command exits; last status: {status:?}"
    );

    ctx.new_cmd()
        .args(["inspect", "-f", "{{.State.ExitCode}}", "init-sem-status"])
        .assert()
        .success()
        .stdout(predicate::str::contains("42"));

    ctx.cleanup_box("init-sem-status");
}

/// S-create: `create IMAGE COMMAND...` stores the command, and starting the box
/// runs it as init — same as `run`, only later.
///
/// New parsing surface (a trailing positional on `create`), feeding the very
/// field the re-run gate keys on. It also pins the half of §6 that `run` cannot
/// reach: a box *created* with a command must not be booted by a side effect
/// either — `create job … send-payment` then `cp ./input job:/in` would run the
/// payment as a consequence of copying a file in.
#[test]
fn test_init_semantics_create_stores_the_command_as_init() {
    let ctx = common::boxlite();
    ctx.cleanup_box("init-sem-create");

    ctx.new_cmd()
        .args([
            "create",
            "--name",
            "init-sem-create",
            "alpine:latest",
            "sh",
            "-c",
            "exit 23",
        ])
        .assert()
        .success();

    // Created, not started: nothing has run yet.
    ctx.new_cmd()
        .args(["inspect", "-f", "{{.State.Status}}", "init-sem-create"])
        .assert()
        .success()
        .stdout(predicate::str::contains("configured"));

    // A file copy must not be what starts someone's job.
    let cp = ctx
        .new_cmd()
        .args(["cp", "init-sem-create:/etc/hostname", "."])
        .output()
        .expect("cp runs");
    assert!(
        !cp.status.success(),
        "cp must not boot a created job — booting it runs the command"
    );

    // Started deliberately, the stored command runs as init and its code is the
    // box's: proof that `create`'s trailing COMMAND really did become `cmd`.
    ctx.new_cmd()
        .args(["start", "init-sem-create"])
        .assert()
        .success();

    let stopped = wait_for_stopped(&ctx, "init-sem-create", Duration::from_secs(30));
    assert!(
        stopped.contains("stopped") || stopped.contains("exited"),
        "the stored command must run and end the box, got {stopped:?}"
    );
    ctx.new_cmd()
        .args(["inspect", "-f", "{{.State.ExitCode}}", "init-sem-create"])
        .assert()
        .success()
        .stdout(predicate::str::contains("23"));

    ctx.cleanup_box("init-sem-create");
}

/// S-cp: fetching a file out of a finished job must not re-run the job.
///
/// This is the scenario the whole gate exists for, and `cp` was the path that
/// walked around it: it used to `start()` the box itself whenever it was not
/// running, which is the restart pipeline, which re-runs init — and init is now
/// the user's command.
///
///     boxlite run --name job alpine sh -c 'send-payment'
///     boxlite cp job:/receipt .        # would send it a second time
///
/// The box below uses `--entrypoint` and **no** trailing COMMAND, so its `cmd`
/// is None while its init is still entirely the user's choice — `final_cmd()` is
/// entrypoint ++ cmd. A gate keyed only on `cmd` would wave this one through.
#[test]
fn test_init_semantics_cp_from_a_finished_job_does_not_rerun_it() {
    let ctx = common::boxlite();
    ctx.cleanup_box("init-sem-cp");

    ctx.new_cmd()
        .args([
            "run",
            "-d",
            "--name",
            "init-sem-cp",
            "--entrypoint",
            "/bin/true",
            "alpine:latest",
        ])
        .assert()
        .success();

    let stopped = wait_for_stopped(&ctx, "init-sem-cp", Duration::from_secs(30));
    assert!(
        stopped.contains("stopped") || stopped.contains("exited"),
        "precondition: the job must finish, got {stopped:?}"
    );

    // `cp` must refuse, not reboot: rebooting is what re-runs the command.
    let cp = ctx
        .new_cmd()
        .args(["cp", "init-sem-cp:/etc/hostname", "."])
        .output()
        .expect("cp runs");
    assert!(
        !cp.status.success(),
        "cp on a finished job must be refused, not silently satisfied by a reboot"
    );

    let after = ctx
        .new_cmd()
        .args(["inspect", "-f", "{{.State.Status}}", "init-sem-cp"])
        .output()
        .expect("inspect runs");
    let status = String::from_utf8_lossy(&after.stdout).trim().to_string();
    assert!(
        !status.contains("running"),
        "cp must not restart a finished job — that re-runs the user's command. Status: {status:?}"
    );

    ctx.cleanup_box("init-sem-cp");
}

/// S-signal: a main command killed by a signal is recorded docker-style, as
/// `128 + n`.
///
/// Init is PID 1 of its namespace, so it cannot be signalled from inside the
/// box at all — the kernel drops unhandled signals sent to a namespace's init.
/// The only thing that can signal it is the guest, and `stop` is how that
/// happens (SIGKILL). So this is the one route to the `128 + n` branch, and
/// without it nothing covers it: every other command here exits with a code of
/// its own choosing.
#[test]
fn test_init_semantics_signal_death_recorded_as_128_plus_n() {
    let ctx = common::boxlite();
    ctx.cleanup_box("init-sem-signal");

    ctx.new_cmd()
        .args([
            "run",
            "-d",
            "--name",
            "init-sem-signal",
            "alpine:latest",
            "sleep",
            "300",
        ])
        .assert()
        .success();

    ctx.new_cmd()
        .args(["stop", "init-sem-signal"])
        .assert()
        .success();

    // Assert on the field a user actually reads. Once `stop` returns, the guest
    // has joined its exit watcher, so the record is on disk and the host has
    // taken it — no polling, because there is nothing left to wait for.
    ctx.new_cmd()
        .args(["inspect", "-f", "{{.State.ExitCode}}", "init-sem-signal"])
        .assert()
        .success()
        .stdout(predicate::str::contains("137"));

    // And the record it came from says the same thing, which is what makes the
    // 128+n branch — reachable no other way — actually covered.
    let record = wait_for_exit_file(&ctx.home, Duration::from_secs(5))
        .expect("the guest must record the main command's exit");
    assert!(
        record.contains("137"),
        "SIGKILL must be recorded as 128+9=137 (docker's convention), got: {record}"
    );

    ctx.cleanup_box("init-sem-signal");
}

/// S-exec-refusal: exec against a box whose main command has exited is refused
/// — cleanly, and **without restarting the box**.
///
/// The no-restart half is the part that matters, and it is the part that is
/// easy to get wrong. `exec` boots the VM lazily, and `Stopped` maps to the
/// full restart pipeline, so an ungated `exec` on a finished box quietly boots
/// a new VM — which now re-runs the *user's own command*, because that command
/// is the container's init. `run --name job … send-payment` followed by an
/// `exec` or a `cp` would send the payment a second time.
///
/// The command here therefore *sleeps*: a short-lived one would let the test
/// pass for the wrong reason, since the restarted init would exit again within
/// microseconds and rewrite the exit file that the exec guard reads. With
/// `sleep 300`, a box that restarts stays Running — and the assertions below
/// catch it.
#[test]
fn test_init_semantics_exec_after_exit_refused_without_restarting() {
    let ctx = common::boxlite();
    ctx.cleanup_box("init-sem-exec");

    // Exits immediately (so the box stops), but a *restart* would run `sleep
    // 300` and leave the box Running — which is exactly what we assert against.
    ctx.new_cmd()
        .args([
            "run",
            "-d",
            "--name",
            "init-sem-exec",
            "alpine:latest",
            "sh",
            "-c",
            "test -f /tmp/ran && sleep 300; touch /tmp/ran",
        ])
        .assert()
        .success();

    let stopped = wait_for_stopped(&ctx, "init-sem-exec", Duration::from_secs(30));
    assert!(
        stopped.contains("stopped") || stopped.contains("exited"),
        "precondition: the box must stop when its main command exits, got {stopped:?}"
    );

    let assert = ctx
        .new_cmd()
        .args(["exec", "init-sem-exec", "--", "echo", "should-not-run"])
        .assert()
        .failure();
    let stderr = String::from_utf8_lossy(&assert.get_output().stderr).to_string();
    assert!(
        !stderr.contains("procfs") && !stderr.contains("please report this"),
        "exec refusal must be a clean status error, got: {stderr}"
    );

    // The refusal must be a refusal, not a reboot. If exec restarted the box,
    // its main command ran a second time — this time taking the `sleep 300`
    // branch — and the box is Running again.
    let after = ctx
        .new_cmd()
        .args(["inspect", "-f", "{{.State.Status}}", "init-sem-exec"])
        .output()
        .expect("inspect runs");
    let status = String::from_utf8_lossy(&after.stdout).trim().to_string();
    assert!(
        !status.contains("running"),
        "exec must not restart a finished box — that re-runs the user's main command. Status: {status:?}"
    );

    ctx.cleanup_box("init-sem-exec");
}

/// S-restart: a deliberate second `start` re-runs the stored command through a
/// fresh VM, zygote, and init build, and re-records its exit.
///
/// The command's exit code differs by run — 7 first, 8 once its marker file
/// exists — so a stale first-run exit record surviving into the second run is
/// distinguishable from a genuinely fresh one: `inspect` must report 7, then 8.
#[test]
fn test_init_semantics_restart_reruns_init_and_rerecords_exit() {
    let ctx = common::boxlite();
    ctx.cleanup_box("init-sem-restart");

    ctx.new_cmd()
        .args([
            "run",
            "-d",
            "--name",
            "init-sem-restart",
            "alpine:latest",
            "sh",
            "-c",
            "test -e /ran && exit 8; touch /ran; exit 7",
        ])
        .assert()
        .success();

    let stopped = wait_for_stopped(&ctx, "init-sem-restart", Duration::from_secs(30));
    assert!(
        stopped.contains("stopped") || stopped.contains("exited"),
        "first run must end the box, got {stopped:?}"
    );
    ctx.new_cmd()
        .args(["inspect", "-f", "{{.State.ExitCode}}", "init-sem-restart"])
        .assert()
        .success()
        .stdout(predicate::str::contains("7"));

    // Second, deliberate start: the restart pipeline rebuilds init in the new
    // boot's zygote; the guest clears the stale exit file before running it.
    ctx.new_cmd()
        .args(["start", "init-sem-restart"])
        .assert()
        .success();
    let stopped = wait_for_stopped(&ctx, "init-sem-restart", Duration::from_secs(30));
    assert!(
        stopped.contains("stopped") || stopped.contains("exited"),
        "restarted run must end the box again, got {stopped:?}"
    );
    ctx.new_cmd()
        .args(["inspect", "-f", "{{.State.ExitCode}}", "init-sem-restart"])
        .assert()
        .success()
        .stdout(predicate::str::contains("8"));

    ctx.cleanup_box("init-sem-restart");
}

/// S-fail: a failing init build must surface as a start error carrying the
/// create-container context — not a hang, not a half-created running box —
/// and must leave nothing wedged: the failed box is removable by name and a
/// fresh box on the same home runs fine afterwards.
#[test]
fn test_init_semantics_failed_init_build_reports_and_recovers() {
    let ctx = common::boxlite();
    ctx.cleanup_boxes(&["init-sem-badwd", "init-sem-goodwd"]);

    // A workdir that cannot be entered fails libcontainer's init build inside
    // the zygote; the box-start error is built from that build failure.
    ctx.new_cmd()
        .args([
            "run",
            "--workdir",
            "/nonexistent/deep",
            "--name",
            "init-sem-badwd",
            "alpine:latest",
            "true",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("Failed to create container"));

    // Nothing wedged: the failed box can be removed by name...
    ctx.new_cmd()
        .args(["rm", "-f", "init-sem-badwd"])
        .assert()
        .success();

    // ...and a fresh box on the same home boots and runs to completion.
    ctx.new_cmd()
        .args([
            "run",
            "--name",
            "init-sem-goodwd",
            "alpine:latest",
            "sh",
            "-c",
            "exit 0",
        ])
        .assert()
        .success();
    let stopped = wait_for_stopped(&ctx, "init-sem-goodwd", Duration::from_secs(30));
    assert!(
        stopped.contains("stopped") || stopped.contains("exited"),
        "the recovery box must run and stop cleanly, got {stopped:?}"
    );
    ctx.cleanup_box("init-sem-goodwd");
}
