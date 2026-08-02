//! Regression: when a host port is already bound by another process,
//! `boxlite run -p HOST:GUEST` must fail fast through gvproxy's runtime
//! `/services/forwarder/expose` API, with the underlying bind error intact.
//! Port publication runs only after gvproxy's control socket is ready, so a
//! conflict must never leave a silently running box with a missing forward.

mod common;

use std::net::TcpListener;
use std::process::Command;
use std::time::Instant;

fn bind_exclusive_ephemeral() -> TcpListener {
    use socket2::{Domain, Protocol, Socket, Type};
    use std::io;
    use std::net::SocketAddr;

    fn bind(domain: Domain, address: &str, is_dual_stack: bool) -> io::Result<TcpListener> {
        let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
        if is_dual_stack {
            socket.set_only_v6(false)?;
        }
        socket.set_reuse_address(false)?;
        let address = address.parse::<SocketAddr>().unwrap();
        socket.bind(&address.into())?;
        socket.listen(1)?;
        Ok(socket.into())
    }

    // Go uses an IPv6 dual-stack socket for a wildcard TCP bind when the host
    // supports IPv4-mapped IPv6. Rust's TcpListener uses IPv4 here, and Darwin
    // allows those two families to coexist on one port. Match Go's choice, with
    // its IPv4 fallback for hosts where dual-stack IPv6 is unavailable.
    bind(Domain::IPV6, "[::]:0", true).unwrap_or_else(|ipv6_error| {
        bind(Domain::IPV4, "0.0.0.0:0", false).unwrap_or_else(|ipv4_error| {
            panic!(
                "bind exclusive ephemeral TCP listener: IPv6 failed ({ipv6_error}); \
                 IPv4 failed ({ipv4_error})"
            )
        })
    })
}

#[test]
fn gvproxy_port_conflict_fails_fast_with_named_error() {
    // Hold the same dual-stack wildcard gvproxy uses for BoxLite's default
    // publication. Port 0 keeps the test parallel-safe.
    let holder = bind_exclusive_ephemeral();
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
    if !stderr.contains("/services/forwarder/expose") {
        failures
            .push("L2 [stderr names gvproxy expose]: stderr missing '/services/forwarder/expose'");
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
/// The underlying OS error differs ("permission denied" rather than
/// "address already in use"), proving that the expose path preserves the
/// backend's actual bind failure instead of synthesizing one conflict string.
#[test]
fn gvproxy_privileged_port_fails_fast_with_named_error() {
    // Skip when the runner happens to have permission to bind <1024
    // (root, fcap'd binary, container with CAP_NET_BIND_SERVICE,
    // sysctl `net.ipv4.ip_unprivileged_port_start` lowered). The test
    // premise is "bind privileged port fails"; without that, the test
    // is meaningless.
    //
    // Probe the wildcard, because that is what publication binds: `-p 80:80`
    // leaves `PortSpec::host_ip` unset, which resolves to 0.0.0.0. Darwin
    // applies the reserved-port check only to a named address, so `0.0.0.0:80`
    // succeeds there while every specific address returns EACCES — probing
    // 127.0.0.1 would report the premise as holding when it does not, and the
    // test would then fail against a box that published port 80 correctly.
    if TcpListener::bind("0.0.0.0:80").is_ok() || TcpListener::bind("[::]:80").is_ok() {
        eprintln!(
            "SKIP gvproxy_privileged_port_fails_fast_with_named_error: \
             host allows binding port 80 on the wildcard address (Darwin / root / \
             CAP_NET_BIND_SERVICE / low ip_unprivileged_port_start)"
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
    if !stderr.contains("/services/forwarder/expose") {
        failures
            .push("L2 [stderr names gvproxy expose]: stderr missing '/services/forwarder/expose'");
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
