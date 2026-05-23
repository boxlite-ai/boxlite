//! Integration test: `boxlite run --privileged` actually lets
//! `docker compose` orchestrate a multi-service project with the
//! default compose-managed bridge network end-to-end inside the box.
//!
//! Companion to `dind_build.rs` (which exercises image pull +
//! `docker build` — a single-container path). This one exercises:
//!   - `docker compose up` (the v2 plugin shipped inside docker:dind)
//!   - Per-project bridge network auto-created by compose
//!   - Compose's embedded DNS resolver (service-name → IP)
//!   - L3 (ICMP) and L4 (TCP) connectivity between two services
//!
//! Same disk budget as `dind_build` — both services use a SINGLE
//! pre-pulled `alpine:3.19` (compose dedupes by image digest), so the
//! box's ~417 MB writable rootfs limit isn't a factor.
//!
//! Failure here flags one of:
//!   * `docker compose` plugin missing or broken inside privileged kernel
//!   * compose's per-project bridge networking broken (regression of
//!     the `BoxliteExecutor` mitigation that lets dockerd's bridge
//!     setup write `/proc/sys/net/ipv4/ip_forward`)
//!   * compose's embedded DNS resolver broken
//!   * inter-container L3/L4 broken

use assert_cmd::Command;
use boxlite_test_utils::home::PerTestBoxHome;
use std::time::Duration;

// `nc -l -p 8080` is portable across alpine busybox builds (the
// `httpd` applet is no longer in default alpine busybox, but `nc`
// is). The server echoes the marker; client retries up to ~5 s
// because there's a tiny gap between connections while the
// server's nc loop respawns its listener.
//
// `$$` is the YAML/compose escape for `$` — compose performs variable
// interpolation on the YAML body BEFORE handing the command to sh,
// so a bare `$reply` would be substituted to the empty string. `$$`
// becomes `$` post-compose-interpolation, then shell evaluates the
// variable.
//
// `pull_policy: missing` so the prebuilt alpine pre-pulled by the
// probe script is reused instead of triggering a second registry
// HEAD round-trip per service (which can flake on cold DNS).
const COMPOSE_YAML: &str = r#"services:
  server:
    image: alpine:3.19
    pull_policy: missing
    command:
      - sh
      - -c
      - |
        echo "[server] hostname=$$(hostname) ip=$$(hostname -i)"
        echo "[server] entering nc listen loop on 8080"
        while true; do
          echo "hello-from-compose-server" | nc -l -p 8080
        done
  client:
    image: alpine:3.19
    pull_policy: missing
    depends_on:
      - server
    command:
      - sh
      - -c
      - |
        set -e
        for i in 1 2 3 4 5 6 7 8 9 10; do
          getent hosts server >/dev/null && break
          sleep 0.5
        done
        echo "[client] hostname=$$(hostname) ip=$$(hostname -i)"
        echo "[client] === DNS via compose embedded resolver ==="
        getent hosts server
        echo "[client] === ICMP (L3) ==="
        ping -c 2 -W 2 server | tail -3
        echo "[client] === TCP (L4) ==="
        reply=""
        for i in 1 2 3 4 5 6 7 8 9 10; do
          reply=$$(nc -w 2 server 8080 2>/dev/null || true)
          [ -n "$$reply" ] && break
          sleep 0.5
        done
        echo "[client] got: [$$reply]"
        [ "$$reply" = "hello-from-compose-server" ] || { echo "[client] FAIL body mismatch"; exit 1; }
        echo "[compose-c2c-ok]"
"#;

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
echo "[probe] docker compose version: $(docker compose version --short 2>/dev/null || echo MISSING)"

# Pre-pull alpine via the mirror fallback list — both compose services
# use the same digest, and `pull_policy: missing` in the compose file
# means they reuse this instead of each issuing its own registry HEAD
# round-trip. gvproxy's DNS (192.168.127.1:53) can flake on cold boots
# when contacting registry-1.docker.io directly; the mirrors are
# reliable from this host. Pull from whichever mirror responds first,
# then `docker tag` to the canonical name so compose's
# `image: alpine:3.19` (with `pull_policy: missing`) reuses it.
echo "[probe] pre-pull alpine:3.19 (mirror fallback)"
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

cd /probe/proj
echo "[probe] running docker compose up"
docker compose up --abort-on-container-exit --no-color
RC=$?
echo "[probe] compose exit: $RC"

echo "[probe] teardown"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
echo "[exit=$RC]"
"#;

#[test]
fn dind_compose_multi_service_network() {
    if std::env::var("BOXLITE_SKIP_DIND_TEST").as_deref() == Ok("1") {
        eprintln!("SKIP dind_compose_multi_service_network: BOXLITE_SKIP_DIND_TEST=1");
        return;
    }

    // Stage compose.yml + probe.sh in a host-visible tempdir; the box
    // mounts this dir at /probe and the probe script is the foreground
    // exec (PID 1 stays as dockerd-entrypoint.sh).
    let tmp = tempfile::tempdir().expect("create tempdir");
    let proj = tmp.path().join("proj");
    std::fs::create_dir(&proj).expect("mkdir proj");
    std::fs::write(proj.join("compose.yml"), COMPOSE_YAML).expect("write compose.yml");
    std::fs::write(tmp.path().join("probe.sh"), PROBE_SCRIPT).expect("write probe.sh");

    let home_dir = PerTestBoxHome::new();
    let mount = format!("{}:/probe", tmp.path().display());

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_boxlite"));
    // `--registry` mirror: see the equivalent comment in dind_build.rs.
    // Avoids Docker Hub unauthenticated rate limits on both docker:dind
    // and the boxlite-internal debian:bookworm-slim init image.
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
            "-v",
            &mount,
            "docker:dind",
            "sh",
            "/probe/probe.sh",
        ]);
    // `assert_cmd::Command::ok()` returns the captured output without
    // panicking on non-zero exit, so we can dump `/probe/result.log`
    // into the test report BEFORE asserting on the exit code. Without
    // this, an early failure (e.g. the pre-pull retries hitting code
    // 125) leaves no breadcrumb in CI — assert_cmd only shows the box
    // host's stderr noise, not what dockerd actually did.
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
    // 1. compose itself exited 0 (the [exit=N] line is the script's
    //    trailing marker, where N is `docker compose up`'s exit code).
    assert!(
        log.contains("[exit=0]"),
        "docker compose up did not exit 0 — see result.log above",
    );
    // 2. The client service ran to completion and printed the
    //    end-to-end success marker AFTER passing DNS, ping, and the
    //    TCP read of the server's payload.
    assert!(
        log.contains("[compose-c2c-ok]"),
        "client did not reach compose-c2c-ok marker — see result.log above",
    );
}
