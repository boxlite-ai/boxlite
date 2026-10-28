//! Per-box resource ceilings derived from host capacity.
//!
//! A box may never be given more vCPUs or memory than the host can back.
//! [`ResourceCeiling`] is the smallest of the limits a [`HostProbe`] reports,
//! following Kata's `default_maxvcpus` / `default_maxmemory` rule.

use crate::runtime::constants::vm_defaults::GUEST_KERNEL_MAX_VCPUS;
use boxlite_shared::{BoxliteError, BoxliteResult};

/// Host limits that bound a box's resources.
pub(crate) trait HostProbe {
    /// CPUs this process may run on.
    fn cpus(&self) -> u32;
    /// Memory this process may use, in MiB (host RAM or its cgroup limit).
    fn memory_mib(&self) -> u64;
    /// The hypervisor's vCPU limit per VM, when it can be queried.
    fn hypervisor_max_vcpus(&self) -> Option<u32>;
}

/// The largest vCPU count and memory size a box may have on this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResourceCeiling {
    pub(crate) max_cpus: u8,
    pub(crate) max_memory_mib: u32,
}

impl ResourceCeiling {
    /// Ceiling for the current host.
    pub(crate) fn detect() -> Self {
        Self::from_probe(&SystemProbe)
    }

    pub(crate) fn from_probe(probe: &dyn HostProbe) -> Self {
        let mut cpus = probe.cpus().min(u32::from(GUEST_KERNEL_MAX_VCPUS));
        if let Some(hypervisor) = probe.hypervisor_max_vcpus() {
            cpus = cpus.min(hypervisor);
        }
        Self {
            max_cpus: cpus.clamp(1, u32::from(u8::MAX)) as u8,
            max_memory_mib: probe.memory_mib().min(u64::from(u32::MAX)) as u32,
        }
    }

    /// Reject a requested size that is zero or above the ceiling.
    pub(crate) fn check(&self, cpus: u8, memory_mib: u32) -> BoxliteResult<()> {
        if cpus == 0 || cpus > self.max_cpus {
            return Err(BoxliteError::InvalidArgument(format!(
                "cpus must be between 1 and {} on this host, got {cpus}",
                self.max_cpus
            )));
        }
        if memory_mib == 0 || memory_mib > self.max_memory_mib {
            return Err(BoxliteError::InvalidArgument(format!(
                "memory_mib must be between 1 and {} on this host, got {memory_mib}",
                self.max_memory_mib
            )));
        }
        Ok(())
    }
}

/// [`HostProbe`] backed by the running host.
struct SystemProbe;

impl HostProbe for SystemProbe {
    fn cpus(&self) -> u32 {
        // Honors the affinity mask and cgroup quota, unlike the online count.
        std::thread::available_parallelism().map_or(1, |n| n.get() as u32)
    }

    fn memory_mib(&self) -> u64 {
        let mut system = sysinfo::System::new();
        system.refresh_memory();
        #[allow(unused_mut)]
        let mut bytes = system.total_memory();
        #[cfg(target_os = "linux")]
        if let Some(limit) = linux::cgroup_memory_max() {
            bytes = bytes.min(limit);
        }
        bytes / (1024 * 1024)
    }

    fn hypervisor_max_vcpus(&self) -> Option<u32> {
        #[cfg(target_os = "linux")]
        {
            linux::kvm_max_vcpus()
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::os::fd::AsRawFd;

    /// `memory.max` of this process's cgroup v2, if it sets a limit.
    pub(super) fn cgroup_memory_max() -> Option<u64> {
        let membership = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        let path = membership.lines().find_map(|l| l.strip_prefix("0::"))?;
        let path = path.trim_start_matches('/');
        let value = std::fs::read_to_string(format!("/sys/fs/cgroup/{path}/memory.max")).ok()?;
        value.trim().parse().ok()
    }

    /// `KVM_CAP_MAX_VCPUS`, falling back to `KVM_CAP_NR_VCPUS` as libkrun's
    /// `krun_get_max_vcpus` does. The runtime does not link libkrun.
    pub(super) fn kvm_max_vcpus() -> Option<u32> {
        const KVM_CHECK_EXTENSION: libc::c_ulong = 0xAE03;
        const KVM_CAP_NR_VCPUS: libc::c_int = 9;
        const KVM_CAP_MAX_VCPUS: libc::c_int = 66;

        let kvm = std::fs::File::open("/dev/kvm").ok()?;
        let check = |cap: libc::c_int| unsafe {
            libc::ioctl(kvm.as_raw_fd(), KVM_CHECK_EXTENSION as _, cap)
        };
        [KVM_CAP_MAX_VCPUS, KVM_CAP_NR_VCPUS]
            .into_iter()
            .map(check)
            .find(|&n| n > 0)
            .map(|n| n as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeProbe {
        cpus: u32,
        memory_mib: u64,
        hypervisor: Option<u32>,
    }

    impl HostProbe for FakeProbe {
        fn cpus(&self) -> u32 {
            self.cpus
        }
        fn memory_mib(&self) -> u64 {
            self.memory_mib
        }
        fn hypervisor_max_vcpus(&self) -> Option<u32> {
            self.hypervisor
        }
    }

    fn ceiling(cpus: u32, memory_mib: u64, hypervisor: Option<u32>) -> ResourceCeiling {
        ResourceCeiling::from_probe(&FakeProbe {
            cpus,
            memory_mib,
            hypervisor,
        })
    }

    #[test]
    fn host_cpus_bound_the_ceiling() {
        assert_eq!(ceiling(4, 8192, Some(1024)).max_cpus, 4);
    }

    #[test]
    fn guest_kernel_limit_bounds_large_hosts() {
        assert_eq!(
            ceiling(128, 8192, Some(1024)).max_cpus,
            GUEST_KERNEL_MAX_VCPUS
        );
    }

    #[test]
    fn hypervisor_limit_bounds_the_ceiling() {
        assert_eq!(ceiling(12, 8192, Some(8)).max_cpus, 8);
    }

    #[test]
    fn memory_ceiling_saturates_at_u32() {
        assert_eq!(ceiling(4, u64::MAX, None).max_memory_mib, u32::MAX);
    }

    #[test]
    fn check_accepts_sizes_at_the_ceiling() {
        assert!(ceiling(4, 8192, None).check(4, 8192).is_ok());
    }

    #[test]
    fn check_rejects_zero_and_oversized_requests() {
        let c = ceiling(4, 8192, None);
        for (cpus, memory_mib) in [(0, 512), (5, 512), (1, 0), (1, 8193)] {
            let err = c.check(cpus, memory_mib).unwrap_err();
            assert!(matches!(err, BoxliteError::InvalidArgument(_)), "{err}");
        }
    }

    #[test]
    fn detect_reports_a_usable_host() {
        let c = ResourceCeiling::detect();
        assert!(c.max_cpus >= 1);
        assert!(c.max_memory_mib > 0);
    }
}
