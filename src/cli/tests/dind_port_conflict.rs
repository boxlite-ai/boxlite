//! Integration test: when two boxes claim the same `-p` host port,
//! the second one must fail fast via the gvproxy `initErr` channel
//! in `src/deps/libgvproxy-sys/gvproxy-bridge/main.go`.
//!
//! Regression guard. Pre-fix, `virtualnetwork.New`'s bind error died
//! in a logrus line inside the goroutine; `gvproxy_create` returned a
//! valid id, the shim handed the socket to libkrun, the guest booted,
//! dockerd started, and the failure surfaced ~20s+ later as a guest
//! "DNS lookup … i/o timeout" — multiple layers from the root cause.
//! With `initErr`, the bind result reaches the FFI boundary and
//! `boxlite run` exits non-zero in a few seconds.
//!
//! Uses host:22375/22376 (off the EXPOSE-default 2375/2376) so this
//! test stays parallel-safe with `dind_build` (auto-publishes
//! 2375/2376) and `dind_compose_multi_service_network` (overrides
//! onto 12375/12376) under the `vm` nextest profile.

use assert_cmd::Command;
use boxlite_test_utils::home::PerTestBoxHome;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::time::{Duration, Instant};

/// RAII cleanup for the detached holder box. Drop runs on panic too,
/// so an assertion failure in the rest of the test doesn't leak a
/// libkrun VM holding 22375/22376 across runs (which would then make
/// the *next* test invocation fail box A's startup with the very
/// `gvproxy_create failed` we're trying to verify — a confusing
/// loop).
struct BoxCleanup {
    home_path: PathBuf,
    box_id: String,
}

impl Drop for BoxCleanup {
    fn drop(&mut self) {
        // boxlite removes `<home>/boxes/<box_id>/shim.pid` (and the
        // rest of the on-disk handoff state) shortly after
        // `boxlite run -d` daemonizes — the FDs migrate into the
        // libkrun VM process and the on-disk files are no longer
        // needed. At Drop time the file is gone, so we can't read
        // the pid from disk. Instead we scan `/proc/*/fd` for any
        // process still holding open files under
        // `<home>/boxes/<box_id>/...` (Linux keeps the original
        // path on `(deleted)` FDs) — that uniquely identifies the
        // live libkrun VM for this box. SIGKILL it to free the
        // host ports.
        //
        // `boxlite rm -f` is deliberately NOT used: its recovery
        // path in src/boxlite/src/runtime/rt_impl.rs mis-identifies
        // the live shim as dead and removes the pid file without
        // killing the process (see the May 2026 incident).
        let needle = format!("/boxes/{}/", self.box_id);
        let home_prefix = self.home_path.to_string_lossy().into_owned();
        let mut killed = Vec::<u32>::new();
        if let Ok(procs) = std::fs::read_dir("/proc") {
            for proc_entry in procs.flatten() {
                let Some(name) = proc_entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let Ok(pid) = name.parse::<u32>() else {
                    continue;
                };
                let fd_dir = proc_entry.path().join("fd");
                let Ok(fds) = std::fs::read_dir(&fd_dir) else {
                    continue;
                };
                let matched = fds.flatten().any(|fd| {
                    std::fs::read_link(fd.path())
                        .map(|tgt| {
                            let s = tgt.to_string_lossy();
                            s.starts_with(&home_prefix) && s.contains(&needle)
                        })
                        .unwrap_or(false)
                });
                if matched {
                    let _ = StdCommand::new("kill")
                        .args(["-9", &pid.to_string()])
                        .output();
                    killed.push(pid);
                }
            }
        }
        eprintln!("[cleanup] box {} SIGKILL'd pids={:?}", self.box_id, killed);
    }
}

#[test]
fn dind_port_conflict_fails_fast() {
    if std::env::var("BOXLITE_SKIP_DIND_TEST").as_deref() == Ok("1") {
        eprintln!("SKIP dind_port_conflict_fails_fast: BOXLITE_SKIP_DIND_TEST=1");
        return;
    }

    // Both boxes share one home: the image cache symlink is the
    // same in either case, but the per-home `db/boxlite.db` is what
    // tells boxlite whether `docker:dind` is already registered for
    // this home. Separate homes force box B to redo the manifest
    // fetch from Docker Hub, which intermittently hits the
    // unauthenticated pull rate limit and produces a fast non-zero
    // exit that *isn't* the gvproxy bind failure we're testing for.
    // One home → box A pulls + registers, box B reuses; only the
    // host-port collision can fail box B.
    let home = PerTestBoxHome::new();

    // Box A: detached, holds host:22375/22376. `sleep` overrides
    // dockerd-entrypoint — we only need gvproxy's netstack bind alive,
    // not a running dockerd. With the initErr fix, `boxlite run -d`
    // only returns after `gvproxy_create` has finished binding, so by
    // the time we read the box id the host ports are already held.
    // `--registry` mirror: see dind_build.rs comment. Both this box
    // and box B inherit the same mirror via shared home.
    let assert_a = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&home.path)
        .arg("--registry")
        .arg("docker.m.daocloud.io")
        .timeout(Duration::from_secs(300))
        .args([
            "run",
            "-d",
            "--rm",
            "--privileged",
            "--memory",
            "1024",
            "-p",
            "22375:2375",
            "-p",
            "22376:2376",
            "docker:dind",
            "sleep",
            "600",
        ])
        .assert()
        .success();
    let box_a_id = String::from_utf8_lossy(&assert_a.get_output().stdout)
        .trim()
        .to_string();
    eprintln!("box A id: {}", box_a_id);
    let _cleanup_a = BoxCleanup {
        home_path: home.path.clone(),
        box_id: box_a_id.clone(),
    };

    // Box B: same host ports → `virtualnetwork.New` must EADDRINUSE,
    // initErr fires, gvproxy_create returns -1, `boxlite run` exits
    // non-zero. We deliberately bypass `assert_cmd::Command` here and
    // go straight to `std::process::Command`: assert_cmd 2.x's own
    // `output()` / `ok()` / `assert()` all return / panic on non-zero
    // exit (treating it as a test failure), but our predicted path IS
    // non-zero. Plain `StdCommand::output()` returns Err only on
    // spawn failure and gives us the raw `Output` for inspection.
    let started_at = Instant::now();
    let output_b = StdCommand::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&home.path)
        .arg("--registry")
        .arg("docker.m.daocloud.io")
        .args([
            "run",
            "--rm",
            "--privileged",
            "--memory",
            "1024",
            "-p",
            "22375:2375",
            "-p",
            "22376:2376",
            "docker:dind",
            "true",
        ])
        .output()
        .expect("box B failed to spawn");
    let elapsed = started_at.elapsed();

    // Box A cleanup happens via `_cleanup_a`'s Drop above — it fires
    // even if the assertions below panic, which keeps the holder VM
    // from leaking across runs.

    let stderr_b = String::from_utf8_lossy(&output_b.stderr);
    eprintln!(
        "=== box B stderr ===\n{}\n=== end ===\nbox B elapsed: {:?}",
        stderr_b, elapsed,
    );
    // Don't drop home_a / home_b explicitly here. Rust drops locals
    // in reverse declaration order at scope end, so `_cleanup_a` runs
    // first (with home_a still alive — its temp dir + the box's
    // shim.pid are exactly what `boxlite rm -f` needs to find the
    // box) and the homes drop afterwards. Calling `drop(home_a)`
    // explicitly here would invalidate the home BEFORE `_cleanup_a`
    // gets to run, and the `rm` would silently no-op and leak the
    // detached libkrun VM holding 22375/22376.

    assert!(
        !output_b.status.success(),
        "box B should have failed (host:22375/22376 already bound by box A)",
    );

    // Strong regression marker: the error must come from the gvproxy
    // initErr channel, not some other failure mode. The shim's
    // `Network("gvproxy_create failed")` is the literal message the
    // Rust side returns when the Go bridge's gvproxy_create returns
    // -1 (see src/deps/libgvproxy-sys/src/lib.rs).
    assert!(
        stderr_b.contains("gvproxy_create failed"),
        "box B failed but stderr did not contain the expected gvproxy \
         initErr marker `gvproxy_create failed` — see stderr above",
    );

    // The regression line: gvproxy bind failure must surface before
    // libkrun boots the guest (a few seconds). Pre-fix the failure
    // took 25+s because the goroutine swallowed the bind error,
    // `gvproxy_create` returned a valid id, libkrun booted, dockerd
    // started, and the failure surfaced as a misleading guest DNS
    // timeout.
    assert!(
        elapsed < Duration::from_secs(15),
        "box B took {:?} to fail; gvproxy bind error must surface fast (< 15s)",
        elapsed,
    );
}
