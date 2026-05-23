//! Integration test: when the desired host port for an image's `EXPOSE`
//! is already bound on the host, `boxlite run` (no explicit `-p`) MUST
//! auto-remap that EXPOSE entry to an OS-allocated ephemeral host port
//! instead of failing fast with `gvproxy_create failed`.
//!
//! Critical guarantees this test pins down (per the user requirement
//! "host and box must both reach the service through their respective
//! port numbers after auto-remap"):
//!   1. **No regression on the existing fail-fast contract for
//!      `dind_port_conflict_fails_fast`.** That test uses explicit
//!      `-p HOST:GUEST` (a user intent), which still fails fast on
//!      collision. This test exercises the orthogonal new path:
//!      EXPOSE-only auto-publish, no `-p`.
//!   2. **`boxlite inspect <id>` surfaces the actual host port.** The
//!      `Ports` array on inspect JSON must contain an entry with the
//!      image's EXPOSE port as `GuestPort`, a non-equal `HostPort`,
//!      and `Source=auto_remap`.
//!   3. **Host-side reachability via the new port.** A raw TCP probe
//!      from the test process to `127.0.0.1:<new_host_port>` must
//!      reach the in-box service — proves the gvproxy forward
//!      terminates at the original `guest_port`.
//!   4. **Box-side reachability still uses the original guest port.**
//!      `boxlite exec <id> -- redis-cli ping` (running inside the box
//!      against `localhost:6379`) must answer `PONG` — proves the
//!      service is bound on the unchanged EXPOSE port internally;
//!      only the host side moved.
//!
//! Image choice: `redis:7-alpine` because (a) it's tiny (~13 MB
//! compressed), (b) it has `EXPOSE 6379` in its image config so the
//! auto-publish code path engages without `-p`, (c) it ships
//! `redis-cli` for the box-side check, and (d) it does NOT need
//! `--privileged`, so this test runs in the default
//! `make test:integration:cli` matrix — no libkrunfw-privileged
//! prerequisite.

mod common;

use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

const EXPOSE_PORT: u16 = 6379;

/// Send the RESP "PING" command and accept the canonical "+PONG\r\n"
/// reply. Returns the raw response head on shape mismatch so the
/// caller can decide whether to keep polling or surface the bytes
/// for diagnosis.
fn redis_ping(host_port: u16) -> Result<(), String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", host_port)
            .parse()
            .expect("addr parse"),
        Duration::from_secs(2),
    )
    .map_err(|e| format!("connect: {}", e))?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok();

    // Inline command form (no RESP framing); redis accepts both since
    // forever. Keeps the test deps-free.
    stream
        .write_all(b"PING\r\n")
        .map_err(|e| format!("write: {}", e))?;

    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf).map_err(|e| format!("read: {}", e))?;
    let reply = String::from_utf8_lossy(&buf[..n]);
    if reply.starts_with("+PONG") {
        Ok(())
    } else {
        Err(format!("unexpected reply: {:?}", reply))
    }
}

#[test]
fn auto_remap_expose_keeps_host_and_box_reachable() {
    // If the host already runs a redis (or anything else) on 6379, the
    // helper would auto-remap on its own and we'd never exercise the
    // probe in this test. Skip cleanly instead of producing a flaky
    // result.
    let blocker = match TcpListener::bind(("0.0.0.0", EXPOSE_PORT)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!(
                "SKIP auto_remap_expose_keeps_host_and_box_reachable: \
                 cannot pre-bind 0.0.0.0:{EXPOSE_PORT} ({e}). The test \
                 needs an unbound EXPOSE port on the host to force the \
                 conflict path; rerun on a host that isn't already \
                 serving on {EXPOSE_PORT}."
            );
            return;
        }
    };
    // Hold the listener for the test's full duration (drop at scope end).

    let ctx = common::boxlite();

    // Start redis detached without any `-p`. The image's EXPOSE 6379
    // is the only thing that should produce a host-side mapping —
    // since 6379 is busy (we hold it above), the runtime MUST fall
    // back to an OS-allocated ephemeral host port.
    //
    // `--entrypoint redis-server` is REQUIRED here, not optional:
    //   - boxlite's positional command tail becomes a *secondary* exec
    //     inside the container, not PID 1 (see
    //     `src/cli/src/commands/run.rs::prepare_command`). With no
    //     `--entrypoint`, PID 1 = image's CMD (`redis-server` with
    //     defaults), which binds only `127.0.0.1:6379` — unreachable
    //     from gvproxy's network namespace.
    //   - With `--entrypoint redis-server`, the positional tail after
    //     the image is the args to PID 1 (matching `docker run
    //     --entrypoint`). `--bind 0.0.0.0` puts redis on the box's
    //     external NIC so gvproxy can forward to it;
    //     `--protected-mode no` skips redis's loopback-only safety
    //     since the connection is intentional.
    let run_output = ctx
        .new_cmd()
        .timeout(Duration::from_secs(120))
        .args([
            "run",
            "-d",
            "--entrypoint",
            "redis-server",
            "redis:7-alpine",
            "--",
            "--bind",
            "0.0.0.0",
            "--protected-mode",
            "no",
        ])
        .ok()
        .expect("boxlite run -d redis:7-alpine spawn failed");
    assert!(
        run_output.status.success(),
        "boxlite run -d redis:7-alpine exited non-zero — auto-remap path \
         is regressing back to fail-fast. stderr:\n{}",
        String::from_utf8_lossy(&run_output.stderr),
    );
    let box_id = String::from_utf8_lossy(&run_output.stdout)
        .trim()
        .to_string();
    assert!(
        !box_id.is_empty(),
        "boxlite run -d returned an empty box id"
    );
    eprintln!("box id: {box_id}");

    // Make sure the box is torn down even if a panic skips the
    // explicit `rm` below. The CLI binary handles SIGKILL of orphaned
    // libkrun children cleanly via the lock file.
    struct Cleanup<'a>(&'a common::TestContext, &'a str);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = self.0.new_cmd().args(["rm", "--force", self.1]).ok();
        }
    }
    let _cleanup = Cleanup(&ctx, &box_id);

    // Pull the resolved port mappings out of `boxlite inspect`. They
    // are written into `BoxState::port_mappings` at the Running
    // transition (see `box_impl.rs`), so by the time `run -d`
    // returned, inspect already has them.
    let inspect_output = ctx
        .new_cmd()
        .args(["inspect", &box_id])
        .ok()
        .expect("boxlite inspect spawn failed");
    let inspect_stdout = String::from_utf8_lossy(&inspect_output.stdout);
    eprintln!("=== inspect ===\n{inspect_stdout}\n=== end ===");
    assert!(
        inspect_output.status.success(),
        "boxlite inspect exited non-zero — stderr:\n{}",
        String::from_utf8_lossy(&inspect_output.stderr),
    );

    let inspect_root: Value =
        serde_json::from_str(&inspect_stdout).expect("inspect output must be valid JSON");
    let ports = inspect_root
        .get(0)
        .and_then(|v| v.get("Ports"))
        .and_then(|p| p.as_array())
        .expect("inspect output must include a `Ports` array");
    let entry = ports
        .iter()
        .find(|m| m.get("GuestPort").and_then(|v| v.as_u64()) == Some(EXPOSE_PORT as u64))
        .unwrap_or_else(|| {
            panic!("inspect Ports has no entry for guest port {EXPOSE_PORT}: {ports:#?}")
        });
    let host_port = entry
        .get("HostPort")
        .and_then(|v| v.as_u64())
        .expect("Ports entry must include HostPort") as u16;
    let source = entry
        .get("Source")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    assert_ne!(
        host_port, EXPOSE_PORT,
        "EXPOSE {EXPOSE_PORT} must have been auto-remapped — we pre-bound \
         0.0.0.0:{EXPOSE_PORT} before starting the box. inspect entry: {entry:#?}",
    );
    assert_eq!(
        source, "auto_remap",
        "EXPOSE entry for guest:{EXPOSE_PORT} must be Source=auto_remap (got {source:?})",
    );
    eprintln!("[ok] inspect → host:{host_port} → guest:{EXPOSE_PORT} (auto_remap)");

    // ─── Host-side reachability ─────────────────────────────────────
    // Redis takes ~0.5–2s after VM ready to accept TCP. Poll up to 30s.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last_err = String::new();
    let mut host_ok = false;
    while Instant::now() < deadline {
        match redis_ping(host_port) {
            Ok(()) => {
                host_ok = true;
                break;
            }
            Err(e) => last_err = e,
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    assert!(
        host_ok,
        "redis PING on host:{host_port} never returned +PONG within 30s — \
         host-side reachability of the auto-remapped port is broken. \
         Last error: {last_err}",
    );
    eprintln!("[ok] host: redis PING via host:{host_port} → +PONG");

    // ─── Box-side reachability ──────────────────────────────────────
    // Inside the box, redis-server still listens on the ORIGINAL
    // EXPOSE port 6379 (auto-remap only moved the host side). The
    // redis-alpine image ships `redis-cli`, so a one-shot
    // `redis-cli ping` from inside the box hits the daemon over
    // loopback at the unchanged guest port.
    let exec_out = ctx
        .new_cmd()
        .timeout(Duration::from_secs(30))
        .args(["exec", &box_id, "--", "redis-cli", "ping"])
        .ok()
        .expect("boxlite exec spawn failed");
    let exec_stdout = String::from_utf8_lossy(&exec_out.stdout);
    let exec_stderr = String::from_utf8_lossy(&exec_out.stderr);
    eprintln!(
        "=== exec stdout ===\n{exec_stdout}\n=== exec stderr ===\n{exec_stderr}\n=== end ==="
    );
    assert!(
        exec_out.status.success(),
        "boxlite exec redis-cli ping exited non-zero — guest-side \
         reachability of the unchanged EXPOSE port {EXPOSE_PORT} is broken",
    );
    assert!(
        exec_stdout.trim_end().ends_with("PONG"),
        "redis-cli ping inside the box did not print PONG — daemon may \
         have moved off {EXPOSE_PORT} inside the guest, or the exec path \
         isn't reaching it",
    );
    eprintln!("[ok] box: redis-cli ping (against guest:{EXPOSE_PORT}) → PONG");

    drop(blocker);
}
