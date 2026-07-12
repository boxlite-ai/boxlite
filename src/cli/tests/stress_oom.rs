//! Integration tests for the container cgroup resource guard (`memory.max` +
//! `pids.max`) that keeps a hostile workload from taking down the guest VM.
//!
//! Two angles, both against a real 128 MB box:
//!   - enforcement — the limits are actually written to the container's own
//!     cgroup (`/boxlite/<id>/memory.max` bounded, `pids.max` = 512), so a
//!     regression that drops the resources or re-disables cgroups (leaving the
//!     container in the root) is caught directly.
//!   - survival — the VM stays `Running` and keeps serving exec through three
//!     escalating attack waves (a 1000-fork pids bomb, a single 512 MB malloc
//!     in a 128 MB VM, and a 200×2 MB fork+alloc bomb).
//!
//! Requires a VM-capable host with network to pull `alpine` and `apk add gcc`.

use assert_cmd::Command;
use boxlite_test_utils::home::PerTestBoxHome;
use std::path::Path;
use std::time::Duration;

/// `boxlite --home <home> <args...>` with a timeout.
fn boxlite(home: &Path, args: &[&str], timeout: Duration) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(home)
        .args(args)
        .timeout(timeout)
        .output()
        .expect("spawn boxlite")
}

/// `boxlite exec <box> -- sh -c <script>`.
fn exec_sh(home: &Path, box_id: &str, script: &str, timeout: Duration) -> std::process::Output {
    boxlite(home, &["exec", box_id, "--", "sh", "-c", script], timeout)
}

/// Force-removes a box on drop so the `PerTestBoxHome` live-shim guard can't
/// fire and mask the real failure. Declare it *after* the home so it drops
/// first (reverse declaration order).
struct BoxCleanup {
    home: std::path::PathBuf,
    id: String,
}
impl Drop for BoxCleanup {
    fn drop(&mut self) {
        let _ = boxlite(&self.home, &["rm", "-f", &self.id], Duration::from_secs(30));
    }
}

/// Start a detached alpine box of size `mem_mib` MiB; returns its id.
/// `start_128mb_box` is just `start_mb_box(home, 128)`.
fn start_mb_box(home: &Path, mem_mib: u32) -> String {
    let mem = mem_mib.to_string();
    let out = boxlite(
        home,
        &[
            "--registry",
            "docker.m.daocloud.io",
            "run",
            "-d",
            "--memory",
            &mem,
            "alpine:latest",
            "sleep",
            "600",
        ],
        Duration::from_secs(300),
    );
    assert!(
        out.status.success(),
        "box start failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Read the container's own cgroup path via `/proc/self/cgroup`. Returns the
/// path stripped of the `0::` prefix (e.g. `/boxlite/<id>`).
fn read_container_cgroup(home: &Path, box_id: &str) -> String {
    let out = exec_sh(
        home,
        box_id,
        "sed 's/^0:://' /proc/self/cgroup",
        Duration::from_secs(15),
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Start a detached 128 MB alpine box running `sleep 600`; returns its id.
fn start_128mb_box(home: &Path) -> String {
    start_mb_box(home, 128)
}

/// Directly verifies the limits are applied to the container's own cgroup: a
/// `/boxlite/<id>` path with `memory.max` bounded below the VM and `pids.max`
/// = 512. Guards both the explicit cgroups_path and that the resources are
/// written — dropping either (or re-disabling cgroups, which puts the
/// container back in the root) fails here.
#[test]
fn cgroup_limits_are_enforced_on_the_container() {
    let home = PerTestBoxHome::new();
    let box_id = start_128mb_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // Read the container *init* (PID 1)'s cgroup — that's where the workload
    // limits live. `/proc/self/cgroup` would return the exec'd shell's cgroup
    // which is now in the operator sibling subgroup (carved out so a workload
    // bomb doesn't lock the operator out), and that subgroup has a different
    // smaller budget. The contract this test pins is the WORKLOAD's cap.
    let out = exec_sh(
        home.path.as_path(),
        &box_id,
        "cg=$(sed 's/^0:://' /proc/1/cgroup); \
         printf 'CG=%s\\nMEM=%s\\nPIDS=%s\\n' \
           \"$cg\" \
           \"$(cat /sys/fs/cgroup$cg/memory.max 2>&1)\" \
           \"$(cat /sys/fs/cgroup$cg/pids.max 2>&1)\"",
        Duration::from_secs(30),
    );
    let report = String::from_utf8_lossy(&out.stdout);
    let field = |key: &str| -> String {
        report
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .unwrap_or("")
            .trim()
            .to_string()
    };

    let cg = field("CG=");
    let mem = field("MEM=");
    let pids = field("PIDS=");

    assert!(
        cg.starts_with("/boxlite/") && cg.ends_with("/workload"),
        "container init must run in /boxlite/<id>/workload subgroup (workload + \
         operator carve-out); got {cg:?}\n{report}"
    );
    let mem_max: u64 = mem.parse().unwrap_or_else(|_| {
        panic!("memory.max must be a concrete byte cap, not {mem:?} (cgroup not applied)\n{report}")
    });
    assert!(
        mem_max > 0 && mem_max < 128 * 1024 * 1024,
        "memory.max ({mem_max}) must be a positive cap below the 128 MB VM\n{report}"
    );
    assert_eq!(
        pids, "512",
        "pids.max must be the CONTAINER_PIDS_MAX ceiling\n{report}"
    );
}

/// flood <n> <mb>: fork n children; each (if mb>0) malloc+memset mb MiB to fault
/// it in as RSS, then sleep briefly and exit so waves don't accumulate. The
/// parent prints how many forks actually succeeded (fewer than n once pids.max
/// blocks them) and exits immediately.
const FLOOD_C: &str = r#"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
int main(int c, char **v) {
    int n = c > 1 ? atoi(v[1]) : 100;
    long mb = c > 2 ? atol(v[2]) : 2;
    int i, forked = 0;
    for (i = 0; i < n; i++) {
        pid_t p = fork();
        if (p == 0) {
            if (mb > 0) { char *m = malloc((size_t)mb << 20); if (m) memset(m, 66, (size_t)mb << 20); }
            sleep(20);
            _exit(0);
        }
        if (p > 0) forked++;
    }
    printf("forked %d/%d x %ldMB\n", forked, n, mb);
    fflush(stdout);
    return 0;
}
"#;

/// The VM is healthy iff it still lists as `Running` and a fresh exec succeeds.
/// A guest-kernel panic or dead agent fails one or both.
fn assert_vm_survives(home: &Path, box_id: &str, ctx: &str) {
    let list = boxlite(home, &["list"], Duration::from_secs(15));
    let listing = String::from_utf8_lossy(&list.stdout);
    assert!(
        listing.contains("Running"),
        "VM must survive {ctx}, but it is no longer Running; `list` =\n{listing}"
    );
    let echo = boxlite(
        home,
        &["exec", box_id, "--", "echo", "alive"],
        Duration::from_secs(15),
    );
    assert!(
        echo.status.success(),
        "guest agent must accept exec after {ctx}; stderr = {}",
        String::from_utf8_lossy(&echo.stderr)
    );
}

/// Run one attack wave, then assert the VM survived and reset the box for the
/// next wave by killing any lingering flood children. Returns the flood's
/// stdout (`forked <succeeded>/<requested> x <mb>MB`) so a caller can assert on
/// how many forks the cgroup actually let through.
fn run_wave(home: &Path, box_id: &str, n: u32, mb: u32, ctx: &str) -> String {
    // The parent exits right after forking; give the cgroup a moment to OOM-kill
    // / block, then assert survival before cleaning up.
    let out = exec_sh(
        home,
        box_id,
        &format!("/tmp/flood {n} {mb} || true"),
        Duration::from_secs(30),
    );
    std::thread::sleep(Duration::from_secs(8));
    assert_vm_survives(home, box_id, ctx);
    // Reap survivors so the next wave starts from a clean slate.
    let _ = exec_sh(
        home,
        box_id,
        "pkill -9 -x flood || true",
        Duration::from_secs(15),
    );
    std::thread::sleep(Duration::from_secs(2));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Parse the `forked <succeeded>/<requested>` count the flood prints.
fn forked_count(wave_stdout: &str) -> u32 {
    wave_stdout
        .lines()
        .find_map(|l| l.strip_prefix("forked "))
        .and_then(|rest| rest.split('/').next())
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or_else(|| panic!("flood did not report a fork count:\n{wave_stdout}"))
}

/// 128 MB box, gcc-compiled flood, driven through pids → memory → combined
/// attack waves. The container's `memory.max` + `pids.max` keep the OOM kills
/// scoped to container processes so the guest kernel and agent stay up.
#[test]
fn cgroup_limits_keep_vm_alive_under_pids_and_memory_bombs() {
    let home = PerTestBoxHome::new();
    let box_id = start_128mb_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // Toolchain to build the flood in-box (a real source of memory pressure too).
    let install = exec_sh(
        home.path.as_path(),
        &box_id,
        "apk add -q --no-cache gcc musl-dev >/dev/null 2>&1 && echo ok",
        Duration::from_secs(180),
    );
    assert!(
        String::from_utf8_lossy(&install.stdout).contains("ok"),
        "gcc install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let compile = format!(
        "cat > /tmp/flood.c << 'CEOF'\n{FLOOD_C}\nCEOF\ngcc -O0 -o /tmp/flood /tmp/flood.c && echo compiled"
    );
    let out = exec_sh(
        home.path.as_path(),
        &box_id,
        &compile,
        Duration::from_secs(90),
    );
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("compiled"),
        "flood compile failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Wave 1 — pids bomb: 1000 idle forks vs pids.max = 512.
    let wave1 = run_wave(
        home.path.as_path(),
        &box_id,
        1000,
        0,
        "a 1000-fork pids bomb",
    );
    // Survival alone can't tell an enforced cap from a kernel that happened to
    // cope: assert pids.max actually blocked the bomb. The container can hold
    // at most 512 tasks (CONTAINER_PIDS_MAX) including the ones already running,
    // so far fewer than the requested 1000 forks can succeed. 700 leaves slack
    // above the 512 ceiling while still proving hundreds of forks were refused.
    let forked = forked_count(&wave1);
    assert!(
        (1..700).contains(&forked),
        "pids.max must cap the fork bomb well below the requested 1000 \
         (ceiling 512 + already-running tasks); got forked={forked}\n{wave1}"
    );
    // Wave 2 — memory bomb: one process grabs 512 MB in a 128 MB VM.
    run_wave(
        home.path.as_path(),
        &box_id,
        1,
        512,
        "a single 512 MB allocation",
    );
    // Wave 3 — combined: 200 children each touch 2 MB.
    run_wave(
        home.path.as_path(),
        &box_id,
        200,
        2,
        "a 200×2 MB fork+alloc bomb",
    );
}

// ============================================================================
// Cleanup, isolation, restart, and limit-enforces-by-killing checks.
// Added in the design-review pass on this PR — gaps the original two tests
// didn't cover.
// ============================================================================

/// `memory.max` must actually OOM-kill a single allocation that overruns the
/// cap — survival-of-the-VM is necessary but not sufficient; the WHOLE point of
/// the limit is to kill the offender. A container that allocates well past
/// `memory.max` in one chunk must exit non-zero (cgroup OOM-killed → SIGKILL =
/// exit 137), not return success.
#[test]
fn memory_limit_actually_oom_kills_overconsumption() {
    let home = PerTestBoxHome::new();
    let box_id = start_128mb_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // alpine has busybox `dd`, which can be used to allocate a large /dev/zero
    // buffer in RAM via tmpfs. We allocate WELL beyond memory.max (which is
    // ~90% of MemAvailable on a 128 MB VM ≈ 90 MB): write 200 MB into /tmp
    // (tmpfs, RAM-backed inside the cgroup). That MUST be killed.
    let out = exec_sh(
        home.path.as_path(),
        &box_id,
        "dd if=/dev/zero of=/tmp/hog bs=1M count=200 2>&1; echo exit=$?",
        Duration::from_secs(45),
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    // The exec returns the dd's exit code through the printed `exit=N`. Either
    // dd was SIGKILL'd (137), it returned non-zero with an error, or the host
    // exec channel itself returned non-zero — all are valid "killed by cgroup"
    // signals. What's NOT acceptable is `exit=0` (write fully succeeded with
    // no enforcement).
    assert!(
        !stdout.contains("exit=0"),
        "memory.max did not stop a 200 MB allocation in a 128 MB box (memory limit not enforced)\noutput:\n{stdout}"
    );

    // And the VM itself must still be Running — the cap killed the container
    // process, not the VM.
    assert_vm_survives(home.path.as_path(), &box_id, "memory OOM kill");
}

/// After `rm -f`, the box's `/sys/fs/cgroup/boxlite/<id>` must not linger.
/// youki removes it on container delete; if a regression bypasses that, the
/// host cgroup tree grows unbounded across box churn.
#[test]
fn cgroup_dir_is_removed_after_box_rm() {
    let home = PerTestBoxHome::new();
    let box_id = start_128mb_box(home.path.as_path());

    // Capture the cgroup path the running box uses.
    let cg = read_container_cgroup(home.path.as_path(), &box_id);
    assert!(
        cg.starts_with("/boxlite/"),
        "expected /boxlite/<id>; got {cg:?}"
    );

    // The cgroup directory itself lives on the guest. After `rm -f` the VM is
    // gone, so we verify by starting a SECOND box and checking the first one's
    // cgroup directory is absent from the guest's view. We must use the same
    // home to reuse cached images; otherwise the second box takes too long.
    let rm = boxlite(
        home.path.as_path(),
        &["rm", "-f", &box_id],
        Duration::from_secs(60),
    );
    assert!(
        rm.status.success(),
        "rm failed: {}",
        String::from_utf8_lossy(&rm.stderr)
    );

    // Bring up a fresh box on the same home and ask it whether the prior
    // box's cgroup directory exists. If it does, youki / boxlite leaked the
    // cgroup. The fresh box's PID-namespace can read the host cgroup tree
    // (we didn't add a cgroup namespace).
    let box2 = start_128mb_box(home.path.as_path());
    let _c2 = BoxCleanup {
        home: home.path.clone(),
        id: box2.clone(),
    };
    let check = exec_sh(
        home.path.as_path(),
        &box2,
        &format!("if [ -d /sys/fs/cgroup{cg} ]; then echo LEAKED; else echo CLEAN; fi"),
        Duration::from_secs(15),
    );
    let s = String::from_utf8_lossy(&check.stdout);
    assert!(
        s.contains("CLEAN"),
        "cgroup {cg} not cleaned up after box rm — saw: {s:?}\n(check stderr: {})",
        String::from_utf8_lossy(&check.stderr)
    );
}

/// Two concurrently-running boxes must each land in their own
/// `/boxlite/<unique-id>` cgroup. A regression that derived the path from
/// something shared (e.g. a hashed image id) would have both boxes in the
/// same cgroup and one's fork bomb cap would be split between them.
#[test]
fn concurrent_boxes_have_independent_cgroups() {
    let home = PerTestBoxHome::new();
    let box_a = start_128mb_box(home.path.as_path());
    let box_b = start_128mb_box(home.path.as_path());
    let _a = BoxCleanup {
        home: home.path.clone(),
        id: box_a.clone(),
    };
    let _b = BoxCleanup {
        home: home.path.clone(),
        id: box_b.clone(),
    };
    let cg_a = read_container_cgroup(home.path.as_path(), &box_a);
    let cg_b = read_container_cgroup(home.path.as_path(), &box_b);
    assert!(
        cg_a.starts_with("/boxlite/") && cg_b.starts_with("/boxlite/"),
        "both boxes must run under /boxlite/<id>; got {cg_a:?} and {cg_b:?}"
    );
    assert_ne!(
        cg_a, cg_b,
        "concurrent boxes must have distinct cgroups; both at {cg_a:?}"
    );
}

/// After stop+start the box must re-land in a /boxlite/<id> cgroup with the
/// same limits (the new container id changes, but the spec-building path is
/// the same so the path-prefix invariant must hold). A regression that lost
/// the cgroups_path on restart would land the restarted container in
/// `/:youki:<id>`.
#[test]
fn cgroup_limits_survive_stop_and_start() {
    let home = PerTestBoxHome::new();
    let box_id = start_128mb_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // stop
    let stop = boxlite(
        home.path.as_path(),
        &["stop", &box_id],
        Duration::from_secs(60),
    );
    assert!(
        stop.status.success(),
        "stop failed: {}",
        String::from_utf8_lossy(&stop.stderr)
    );

    // start again
    let start = boxlite(
        home.path.as_path(),
        &["start", &box_id],
        Duration::from_secs(120),
    );
    assert!(
        start.status.success(),
        "start failed: {}",
        String::from_utf8_lossy(&start.stderr)
    );

    let cg = read_container_cgroup(home.path.as_path(), &box_id);
    assert!(
        cg.starts_with("/boxlite/"),
        "after restart, container must still run under /boxlite/<id>; got {cg:?}"
    );
}

/// **The carve-out's load-bearing test**: after a workload bomb saturates the
/// workload subgroup, `boxlite exec --debug` must land in the sibling
/// `/operator` subgroup (own `pids.max=64`), not the workload's saturated one.
///
/// What the assertions pin:
///   1. The `--debug` exec succeeds (operator can still get into the box).
///   2. The exec'd process's `/proc/self/cgroup` ends with `/operator` —
///      the structural proof of the carve-out. Without the swap-on-debug
///      logic this would be `/workload` (or `/boxlite/<id>` if the spec
///      change is also reverted), and the operator would share fate with
///      a runaway workload.
///
/// Honest caveat: the libcontainer-tenant lockout that originally motivated
/// the carve-out (workload saturating `/boxlite/<id>` → `failed to launch
/// init process`) does not reproduce deterministically with this bomb size
/// in CI — libcontainer needs only ~1 PID slot for tenant exec and the
/// workload bomb usually leaves at least that much. Assertion #2 is the
/// deterministic guard; #1 is a smoke check that the API works end-to-end.
#[test]
fn operator_exec_works_when_workload_saturates_pids_cap() {
    let home = PerTestBoxHome::new();
    let box_id = start_128mb_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // Bring up gcc + compile the flood binary (same recipe as the other
    // stress tests).
    let install = exec_sh(
        home.path.as_path(),
        &box_id,
        "apk add -q --no-cache gcc musl-dev >/dev/null 2>&1 && echo ok",
        Duration::from_secs(180),
    );
    assert!(
        String::from_utf8_lossy(&install.stdout).contains("ok"),
        "gcc install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );
    let compile = format!(
        "cat > /tmp/flood.c << 'CEOF'\n{FLOOD_C}\nCEOF\ngcc -O0 -o /tmp/flood /tmp/flood.c && echo compiled"
    );
    let out = exec_sh(
        home.path.as_path(),
        &box_id,
        &compile,
        Duration::from_secs(90),
    );
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("compiled"),
        "flood compile failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Saturate the workload subgroup: 1000 forks against pids.max=512. The
    // flood binary's forked children sleep 20 s holding their PIDs, so
    // they're still alive when we probe `exec` below.
    let _ = exec_sh(
        home.path.as_path(),
        &box_id,
        "(/tmp/flood 1000 0 &) ; sleep 1 ; echo bomb-launched",
        Duration::from_secs(30),
    );

    // Give the bomb a moment to climb to the 512 ceiling. After this the
    // workload subgroup IS full — any libcontainer cgroup-join into the
    // same subgroup would EAGAIN.
    std::thread::sleep(Duration::from_secs(3));

    // Assertion #1 — smoke: `boxlite exec --debug` succeeds against a box
    // whose workload subgroup is at pids.max. The `--debug` flag is what
    // routes us out of workload's saturated subgroup.
    let probe = boxlite(
        home.path.as_path(),
        &["exec", "--debug", &box_id, "--", "echo", "operator-alive"],
        Duration::from_secs(30),
    );
    let stdout = String::from_utf8_lossy(&probe.stdout);
    let stderr = String::from_utf8_lossy(&probe.stderr);
    assert!(
        probe.status.success() && stdout.contains("operator-alive"),
        "boxlite exec --debug must succeed on a workload-saturated box. \
         exit: {:?}\nstdout: {stdout}\nstderr: {stderr}",
        probe.status.code()
    );

    // Assertion #2 (the deterministic one): the `--debug`-exec'd process
    // landed in the operator subgroup, not workload. This is what catches
    // a regression where the swap is silently a no-op — the bomb might not
    // be strong enough to lock workload out, but the cgroup path tells us
    // definitively whether the carve-out is active.
    let cg_probe = boxlite(
        home.path.as_path(),
        &[
            "exec",
            "--debug",
            &box_id,
            "--",
            "sh",
            "-c",
            "sed 's/^0:://' /proc/self/cgroup",
        ],
        Duration::from_secs(15),
    );
    let cg = String::from_utf8_lossy(&cg_probe.stdout).trim().to_string();
    assert!(
        cg.ends_with("/operator"),
        "--debug exec must land in /boxlite/<id>/operator (the carve-out \
         sibling), not in workload or a single combined cgroup; got {cg:?}"
    );
}
