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
