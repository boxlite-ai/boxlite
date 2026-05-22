//! Regression test: non-`--privileged` boxes preserve OCI default
//! hardening byte-for-byte (the companion to `dind_build.rs`, which
//! exercises the privileged path).
//!
//! What this pins:
//!   - `/proc/sys`, `/proc/bus`, `/proc/fs`, `/proc/irq` are ro
//!     bind+remounted on top of the base procfs (the standard OCI
//!     hardening libcontainer applies via `readonly_paths`).
//!   - The masked paths (`/proc/kcore`, `/proc/keys`, `/proc/timer_list`,
//!     `/sys/firmware`, ...) are overlaid with `/dev/null` or tmpfs
//!     (standard OCI `masked_paths`).
//!   - `/sys/fs/cgroup` is ro (the `--privileged` path remounts it rw
//!     for in-box dockerd; non-priv must not).
//!   - Writing `/proc/sys/net/ipv4/ip_forward` returns EROFS (proof
//!     that `BoxliteExecutor` did NOT undo the ro overlay — annotation
//!     `io.boxlite.privileged` is absent, executor skips the umount
//!     loop and delegates to `DefaultExecutor`).
//!   - `CAP_SYS_ADMIN` is NOT in the effective set (verified by trying
//!     `mount --bind` and expecting EPERM).
//!   - `CAP_NET_ADMIN` is NOT in the effective set (verified by trying
//!     `ip link add type dummy` and expecting EPERM).
//!   - The lean libkrunfw is selected, not the dind-capable one
//!     (verified by absence of `/proc/sys/net/bridge`, which only
//!     exists when `CONFIG_BRIDGE_NETFILTER=y` — only the dind kernel
//!     carries that).
//!
//! Failure here means something in the privileged / dind plumbing
//! leaked into the default path and weakened sandbox guarantees for
//! every existing user.

use std::time::Duration;

mod common;

const HARDENING_PROBE: &str = r#"set +e
echo "=== MOUNTINFO ==="
grep -E ' /proc| /sys' /proc/self/mountinfo
echo "=== END_MOUNTINFO ==="

echo "=== WRITABILITY ==="
echo "ip_forward_before=$(cat /proc/sys/net/ipv4/ip_forward 2>&1)"
err=$( (echo 1 > /proc/sys/net/ipv4/ip_forward) 2>&1 )
echo "ip_forward_write_err=$err"
echo "ip_forward_after=$(cat /proc/sys/net/ipv4/ip_forward 2>&1)"
echo "=== END_WRITABILITY ==="

echo "=== CAPS_SYSCALL_PROBES ==="
# CAP_SYS_ADMIN required for mount(2). Default cap set lacks it → EPERM.
mkdir -p /tmp/probe_a /tmp/probe_b
mount_err=$( (mount --bind /tmp/probe_a /tmp/probe_b) 2>&1 )
echo "mount_bind_err=$mount_err"
# CAP_NET_ADMIN required for RTM_NEWLINK. Default cap set lacks it → EPERM.
iplink_err=$( (ip link add dummytest type dummy) 2>&1 )
echo "ip_link_add_err=$iplink_err"
echo "=== END_CAPS_SYSCALL_PROBES ==="

echo "=== CAPS_STATUS ==="
grep -E '^Cap(Eff|Bnd|Prm):' /proc/self/status
echo "=== END_CAPS_STATUS ==="

echo "=== KERNEL_FEATURES ==="
if [ -d /proc/sys/net/bridge ]; then
    echo "bridge_dir=present"
else
    echo "bridge_dir=absent"
fi
echo "=== END_KERNEL_FEATURES ==="
"#;

/// Privileged "full" capability mask we explicitly disallow on non-priv.
/// The dind path uses `docker_capabilities()` which yields every Linux
/// capability the host kernel recognises; the printed `CapEff` is
/// `000001ffffffffff`. If we ever see that hex on a non-priv box, the
/// privileged cap set has leaked into the default path.
const PRIVILEGED_CAPEFF_HEX: &str = "000001ffffffffff";

#[test]
fn non_privileged_preserves_oci_default_hardening() {
    let mut ctx = common::boxlite();
    // 60s default is tight for image pull on cold caches; give it room.
    ctx.cmd.timeout(Duration::from_secs(180));
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", HARDENING_PROBE]);
    let assert = ctx.cmd.assert().success();
    let stdout = String::from_utf8_lossy(&assert.get_output().stdout).to_string();
    eprintln!("=== probe stdout ===\n{}\n=== end ===", stdout);

    // ── 1. Default readonly_paths applied ──────────────────────────────
    // The OCI default readonly_paths set is /proc/bus, /proc/fs, /proc/irq,
    // /proc/sys, /proc/sysrq-trigger. The first four reliably show up in
    // mountinfo; /proc/sysrq-trigger may be skipped via ENOENT on this
    // kernel, so we don't gate on it.
    for path in ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys"] {
        let needle = format!(" {} ro,", path);
        assert!(
            stdout.contains(&needle),
            "expected '{}' bind+remount-ro in mountinfo (OCI default \
             readonly_paths must be applied on non-priv boxes):\n{}",
            path,
            stdout
        );
    }

    // ── 2. /sys/fs/cgroup must stay ro on non-priv ─────────────────────
    // The privileged path remounts it rw so in-box dockerd can manage
    // cgroup limits. Default boxes must NOT get that relaxation.
    assert!(
        stdout.contains(" /sys/fs/cgroup ro,"),
        "expected /sys/fs/cgroup ro in mountinfo (only --privileged \
         must remount cgroup2 rw):\n{}",
        stdout
    );

    // ── 3. /sys/firmware masked with tmpfs ro (OCI default masked_paths) ─
    assert!(
        stdout.contains(" /sys/firmware ro,relatime - tmpfs "),
        "expected /sys/firmware masked with tmpfs ro (OCI default \
         masked_paths must be applied):\n{}",
        stdout
    );

    // ── 4. /proc/sys write fails with EROFS ────────────────────────────
    // The most user-visible proof that `BoxliteExecutor` correctly
    // skipped its umount path (annotation absent ⇒ no privileged
    // mitigation ⇒ libcontainer's ro overlay stays intact).
    assert!(
        stdout.contains("ip_forward_write_err=")
            && (stdout.contains("Read-only file system")
                || stdout.contains("read-only file system")),
        "expected EROFS writing /proc/sys/net/ipv4/ip_forward on non-priv:\n{}",
        stdout
    );
    assert!(
        stdout.contains("ip_forward_after=0"),
        "ip_forward value must remain 0 after a failed write attempt:\n{}",
        stdout
    );

    // ── 5. CAP_SYS_ADMIN absent (mount --bind ⇒ EPERM) ─────────────────
    // util-linux prints "Operation not permitted" on EPERM. busybox
    // mount prints "Permission denied" in some builds — accept either.
    assert!(
        stdout.contains("mount_bind_err=")
            && (stdout.contains("Operation not permitted")
                || stdout.contains("permission denied")
                || stdout.contains("Permission denied")),
        "expected EPERM on `mount --bind` (CAP_SYS_ADMIN must NOT be in \
         the default cap set):\n{}",
        stdout
    );

    // ── 6. CAP_NET_ADMIN absent (ip link add ⇒ EPERM/RTNETLINK error) ──
    // iproute2 sometimes phrases the error as "RTNETLINK answers:
    // Operation not permitted". Either surface is acceptable.
    assert!(
        stdout.contains("ip_link_add_err=")
            && (stdout.contains("Operation not permitted") || stdout.contains("RTNETLINK")),
        "expected EPERM on `ip link add` (CAP_NET_ADMIN must NOT be \
         in the default cap set):\n{}",
        stdout
    );

    // ── 7. Privileged full-cap mask must not have leaked ───────────────
    assert!(
        !stdout.contains(PRIVILEGED_CAPEFF_HEX),
        "non-priv box must NOT see the privileged full cap mask \
         ({}); something leaked the privileged cap set into the \
         default path:\n{}",
        PRIVILEGED_CAPEFF_HEX,
        stdout
    );

    // ── 8. Lean libkrunfw selected, not the dind kernel ────────────────
    // Only the dind kernel ships CONFIG_BRIDGE_NETFILTER, which creates
    // /proc/sys/net/bridge/. If it's there on a non-priv box, the per-box
    // libkrunfw selection logic in `src/boxlite/` has incorrectly
    // attached the fat blob to a default box.
    assert!(
        stdout.contains("bridge_dir=absent"),
        "/proc/sys/net/bridge must NOT exist on the lean libkrunfw \
         (only the dind kernel has CONFIG_BRIDGE_NETFILTER=y); \
         libkrunfw selection has leaked the dind blob to a non-priv \
         box:\n{}",
        stdout
    );
}
