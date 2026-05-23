//! Integration test: end-to-end host-side reachability of `boxlite run -p`.
//!
//! This is the **positive companion** to:
//!   - `dind_port_conflict_fails_fast` — proves the *failure* path
//!     (gvproxy bind error surfaces via initErr); does NOT prove that
//!     a successful bind actually carries traffic.
//!   - `src/cli/tests/run.rs::test_run_with_publish_*` — CLI flag-parsing
//!     smoke tests; they assert that `boxlite run -p HOST:GUEST alpine
//!     echo ok` exits 0, but never bind anything inside the guest and
//!     never connect to the host port. The gvproxy `tapConfig.Forwards`
//!     entry is populated but is never proven to carry a packet.
//!
//! The gap this closes: nothing in the test suite proves that a packet
//! sent to `localhost:HOST_PORT` on the host actually reaches a listener
//! bound to `HOST_PORT_GUEST` inside the guest. A regression in
//! `src/deps/libgvproxy-sys/gvproxy-bridge/main.go::buildTapConfig`
//! (the loop that turns `PortMappings` into `tapConfig.Forwards`) or
//! in `src/boxlite/src/litebox/init/tasks/vmm_spawn.rs::build_network_config`
//! could silently lose the mapping and every existing test would still
//! pass — confirmed by inspection (none read from the host side).
//!
//! Test shape:
//!   1. Stage a probe script in a host-visible tempdir.
//!   2. `boxlite run -d --rm -p 36080:8080 alpine sh /probe/probe.sh`.
//!      Probe binds an `nc` listener on guest:8080 in an infinite loop,
//!      each iteration serving the same fixed payload.
//!   3. From the host, `TcpStream::connect("127.0.0.1:36080")` with
//!      retry: the listener and gvproxy are racing the test thread, so
//!      we poll for ~10 s. Read the payload, assert byte-equality.
//!   4. RAII `BoxCleanup` SIGKILLs the detached libkrun VM on Drop
//!      (including on assertion panic), keeping host:36080 free for
//!      the next run.
//!
//! No `--privileged`, no docker:dind: this gap applies to *every*
//! boxlite user, not just dind. Using alpine keeps the test cheap
//! (~10 MB cached image, lean libkrunfw, ~5 s boot).
//!
//! Host port 36080 picked off the existing dind suite's
//! 2/12/22-prefixed slices documented in `make/test.mk` (still safe
//! under nextest profile `vm` -j4 because no other test binds 36080).

use assert_cmd::Command;
use boxlite_test_utils::box_cleanup::BoxCleanup;
use boxlite_test_utils::home::PerTestBoxHome;
use std::io::Read;
use std::net::TcpStream;
use std::thread;
use std::time::{Duration, Instant};

const PAYLOAD: &str = "hello-from-boxlite-guest";

/// Probe runs as the foreground exec inside the box. It binds `nc` on
/// 0.0.0.0:8080 in a respawn loop so successive host connections (the
/// retry loop in the test, plus any keep-alive probes) each get a
/// fresh listener. busybox `nc -l` is single-shot; the outer `while`
/// keeps the port held until the box is SIGKILL'd.
const PROBE_SCRIPT: &str = r#"set -e
echo "[probe] starting listener loop on guest:8080" >&2
while true; do
    echo -n "PAYLOAD_HERE" | nc -l -p 8080
done
"#;

#[test]
fn run_p_forwards_host_to_guest_end_to_end() {
    let probe_script = PROBE_SCRIPT.replace("PAYLOAD_HERE", PAYLOAD);

    let tmp = tempfile::tempdir().expect("create tempdir");
    std::fs::write(tmp.path().join("probe.sh"), probe_script).expect("write probe.sh");

    let home = PerTestBoxHome::new();
    let mount = format!("{}:/probe", tmp.path().display());

    // `boxlite run -d` daemonizes after gvproxy_create succeeds (the
    // 617f60b initErr fix made the return synchronous on bind), so by
    // the time `assert().success()` returns, host:36080 is already
    // bound by gvproxy and forwarded to guest:8080. The guest-side
    // listener still has to come up — that race is handled by the
    // host-side retry loop below.
    let assert_run = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&home.path)
        .arg("--registry")
        .arg("docker.m.daocloud.io")
        .timeout(Duration::from_secs(180))
        .args([
            "run",
            "-d",
            "--rm",
            "-p",
            "36080:8080",
            "-v",
            &mount,
            "alpine:latest",
            "sh",
            "/probe/probe.sh",
        ])
        .assert()
        .success();
    let box_id = String::from_utf8_lossy(&assert_run.get_output().stdout)
        .trim()
        .to_string();
    eprintln!("box id: {}", box_id);

    // RAII cleanup MUST be declared after `home` so reverse-order drop
    // tears down the libkrun VM BEFORE the home dir is removed (the
    // cleanup matches /proc/*/fd against the home path; if the home
    // is gone first, no FDs match and the kill silently no-ops, leaking
    // the detached VM holding 36080).
    let _cleanup = BoxCleanup {
        home_path: home.path.clone(),
        box_id: box_id.clone(),
    };

    // ── Host-side reachability ─────────────────────────────────────────
    // The listener and gvproxy come up asynchronously after the
    // daemonized run returns — alpine boot + `sh /probe/probe.sh` +
    // first `nc -l` is on the order of seconds. Retry connect for up
    // to 30 s before declaring the forward broken.
    let deadline = Instant::now() + Duration::from_secs(30);
    // `last_err` is assigned in every loop iteration before the deadline
    // check that reads it, so the initial `None` is provably dead — the
    // compiler can't see across the `break` and warns anyway.
    #[allow(unused_assignments)]
    let mut last_err: Option<String> = None;
    let received = loop {
        match TcpStream::connect("127.0.0.1:36080") {
            Ok(mut stream) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .expect("set read timeout");
                let mut buf = Vec::new();
                match stream.read_to_end(&mut buf) {
                    Ok(_) => break String::from_utf8_lossy(&buf).into_owned(),
                    Err(e) => last_err = Some(format!("read: {e}")),
                }
            }
            Err(e) => last_err = Some(format!("connect: {e}")),
        }
        if Instant::now() >= deadline {
            panic!(
                "host could not reach guest listener via 127.0.0.1:36080 within 30s; \
                 last error: {} (box {box_id})",
                last_err.as_deref().unwrap_or("<no attempt>"),
            );
        }
        thread::sleep(Duration::from_millis(200));
    };

    eprintln!(
        "=== received {} bytes ===\n{}\n=== end ===",
        received.len(),
        received
    );

    assert_eq!(
        received, PAYLOAD,
        "payload received via gvproxy host:36080 → guest:8080 does not match what \
         the in-box listener sent — host-side -p forward is broken (box {box_id})"
    );
}
