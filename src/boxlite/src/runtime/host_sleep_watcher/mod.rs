//! Detect host sleep/resume and synchronize guest clocks.
//!
//! macOS follows [krunkit `timesync.rs`](https://github.com/containers/krunkit/blob/main/src/timesync.rs):
//! `IORegisterForSystemPower` + `kIOMessageSystemWillPowerOn | kIOMessageSystemHasPoweredOn`.

#[cfg(target_os = "macos")]
mod macos;

use tokio_util::sync::CancellationToken;

use crate::runtime::rt_impl::SharedRuntimeImpl;

/// Host power events relevant to guest clock resync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostPowerActivity {
    Sleep,
    Wake,
}

// IOKit IOPM message constants (stable; see IOPMLib.h).
const IOMSG_SYSTEM_WILL_SLEEP: u32 = 0xE000_0280;
const IOMSG_SYSTEM_WILL_POWER_ON: u32 = 0xE000_0320;
const IOMSG_SYSTEM_HAS_POWERED_ON: u32 = 0xE000_0300;

/// Map IOKit system power notifications to host sleep/wake activity.
pub(crate) fn map_iokit_power_message(message_type: u32) -> Option<HostPowerActivity> {
    match message_type {
        IOMSG_SYSTEM_WILL_SLEEP => Some(HostPowerActivity::Sleep),
        IOMSG_SYSTEM_WILL_POWER_ON | IOMSG_SYSTEM_HAS_POWERED_ON => Some(HostPowerActivity::Wake),
        _ => None,
    }
}

/// Start a background task that watches for host wake and syncs running boxes.
pub fn spawn(runtime: SharedRuntimeImpl, shutdown_token: CancellationToken) {
    #[cfg(target_os = "macos")]
    macos::spawn(runtime, shutdown_token);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (runtime, shutdown_token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_will_sleep_to_sleep() {
        assert_eq!(
            map_iokit_power_message(IOMSG_SYSTEM_WILL_SLEEP),
            Some(HostPowerActivity::Sleep)
        );
    }

    #[test]
    fn maps_will_power_on_to_wake() {
        assert_eq!(
            map_iokit_power_message(IOMSG_SYSTEM_WILL_POWER_ON),
            Some(HostPowerActivity::Wake)
        );
    }

    #[test]
    fn maps_has_powered_on_to_wake() {
        assert_eq!(
            map_iokit_power_message(0xE000_0300),
            Some(HostPowerActivity::Wake)
        );
        assert_eq!(
            map_iokit_power_message(IOMSG_SYSTEM_HAS_POWERED_ON),
            Some(HostPowerActivity::Wake)
        );
    }

    #[test]
    fn ignores_unknown_power_messages() {
        assert_eq!(map_iokit_power_message(0xDEAD_BEEF), None);
    }

    #[test]
    fn non_macos_spawn_is_compile_time_no_op() {
        // Linux/CI builds must not link IOKit; wake detection is intentionally macOS-only.
        #[cfg(not(target_os = "macos"))]
        {
            let _spawn = super::spawn as fn(SharedRuntimeImpl, CancellationToken);
        }
    }
}
