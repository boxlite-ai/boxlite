//! Integration test: `boxlite run --support-docker` actually lets a
//! `docker build` complete end-to-end inside the box.
//!
//! Gated on `BOXLITE_DIND_TEST=1` because it requires a libkrunfw-dind
//! blob bundled at build time (`make libkrunfw-dind && cargo build` with
//! `BOXLITE_LIBKRUNFW_DIND_PATH` set). Without the env var the test
//! prints a SKIP notice and returns Ok — keeps the default
//! `test:integration:cli` matrix runnable on hosts without the dind
//! kernel built.
//!
//! What we assert end-to-end:
//!   - boxlite spawns a `--support-docker` box that successfully runs
//!     dockerd (the Phase A caps + cgroup rw work)
//!   - dockerd pulls `alpine:3.19` over the box's gvproxy network
//!   - `docker build --network=host` produces an image with a custom
//!     tag (the build's RUN step executes a child container, exercising
//!     containerd shim + the dind kernel's mqueue/netfilter subsystems)
//!
//! Failure here is the right canary for issue #276's regression budget:
//! every existing capability we depend on (libkrunfw-dind kernel
//! configs, the entrypoint bypass, the support_docker flag plumbing,
//! the per-box libkrunfw symlink) is exercised on a real VM.

use assert_cmd::Command;
use boxlite_test_utils::home::PerTestBoxHome;
use std::time::Duration;

const PROBE_SCRIPT: &str = r#"exec > /probe/result.log 2>&1
dockerd --host=unix:///var/run/docker.sock \
        --bridge=none --iptables=false --storage-driver=vfs \
        > /tmp/d.log 2>&1 &
until [ -S /var/run/docker.sock ]; do sleep 0.5; done
docker build --network=host -t boxlite-dind-test:1 /probe/ctx
echo "[exit=$?]"
"#;

const DOCKERFILE: &str = "FROM alpine:3.19\nRUN echo \"built\" > /built.txt\n";

#[test]
fn dind_supports_docker_build() {
    if std::env::var("BOXLITE_DIND_TEST").is_err() {
        eprintln!(
            "SKIP dind_supports_docker_build: set BOXLITE_DIND_TEST=1 \
             after `make libkrunfw-dind` + a rebuild of boxlite with \
             BOXLITE_LIBKRUNFW_DIND_PATH set, so the dind libkrunfw \
             blob is bundled into the embedded runtime."
        );
        return;
    }

    // ── Stage Dockerfile + probe.sh in a host-visible tempdir ──────────
    // The box mounts this dir at /probe; the probe script starts dockerd
    // and runs `docker build` against /probe/ctx. Output lands in
    // /probe/result.log (which we read on the host after boxlite exits).
    let tmp = tempfile::tempdir().expect("create tempdir");
    let ctx_dir = tmp.path().join("ctx");
    std::fs::create_dir(&ctx_dir).expect("mkdir ctx");
    std::fs::write(ctx_dir.join("Dockerfile"), DOCKERFILE).expect("write Dockerfile");
    std::fs::write(tmp.path().join("probe.sh"), PROBE_SCRIPT).expect("write probe.sh");

    // ── Spawn boxlite ──────────────────────────────────────────────────
    // Build the command directly instead of going through `common::boxlite()`
    // / `new_cmd()`: those helpers force docker.m.daocloud.io et al. as
    // image registries, and `docker:dind` isn't mirrored there reliably —
    // the pull returns a bearer-token error and the box exits before the
    // probe script runs. Using the default registry list (Docker Hub) is
    // the right config for a test image that exercises Docker itself.
    let home_dir = PerTestBoxHome::new();
    let mount = format!("{}:/probe", tmp.path().display());

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_boxlite"));
    // First-time pull of docker:dind (~250 MB compressed) plus a kernel
    // boot and a docker build is comfortably under 10 min on a
    // 2-core/2 GB box even with a cold image cache. The dind-blob check
    // gate above already filters out hosts that can't run this in
    // sensible time, so generous but bounded.
    cmd.timeout(Duration::from_secs(600))
        .arg("--home")
        .arg(&home_dir.path)
        .args([
            "run",
            "--rm",
            "--support-docker",
            "--entrypoint",
            "sh",
            "--memory",
            "2048",
            "-v",
            &mount,
            "docker:dind",
            "/probe/probe.sh",
        ]);
    // Note: we do NOT assert on boxlite's exit code. When `--entrypoint`
    // is set the foreground exec is `sleep infinity` (an artifact of
    // attaching stdio while the real workload runs as PID 1); when the
    // entrypoint script exits, the container's PID namespace tears down
    // and SIGKILL's the sleep — boxlite then reports 137 even though the
    // init process exited cleanly. The probe script's `[exit=$?]` marker
    // is what we actually care about. (Tracked as a follow-up: foreground
    // exit code should follow the init process, not the foreground sleep.)
    let _ = cmd.assert();
    let log_path = tmp.path().join("result.log");
    let log = std::fs::read_to_string(&log_path)
        .unwrap_or_else(|e| panic!("probe never produced {}: {}", log_path.display(), e));
    eprintln!("=== /probe/result.log ===\n{}\n=== end ===", log);
    // `home_dir`'s Drop wipes the per-test home; keep it alive past the
    // log read so boxlite had somewhere to write its DB / boxes dir for
    // the duration of the run.
    drop(home_dir);

    // ── Verify the probe script's recorded result ──────────────────────
    // The probe writes `[exit=N]` as its last line, where N is the
    // `docker build` exit code.
    assert!(
        log.contains("[exit=0]"),
        "docker build did not exit 0 — see result.log above",
    );
    // And it must have actually written the image into dockerd's image
    // store (the BuildKit emits this line on the export step). Without
    // this the build could exit 0 having never reached image writing —
    // defensive guard against silently weak builds.
    assert!(
        log.contains("naming to docker.io/library/boxlite-dind-test:1"),
        "image was not tagged into dockerd's store — see result.log above",
    );
}
