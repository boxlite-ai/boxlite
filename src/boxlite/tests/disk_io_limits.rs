//! Integration tests for disk I/O rate limits (`BoxOptions::disk_io`).
//!
//! The limits are written to the box's cgroup v2 `io.max` on Linux. Whether
//! that can happen depends on the host: root sees the `io` controller, a
//! rootless session only if systemd delegated it. The suite therefore has two
//! legs and runs whichever the host supports:
//!
//! - `io` available → the box's cgroup carries the requested line and a
//!   flushed write inside the guest is measurably slower than the unthrottled
//!   baseline;
//! - `io` unavailable → the limits degrade to a warning and the box still
//!   starts (the documented warn-and-continue contract).
//!
//! Run with:
//!
//! ```sh
//! cargo test -p boxlite --features krun,gvproxy --test disk_io_limits -- --nocapture
//! ```

#![cfg(target_os = "linux")]

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use boxlite::runtime::options::{BoxOptions, DiskIoLimits, RootfsSpec};
use common::box_test::BoxTestBase;

const WRITE_BPS: u64 = 4 * 1024 * 1024;

fn throttled_opts() -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_delete: Some(0),
        disk_io: Some(DiskIoLimits {
            write_bps: Some(WRITE_BPS),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Where `jailer::cgroup` puts box cgroups, recomputed here because the module
/// is crate-private: `/sys/fs/cgroup` as root, the user's systemd service
/// otherwise.
fn cgroup_base() -> PathBuf {
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    if uid == 0 {
        PathBuf::from("/sys/fs/cgroup")
    } else {
        PathBuf::from(format!(
            "/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service"
        ))
    }
}

fn io_controller_available() -> bool {
    std::fs::read_to_string(cgroup_base().join("cgroup.controllers"))
        .map(|s| s.split_whitespace().any(|c| c == "io"))
        .unwrap_or(false)
}

/// Time a 32 MiB direct, flushed write inside the guest. A box with limits
/// opens its disks with O_DIRECT, so each guest write reaches the host block
/// layer as it happens; `conv=fsync` keeps the measurement honest for the
/// unthrottled baseline, whose disks are buffered.
async fn timed_flushed_write(t: &BoxTestBase) -> Duration {
    let started = Instant::now();
    t.exec_stdout(
        "dd",
        &[
            "if=/dev/zero",
            "of=/root/disk-io-probe",
            "bs=1M",
            "count=32",
            "oflag=direct",
            "conv=fsync",
        ],
    )
    .await;
    started.elapsed()
}

/// With the `io` controller available, the requested limit must land in the
/// box cgroup's `io.max` — as a `wbps=` line for the device backing the disk —
/// and a flushed 32 MiB write must take at least half the theoretical 8s.
///
/// Without the controller, the same options must still start a box (the
/// limits are logged, not enforced): a fail-fast here would break every
/// rootless host without an `io` delegation.
#[tokio::test]
async fn disk_io_limits_land_in_io_max_or_degrade_to_a_warning() {
    let t = BoxTestBase::with_options(throttled_opts()).await;
    t.bx.start().await.expect("a box with disk_io must start");
    t.exec_stdout("echo", &["disk-io-ok"]).await;

    if !io_controller_available() {
        eprintln!(
            "io controller not delegated at {}: exercised the warn-and-continue leg only",
            cgroup_base().display()
        );
        return;
    }

    let io_max = cgroup_base()
        .join("boxlite")
        .join(t.bx.id().as_str())
        .join("io.max");
    let contents = std::fs::read_to_string(&io_max)
        .unwrap_or_else(|e| panic!("read {}: {e}", io_max.display()));
    assert!(
        contents.contains(&format!("wbps={WRITE_BPS}")),
        "io.max must carry the requested write limit, got: {contents:?}"
    );
    assert!(
        contents.contains("rbps=max"),
        "unset dimensions must stay unlimited, got: {contents:?}"
    );

    let throttled = timed_flushed_write(&t).await;
    assert!(
        throttled >= Duration::from_secs(4),
        "32 MiB at 4 MiB/s should take ~8s; a {throttled:?} write means io.max did not bite"
    );
}

/// Baseline for the timing assertion above: the same write without limits is
/// not itself slow on this host. Only meaningful where the throttled leg runs.
#[tokio::test]
async fn unthrottled_flushed_write_is_faster_than_the_throttle_floor() {
    if !io_controller_available() {
        eprintln!("io controller not delegated: skipping the unthrottled baseline");
        return;
    }
    let t = BoxTestBase::new().await;
    let elapsed = timed_flushed_write(&t).await;
    assert!(
        elapsed < Duration::from_secs(4),
        "unthrottled 32 MiB write took {elapsed:?}; the throttled assertion would be meaningless"
    );
}

/// With the jailer off there is no cgroup at all: the limits are logged and
/// the box still starts.
#[tokio::test]
async fn disk_io_limits_without_the_jailer_only_warn() {
    let mut opts = throttled_opts();
    opts.advanced.security = boxlite::runtime::advanced_options::SecurityOptions::disabled();
    let t = BoxTestBase::with_options(opts).await;
    t.bx.start()
        .await
        .expect("disk_io with the jailer disabled must not block start");
    let out = t.exec_stdout("echo", &["no-jailer-ok"]).await;
    assert!(out.contains("no-jailer-ok"));
}
