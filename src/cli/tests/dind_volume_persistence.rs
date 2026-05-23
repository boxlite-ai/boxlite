//! Integration test: `docker volume` round-trip inside a `--privileged`
//! dind box — named volume survives container A's exit and container B
//! reads back what A wrote.
//!
//! Part of the forced `test:integration:cli` matrix (default RUN). Skip
//! with `BOXLITE_SKIP_DIND_TEST=1` on hosts without nested virt.
//!
//! What this proves end-to-end:
//!   - In-box dockerd's named-volume driver actually persists writes
//!     across container lifecycles (creates the volume, mounts it
//!     into A, sees A's bytes from B after A is gone).
//!   - The dind storage driver (`overlay2` by default on the privileged
//!     kernel — relies on overlayfs in the kernel config overlay)
//!     handles multiple container mounts of the same volume without
//!     corruption.
//!   - The privileged kernel's required mount namespacing (CAP_SYS_ADMIN
//!     in the box + bind/move-mount machinery) hold for repeated
//!     mount/unmount cycles, not just the single-pod path that
//!     dind_build exercises.
//!
//! Why this matters for agents: any agent that runs multi-step
//! workflows (build → test → ship) needs named volumes to carry
//! state between steps. A regression that silently drops volume
//! contents would make every such workflow look "successful" while
//! losing data.
//!
//! Host port slice: 52375/52376.

use assert_cmd::Command;
use boxlite_test_utils::home::PerTestBoxHome;
use std::time::Duration;

const PAYLOAD: &str = "persistent-agent-state-marker";

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

# Pre-pull alpine via the mirror fallback list (boxlite gvproxy DNS
# can flake on cold contact with registry-1.docker.io; the mirrors
# are reliable). Tag canonically so the two `docker run` calls below
# resolve from the local store with `pull_policy=never` semantics.
echo "[probe] pre-pull alpine:3.19"
pull_ok=0
for reg in docker.m.daocloud.io docker.xuanyuan.me docker.1ms.run docker.io; do
    if docker pull "$reg/library/alpine:3.19" >/probe/pull.log 2>&1; then
        docker tag "$reg/library/alpine:3.19" alpine:3.19
        pull_ok=1
        echo "[probe] pre-pull ok via $reg"
        break
    fi
    echo "[probe] pull via $reg failed"
    tail -3 /probe/pull.log
done
if [ "$pull_ok" != "1" ]; then
    echo "[probe] pull never succeeded — every mirror failed"
    echo "[exit=125]"
    exit 125
fi

# Create the named volume up front so both containers can mount it.
# `docker volume create` is idempotent but we want a deterministic name
# so the read step can target the same volume the write step used.
echo "[probe] docker volume create agent-data"
docker volume create agent-data || { echo "[exit=126]"; exit 126; }

# Container A: write the payload into /data on the volume, then exit.
# `--rm` removes the container itself; the named volume survives
# because volumes are decoupled from containers.
#
# `\$(wc -c …)` is escaped so the outer probe.sh shell passes the
# literal `$(...)` through to the in-container sh — otherwise it would
# expand in probe.sh (where /data/marker does not exist) and the
# diagnostic would read "wrote bytes" instead of "wrote N bytes".
echo "[probe] container A writes payload"
docker run --rm -v agent-data:/data alpine:3.19 \
    sh -c "printf '%s' '__PAYLOAD__' > /data/marker && echo wrote \$(wc -c < /data/marker) bytes" \
    || { echo "[exit=127]"; exit 127; }

# Container B: read the payload back. If the volume didn't persist
# A's write, this either prints empty (the file is missing) or fails
# entirely. Either way, the host-side assertion catches it because the
# probe writes the read result to /probe/readback.txt for the test to
# slurp.
echo "[probe] container B reads back"
docker run --rm -v agent-data:/data alpine:3.19 \
    sh -c "cat /data/marker" > /probe/readback.txt 2>>/probe/result.log \
    || { echo "[exit=128]"; exit 128; }

# Show what B read so a failing run leaves a trace in the test report.
echo "[probe] readback bytes: $(wc -c < /probe/readback.txt)"
echo "[probe] readback content (escaped):"
od -c /probe/readback.txt | head

# Tidy up the volume so successive test runs (rare — each test gets a
# fresh home/box) don't see stale state. Tolerant of failure since the
# whole box is about to be torn down by --rm anyway.
docker volume rm agent-data >/dev/null 2>&1 || true

echo "[exit=0]"
"#;

#[test]
fn dind_named_volume_persists_across_containers() {
    if std::env::var("BOXLITE_SKIP_DIND_TEST").as_deref() == Ok("1") {
        eprintln!("SKIP dind_named_volume_persists_across_containers: BOXLITE_SKIP_DIND_TEST=1");
        return;
    }

    let probe_script = PROBE_SCRIPT.replace("__PAYLOAD__", PAYLOAD);

    let tmp = tempfile::tempdir().expect("create tempdir");
    std::fs::write(tmp.path().join("probe.sh"), probe_script).expect("write probe.sh");

    let home_dir = PerTestBoxHome::new();
    let mount = format!("{}:/probe", tmp.path().display());

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_boxlite"));
    // --disk-size 5: dockerd's /var/lib/docker holds the volume's
    // backing dir + alpine (~10 MB) + dockerd's image-store metadata.
    // 5 GB is comfortably oversized but cheap because the COW overlay
    // is sparse; only used pages allocate disk.
    //
    // 52375/52376: dedicated port slice (see make/test.mk header).
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
            "52375:2375",
            "-p",
            "52376:2376",
            "-v",
            &mount,
            "docker:dind",
            "sh",
            "/probe/probe.sh",
        ]);
    let output = cmd.ok();

    let log = std::fs::read_to_string(tmp.path().join("result.log")).unwrap_or_default();
    let readback = std::fs::read_to_string(tmp.path().join("readback.txt")).unwrap_or_default();
    eprintln!("=== /probe/result.log ===\n{}\n=== end ===", log);
    eprintln!(
        "=== /probe/readback.txt ({} bytes) ===\n{}\n=== end ===",
        readback.len(),
        readback
    );
    drop(home_dir);

    let output = output.expect("boxlite run failed; see probe logs above");
    assert!(
        output.status.success(),
        "boxlite run exited non-zero (code={:?}); see probe logs above",
        output.status.code()
    );

    assert!(
        log.contains("[exit=0]"),
        "probe ended without [exit=0] — see result.log above",
    );

    // Container B must have read back exactly what A wrote. The probe
    // dumps B's stdout into /probe/readback.txt; on the host we slurp
    // it and compare byte-equal to the original payload. Anything else
    // (empty, partial, corrupted) means the named volume failed to
    // persist A's write through the in-box dockerd storage driver.
    assert_eq!(
        readback.trim_end_matches('\n'),
        PAYLOAD,
        "container B did not read back the payload container A wrote to the named \
         volume — in-box `docker volume` persistence is broken",
    );
}
