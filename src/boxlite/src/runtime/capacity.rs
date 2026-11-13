//! Per-box resource ceilings derived from host capacity.
//!
//! A box boots with spare vCPUs and memory up to these ceilings so it can grow
//! online later. Creation does not check against them; a box larger than the
//! host still boots, just without room to grow.
//! [`ResourceCeiling`] is the smallest of the limits a [`HostProbe`] reports,
//! following Kata's `default_maxvcpus` / `default_maxmemory` rule. The bundled
//! guest kernel's vCPU cap applies only when no custom kernel is configured.

use crate::runtime::constants::vm_defaults::GUEST_KERNEL_MAX_VCPUS;

/// Host limits that bound a box's resources.
pub(crate) trait HostProbe {
    /// CPUs this process may run on.
    fn cpus(&self) -> u32;
    /// Memory this process may use, in MiB (host RAM or its cgroup limit).
    fn memory_mib(&self) -> u64;
    /// The hypervisor's vCPU limit per VM, when it can be queried.
    fn hypervisor_max_vcpus(&self) -> Option<u32>;
}

/// The largest vCPU count and memory size a box may grow to on this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResourceCeiling {
    pub(crate) max_cpus: u8,
    pub(crate) max_memory_mib: u32,
}

impl ResourceCeiling {
    /// Ceiling for the current host. A custom kernel supplies its own vCPU
    /// limit, so the bundled kernel's cap applies only when `custom_kernel`
    /// is false.
    pub(crate) fn detect_with_kernel(custom_kernel: bool) -> Self {
        Self::from_probe(&SystemProbe, custom_kernel)
    }

    pub(crate) fn from_probe(probe: &dyn HostProbe, custom_kernel: bool) -> Self {
        let mut cpus = probe.cpus();
        if !custom_kernel {
            cpus = cpus.min(u32::from(GUEST_KERNEL_MAX_VCPUS));
        }
        if let Some(hypervisor) = probe.hypervisor_max_vcpus() {
            cpus = cpus.min(hypervisor);
        }
        Self {
            max_cpus: cpus.clamp(1, u32::from(u8::MAX)) as u8,
            max_memory_mib: probe.memory_mib().min(u64::from(u32::MAX)) as u32,
        }
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
    use std::path::{Component, Path};

    /// Smallest finite `memory.max` in the visible cgroup v2 ancestry.
    pub(super) fn cgroup_memory_max() -> Option<u64> {
        let membership = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        let path = membership.lines().find_map(|l| l.strip_prefix("0::"))?;
        let relative = Path::new(path.strip_prefix('/')?);
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return None;
        }
        let root = Path::new("/sys/fs/cgroup");
        let leaf = root.join(relative);
        leaf.ancestors()
            .take_while(|ancestor| ancestor.starts_with(root))
            .filter_map(|ancestor| std::fs::read_to_string(ancestor.join("memory.max")).ok())
            .filter_map(|value| value.trim().parse::<u64>().ok())
            .min()
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

    // Redirect only cgroup probe files into a per-test filesystem. The production
    // traversal and parsing run unchanged, including on the pre-fix baseline.
    #[cfg(test)]
    mod std {
        pub use ::std::{os, path};
        pub mod fs {
            pub use ::std::fs::File;
            use ::std::{
                cell::RefCell,
                io,
                path::{Path, PathBuf},
            };
            thread_local! { pub static FIXTURE: RefCell<Option<PathBuf>> = const { RefCell::new(None) }; }
            pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
                let path = path.as_ref();
                let redirected = FIXTURE.with(|fixture| {
                    fixture.borrow().as_ref().and_then(|root| {
                        if path == Path::new("/proc/self/cgroup") {
                            Some(root.join("membership"))
                        } else {
                            path.strip_prefix("/sys/fs/cgroup")
                                .ok()
                                .map(|suffix| root.join("cgroup").join(suffix))
                        }
                    })
                });
                ::std::fs::read_to_string(redirected.as_deref().unwrap_or(path))
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cgroup_memory_ceiling_honors_visible_ancestors() {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("cgroup");
            ::std::fs::create_dir_all(root.join("parent/leaf")).unwrap();
            ::std::fs::write(dir.path().join("membership"), "0::/parent/leaf\n").unwrap();
            ::std::fs::write(root.join("memory.max"), "max\n").unwrap();
            ::std::fs::write(root.join("parent/memory.max"), "2147483648\n").unwrap();
            ::std::fs::write(root.join("parent/leaf/memory.max"), "max\n").unwrap();
            std::fs::FIXTURE.with(|fixture| *fixture.borrow_mut() = Some(dir.path().to_owned()));
            let observed = cgroup_memory_max();
            std::fs::FIXTURE.with(|fixture| *fixture.borrow_mut() = None);
            assert_eq!(
                observed,
                Some(2147483648),
                "an unlimited leaf still inherits its parent limit"
            );
        }

        #[test]
        fn cgroup_memory_ceiling_handles_root_missing_and_finite_limits() {
            for (membership, leaf, parent, root_limit, expected) in [
                (
                    "/parent/leaf",
                    Some("1024"),
                    Some("2048"),
                    "max",
                    Some(1024),
                ),
                (
                    "/parent/leaf",
                    Some("4096"),
                    Some("2048"),
                    "max",
                    Some(2048),
                ),
                ("/parent/leaf", None, Some("2048"), "1024", Some(1024)),
                ("/", None, None, "1024", Some(1024)),
                ("/parent/leaf", Some("max"), None, "max", None),
                ("/../escape", None, None, "1024", None),
            ] {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path().join("cgroup");
                ::std::fs::create_dir_all(root.join("parent/leaf")).unwrap();
                ::std::fs::write(dir.path().join("membership"), format!("0::{membership}\n"))
                    .unwrap();
                ::std::fs::write(root.join("memory.max"), root_limit).unwrap();
                for (path, value) in [
                    ("parent/memory.max", parent),
                    ("parent/leaf/memory.max", leaf),
                ] {
                    if let Some(value) = value {
                        ::std::fs::write(root.join(path), value).unwrap();
                    }
                }
                std::fs::FIXTURE
                    .with(|fixture| *fixture.borrow_mut() = Some(dir.path().to_owned()));
                let observed = cgroup_memory_max();
                std::fs::FIXTURE.with(|fixture| *fixture.borrow_mut() = None);
                assert_eq!(
                    observed, expected,
                    "membership {membership}, leaf {leaf:?}, parent {parent:?}"
                );
            }
        }
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
        ResourceCeiling::from_probe(
            &FakeProbe {
                cpus,
                memory_mib,
                hypervisor,
            },
            false,
        )
    }

    fn custom_kernel_ceiling(
        cpus: u32,
        memory_mib: u64,
        hypervisor: Option<u32>,
    ) -> ResourceCeiling {
        ResourceCeiling::from_probe(
            &FakeProbe {
                cpus,
                memory_mib,
                hypervisor,
            },
            true,
        )
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
    fn custom_kernel_uses_the_host_ceiling() {
        assert_eq!(custom_kernel_ceiling(128, 8192, Some(1024)).max_cpus, 128);
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
    fn detect_reports_a_usable_host() {
        let c = ResourceCeiling::detect_with_kernel(false);
        assert!(c.max_cpus >= 1);
        assert!(c.max_memory_mib > 0);
    }
}
