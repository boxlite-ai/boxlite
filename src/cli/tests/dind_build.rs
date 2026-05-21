//! Integration test: `boxlite run --privileged` actually lets a
//! `docker build` complete end-to-end inside the box.
//!
//! Part of the forced `test:integration:cli` matrix — runs by default.
//! Prerequisites the make target sets up for us:
//!   1. `target/dind-kernel/lib64/libkrunfw-dind.so.5` exists (built
//!      via `make libkrunfw-dind`, which `test:integration:cli` checks
//!      for and refuses to run without — heavy one-time ~10–20 min
//!      kernel build, cached thereafter).
//!   2. `BOXLITE_LIBKRUNFW_DIND_PATH` is exported when cargo builds the
//!      CLI binary so the dind libkrunfw blob is staged alongside the
//!      lean one inside the embedded runtime.
//!
//! Ignore-condition: set `BOXLITE_SKIP_DIND_TEST=1` to skip with a
//! SKIP marker (useful on hosts that genuinely cannot run dind — e.g.,
//! nested-virt unavailable or security profile blocks the cgroup2
//! mounts the box needs). The default is RUN, not SKIP, so anyone who
//! breaks dind without realising it gets a failing CI signal.
//!
//! Architecture under test (NO entrypoint bypass): we let the image's
//! own `dockerd-entrypoint.sh` run as PID 1 inside the container and
//! pass its dockerd flags via `--cmd` (i.e., as the box's CMD, not by
//! replacing ENTRYPOINT). The positional `boxlite run` command tail is
//! the foreground exec — a probe script that waits for dockerd to come
//! up and then drives `docker build`. The previous variant of this
//! test used `--entrypoint sh` to swap the entrypoint out and ran
//! dockerd manually from the probe; that bypass is no longer needed
//! now that `--cmd` exists.
//!
//! What we assert end-to-end:
//!   - boxlite spawns a `--privileged` box whose init process is
//!     the image's `dockerd-entrypoint.sh` (Phase A caps + cgroup rw
//!     plus the Phase B dind kernel let it boot)
//!   - dockerd-entrypoint.sh launches dockerd with our `--bridge=none`
//!     / `--iptables=false` / `--storage-driver=vfs` flags (needed
//!     because libcontainer-0.5.7 still bind-remounts `/proc/sys` ro
//!     under us — see commit fb073bf)
//!   - dockerd pulls `alpine:3.19` over the box's gvproxy network
//!   - `docker build --network=host` produces an image with a custom
//!     tag (the build's RUN step executes a child container,
//!     exercising containerd shim + the dind kernel's mqueue /
//!     netfilter subsystems)
//!
//! Failure here is the right canary for issue #276's regression
//! budget: every existing capability we depend on (the dind kernel,
//! the per-box libkrunfw symlink, --privileged plumbing, and now
//! the `--cmd` plumbing that lets the image's real ENTRYPOINT run as
//! PID 1) is exercised on a real VM.

use assert_cmd::Command;
use boxlite_test_utils::home::PerTestBoxHome;
use std::time::Duration;

const PROBE_SCRIPT: &str = r#"exec > /probe/result.log 2>&1
echo "[probe] waiting for /var/run/docker.sock"
for i in $(seq 1 180); do
    [ -S /var/run/docker.sock ] && break
    sleep 1
done
if [ ! -S /var/run/docker.sock ]; then
    echo "[probe] dockerd socket never appeared after 180s"
    echo "[exit=124]"
    exit 124
fi
echo "[probe] socket present, running build"
docker build --network=host -t boxlite-dind-test:1 /probe/ctx
echo "[exit=$?]"
"#;

const DOCKERFILE: &str = "FROM alpine:3.19\nRUN echo \"built\" > /built.txt\n";

#[test]
fn dind_supports_docker_build() {
    // Opt-out ignore-condition (see module docs): hosts that genuinely
    // cannot run dind set BOXLITE_SKIP_DIND_TEST=1. Default is RUN —
    // `make test:integration:cli` does not set this, so a regression
    // in dind support fails the suite.
    if std::env::var("BOXLITE_SKIP_DIND_TEST").as_deref() == Ok("1") {
        eprintln!("SKIP dind_supports_docker_build: BOXLITE_SKIP_DIND_TEST=1");
        return;
    }

    // ── Stage Dockerfile + probe.sh in a host-visible tempdir ──────────
    // The box mounts this dir at /probe; the probe script (the foreground
    // exec) waits for dockerd to come up and runs `docker build` against
    // /probe/ctx. Output lands in /probe/result.log which we read on the
    // host after the run completes.
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
            "--privileged",
            // `--cmd` carries the dockerd flags to the image's real
            // ENTRYPOINT (dockerd-entrypoint.sh). Without these,
            // dockerd-entrypoint.sh boots dockerd with default bridge/
            // iptables, which fails because libcontainer-0.5.7 still
            // bind-remounts /proc/sys as ro under us (commit fb073bf).
            "--cmd",
            "--bridge=none",
            "--cmd",
            "--iptables=false",
            "--cmd",
            "--storage-driver=vfs",
            "--memory",
            "2048",
            "-v",
            &mount,
            "docker:dind",
            // Foreground exec: probe waits for the dockerd socket
            // (which `dockerd-entrypoint.sh` running as PID 1 brings
            // up) and runs `docker build`.
            "sh",
            "/probe/probe.sh",
        ]);
    // `boxlite run`'s exit code is the probe script's exit code (it
    // controls the foreground exec, not PID 1). PID 1 (dockerd) keeps
    // running after the build; the RuntimeImpl Drop on shutdown sends
    // SIGTERM to the shim, the VM exits, and `--rm` plus recovery on
    // next runtime start clean up any lingering box record.
    cmd.assert().success();

    // Capture the probe's recorded result for the test report and the
    // two assertions below.
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
