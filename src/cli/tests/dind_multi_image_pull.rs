//! Integration test: agent-style multi-image pull inside a `--privileged`
//! `docker:dind` box. Exercises the **prolonged dockerd + large in-box
//! disk writes** code path that single-image tests don't reach.
//!
//! Part of the forced `test:integration:cli` matrix (default RUN).
//! Skip with `BOXLITE_SKIP_DIND_TEST=1` on hosts without nested virt.
//! Prereq: `target/privileged-kernel/lib64/libkrunfw-privileged.so.5`
//! (see `make/test.mk:276` precheck).
//!
//! What this proves end-to-end:
//!   - `boxlite run --disk-size 10` actually plumbs through to
//!     `BoxOptions.disk_size_gb` and `container_rootfs::create_cow_disk`
//!     sizes the COW overlay to the larger of (user, base). Without
//!     this, dockerd's `/var/lib/docker` runs out of space mid-pull
//!     and the probe writes a fast `[exit≠0]`.
//!   - dockerd stays healthy across three consecutive `docker pull`s
//!     (boot → pull alpine → pull python → pull node → `docker images`),
//!     covering the long-running daemon path that single-pull tests
//!     (dind_build pulls only alpine) don't exercise.
//!   - boxlite gvproxy's NAT + DNS hold up under sustained outbound
//!     traffic (~150 MB cumulative pull volume vs ~10 MB in dind_build).
//!   - The privileged kernel's containerd-shim path handles three
//!     distinct base images registered into the in-box storage driver
//!     without leaks (the next test step's `docker images` listing must
//!     show all three).
//!
//! Why three specific images: alpine (musl, lean), python:3.12-slim
//! (glibc, ~50 MB compressed), node:20-slim (glibc, ~75 MB compressed)
//! — together these are the typical "agent toolkit" baseline: a tiny
//! shell image, an interpreted-language image, and a JS/TS runtime
//! image. They share no layers, so the disk-write volume is real (not
//! deduped away by overlay2).
//!
//! Host port slice: 42375/42376 (off the existing 2/12/22-prefixed
//! slices used by dind_build, dind_compose, dind_port_conflict — see
//! make/test.mk's documented table).

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
echo "[probe] socket present"

# Pull three images via mirror fallback. Each one is the same shape as
# the dind_build pre-pull: try mirrors in order, tag canonically on
# first success so `docker images` shows the expected short names.
pull_one() {
    target="$1"
    short="$2"
    echo "[probe] pull $target"
    for reg in docker.m.daocloud.io docker.xuanyuan.me docker.1ms.run docker.io; do
        if docker pull "$reg/library/$target" >/probe/pull.log 2>&1; then
            docker tag "$reg/library/$target" "$short"
            echo "[probe] pulled $short via $reg"
            return 0
        fi
        echo "[probe] pull via $reg failed"
        tail -3 /probe/pull.log
    done
    echo "[probe] FAIL: every mirror failed for $target"
    return 125
}

pull_one alpine:3.19           alpine:3.19           || { echo "[exit=125]"; exit 125; }
pull_one python:3.12-slim      python:3.12-slim      || { echo "[exit=125]"; exit 125; }
pull_one node:20-slim          node:20-slim          || { echo "[exit=125]"; exit 125; }

echo "[probe] all pulls succeeded; listing images"
docker images --format '{{.Repository}}:{{.Tag}}'
echo "[exit=$?]"
"#;

#[test]
fn dind_agent_pulls_alpine_python_node() {
    if std::env::var("BOXLITE_SKIP_DIND_TEST").as_deref() == Ok("1") {
        eprintln!("SKIP dind_agent_pulls_alpine_python_node: BOXLITE_SKIP_DIND_TEST=1");
        return;
    }

    let tmp = tempfile::tempdir().expect("create tempdir");
    std::fs::write(tmp.path().join("probe.sh"), PROBE_SCRIPT).expect("write probe.sh");

    let home_dir = PerTestBoxHome::new();
    let mount = format!("{}:/probe", tmp.path().display());

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_boxlite"));
    // Generous total budget: docker:dind cold pull (~250 MB compressed)
    // + boot (~10 s) + dockerd init (~30 s) + 3 image pulls (~150 MB
    // cumulative compressed, much more after extract). 15 min ceiling.
    //
    // `--disk-size 10`: the new --disk-size flag (see
    // src/cli/src/cli.rs::ResourceFlags) sizes the COW overlay's
    // virtual size to 10 GB so dockerd's `/var/lib/docker` has room
    // for three extracted base images (~600 MB after decompression)
    // plus dockerd's own state plus headroom. Default (unset) is
    // base-image size and would ENOSPC mid-pull.
    //
    // `--memory 2048`: docker:dind boot + dockerd + buffer caches
    // for the pull I/O. Matches dind_build's budget.
    //
    // Explicit -p 42375:2375 -p 42376:2376: suppresses EXPOSE-driven
    // auto-publish onto host:2375/2376 (which would collide with
    // dind_build under nextest -j4). See the dind suite header in
    // make/test.mk for the port-slice table.
    cmd.timeout(Duration::from_secs(900))
        .arg("--home")
        .arg(&home_dir.path)
        .arg("--registry")
        .arg("docker.m.daocloud.io")
        .args([
            "run",
            "--rm",
            "--privileged",
            "--memory",
            "2048",
            "--disk-size",
            "10",
            "-p",
            "42375:2375",
            "-p",
            "42376:2376",
            "-v",
            &mount,
            "docker:dind",
            "sh",
            "/probe/probe.sh",
        ]);
    let output = cmd.ok();

    let log_path = tmp.path().join("result.log");
    let log = std::fs::read_to_string(&log_path).unwrap_or_default();
    let pull_log = std::fs::read_to_string(tmp.path().join("pull.log")).unwrap_or_default();
    eprintln!("=== /probe/result.log ===\n{}\n=== end ===", log);
    if !pull_log.is_empty() {
        eprintln!(
            "=== /probe/pull.log (last attempt) ===\n{}\n=== end ===",
            pull_log
        );
    }
    drop(home_dir);

    let output = output.expect("boxlite run failed; see probe logs above");
    assert!(
        output.status.success(),
        "boxlite run exited non-zero (code={:?}); see probe logs above",
        output.status.code()
    );

    // ── Assertions ─────────────────────────────────────────────────────
    // 1. The trailing `[exit=N]` marker is `docker images`' exit code.
    assert!(
        log.contains("[exit=0]"),
        "probe ended without [exit=0] — see result.log above",
    );

    // 2. All three images present in the listing. The `--format` in
    //    the probe normalizes to `repo:tag` per line.
    for expected in ["alpine:3.19", "python:3.12-slim", "node:20-slim"] {
        assert!(
            log.contains(expected),
            "expected `{}` in the in-box `docker images` output but it was missing — \
             dind pull/registration of that image silently failed (see result.log):\n{}",
            expected,
            log
        );
    }
}
