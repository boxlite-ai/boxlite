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
