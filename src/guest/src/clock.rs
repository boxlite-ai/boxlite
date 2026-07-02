//! Guest wall-clock synchronization with the host.
//!
//! After host sleep/resume the guest vCPU clock stops advancing while host
//! wall time continues. Prefer the virtual RTC when it agrees with the host
//! timestamp; when RTC is stale (common after libkrun host suspend), apply
//! the host timestamp supplied over gRPC.

use boxlite_shared::SyncClockSource;
use nix::errno::Errno;
use std::fs::OpenOptions;
use std::os::unix::io::AsRawFd;
use tracing::{debug, warn};

/// Result of a guest clock synchronization operation.
pub struct SyncClockOutcome {
    pub guest_unix_nanos_before: i64,
    pub guest_unix_nanos_after: i64,
    pub correction_nanos: i64,
    pub source: SyncClockSource,
}

const RTC_DEVICE: &str = "/dev/rtc0";
/// Max allowed skew between host timestamp and RTC before treating RTC as stale.
const MAX_HOST_RTC_SKEW_NANOS: i64 = 2_000_000_000;
// Linux RTC_RD_TIME: _IOR('p', 0x09, struct rtc_time)
const RTC_RD_TIME: nix::libc::c_ulong = 0x8024_7009;

#[repr(C)]
struct RtcTime {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
}

/// Synchronize guest wall clock to the host/RTC.
pub fn sync_clock(host_unix_nanos: i64, force_host_timestamp: bool) -> Result<SyncClockOutcome, String> {
    let before = realtime_nanos()?;

    let (target_nanos, source) = if force_host_timestamp {
        if host_unix_nanos <= 0 {
            return Err(format!("invalid host timestamp: {host_unix_nanos}"));
        }
        (host_unix_nanos, SyncClockSource::HostTimestamp)
    } else {
        match read_rtc_unix_nanos() {
            Ok(rtc_nanos) => choose_sync_target(host_unix_nanos, rtc_nanos),
            Err(e) => {
                debug!(error = %e, "RTC unavailable, using host timestamp");
                if host_unix_nanos <= 0 {
                    return Err(format!("invalid host timestamp: {host_unix_nanos}"));
                }
                (host_unix_nanos, SyncClockSource::HostTimestamp)
            }
        }
    };

    set_realtime_nanos(target_nanos)?;
    let after = realtime_nanos()?;

    Ok(SyncClockOutcome {
        guest_unix_nanos_before: before,
        guest_unix_nanos_after: after,
        correction_nanos: after - before,
        source,
    })
}

fn realtime_nanos() -> Result<i64, String> {
    let mut ts = nix::libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    let ret = unsafe { nix::libc::clock_gettime(nix::libc::CLOCK_REALTIME, &mut ts) };
    if ret != 0 {
        return Err(Errno::last().to_string());
    }
    Ok(ts.tv_sec * 1_000_000_000 + ts.tv_nsec)
}

fn set_realtime_nanos(nanos: i64) -> Result<(), String> {
    let ts = nix::libc::timespec {
        tv_sec: nanos.div_euclid(1_000_000_000),
        tv_nsec: nanos.rem_euclid(1_000_000_000) as nix::libc::c_long,
    };
    let ret = unsafe { nix::libc::clock_settime(nix::libc::CLOCK_REALTIME, &ts) };
    if ret != 0 {
        return Err(Errno::last().to_string());
    }
    Ok(())
}

fn read_rtc_unix_nanos() -> Result<i64, String> {
    let file = OpenOptions::new()
        .read(true)
        .open(RTC_DEVICE)
        .map_err(|e| format!("open {RTC_DEVICE}: {e}"))?;

    let mut rtc = RtcTime {
        tm_sec: 0,
        tm_min: 0,
        tm_hour: 0,
        tm_mday: 0,
        tm_mon: 0,
        tm_year: 0,
        tm_wday: 0,
        tm_yday: 0,
        tm_isdst: 0,
    };

    let ret = unsafe { nix::libc::ioctl(file.as_raw_fd(), RTC_RD_TIME as _, &mut rtc) };
    if ret < 0 {
        return Err(format!(
            "RTC_RD_TIME on {RTC_DEVICE}: {}",
            Errno::last()
        ));
    }

    let unix_secs = rtc_time_to_unix(&rtc)?;
    Ok(unix_secs * 1_000_000_000)
}

fn choose_sync_target(host_unix_nanos: i64, rtc_nanos: i64) -> (i64, SyncClockSource) {
    if host_unix_nanos > 0 {
        let host_skew = (host_unix_nanos - rtc_nanos).abs();
        if host_skew > MAX_HOST_RTC_SKEW_NANOS {
            warn!(
                host_skew_secs = host_skew / 1_000_000_000,
                "RTC and host timestamp differ; using host timestamp"
            );
            return (host_unix_nanos, SyncClockSource::HostTimestamp);
        }
    }
    (rtc_nanos, SyncClockSource::Rtc)
}

fn rtc_time_to_unix(rtc: &RtcTime) -> Result<i64, String> {
    let mut tm: nix::libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_sec = rtc.tm_sec;
    tm.tm_min = rtc.tm_min;
    tm.tm_hour = rtc.tm_hour;
    tm.tm_mday = rtc.tm_mday;
    tm.tm_mon = rtc.tm_mon;
    tm.tm_year = rtc.tm_year;
    tm.tm_wday = rtc.tm_wday;
    tm.tm_yday = rtc.tm_yday;
    tm.tm_isdst = rtc.tm_isdst;

    // SAFETY: timegm interprets tm as UTC when available (glibc/musl on Linux).
    let unix_secs = unsafe { nix::libc::timegm(&mut tm) };
    if unix_secs < 0 {
        return Err("timegm failed for RTC time".to_string());
    }
    Ok(unix_secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choose_sync_target_prefers_rtc_when_host_agrees() {
        let host = 1_700_000_000_000_000_000_i64;
        let rtc = host + 500_000_000;
        let (target, source) = choose_sync_target(host, rtc);
        assert_eq!(target, rtc);
        assert_eq!(source, SyncClockSource::Rtc);
    }

    #[test]
    fn choose_sync_target_uses_host_when_rtc_stale() {
        let host = 1_700_000_000_000_000_000_i64;
        let rtc = host - 3_600_000_000_000;
        let (target, source) = choose_sync_target(host, rtc);
        assert_eq!(target, host);
        assert_eq!(source, SyncClockSource::HostTimestamp);
    }

    #[test]
    fn rtc_time_to_unix_converts_utc_components() {
        let rtc = RtcTime {
            tm_sec: 0,
            tm_min: 0,
            tm_hour: 0,
            tm_mday: 1,
            tm_mon: 0,    // January
            tm_year: 120, // 2020
            tm_wday: 0,
            tm_yday: 0,
            tm_isdst: 0,
        };
        let unix = rtc_time_to_unix(&rtc).expect("conversion");
        assert_eq!(unix, 1_577_836_800);
    }
}
