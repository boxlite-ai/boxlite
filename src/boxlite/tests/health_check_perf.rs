//! Perf-measurement test: how much CPU does the in-process health check
//! task add per box? Spawns two alpine boxes — one with `health_check =
//! None`, one with an aggressive `health_check = Some(100ms)` — measures
//! the parent test process's `/proc/self/stat` CPU delta over 10 s, and
//! prints the diff so a reviewer can see the per-tick + per-box overhead.
//!
//! Not a strict assertion (CPU varies with host load); the test passes
//! as long as it can spawn + stop both boxes and read /proc.
//!
//! Methodology notes for whoever runs this:
//!   * Health check interval: 100 ms → ~100 ticks in 10 s. Production
//!     default is 30 s → 0.33 ticks / 10 s. Divide the measured delta
//!     by 100 to project to the production cadence.
//!   * The work is in the boxlite process (the test binary), not in
//!     the shim subprocess — the tokio task lives in the parent.
//!   * Each tick is one `gRPC Ping` over vsock to the guest agent;
//!     wall-clock per tick is dominated by the vsock round-trip, not
//!     the in-process state mutation.

mod common;

use boxlite::litebox::HealthState;
use boxlite::runtime::advanced_options::{AdvancedBoxOptions, HealthCheckOptions};
use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use common::box_test::BoxTestBase;
use std::time::Duration;
use tokio::time::sleep;

/// Read cumulative (utime + stime) for /proc/self/stat. Returns clock
/// ticks (sysconf(_SC_CLK_TCK) ticks per second; usually 100).
fn read_self_cpu_ticks() -> u64 {
    let s = std::fs::read_to_string("/proc/self/stat").expect("read /proc/self/stat");
    // /proc/<pid>/stat fields: pid (comm) state ppid ... utime(14) stime(15)
    // comm contains spaces, so split after the last ')'.
    let after_comm = s.rsplit_once(')').expect("comm closing paren").1;
    let fields: Vec<&str> = after_comm.split_whitespace().collect();
    // After ')', field index is shifted: state is fields[0], so utime is
    // fields[11] (14 - 3 = 11) and stime is fields[12].
    let utime: u64 = fields[11].parse().expect("utime");
    let stime: u64 = fields[12].parse().expect("stime");
    utime + stime
}

fn cpu_ms_from_ticks(ticks: u64) -> u64 {
    // /proc/<pid>/stat utime/stime are in clock ticks. The divisor
    // is `sysconf(_SC_CLK_TCK)` — commonly 100 on x86_64 Linux, but
    // the kernel may have been built with HZ=250/300/1000 (especially
    // on ARM or low-latency profiles). Coderabbitai review on #613
    // verified the man-page contract; previously this hardcoded
    // `ticks * 10` (= a 100 Hz assumption), which would over- or
    // under-report by 2.5× / 10× on those kernels.
    //
    // Read the real value at runtime and fall back to 100 only if
    // sysconf returns something nonsensical (defensive — we still
    // want a number to print in the report).
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let hz = if hz > 0 { hz as u64 } else { 100 };
    // ticks / hz = seconds; * 1000 = ms.
    ticks.saturating_mul(1000) / hz
}

#[tokio::test]
async fn perf_health_check_default_on_vs_off_cpu_delta() {
    const OBSERVATION_SECS: u64 = 10;

    // --- Phase 1: box with health check OFF -----------------------
    let off_opts = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        advanced: AdvancedBoxOptions {
            health_check: None,
            ..Default::default()
        },
        auto_remove: false,
        ..Default::default()
    };
    let t_off = BoxTestBase::with_options(off_opts).await;
    t_off.bx.start().await.expect("start off-box");

    // Settle: give the runtime a beat to finish any post-start work
    // so it doesn't bleed into the measurement window.
    sleep(Duration::from_secs(1)).await;

    let cpu_off_before = read_self_cpu_ticks();
    sleep(Duration::from_secs(OBSERVATION_SECS)).await;
    let cpu_off_after = read_self_cpu_ticks();
    let cpu_off_delta = cpu_off_after - cpu_off_before;

    t_off.bx.stop().await.expect("stop off-box");

    // --- Phase 2: box with aggressive health check ON -------------
    let on_opts = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        advanced: AdvancedBoxOptions {
            health_check: Some(HealthCheckOptions {
                // Aggressive interval to make the per-tick overhead
                // observable in a short window. Production default is
                // 30 s — multiply our number by 1/300 to project.
                interval: Duration::from_millis(100),
                timeout: Duration::from_secs(1),
                retries: 3,
                // No startup grace — start counting immediately so we
                // actually see ticks during the observation window.
                start_period: Duration::from_millis(0),
            }),
            ..Default::default()
        },
        auto_remove: false,
        ..Default::default()
    };
    let t_on = BoxTestBase::with_options(on_opts).await;
    t_on.bx.start().await.expect("start on-box");

    // Wait long enough for health check to land in Healthy before
    // measurement; otherwise the first window includes startup pings
    // failing on a not-yet-ready guest. Coderabbitai review on #613:
    // assert the box actually reached Healthy — otherwise a timed-out
    // wait still records CPU against startup / unhealthy behaviour and
    // prints it as steady-state overhead.
    let healthy_deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut became_healthy = false;
    while std::time::Instant::now() < healthy_deadline {
        let info = t_on
            .runtime
            .get_info(t_on.bx.id().as_str())
            .await
            .unwrap()
            .unwrap();
        if info.health_status.state == HealthState::Healthy {
            became_healthy = true;
            break;
        }
        sleep(Duration::from_millis(200)).await;
    }
    assert!(
        became_healthy,
        "health-check-on box never reached Healthy within 15s; the perf number that follows \
         would mix in startup / unhealthy pings instead of steady-state overhead"
    );

    let cpu_on_before = read_self_cpu_ticks();
    sleep(Duration::from_secs(OBSERVATION_SECS)).await;
    let cpu_on_after = read_self_cpu_ticks();
    let cpu_on_delta = cpu_on_after - cpu_on_before;

    t_on.bx.stop().await.expect("stop on-box");

    // --- Report ---------------------------------------------------
    let off_ms = cpu_ms_from_ticks(cpu_off_delta);
    let on_ms = cpu_ms_from_ticks(cpu_on_delta);
    let delta_ms = on_ms.saturating_sub(off_ms);

    // Approximate ticks during the on-window: interval=100ms over
    // OBSERVATION_SECS = OBSERVATION_SECS * 10 ticks.
    let approx_ticks = OBSERVATION_SECS * 10;
    let per_tick_us = (delta_ms * 1000).checked_div(approx_ticks).unwrap_or(0);

    // Production projection: default interval 30 s ⇒ 0.033 ticks/s
    // per box ⇒ delta_per_box_per_sec_us ≈ per_tick_us / 30
    let prod_per_box_per_sec_us = per_tick_us / 30;

    println!(
        "PERF\n  observation window: {OBSERVATION_SECS}s\n  off-box CPU: {off_ms} ms\n  on-box CPU:  {on_ms} ms\n  delta:       {delta_ms} ms over ~{approx_ticks} ticks (100ms interval)\n  per-tick:    ~{per_tick_us} us\n  projected at default 30s interval, per box: ~{prod_per_box_per_sec_us} us/sec ({} ms/box/hour)",
        prod_per_box_per_sec_us * 36 / 10_000,
    );
}
