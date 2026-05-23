//! Integration test: long-running container in a `--privileged` dind
//! box exposes the **container lifecycle surface** that agent workflows
//! depend on — `docker run -d` → `docker stats` → `docker exec` →
//! `docker stop` → `docker rm`. One VM exercises five distinct dockerd
//! subsystems back-to-back.
//!
//! Part of the opt-in `make test:integration:privileged` suite (default
//! RUN; NOT in the default `make test` matrix). Skip with
//! `BOXLITE_SKIP_PRIVILEGED_TEST=1` on hosts without nested virt.
//!
//! What this proves end-to-end:
//!   1. `docker run -d` (detached) actually backgrounds the container
//!      and returns a container id — the in-box containerd-shim is
//!      handling the daemonize correctly through the privileged kernel.
//!   2. `docker stats --no-stream <id>` returns one row — the privileged
//!      kernel's cgroup v2 path (CONFIG_BLK_CGROUP, CONFIG_MEMCG, etc.
//!      from the libkrunfw-privileged config) exposes the cgroup data
//!      dockerd needs to render the stats line. A regression here would
//!      print `--` for every metric column.
//!   3. `docker exec <id> echo from-exec` opens a new pid in the
//!      running container's namespaces — covers the exec syscall +
//!      tty allocation path, the most-used "agent enters container"
//!      operation.
//!   4. `docker stop <id>` sends SIGTERM, dockerd waits the default
//!      grace, then SIGKILL — proves the signal-propagation path
//!      through containerd-shim + the cgroup freezer (CONFIG_CGROUP_FREEZER).
//!   5. `docker rm <id>` releases the container record + the per-container
//!      writable layer — proves cleanup completes (no leftover record
//!      shows in `docker ps -a`).
//!
//! Why one test for five steps: each step depends on the previous (no
//! id without `run -d`, no exec without a running container), so
//! splitting them would mean five fresh VMs / five fresh `docker:dind`
//! pulls. Failure breakdown stays diagnosable because each step writes
//! its own `[stepN-ok]` / `[stepN-fail]` marker before the trailing
//! `[exit=N]`.
//!
//! Host port slice: 62375/62376.

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

# Pre-pull busybox via mirror fallback. Tiny image (~2 MB compressed),
# perfect for a sleep container we'll exec into and tear down.
echo "[probe] pre-pull busybox"
pull_ok=0
for reg in docker.m.daocloud.io docker.xuanyuan.me docker.1ms.run docker.io; do
    if docker pull "$reg/library/busybox:1.36" >/probe/pull.log 2>&1; then
        docker tag "$reg/library/busybox:1.36" busybox:1.36
        pull_ok=1
        echo "[probe] pre-pull ok via $reg"
        break
    fi
    echo "[probe] pull via $reg failed"
    tail -3 /probe/pull.log
done
if [ "$pull_ok" != "1" ]; then
    echo "[probe] pull never succeeded"
    echo "[exit=125]"
    exit 125
fi

# ── Step 1: docker run -d ──────────────────────────────────────────
# Foreground exec backgrounds; container id arrives on stdout.
# `sleep 600` keeps the container alive long enough for the next steps.
echo "[probe] step1: docker run -d busybox sleep"
CID=$(docker run -d --name worker busybox:1.36 sleep 600)
if [ -z "$CID" ]; then
    echo "[step1-fail] no container id returned"
    echo "[exit=131]"
    exit 131
fi
echo "[step1-ok] cid=$CID"

# Tiny grace so dockerd's create→start transition completes before
# `docker stats` queries cgroup state — otherwise stats can race and
# print `--` for the cpu / mem columns and look like a regression.
sleep 1

# ── Step 2: docker stats --no-stream ───────────────────────────────
# Single snapshot from cgroup v2. Capture verbatim so the host
# assertion can validate the line shape, not just exit code.
echo "[probe] step2: docker stats --no-stream"
docker stats --no-stream --format '{{.Container}} {{.CPUPerc}} {{.MemUsage}}' worker > /probe/stats.txt
if [ ! -s /probe/stats.txt ]; then
    echo "[step2-fail] stats produced no output (cgroup v2 read broken in privileged kernel?)"
    echo "[exit=132]"
    exit 132
fi
echo "[step2-ok] stats line: $(cat /probe/stats.txt)"

# ── Step 3: docker exec ────────────────────────────────────────────
# Open a new pid in the worker's namespaces, capture its stdout into a
# host-visible file so the host can assert byte-equal on the
# round-tripped string.
echo "[probe] step3: docker exec"
docker exec worker echo from-exec > /probe/exec.txt 2>>/probe/result.log
RC=$?
if [ "$RC" != "0" ]; then
    echo "[step3-fail] exec exit=$RC"
    echo "[exit=133]"
    exit 133
fi
echo "[step3-ok] exec output: $(cat /probe/exec.txt)"

# ── Step 4: docker stop ─────────────────────────────────────────────
# SIGTERM with default 10s grace. busybox sleep responds to SIGTERM
# quickly, so this should complete in well under a second.
echo "[probe] step4: docker stop"
docker stop -t 5 worker > /dev/null
RC=$?
if [ "$RC" != "0" ]; then
    echo "[step4-fail] stop exit=$RC"
    echo "[exit=134]"
    exit 134
fi
# Verify the container is now in "Exited" state (not still Up).
STATE=$(docker inspect -f '{{.State.Status}}' worker)
if [ "$STATE" != "exited" ]; then
    echo "[step4-fail] container state is '$STATE', expected 'exited'"
    echo "[exit=134]"
    exit 134
fi
echo "[step4-ok] container state: $STATE"

# ── Step 5: docker rm ───────────────────────────────────────────────
# Remove the container record. After this, `docker ps -a -q -f name=worker`
# must be empty.
echo "[probe] step5: docker rm"
docker rm worker > /dev/null
RC=$?
if [ "$RC" != "0" ]; then
    echo "[step5-fail] rm exit=$RC"
    echo "[exit=135]"
    exit 135
fi
LINGER=$(docker ps -a -q -f name=worker)
if [ -n "$LINGER" ]; then
    echo "[step5-fail] worker still listed after rm: $LINGER"
    echo "[exit=135]"
    exit 135
fi
echo "[step5-ok] worker removed cleanly"

echo "[exit=0]"
"#;

#[test]
fn dind_container_run_stats_exec_stop_rm() {
    if std::env::var("BOXLITE_SKIP_PRIVILEGED_TEST").as_deref() == Ok("1") {
        eprintln!("SKIP dind_container_run_stats_exec_stop_rm: BOXLITE_SKIP_PRIVILEGED_TEST=1");
        return;
    }

    let tmp = tempfile::tempdir().expect("create tempdir");
    std::fs::write(tmp.path().join("probe.sh"), PROBE_SCRIPT).expect("write probe.sh");

    let home_dir = PerTestBoxHome::new();
    let mount = format!("{}:/probe", tmp.path().display());

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_boxlite"));
    // --disk-size 5: busybox is tiny (~2 MB) but dockerd state,
    // containerd's shim metadata, and `docker stats` collection
    // overhead all live on /var/lib/docker. 5 GB virtual is cheap
    // (sparse COW) and comfortably oversized.
    //
    // 62375/62376: dedicated port slice (see make/test.mk header).
    cmd.timeout(Duration::from_secs(600))
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
            "5",
            "-p",
            "62375:2375",
            "-p",
            "62376:2376",
            "-v",
            &mount,
            "docker:dind",
            "sh",
            "/probe/probe.sh",
        ]);
    let output = cmd.ok();

    let log = std::fs::read_to_string(tmp.path().join("result.log")).unwrap_or_default();
    let stats = std::fs::read_to_string(tmp.path().join("stats.txt")).unwrap_or_default();
    let exec_out = std::fs::read_to_string(tmp.path().join("exec.txt")).unwrap_or_default();
    eprintln!("=== /probe/result.log ===\n{}\n=== end ===", log);
    eprintln!("=== /probe/stats.txt ===\n{}\n=== end ===", stats);
    eprintln!("=== /probe/exec.txt ===\n{}\n=== end ===", exec_out);
    drop(home_dir);

    let output = output.expect("boxlite run failed; see probe logs above");
    assert!(
        output.status.success(),
        "boxlite run exited non-zero (code={:?}); see probe logs above",
        output.status.code()
    );

    // Every step must have reached its `[stepN-ok]` marker and the
    // trailing exit must be 0 — anything else means the script
    // bailed mid-way.
    assert!(
        log.contains("[exit=0]"),
        "probe ended without [exit=0] — see result.log above",
    );
    for marker in [
        "[step1-ok]",
        "[step2-ok]",
        "[step3-ok]",
        "[step4-ok]",
        "[step5-ok]",
    ] {
        assert!(
            log.contains(marker),
            "missing {marker} — that step failed; see result.log above",
        );
    }

    // `docker stats` line shape: `<short-id-or-name> <pct>%  <mem-usage>`.
    // The `MiB` (or `KiB`/`GiB`) suffix confirms cgroup memory accounting
    // is actually being read; a broken cgroup path would render `--`.
    assert!(
        stats.contains("worker"),
        "docker stats line did not include the container name 'worker':\n{}",
        stats
    );
    assert!(
        stats.contains("MiB") || stats.contains("KiB") || stats.contains("GiB"),
        "docker stats memory column had no human-readable unit — cgroup v2 \
         memory accounting may be broken on the privileged kernel:\n{}",
        stats
    );

    // `docker exec worker echo from-exec` must have round-tripped exactly.
    assert_eq!(
        exec_out.trim_end_matches('\n'),
        "from-exec",
        "docker exec did not return the expected stdout — exec path through \
         containerd-shim is broken",
    );
}
