//! End-to-end test for the production zombie path:
//! `boxlite serve` daemon receives a `rm --force` over REST, sends SIGKILL
//! to the running shim, and the daemon stays alive. On `main` the shim
//! lingers in `/proc` as `State: Z` forever (no `waitpid` ever fires from
//! the daemon's `kill_process(pid)` path). On this branch the daemon's
//! in-process `ShimReaper` sweeps the registered PID within a couple of
//! `REAPER_TICK`s.
//!
//! This complements the lower-level library/SDK tests in
//! `src/boxlite/tests/zombie_reaper.rs` by exercising the actual
//! `boxlite serve` subprocess driven through the production REST surface
//! (HTTP create + start + inspect + DELETE), so the upper layers (axum
//! router, JSON shapes, CLI `--url` mode) are also in the path.
//!
//! Two-sided locally:
//!   - reaper enabled  → `/proc/<shim_pid>/status` disappears within
//!     `REAPER_TICK × 2` (250 ms × 2 ≈ 500 ms, budgeted at 5 s).
//!   - `register()` patched to early-return → the same `/proc` entry
//!     stays `State: Z` past the 5 s budget; the assertion fails with
//!     the persisted zombie state surfaced verbatim.

#![allow(dead_code)]

use assert_cmd::Command as AssertCommand;
use boxlite_test_utils::TEST_REGISTRIES;
use boxlite_test_utils::home::PerTestBoxHome;
use std::net::TcpListener;
use std::process::{Child, Command as StdCommand, Stdio};
use std::time::{Duration, Instant};

fn pick_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind :0");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    port
}

/// Poll `GET /v1/config` via `curl` until 200 OR `timeout` elapses.
fn wait_serve_ready(port: u16, timeout: Duration) -> bool {
    let url = format!("http://127.0.0.1:{port}/v1/config");
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let output = StdCommand::new("curl")
            .args([
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "--max-time",
                "1",
                &url,
            ])
            .output();
        if let Ok(out) = output
            && out.status.success()
            && out.stdout == b"200"
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// `boxlite serve` subprocess wrapped in a `Drop` guard. SIGINT (not
/// SIGTERM) so the daemon hits its `with_graceful_shutdown` future and
/// runs `runtime.shutdown(timeout)` — without that the test could leak
/// the box's shim through the daemon kill path itself.
struct ServeGuard {
    child: Child,
}

impl Drop for ServeGuard {
    fn drop(&mut self) {
        let pid = nix::unistd::Pid::from_raw(self.child.id() as i32);
        let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGINT);
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                _ => {
                    if Instant::now() >= deadline {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

/// Run the boxlite CLI in `--url` mode against the spawned daemon and
/// return its captured stdout (trimmed). Panics on non-zero exit.
fn cli(bin: &str, url: &str, args: &[&str]) -> String {
    let mut cmd = AssertCommand::new(bin);
    cmd.timeout(Duration::from_secs(120));
    cmd.args(["--url", url]);
    for reg in TEST_REGISTRIES {
        cmd.arg("--registry").arg(reg);
    }
    cmd.args(args);
    let out = cmd.output().expect("CLI invocation failed to spawn");
    if !out.status.success() {
        panic!(
            "CLI {args:?} exited {:?}\nstdout: {}\nstderr: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn boxlite_serve_rm_force_active_box_no_zombie_left_in_proc() {
    let bin = env!("CARGO_BIN_EXE_boxlite");
    let server_home = PerTestBoxHome::new();

    // 1. Spawn `boxlite serve` on an ephemeral port. The daemon is the
    //    long-lived `parent` from the bug's point of view — when we
    //    `rm --force` later, the daemon's `kill_process(pid)` path sends
    //    SIGKILL to the shim and the daemon stays alive.
    let port = pick_free_port();
    let mut serve_cmd = StdCommand::new(bin);
    serve_cmd
        .arg("--home")
        .arg(&server_home.path)
        .args(["serve", "--port"])
        .arg(port.to_string())
        .args(["--host", "127.0.0.1"]);
    for reg in TEST_REGISTRIES {
        serve_cmd.arg("--registry").arg(reg);
    }
    serve_cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let child = serve_cmd.spawn().expect("spawn boxlite serve");
    let daemon_pid = child.id();
    let _serve_guard = ServeGuard { child };

    assert!(
        wait_serve_ready(port, Duration::from_secs(30)),
        "boxlite serve never accepted GET /v1/config on 127.0.0.1:{port}"
    );

    let url = format!("http://127.0.0.1:{port}");

    // 2. Create + start + inspect to capture the shim PID. Inspect's
    //    `--format` `{{.pid}}` go-template style is the smallest output
    //    we can parse without depending on JSON shape stability.
    let client_home = PerTestBoxHome::new();
    let mut create_cmd = AssertCommand::new(bin);
    create_cmd
        .timeout(Duration::from_secs(120))
        .arg("--home")
        .arg(&client_home.path)
        .args(["--url", &url]);
    for reg in TEST_REGISTRIES {
        create_cmd.arg("--registry").arg(reg);
    }
    create_cmd.args(["create", "alpine:latest"]);
    let out = create_cmd.output().expect("create");
    if !out.status.success() {
        panic!(
            "create exited {:?}\nstderr: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    let box_id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(!box_id.is_empty(), "create returned empty box ID");

    // Start the box (no `--rm` so we explicitly hit `rm --force` below).
    cli(bin, &url, &["start", &box_id]);

    // Pull just the shim PID out of `inspect`. The go-template format
    // is part of the CLI surface and stable across releases.
    let shim_pid_str = cli(
        bin,
        &url,
        &["inspect", "--format", "{{.State.Pid}}", &box_id],
    );
    let shim_pid: u32 = shim_pid_str
        .parse()
        .unwrap_or_else(|e| panic!("parse PID from {shim_pid_str:?}: {e}"));

    // 3. The actual REST `rm --force` — daemon's REST handler invokes
    //    `runtime.remove(box_id, true)` which calls
    //    `kill_process(shim_pid)` (SIGKILL) and never `waitpid()`s.
    cli(bin, &url, &["rm", "--force", &box_id]);

    // 4. Watch `/proc/<shim_pid>/status` from outside the daemon. With
    //    the reaper enabled the entry disappears within `REAPER_TICK × 2`
    //    (~500 ms). Without it (the patched `register()` no-op simulation
    //    of `main`) the entry stays `State: Z` until the daemon exits.
    let status_path = format!("/proc/{shim_pid}/status");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let probe = std::fs::read_to_string(&status_path);
        match &probe {
            Err(_) => return, // /proc entry gone — reaper got it
            Ok(content) if !content.contains("State:\tZ") => return, // not a zombie any more
            _ => {}           // still `State: Z`
        }
        if Instant::now() >= deadline {
            // Capture State + PPid so we can verify, on the failing path,
            // that the kernel still considers the daemon (not init) the
            // shim's parent — i.e. nothing reparented and init can't
            // touch this zombie even though it's been a zombie for 5 s.
            let (state, ppid) = probe
                .as_ref()
                .map(|c| {
                    let line = |prefix: &str| {
                        c.lines()
                            .find(|l| l.starts_with(prefix))
                            .unwrap_or("<none>")
                            .to_string()
                    };
                    (line("State:"), line("PPid:"))
                })
                .unwrap_or_else(|_| ("GONE".into(), "GONE".into()));
            panic!(
                "boxlite serve daemon (PID {daemon_pid}) left zombie shim PID \
                 {shim_pid} in /proc after REST `rm --force` — /proc/{shim_pid}/status \
                 reports {state:?} {ppid:?} past 5 s. Compare {ppid:?} against the \
                 daemon PID {daemon_pid} and init's PID 1: if `PPid:` matches the daemon \
                 (not 1), nothing reparented — only the daemon can `waitpid()` this \
                 zombie. On `main` this is the bug; on this branch the daemon's \
                 in-process `ShimReaper` should sweep the registered PID within \
                 `REAPER_TICK × 2` (~500 ms)."
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
