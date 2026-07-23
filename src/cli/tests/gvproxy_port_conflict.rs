//! Regression: when a host port is already bound by another process,
//! `boxlite run -p HOST:GUEST` must fail-fast with a Rust-layer error
//! that names gvproxy as the failure source — not silently boot a box
//! with a dead netstack whose breakage only surfaces 20s+ later as a
//! guest "DNS lookup … i/o timeout".
//!
//! Pre-fix:
//! `virtualnetwork.New(tapConfig)` at
//! `src/libgvproxy-sys/gvproxy-bridge/main.go:412-418` returned
//! the bind error to the surrounding goroutine, which logged it to
//! logrus and returned. `gvproxy_create` had already returned a valid
//! id by then, so the FFI caller never learned about the failure.
//!
//! Fix: surface the result via an `initErr` channel so `gvproxy_create`
//! returns -1 on bind failure and the Rust runtime maps that to
//! `Network("gvproxy_create failed")`.

mod common;

use std::net::TcpListener;
use std::process::Command;
use std::time::Instant;

#[test]
fn gvproxy_port_conflict_fails_fast_with_named_error() {
    // Plain TcpListener (no boxlite involvement) holds the host port
    // for the test's lifetime; OS picks a free ephemeral port so the
    // test is parallel-safe with everything.
    let holder = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    let host_port = holder.local_addr().unwrap().port();

    let ctx = common::boxlite();
    let started_at = Instant::now();

    // Bypass `assert_cmd`'s success-asserting wrappers — we expect
    // non-zero exit here and want the raw `Output`.
    let output = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&ctx.home)
        .args(
            boxlite_test_utils::TEST_REGISTRIES
                .iter()
                .flat_map(|r| ["--registry", r]),
        )
        .args([
            "run",
            "--rm",
            "-p",
            &format!("{host_port}:80"),
            "alpine:latest",
            "true",
        ])
        .output()
        .expect("spawn boxlite");

    let elapsed = started_at.elapsed();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);

    drop(holder); // release the held port after we've captured the box exit

    // Collect all check failures, then panic once. This lets a developer
    // observe every level of regression in a single test run — e.g. a
    // partial fix that flips boxlite's exit code but loses the underlying
    // bind detail will still show "L3 missing" instead of needing a
    // second iteration.
    let mut failures: Vec<&'static str> = Vec::new();
    if output.status.success() {
        failures.push("L1 [boxlite rc != 0]: boxlite returned success despite host-port conflict");
    }
    if !stderr.contains("gvproxy_create failed") {
        failures.push("L2 [stderr names gvproxy]: stderr missing 'gvproxy_create failed'");
    }
    if !stderr.contains("address already in use") {
        failures.push("L3 [stderr carries OS detail]: stderr missing 'address already in use'");
    }

    assert!(
        failures.is_empty(),
        "{} of 3 checks failed:\n  - {}\n\n\
         elapsed: {elapsed:?}\nrc: {rc:?}\nstdout: {stdout}\nstderr: {stderr}",
        failures.len(),
        failures.join("\n  - "),
        rc = output.status.code(),
    );
}

/// Companion to `gvproxy_port_conflict_fails_fast_with_named_error`,
/// exercising a *different* gvproxy bind failure mode: EACCES on a
/// privileged port instead of EADDRINUSE on a busy one.
///
/// Same plumbing (`virtualnetwork.New` → goroutine → `initErr` channel
/// → `gvproxy_create` errOut → Rust `Network` folding), but the
/// underlying OS error string differs ("permission denied" vs
/// "address already in use"). Proves the fix surfaces *whatever* the
/// kernel returned at bind time, not a hard-coded port-conflict
/// shortcut.
#[test]
fn gvproxy_privileged_port_fails_fast_with_named_error() {
    // Skip when the runner happens to have permission to bind <1024
    // (root, fcap'd binary, container with CAP_NET_BIND_SERVICE,
    // sysctl `net.ipv4.ip_unprivileged_port_start` lowered). The test
    // premise is "bind privileged port fails"; without that, the test
    // is meaningless.
    if TcpListener::bind("127.0.0.1:80").is_ok() {
        eprintln!(
            "SKIP gvproxy_privileged_port_fails_fast_with_named_error: \
             host allows binding port 80 (root / CAP_NET_BIND_SERVICE / \
             low ip_unprivileged_port_start)"
        );
        return;
    }

    let ctx = common::boxlite();
    let started_at = Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&ctx.home)
        .args(
            boxlite_test_utils::TEST_REGISTRIES
                .iter()
                .flat_map(|r| ["--registry", r]),
        )
        .args(["run", "--rm", "-p", "80:80", "alpine:latest", "true"])
        .output()
        .expect("spawn boxlite");

    let elapsed = started_at.elapsed();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut failures: Vec<&'static str> = Vec::new();
    if output.status.success() {
        failures
            .push("L1 [boxlite rc != 0]: boxlite returned success despite privileged-port bind");
    }
    if !stderr.contains("gvproxy_create failed") {
        failures.push("L2 [stderr names gvproxy]: stderr missing 'gvproxy_create failed'");
    }
    if !stderr.contains("permission denied") {
        failures.push("L3 [stderr carries OS detail]: stderr missing 'permission denied'");
    }

    assert!(
        failures.is_empty(),
        "{} of 3 checks failed:\n  - {}\n\n\
         elapsed: {elapsed:?}\nrc: {rc:?}\nstdout: {stdout}\nstderr: {stderr}",
        failures.len(),
        failures.join("\n  - "),
        rc = output.status.code(),
    );
}
