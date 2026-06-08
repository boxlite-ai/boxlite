//! Integration test: a box's writable rootfs is a bounded, isolated disk.
//!
//! A box must not see or be able to exhaust the host filesystem, and filling
//! its own rootfs to ENOSPC must not take down the guest VM. boxlite sizes the
//! per-box ext4/qcow2 overlay from the image (a few hundred MB for alpine), far
//! below the host disk — so a runaway writer inside a box is capped at its own
//! image size, and the host blast radius is bounded by that, not the host's
//! free space.
//!
//! Requires a VM-capable host with network to pull `alpine`.

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

fn exec_sh(home: &Path, box_id: &str, script: &str, timeout: Duration) -> std::process::Output {
    boxlite(home, &["exec", box_id, "--", "sh", "-c", script], timeout)
}

/// Force-removes the box on drop so the `PerTestBoxHome` live-shim guard can't
/// fire and mask the real failure (declared after `home`, so it drops first).
struct BoxCleanup {
    home: std::path::PathBuf,
    id: String,
}
impl Drop for BoxCleanup {
    fn drop(&mut self) {
        let _ = boxlite(&self.home, &["rm", "-f", &self.id], Duration::from_secs(30));
    }
}

/// Start a detached 256 MB alpine box running `sleep 600`; returns its id.
fn start_box(home: &Path) -> String {
    let out = boxlite(
        home,
        &[
            "--registry",
            "docker.m.daocloud.io",
            "run",
            "-d",
            "--memory",
            "256",
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

/// Disk footprint (1K-blocks) of `path` and everything under it (via `du -sk`).
/// Used to verify that filling a box's rootfs really does grow the home dir on
/// the host and that `boxlite rm` releases that growth — du walks the actual
/// directory tree, so it isn't confused by FD-cached free space or filesystem
/// metadata noise the way `df` is.
fn home_du_kb(path: &Path) -> u64 {
    let out = std::process::Command::new("du")
        .arg("-sk")
        .arg(path)
        .output()
        .expect("spawn du");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("could not parse `du -sk` for {}", path.display()))
}

/// The box is healthy iff a fresh exec eventually succeeds. The agent may be
/// momentarily busy draining I/O after a heavy fill / inode storm, so retry
/// for up to 10 s — that buys reliability without hiding a truly wedged agent.
fn assert_alive(home: &Path, box_id: &str, ctx: &str) {
    let timeout = Duration::from_secs(10);
    let start = std::time::Instant::now();
    loop {
        let echo = boxlite(
            home,
            &["exec", box_id, "--", "echo", "alive"],
            Duration::from_secs(15),
        );
        if echo.status.success() {
            return;
        }
        if start.elapsed() >= timeout {
            panic!(
                "VM must stay alive {ctx}; exec still failing after {}s of retries; last stderr = {}",
                timeout.as_secs(),
                String::from_utf8_lossy(&echo.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// A box's rootfs is its own small disk (not the host's), and filling it to
/// ENOSPC leaves the VM alive and serving.
#[test]
fn box_rootfs_is_bounded_isolated_and_survives_fill() {
    let home = PerTestBoxHome::new();
    let out = boxlite(
        home.path.as_path(),
        &[
            "--registry",
            "docker.m.daocloud.io",
            "run",
            "-d",
            "--memory",
            "256",
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
    let box_id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // Isolation + bound: the box's `/` is its own ext4 (1K-blocks total), sized
    // from the image — far below the host disk. A box that saw the host fs would
    // report tens of millions of 1K-blocks (e.g. a 124 GiB host ≈ 130M blocks).
    let df = exec_sh(
        home.path.as_path(),
        &box_id,
        "df -P / | awk 'NR==2{print $2}'", // 1K-blocks total of the rootfs
        Duration::from_secs(20),
    );
    let total_kb: u64 = String::from_utf8_lossy(&df.stdout)
        .trim()
        .parse()
        .unwrap_or_else(|_| {
            panic!(
                "could not read box rootfs size: {:?}",
                String::from_utf8_lossy(&df.stdout)
            )
        });
    // Lower bound 50 MiB rules out an empty/uninitialised mount; upper bound
    // 2 GiB still discriminates the host fs (a 124 GiB host ≈ 130M blocks)
    // while being tight enough to flag a regression that lets the rootfs grow
    // far past the documented "few hundred MB" image-derived sizing.
    assert!(
        (50 * 1024..2 * 1024 * 1024).contains(&total_kb),
        "box rootfs must be its own bounded disk (~few hundred MB), not the host fs \
         and not a runaway image sizing; got {total_kb} 1K-blocks (~{} MiB)",
        total_kb / 1024
    );

    // Fill the rootfs: the write must hit ENOSPC, not hang or wander onto the
    // host disk. `dd` reports "No space left on device" on the bounded ext4.
    let fill = exec_sh(
        home.path.as_path(),
        &box_id,
        "dd if=/dev/zero of=/fill bs=1M 2>&1; true",
        Duration::from_secs(120),
    );
    let fill_out = String::from_utf8_lossy(&fill.stdout) + String::from_utf8_lossy(&fill.stderr);
    assert!(
        fill_out.contains("No space left"),
        "filling the rootfs must hit ENOSPC (bounded disk), got:\n{fill_out}"
    );

    // The VM survives a full rootfs: still Running and accepting exec.
    let list = boxlite(home.path.as_path(), &["list"], Duration::from_secs(15));
    assert!(
        String::from_utf8_lossy(&list.stdout).contains("Running"),
        "VM must stay Running after its rootfs fills; `list` =\n{}",
        String::from_utf8_lossy(&list.stdout)
    );
    let echo = boxlite(
        home.path.as_path(),
        &["exec", &box_id, "--", "echo", "alive"],
        Duration::from_secs(15),
    );
    assert!(
        echo.status.success(),
        "guest agent must accept exec after the rootfs fills; stderr = {}",
        String::from_utf8_lossy(&echo.stderr)
    );

    // ENOSPC is a *write* error — reading pre-existing files must still work.
    // A regression that remounts the rootfs read-only or panics on read would
    // pass the bare echo probe but fail here.
    let read_old = exec_sh(
        home.path.as_path(),
        &box_id,
        "cat /etc/alpine-release",
        Duration::from_secs(15),
    );
    assert!(
        read_old.status.success() && !read_old.stdout.is_empty(),
        "pre-existing files must remain readable after the rootfs fills; \
         cat /etc/alpine-release stderr = {}",
        String::from_utf8_lossy(&read_old.stderr)
    );

    // `/tmp` is a tmpfs (a separate, RAM-backed resource pool) — filling the
    // rootfs must not poison it. A regression that mounted tmpfs *under* the
    // rootfs limit, or that the VM kernel started serializing all I/O when one
    // mount went ENOSPC, would fail this.
    let write_tmpfs = exec_sh(
        home.path.as_path(),
        &box_id,
        "echo tmpfs-still-writes > /tmp/probe && cat /tmp/probe",
        Duration::from_secs(15),
    );
    assert!(
        String::from_utf8_lossy(&write_tmpfs.stdout).contains("tmpfs-still-writes"),
        "tmpfs (/tmp) must still accept writes after the rootfs (a different \
         resource pool) fills; stderr = {}",
        String::from_utf8_lossy(&write_tmpfs.stderr)
    );
}

/// Two boxes own independent rootfs disks: filling one to ENOSPC must not
/// shrink the other or stop it serving. "self-bounded" (above) plus this
/// "isolated from peers" check is what makes a box's disk a real per-box
/// resource boundary, not a shared pool.
#[test]
fn two_boxes_rootfs_disks_are_isolated() {
    let home = PerTestBoxHome::new();
    let victim = start_box(home.path.as_path());
    let _victim_cleanup = BoxCleanup {
        home: home.path.clone(),
        id: victim.clone(),
    };
    let bystander = start_box(home.path.as_path());
    let _bystander_cleanup = BoxCleanup {
        home: home.path.clone(),
        id: bystander.clone(),
    };

    // Record the bystander's free space before the victim runs amok.
    let avail = |box_id: &str| -> u64 {
        let out = exec_sh(
            home.path.as_path(),
            box_id,
            "df -P / | awk 'NR==2{print $4}'", // 1K-blocks available
            Duration::from_secs(20),
        );
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or_else(|_| {
                panic!(
                    "could not read free space for {box_id}: {:?}",
                    String::from_utf8_lossy(&out.stdout)
                )
            })
    };
    let bystander_free_before = avail(&bystander);

    // The victim fills its own rootfs to ENOSPC.
    let fill = exec_sh(
        home.path.as_path(),
        &victim,
        "dd if=/dev/zero of=/fill bs=1M 2>&1; true",
        Duration::from_secs(120),
    );
    let fill_out = String::from_utf8_lossy(&fill.stdout) + String::from_utf8_lossy(&fill.stderr);
    assert!(
        fill_out.contains("No space left"),
        "victim rootfs must fill to ENOSPC, got:\n{fill_out}"
    );

    // The bystander is untouched: a separate disk keeps essentially all its free
    // space (allow a small slack for its own logging) and still accepts writes.
    let bystander_free_after = avail(&bystander);
    assert!(
        bystander_free_after + 4096 >= bystander_free_before,
        "bystander free space must not shrink when a peer box fills its disk: \
         {bystander_free_before} KB before vs {bystander_free_after} KB after"
    );
    let write = exec_sh(
        home.path.as_path(),
        &bystander,
        "echo isolated > /probe && cat /probe",
        Duration::from_secs(20),
    );
    assert!(
        String::from_utf8_lossy(&write.stdout).contains("isolated"),
        "bystander box must still accept writes after a peer filled its disk; stderr = {}",
        String::from_utf8_lossy(&write.stderr)
    );

    // Both VMs survive.
    assert_alive(home.path.as_path(), &victim, "after filling its own rootfs");
    assert_alive(
        home.path.as_path(),
        &bystander,
        "while a peer box filled its disk",
    );
}

/// Concurrent writers in the *same* box: when several `dd` processes race to
/// fill the rootfs, every one of them must see a clean `No space left on
/// device` (no hangs, no silent partial success, no corruption that the VM
/// can't recover from), and the VM must stay alive. Guards against a bug
/// where one writer hitting ENOSPC could deadlock or wedge the rootfs for the
/// others — e.g. a stuck journal commit, an EXT4 lock pile-up, or a guest
/// agent that dies on the I/O storm.
#[test]
fn concurrent_writers_all_hit_enospc_and_vm_survives() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // Spawn N writers in parallel, each filling its own file. The shell waits
    // for all of them, then dumps every writer's stderr — so the aggregated
    // stdout carries exactly one ENOSPC message per writer if the rootfs
    // serialized them cleanly. Capture per-writer rc too, so a writer that
    // exited silently (not ENOSPC) shows up loudly.
    const N: u32 = 6;
    let script = format!(
        "for i in $(seq 1 {N}); do \
           ( dd if=/dev/zero of=/fill$i bs=1M 2>/tmp/dd-$i.err; \
             echo \"RC=$? FILE=/fill$i\" >>/tmp/dd-$i.err ) & \
         done; wait; \
         for i in $(seq 1 {N}); do \
           echo \"--- writer $i ---\"; cat /tmp/dd-$i.err; \
         done"
    );
    let out = exec_sh(
        home.path.as_path(),
        &box_id,
        &script,
        Duration::from_secs(180),
    );
    let stdout = String::from_utf8_lossy(&out.stdout);

    // Every writer must hit ENOSPC. `dd` prints exactly one "No space left on
    // device" per writer when the rootfs is full; ≥ N occurrences proves every
    // one was rejected by the bounded ext4 rather than hanging or silently
    // succeeding.
    let enospc = stdout.matches("No space left").count();
    assert!(
        enospc >= N as usize,
        "every one of the {N} concurrent writers must hit ENOSPC; saw {enospc} \
         ENOSPC messages\n{stdout}"
    );

    // Every writer must have exited non-zero (dd returns 1 on write error).
    // RC=0 would mean a writer somehow succeeded with the disk full.
    let rc_zero = stdout.matches("RC=0 ").count();
    assert_eq!(
        rc_zero, 0,
        "no concurrent writer may exit RC=0 while the rootfs is full;\n{stdout}"
    );

    // The VM and the guest agent survive the concurrent I/O storm + ENOSPC.
    assert_alive(
        home.path.as_path(),
        &box_id,
        "after a concurrent fill of the rootfs",
    );
}

/// Inode exhaustion is a separate resource axis from block exhaustion: ext4
/// reserves a fixed number of inodes at mkfs time, and mass-creating empty
/// files runs out of *those* (different code path from `dd`-style block
/// fill). The VM must still survive and pre-existing files must remain
/// readable.
#[test]
fn rootfs_inode_exhaustion_keeps_vm_alive_and_old_files_readable() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // Mass-touch until the loop fails — record how many got through. A loop
    // that finished without failing (created == hard cap) means the rootfs
    // wasn't actually exhausted, so the assertion below catches that too.
    let script = "mkdir -p /inotest && cd /inotest && \
        i=0; while touch f$i 2>/tmp/last.err; do i=$((i+1)); \
            if [ $i -gt 500000 ]; then echo 'exceeded safety cap'; break; fi; \
        done; \
        echo created=$i; echo last_err=$(cat /tmp/last.err)";
    let out = exec_sh(
        home.path.as_path(),
        &box_id,
        script,
        Duration::from_secs(180),
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let created: u64 = stdout
        .lines()
        .find_map(|l| l.strip_prefix("created=").and_then(|n| n.parse().ok()))
        .unwrap_or_else(|| panic!("expected `created=N`; got\n{stdout}"));
    assert!(
        created > 100,
        "must create enough files for the exhaustion to be a real one \
         (created={created})\n{stdout}"
    );
    assert!(
        !stdout.contains("exceeded safety cap"),
        "loop must terminate via exhaustion, not the test safety cap (means \
         rootfs has more inodes than expected — test is no longer probing the \
         exhaustion path)\n{stdout}"
    );

    // VM still serving exec.
    assert_alive(home.path.as_path(), &box_id, "after inode exhaustion");

    // Pre-existing files remain readable (the rootfs didn't go read-only or
    // hard-fault).
    let read_old = exec_sh(
        home.path.as_path(),
        &box_id,
        "cat /etc/alpine-release",
        Duration::from_secs(15),
    );
    assert!(
        read_old.status.success() && !read_old.stdout.is_empty(),
        "pre-existing files must remain readable after inode exhaustion; \
         stderr = {}",
        String::from_utf8_lossy(&read_old.stderr)
    );
}

/// `boxlite rm` must release the host disk space the box's qcow2 overlay grew
/// to during a fill. A regression that leaks the overlay file would silently
/// accumulate host disk usage across box churn — the host disk-space guard in
/// #618 would eventually trip, but the leak itself would be invisible.
#[test]
fn rm_after_fill_releases_host_disk_space() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    // Safety-net cleanup if the explicit rm below panics; idempotent.
    let _safety = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    let pre_fill = home_du_kb(home.path.as_path());

    let fill = exec_sh(
        home.path.as_path(),
        &box_id,
        "dd if=/dev/zero of=/fill bs=1M 2>&1; true",
        Duration::from_secs(120),
    );
    let fill_out = String::from_utf8_lossy(&fill.stdout) + String::from_utf8_lossy(&fill.stderr);
    assert!(
        fill_out.contains("No space left"),
        "fill must hit ENOSPC, got:\n{fill_out}"
    );

    let post_fill = home_du_kb(home.path.as_path());
    let consumed = post_fill.saturating_sub(pre_fill);
    assert!(
        consumed >= 50 * 1024,
        "filling a box rootfs must grow the home directory on the host \
         (qcow2 overlay growth); pre_fill={pre_fill} KB post_fill={post_fill} KB \
         (grew only {consumed} KB)"
    );

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

    // Poll briefly — boxlite may do async file removal; the test cares about
    // "is the space eventually released", not "is it released the exact
    // instant rm returns". A leaked qcow2 will never shrink.
    let target_residual = consumed / 10; // ≤10% of growth still present = released
    let timeout = Duration::from_secs(30);
    let start = std::time::Instant::now();
    let mut post_rm = post_fill;
    while start.elapsed() < timeout {
        post_rm = home_du_kb(home.path.as_path());
        let still = post_rm.saturating_sub(pre_fill);
        if still <= target_residual {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let still_consumed = post_rm.saturating_sub(pre_fill);
    assert!(
        still_consumed <= target_residual,
        "rm must release ≥90% of the host-disk growth from the fill within {}s; \
         pre_fill={pre_fill} KB post_fill={post_fill} KB (consumed {consumed}); \
         post_rm={post_rm} KB → still_consumed={still_consumed} KB (target ≤ {target_residual})",
        timeout.as_secs()
    );
}

/// A full rootfs must not be a startup-blocking condition: an operator who
/// hit ENOSPC inside a box should be able to `stop` and `start` it cleanly
/// to investigate, with the box's filesystem state preserved across the cycle.
#[test]
fn box_restarts_cleanly_with_full_rootfs() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // Fill the rootfs and drop a marker inside.
    let fill = exec_sh(
        home.path.as_path(),
        &box_id,
        "dd if=/dev/zero of=/fill bs=1M 2>&1; true; echo marker > /root/marker || true",
        Duration::from_secs(120),
    );
    let fill_out = String::from_utf8_lossy(&fill.stdout) + String::from_utf8_lossy(&fill.stderr);
    assert!(
        fill_out.contains("No space left"),
        "initial fill must hit ENOSPC"
    );

    let stop = boxlite(
        home.path.as_path(),
        &["stop", &box_id],
        Duration::from_secs(60),
    );
    assert!(
        stop.status.success(),
        "stop with full rootfs failed: {}",
        String::from_utf8_lossy(&stop.stderr)
    );

    let start = boxlite(
        home.path.as_path(),
        &["start", &box_id],
        Duration::from_secs(180),
    );
    assert!(
        start.status.success(),
        "start with full rootfs failed: {}",
        String::from_utf8_lossy(&start.stderr)
    );

    // The /fill file (and the marker) must persist across stop/start.
    let ls = exec_sh(
        home.path.as_path(),
        &box_id,
        "ls -l /fill",
        Duration::from_secs(15),
    );
    assert!(
        ls.status.success(),
        "/fill must persist across stop/start; stderr = {}",
        String::from_utf8_lossy(&ls.stderr)
    );

    // The rootfs is still full — new writes still hit ENOSPC.
    let retry = exec_sh(
        home.path.as_path(),
        &box_id,
        "dd if=/dev/zero of=/fill2 bs=1M count=1 2>&1; true",
        Duration::from_secs(30),
    );
    let retry_out = String::from_utf8_lossy(&retry.stdout) + String::from_utf8_lossy(&retry.stderr);
    assert!(
        retry_out.contains("No space left"),
        "after restart, a full rootfs must still report ENOSPC on new writes; \
         got:\n{retry_out}"
    );

    assert_alive(
        home.path.as_path(),
        &box_id,
        "after restarting with a full rootfs",
    );
}

/// A peer box filling its disk must not slow or stall a bystander box that is
/// *actively writing*. The earlier `two_boxes_rootfs_disks_are_isolated` test
/// has an idle bystander; this one runs a background appender in the bystander
/// throughout the victim's fill and asserts the appender kept progressing.
#[test]
fn bystander_writes_keep_progressing_while_peer_fills_its_disk() {
    let home = PerTestBoxHome::new();
    let victim = start_box(home.path.as_path());
    let _vc = BoxCleanup {
        home: home.path.clone(),
        id: victim.clone(),
    };
    let bystander = start_box(home.path.as_path());
    let _bc = BoxCleanup {
        home: home.path.clone(),
        id: bystander.clone(),
    };

    // Start a background appender in the bystander (one line per ~100 ms).
    let _ = exec_sh(
        home.path.as_path(),
        &bystander,
        "mkdir -p /work && \
         ( while true; do echo tick >> /work/log; sleep 0.1; done ) </dev/null >/dev/null 2>&1 & \
         echo $! > /tmp/loop.pid",
        Duration::from_secs(15),
    );

    // Let the loop settle, then snapshot.
    std::thread::sleep(Duration::from_secs(1));
    let line_count = |id: &str| -> u64 {
        let out = exec_sh(
            home.path.as_path(),
            id,
            "wc -l < /work/log",
            Duration::from_secs(15),
        );
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0)
    };
    let before = line_count(&bystander);

    // Victim fills its rootfs.
    let fill = exec_sh(
        home.path.as_path(),
        &victim,
        "dd if=/dev/zero of=/fill bs=1M 2>&1; true",
        Duration::from_secs(120),
    );
    let fill_out = String::from_utf8_lossy(&fill.stdout) + String::from_utf8_lossy(&fill.stderr);
    assert!(
        fill_out.contains("No space left"),
        "victim fill must hit ENOSPC"
    );

    let after = line_count(&bystander);

    // Stop the loop before doing anything else.
    let _ = exec_sh(
        home.path.as_path(),
        &bystander,
        "kill $(cat /tmp/loop.pid) 2>/dev/null; true",
        Duration::from_secs(10),
    );

    assert!(
        after > before + 5,
        "bystander's background writer must keep progressing during a peer's \
         fill — at least a handful of new lines should land in /work/log; \
         before={before} after={after}"
    );

    assert_alive(home.path.as_path(), &victim, "after filling its own rootfs");
    assert_alive(
        home.path.as_path(),
        &bystander,
        "while a peer box filled its disk",
    );
}

/// A fill → delete → fill cycle inside one box must not roughly double the
/// box's host-side qcow2 overlay. qcow2 grows monotonically as clusters are
/// dirtied unless discard / unmap is plumbed end-to-end (ext4 → virtio-blk →
/// qcow2), so a regression that drops discard would silently leak the first
/// fill's worth of host disk on every churn cycle.
#[test]
fn rootfs_fill_delete_fill_does_not_double_qcow2_footprint() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    let pre = home_du_kb(home.path.as_path());

    // Round 1: fill to ENOSPC, then delete the fill file + sync to push the
    // discard request (if the stack supports it) downwards.
    let fill1 = exec_sh(
        home.path.as_path(),
        &box_id,
        "dd if=/dev/zero of=/fill bs=1M 2>&1; true",
        Duration::from_secs(120),
    );
    let fill1_out = String::from_utf8_lossy(&fill1.stdout) + String::from_utf8_lossy(&fill1.stderr);
    assert!(
        fill1_out.contains("No space left"),
        "round-1 fill must hit ENOSPC"
    );
    let after_first = home_du_kb(home.path.as_path());
    let grew = after_first.saturating_sub(pre);
    assert!(
        grew >= 50 * 1024,
        "round-1 fill must visibly grow the host qcow2 footprint; \
         pre={pre} after_first={after_first} (grew {grew} KB)"
    );

    let _ = exec_sh(
        home.path.as_path(),
        &box_id,
        "rm -f /fill && sync",
        Duration::from_secs(30),
    );

    // Round 2: fill again. With discard / unmap working, qcow2 can reuse the
    // freed clusters and the host footprint should not roughly double.
    let fill2 = exec_sh(
        home.path.as_path(),
        &box_id,
        "dd if=/dev/zero of=/fill bs=1M 2>&1; true",
        Duration::from_secs(120),
    );
    let fill2_out = String::from_utf8_lossy(&fill2.stdout) + String::from_utf8_lossy(&fill2.stderr);
    assert!(
        fill2_out.contains("No space left"),
        "round-2 fill must hit ENOSPC"
    );
    let after_second = home_du_kb(home.path.as_path());

    // Cap at pre + 1.6 × first-fill growth (60% slack for qcow2 metadata + ext4
    // journal noise). Anything near 2× = discard is not propagating; the box's
    // churn would leak host disk forever.
    let upper = pre + (grew * 16) / 10;
    assert!(
        after_second <= upper,
        "fill→delete→fill must not balloon the qcow2 to ≈2× the single-fill size; \
         pre={pre} KB after_first={after_first} (grew {grew}); \
         after_second={after_second} (upper bound {upper}). \
         This usually means discard / unmap is not propagating through the stack."
    );
}

/// Inode exhaustion and block exhaustion are independent ENOSPC paths. After
/// mass-touch exhausts the rootfs's inodes, appending to a pre-existing file
/// (which needs new data blocks, not a new inode) must still succeed — a
/// regression that conflated the two error paths would reject this write too
/// and silently break workloads that hold a fixed set of log files.
#[test]
fn rootfs_inode_exhaustion_does_not_block_appending_to_existing_files() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    let setup = exec_sh(
        home.path.as_path(),
        &box_id,
        "echo initial > /persistent.log && \
         mkdir -p /inotest && cd /inotest && \
         i=0; while touch f$i 2>/dev/null; do \
             i=$((i+1)); \
             if [ $i -gt 500000 ]; then echo 'safety cap'; break; fi; \
         done; \
         echo created=$i",
        Duration::from_secs(180),
    );
    let setup_out = String::from_utf8_lossy(&setup.stdout);
    let created: u64 = setup_out
        .lines()
        .find_map(|l| l.strip_prefix("created=").and_then(|n| n.parse().ok()))
        .unwrap_or_else(|| panic!("setup script must report created=N; got\n{setup_out}"));
    assert!(
        created > 100 && !setup_out.contains("safety cap"),
        "inode exhaustion must actually run to completion (created={created})\n{setup_out}"
    );

    // Appending to /persistent.log uses no new inodes — it must succeed.
    let append = exec_sh(
        home.path.as_path(),
        &box_id,
        "echo appended >> /persistent.log && cat /persistent.log",
        Duration::from_secs(15),
    );
    let stdout = String::from_utf8_lossy(&append.stdout);
    assert!(
        append.status.success() && stdout.contains("initial") && stdout.contains("appended"),
        "appending to a pre-existing file after inode exhaustion must succeed; \
         exit_ok={} stdout={stdout:?} stderr={}",
        append.status.success(),
        String::from_utf8_lossy(&append.stderr)
    );

    assert_alive(
        home.path.as_path(),
        &box_id,
        "after inode-exhaustion + append-to-existing",
    );
}

/// The user-visible recovery story: an operator who hit ENOSPC inside a box
/// can `rm` the offending file (a pure metadata op — works even when blocks
/// are 100 % consumed because the directory blocks are already allocated and
/// the journal is pre-reserved) and immediately get the box back to a writable
/// state. The companion `fill_delete_fill_does_not_double_qcow2_footprint`
/// asserts the same at the *host* qcow2 layer; this one pins the *in-box*
/// `df` view + write-resumption that a real operator actually sees.
#[test]
fn rm_after_fill_recovers_in_box_free_space_and_writes_resume() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    let avail = || -> u64 {
        let out = exec_sh(
            home.path.as_path(),
            &box_id,
            "df -P / | awk 'NR==2{print $4}'",
            Duration::from_secs(15),
        );
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or_else(|_| {
                panic!(
                    "unparseable df output: {:?}",
                    String::from_utf8_lossy(&out.stdout)
                )
            })
    };

    let before = avail();
    assert!(
        before > 50 * 1024,
        "box should start with substantial free space (>50 MiB); got {before} KB"
    );

    // Fill to ENOSPC.
    let fill = exec_sh(
        home.path.as_path(),
        &box_id,
        "dd if=/dev/zero of=/fill bs=1M 2>&1; true",
        Duration::from_secs(120),
    );
    let fill_out = String::from_utf8_lossy(&fill.stdout) + String::from_utf8_lossy(&fill.stderr);
    assert!(
        fill_out.contains("No space left"),
        "fill must hit ENOSPC, got:\n{fill_out}"
    );
    let when_full = avail();
    assert!(
        when_full < 1024,
        "after fill, in-box df Available must be ~0; got {when_full} KB"
    );

    // The whole point: `rm` is a pure metadata op (dir-entry write into an
    // already-allocated block, no new block allocation), so it succeeds even
    // when df Available = 0.
    let rm = exec_sh(
        home.path.as_path(),
        &box_id,
        "rm /fill && sync",
        Duration::from_secs(30),
    );
    assert!(
        rm.status.success(),
        "rm /fill on a 100%-full rootfs must succeed (metadata-only op); \
         stderr = {}",
        String::from_utf8_lossy(&rm.stderr)
    );

    // Available recovers to ≈ pre-fill within 5 MiB slack.
    let after_rm = avail();
    assert!(
        after_rm + 5 * 1024 >= before,
        "rm + sync must recover the in-box free space; \
         before={before} KB, when_full={when_full} KB, after_rm={after_rm} KB"
    );

    // And new writes work again — the user-visible "back to normal" signal.
    let write = exec_sh(
        home.path.as_path(),
        &box_id,
        "echo recovered > /probe && cat /probe",
        Duration::from_secs(15),
    );
    let stdout = String::from_utf8_lossy(&write.stdout);
    assert!(
        stdout.contains("recovered"),
        "writes must succeed again after rm + sync; stdout = {stdout:?} stderr = {}",
        String::from_utf8_lossy(&write.stderr)
    );
}

/// Three back-to-back fill → rm cycles, then verify the box is still
/// "serving normally". The single-cycle test pins the first recovery; this
/// one catches regressions that only surface after repeated churn — agent
/// fd / handle leaks per cycle, ext4 journal exhaustion, qcow2 metadata
/// growth, or any state the cgroup / mount layer accumulates per fill.
#[test]
fn three_fill_delete_cycles_leave_the_box_serving_normally() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    let avail = || -> u64 {
        let out = exec_sh(
            home.path.as_path(),
            &box_id,
            "df -P / | awk 'NR==2{print $4}'",
            Duration::from_secs(15),
        );
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or_else(|_| {
                panic!(
                    "unparseable df output: {:?}",
                    String::from_utf8_lossy(&out.stdout)
                )
            })
    };

    let pre = avail();
    assert!(
        pre > 50 * 1024,
        "box should start with substantial free space; got {pre} KB"
    );

    for cycle in 1..=3u32 {
        let fill = exec_sh(
            home.path.as_path(),
            &box_id,
            "dd if=/dev/zero of=/fill bs=1M 2>&1; true",
            Duration::from_secs(120),
        );
        let out = String::from_utf8_lossy(&fill.stdout) + String::from_utf8_lossy(&fill.stderr);
        assert!(
            out.contains("No space left"),
            "cycle {cycle}: fill must hit ENOSPC, got:\n{out}"
        );
        let when_full = avail();
        assert!(
            when_full < 1024,
            "cycle {cycle}: after fill, in-box available must be ~0; got {when_full} KB"
        );

        let rm = exec_sh(
            home.path.as_path(),
            &box_id,
            "rm /fill && sync",
            Duration::from_secs(30),
        );
        assert!(
            rm.status.success(),
            "cycle {cycle}: rm /fill must succeed on a full rootfs; stderr = {}",
            String::from_utf8_lossy(&rm.stderr)
        );

        let after_rm = avail();
        assert!(
            after_rm + 5 * 1024 >= pre,
            "cycle {cycle}: rm must recover free space to ≈ pre-fill; \
             pre={pre} KB after_rm={after_rm} KB"
        );
    }

    // After 3 cycles the box is "serving normally" iff:
    //  - liveness probe passes (agent accepting exec)
    //  - pre-existing files still readable
    //  - a new small write succeeds (rootfs healthy)
    //  - tmpfs still works (separate resource pool wasn't poisoned)
    assert_alive(home.path.as_path(), &box_id, "after 3 fill/delete cycles");

    let read = exec_sh(
        home.path.as_path(),
        &box_id,
        "cat /etc/alpine-release",
        Duration::from_secs(15),
    );
    assert!(
        read.status.success() && !read.stdout.is_empty(),
        "pre-existing files must remain readable after 3 fill/delete cycles; stderr = {}",
        String::from_utf8_lossy(&read.stderr)
    );

    let write = exec_sh(
        home.path.as_path(),
        &box_id,
        "echo healthy > /probe && cat /probe",
        Duration::from_secs(15),
    );
    assert!(
        String::from_utf8_lossy(&write.stdout).contains("healthy"),
        "new writes to rootfs must work after 3 fill/delete cycles; stderr = {}",
        String::from_utf8_lossy(&write.stderr)
    );

    let tmpfs = exec_sh(
        home.path.as_path(),
        &box_id,
        "echo tmpfs > /tmp/probe && cat /tmp/probe",
        Duration::from_secs(15),
    );
    assert!(
        String::from_utf8_lossy(&tmpfs.stdout).contains("tmpfs"),
        "tmpfs (/tmp) must remain functional after 3 fill/delete cycles"
    );
}

/// Box rootfs is bounded against a *host-driven* fill too — `boxlite cp`
/// of an oversized host file into the box must hit ENOSPC, surface the
/// failure as exit≠0, leave the box alive, and **not** grow the host
/// qcow2 past the rootfs cap.
///
/// The earlier `box_rootfs_is_bounded_isolated_and_survives_fill` covers
/// the in-box-write path (`dd`); this one exercises the orthogonal CLI
/// path through `boxlite cp` → tar over vsock → guest extract. A
/// regression where the CLI buffered the whole tar to host `/tmp`, or
/// the guest agent staged it on a tmpfs that quietly filled to ENOSPC
/// with `exit 0`, or the tar extractor left a wedged half-written file,
/// would be invisible to the `dd` test but caught here.
#[test]
fn box_rootfs_is_bounded_against_host_cp_fill() {
    let home = PerTestBoxHome::new();
    let box_id = start_box(home.path.as_path());
    let _cleanup = BoxCleanup {
        home: home.path.clone(),
        id: box_id.clone(),
    };

    // Read the box's rootfs free space so the host file we craft is
    // unambiguously larger than what the rootfs can hold. Using 2x free
    // gives a healthy margin even if the box has unusual prefill.
    let avail_kb: u64 = {
        let out = exec_sh(
            home.path.as_path(),
            &box_id,
            "df -P / | awk 'NR==2{print $4}'",
            Duration::from_secs(20),
        );
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or_else(|_| {
                panic!(
                    "could not read box rootfs free: {:?}",
                    String::from_utf8_lossy(&out.stdout)
                )
            })
    };
    let oversized_bytes = (avail_kb as usize).saturating_mul(1024).saturating_mul(2);
    assert!(
        oversized_bytes > 16 * 1024 * 1024,
        "box rootfs free must be at least a few MiB so the host source \
         comfortably exceeds it; got {avail_kb} KiB free"
    );

    // Host source: a file of zeros, 2x the box rootfs free. Lives under
    // the per-test home so the test doesn't pollute the system /tmp.
    let src = home.path.join("oversized.bin");
    {
        use std::fs::File;
        use std::io::{BufWriter, Write};
        // Stream-write — a Vec<u8> of this size would balloon test RAM.
        let f = File::create(&src).expect("create oversized source");
        let mut w = BufWriter::new(f);
        let chunk = vec![0u8; 4 * 1024 * 1024];
        let mut remaining = oversized_bytes;
        while remaining > 0 {
            let n = remaining.min(chunk.len());
            w.write_all(&chunk[..n]).expect("write source");
            remaining -= n;
        }
        w.flush().expect("flush source");
    }

    // Host disk usage right before the cp — anything beyond this delta
    // is host blast radius we couldn't keep contained.
    let pre = home_du_kb(home.path.as_path());

    // The actual probe: cp the oversized file into the box.
    let dst_in_box = format!("{}:/oversized.bin", box_id);
    let cp = boxlite(
        home.path.as_path(),
        &["cp", src.to_str().unwrap(), dst_in_box.as_str()],
        Duration::from_secs(180),
    );

    // Failure must be visible. A regression that silently truncated +
    // exited 0, or that hung past the 180 s deadline, fails here.
    let stderr = String::from_utf8_lossy(&cp.stderr);
    let stdout = String::from_utf8_lossy(&cp.stdout);
    assert!(
        !cp.status.success(),
        "boxlite cp of an oversized file must exit non-zero on rootfs ENOSPC; \
         stdout = {stdout:?} stderr = {stderr:?}"
    );

    // The box itself must still be alive — a regression that wedged the
    // guest agent on a half-written file (stale tmpfs, hung tar reader,
    // ext4 lock pile-up) would fail this probe.
    assert_alive(home.path.as_path(), &box_id, "after a failed host->box cp");

    // The host blast radius is the central invariant. The rootfs cap
    // (read above as avail_kb) is the most the box can possibly consume
    // on the host; we give a healthy margin (2x avail + 8 MiB slack)
    // because tar metadata + ext4 journal can charge a few MiB beyond
    // the file bytes themselves. A regression where the CLI cached the
    // tar to host /tmp would blow this assertion by the full source
    // size (~2x avail).
    let post = home_du_kb(home.path.as_path());
    let delta_kb = post.saturating_sub(pre);
    let cap_kb = avail_kb * 2 + 8 * 1024;
    assert!(
        delta_kb <= cap_kb,
        "host blast radius must be bounded by the box rootfs cap, not the \
         source file size; pre={pre} post={post} delta={delta_kb} KiB, \
         cap (~2x rootfs free + 8 MiB slack)={cap_kb} KiB"
    );
}
