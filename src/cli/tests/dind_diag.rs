//! Diagnostic (opt-in): reproducer for the `--bridge=none / --iptables=false /
//! --storage-driver=vfs` workaround required by PR #568.
//!
//! ## What this test proves
//!
//! PR #568's stated root cause — "libcontainer-0.5.7 bind-remounts /proc/sys
//! ro under us despite the OCI spec saying `readonlyPaths: []`" — is correct
//! about the SYMPTOM (dockerd hits `/proc/sys/net/ipv4/ip_forward: read-only
//! file system` when bringing up its default bridge) but wrong about the
//! CAUSE.
//!
//! The init container's spec is fine: `tests::test_privileged_clears_
//! readonly_and_masked_paths` in `src/guest/src/container/spec.rs` proves
//! that `create_oci_spec(privileged=true)` produces `linux.readonly_paths =
//! Some([])` and `linux.masked_paths = Some([])` and that those values
//! survive JSON round-trip through `oci_spec::runtime::Spec::save`/`load`.
//!
//! The real bug is in libcontainer's **tenant** path. When boxlite's
//! foreground exec (a `sleep infinity` placeholder when `--entrypoint` is
//! set) goes through `libcontainer::container::tenant_builder::
//! adapt_spec_for_tenant` (`libcontainer-0.5.7/src/container/tenant_builder.rs:442`),
//! the tenant builder discards the init spec's `readonly_paths` and
//! `masked_paths` and rebuilds the Linux block from
//! `LinuxBuilder::default()`. `LinuxBuilder` uses `Linux::default()` for
//! unset fields, and `Linux::default()` in `oci-spec-0.6.7` sets
//! `readonly_paths = Some(get_default_readonly_paths())` (4 paths
//! including `/proc/sys`) and `masked_paths = Some(get_default_maskedpaths())`
//! (10 paths). So every tenant exec re-applies the OCI default hardening
//! into the *shared* mount namespace, ro-mounting `/proc/sys`, `/proc/bus`,
//! `/proc/fs`, `/proc/irq` and masking `/proc/asound`, `/proc/kcore`,
//! `/proc/keys`, `/proc/timer_list`, `/sys/firmware`.
//!
//! The bug is present in:
//!   - libcontainer 0.5.7  (current pin)
//!   - libcontainer 0.6.0  (latest crates.io)
//!   - youki main branch   (commit 2026-05 head, verified)
//!
//! ## What this test does
//!
//! Boots `docker:dind` with NO dockerd flag overrides (default bridge,
//! default iptables, default storage driver), waits for the daemon, and
//! collects:
//!   - `/proc/self/mountinfo` (shows the rogue ro/masked mounts)
//!   - dockerd's full stderr (shows the "ip_forward: read-only file
//!     system" failure when the race goes against dockerd)
//!
//! The outcome is *racy* — dockerd's network controller init either wins
//! the race against the tenant exec (rare; succeeds with two harmless
//! IPv6 RA warnings) or loses it (common; dies during
//! `failed to start daemon: Error initializing network controller`).
//!
//! Gated on `BOXLITE_DIND_DIAG=1`. Assertion-free — it just prints the
//! log so a follow-up libcontainer patch has a clear regression target.
//!
//! ## Proper fix (out of scope for PR #568)
//!
//! Patch `adapt_spec_for_tenant` to preserve `readonly_paths` and
//! `masked_paths` from `spec_linux`, OR submit an upstream PR to
//! youki/youki, OR vendor libcontainer behind `[patch.crates-io]` with
//! the ~6-line preservation patch.

use assert_cmd::Command;
use boxlite_test_utils::home::PerTestBoxHome;
use std::time::Duration;

const PROBE_SCRIPT: &str = r#"set +e
exec > /probe/result.log 2>&1
echo "[probe] launching dockerd with DEFAULT flags"
dockerd > /probe/dockerd.log 2>&1 &
DOCKERD_PID=$!
echo "[probe] dockerd pid: $DOCKERD_PID"
for i in $(seq 1 60); do
    [ -S /var/run/docker.sock ] && break
    if ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
        echo "[probe] dockerd exited at t=${i}s before socket appeared"
        break
    fi
    sleep 1
done
echo "[probe] /proc/self/mountinfo (proc/sys lines):"
grep -E ' /proc| /sys' /proc/self/mountinfo
echo
echo "[probe] ip link:"
ip link show
echo
echo "[probe] dockerd.log:"
cat /probe/dockerd.log
kill "$DOCKERD_PID" 2>/dev/null
wait "$DOCKERD_PID" 2>/dev/null
echo "[diag complete]"
"#;

#[test]
fn dind_diag_default_network_no_workaround() {
    if std::env::var("BOXLITE_DIND_DIAG").as_deref() != Ok("1") {
        eprintln!("SKIP dind_diag_default_network_no_workaround: set BOXLITE_DIND_DIAG=1 to run");
        return;
    }

    let tmp = tempfile::tempdir().expect("create tempdir");
    std::fs::write(tmp.path().join("probe.sh"), PROBE_SCRIPT).expect("write probe.sh");

    let home_dir = PerTestBoxHome::new();
    let mount = format!("{}:/probe", tmp.path().display());

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_boxlite"));
    cmd.timeout(Duration::from_secs(300))
        .arg("--home")
        .arg(&home_dir.path)
        .args([
            "run",
            "--rm",
            "--privileged",
            "--entrypoint",
            "sh",
            "--memory",
            "2048",
            "-v",
            &mount,
            "docker:dind",
            "/probe/probe.sh",
        ]);
    let _ = cmd.assert();

    let log = std::fs::read_to_string(tmp.path().join("result.log"))
        .unwrap_or_else(|e| panic!("probe never produced result.log: {}", e));
    eprintln!("=== /probe/result.log ===\n{}\n=== end ===", log);
    drop(home_dir);
}
