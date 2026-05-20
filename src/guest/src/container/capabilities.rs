//! Linux capabilities for container processes.
//!
//! Defines the default capability set matching Docker/OCI defaults.
//! Used by:
//! - OCI spec builder (process.capabilities)
//! - Tenant process spawning (exec capabilities)

use oci_spec::runtime::Capability;
use std::collections::HashSet;

/// Default capabilities for container processes.
///
/// Matches Docker's default capability set — sufficient for most workloads
/// while excluding dangerous capabilities like CAP_SYS_ADMIN (mount/remount,
/// namespace manipulation), CAP_NET_ADMIN (network reconfiguration),
/// CAP_SYS_MODULE (kernel module loading), and CAP_BPF.
pub fn default_capabilities() -> HashSet<Capability> {
    [
        Capability::Chown,
        Capability::DacOverride,
        Capability::Fowner,
        Capability::Fsetid,
        Capability::Kill,
        Capability::Setgid,
        Capability::Setuid,
        Capability::Setpcap,
        Capability::NetBindService,
        Capability::NetRaw,
        Capability::SysChroot,
        Capability::Mknod,
        Capability::AuditWrite,
        Capability::Setfcap,
    ]
    .into_iter()
    .collect()
}

/// Convert default capabilities to string names for libcontainer API.
pub fn capability_names() -> Vec<String> {
    [
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_FOWNER",
        "CAP_FSETID",
        "CAP_KILL",
        "CAP_SETGID",
        "CAP_SETUID",
        "CAP_SETPCAP",
        "CAP_NET_BIND_SERVICE",
        "CAP_NET_RAW",
        "CAP_SYS_CHROOT",
        "CAP_MKNOD",
        "CAP_AUDIT_WRITE",
        "CAP_SETFCAP",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Expanded capability set for boxes started with `--support-docker`.
///
/// Equivalent to `docker run --privileged`: every capability the host kernel
/// recognises, granted to the container process. Required so a docker daemon
/// inside the box can mount cgroup hierarchies, manipulate network namespaces,
/// load iptables rules, etc.
///
/// SECURITY: This is the full Linux capability set. Code running as root
/// inside a box with this set can mount arbitrary filesystems, modify
/// network configuration, write to all of /proc and /sys, and perform every
/// container-escape primitive that requires capabilities. The microVM
/// boundary still contains the process — host stays protected by KVM/libkrun
/// isolation — but the in-VM blast radius is effectively `root`. Only use
/// this for trusted workloads or where you would otherwise use
/// `docker run --privileged`.
pub fn docker_capabilities() -> HashSet<Capability> {
    [
        Capability::AuditControl,
        Capability::AuditRead,
        Capability::AuditWrite,
        Capability::BlockSuspend,
        Capability::Bpf,
        Capability::CheckpointRestore,
        Capability::Chown,
        Capability::DacOverride,
        Capability::DacReadSearch,
        Capability::Fowner,
        Capability::Fsetid,
        Capability::IpcLock,
        Capability::IpcOwner,
        Capability::Kill,
        Capability::Lease,
        Capability::LinuxImmutable,
        Capability::MacAdmin,
        Capability::MacOverride,
        Capability::Mknod,
        Capability::NetAdmin,
        Capability::NetBindService,
        Capability::NetBroadcast,
        Capability::NetRaw,
        Capability::Perfmon,
        Capability::Setgid,
        Capability::Setfcap,
        Capability::Setpcap,
        Capability::Setuid,
        Capability::SysAdmin,
        Capability::SysBoot,
        Capability::SysChroot,
        Capability::SysModule,
        Capability::SysNice,
        Capability::SysPacct,
        Capability::SysPtrace,
        Capability::SysRawio,
        Capability::SysResource,
        Capability::SysTime,
        Capability::SysTtyConfig,
        Capability::Syslog,
        Capability::WakeAlarm,
    ]
    .into_iter()
    .collect()
}

/// String-name counterpart to `docker_capabilities()` for libcontainer's
/// tenant-exec builder. Used by the zygote when spawning exec'd processes
/// inside a `--support-docker` container so they inherit the same expanded
/// privileges as the init process.
pub fn docker_capability_names() -> Vec<String> {
    [
        "CAP_AUDIT_CONTROL",
        "CAP_AUDIT_READ",
        "CAP_AUDIT_WRITE",
        "CAP_BLOCK_SUSPEND",
        "CAP_BPF",
        "CAP_CHECKPOINT_RESTORE",
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_DAC_READ_SEARCH",
        "CAP_FOWNER",
        "CAP_FSETID",
        "CAP_IPC_LOCK",
        "CAP_IPC_OWNER",
        "CAP_KILL",
        "CAP_LEASE",
        "CAP_LINUX_IMMUTABLE",
        "CAP_MAC_ADMIN",
        "CAP_MAC_OVERRIDE",
        "CAP_MKNOD",
        "CAP_NET_ADMIN",
        "CAP_NET_BIND_SERVICE",
        "CAP_NET_BROADCAST",
        "CAP_NET_RAW",
        "CAP_PERFMON",
        "CAP_SETGID",
        "CAP_SETFCAP",
        "CAP_SETPCAP",
        "CAP_SETUID",
        "CAP_SYS_ADMIN",
        "CAP_SYS_BOOT",
        "CAP_SYS_CHROOT",
        "CAP_SYS_MODULE",
        "CAP_SYS_NICE",
        "CAP_SYS_PACCT",
        "CAP_SYS_PTRACE",
        "CAP_SYS_RAWIO",
        "CAP_SYS_RESOURCE",
        "CAP_SYS_TIME",
        "CAP_SYS_TTY_CONFIG",
        "CAP_SYSLOG",
        "CAP_WAKE_ALARM",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_capabilities_has_14_docker_defaults() {
        let caps = default_capabilities();
        assert_eq!(caps.len(), 14);
    }

    #[test]
    fn default_capabilities_includes_required_caps() {
        let caps = default_capabilities();
        let required = [
            Capability::Chown,
            Capability::DacOverride,
            Capability::Fowner,
            Capability::Fsetid,
            Capability::Kill,
            Capability::Setgid,
            Capability::Setuid,
            Capability::Setpcap,
            Capability::NetBindService,
            Capability::NetRaw,
            Capability::SysChroot,
            Capability::Mknod,
            Capability::AuditWrite,
            Capability::Setfcap,
        ];
        for cap in &required {
            assert!(caps.contains(cap), "missing required capability: {:?}", cap);
        }
    }

    #[test]
    fn default_capabilities_excludes_dangerous_caps() {
        let caps = default_capabilities();
        let dangerous = [
            Capability::SysAdmin,
            Capability::NetAdmin,
            Capability::SysModule,
            Capability::SysRawio,
            Capability::MacOverride,
        ];
        for cap in &dangerous {
            assert!(
                !caps.contains(cap),
                "dangerous capability must be excluded: {:?}",
                cap
            );
        }
    }

    #[test]
    fn capability_names_match_default_capabilities() {
        let caps = default_capabilities();
        let names = capability_names();
        assert_eq!(caps.len(), names.len());
        for name in &names {
            assert!(
                name.starts_with("CAP_"),
                "capability name should start with CAP_: {}",
                name
            );
        }
    }

    #[test]
    fn capability_names_are_all_uppercase() {
        for name in capability_names() {
            assert_eq!(name, name.to_uppercase(), "should be uppercase: {}", name);
        }
    }
}
