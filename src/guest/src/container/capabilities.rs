//! Linux capabilities
//!
//! Single source of truth for all 41 Linux capabilities.
//! Used by:
//! - OCI spec builder (process.capabilities)
//! - Tenant process spawning (exec capabilities)

use oci_spec::runtime::Capability;
use std::collections::HashSet;

/// Get all 41 Linux capabilities as a HashSet
///
/// This is the single source of truth for capabilities in the system.
/// Returns all capabilities for maximum compatibility.
///
/// # Security Note
/// This provides maximum compatibility but reduced security isolation.
/// For production, consider limiting to required capabilities only.
pub fn all_capabilities() -> HashSet<Capability> {
    [
        // File operations (CAP 0-4)
        Capability::Chown,         // 0: chown files
        Capability::DacOverride,   // 1: bypass file read/write/execute permissions
        Capability::DacReadSearch, // 2: bypass file read permission and directory read/execute
        Capability::Fowner,        // 3: bypass file owner checks
        Capability::Fsetid,        // 4: preserve setuid/setgid bits
        // Process capabilities (CAP 5-9)
        Capability::Kill,           // 5: send signals to any process
        Capability::Setgid,         // 6: manipulate process GIDs
        Capability::Setuid,         // 7: manipulate process UIDs
        Capability::Setpcap,        // 8: modify capabilities
        Capability::LinuxImmutable, // 9: set immutable/append-only flags
        // Network capabilities (CAP 10-13)
        Capability::NetBindService, // 10: bind to privileged ports (<1024)
        Capability::NetBroadcast,   // 11: broadcast/multicast
        Capability::NetAdmin,       // 12: network administration
        Capability::NetRaw,         // 13: use RAW/PACKET sockets
        // IPC capabilities (CAP 14-15)
        Capability::IpcLock,  // 14: lock memory
        Capability::IpcOwner, // 15: bypass IPC ownership checks
        // System operations (CAP 16-26)
        Capability::SysModule,    // 16: load/unload kernel modules
        Capability::SysRawio,     // 17: perform I/O port operations
        Capability::SysChroot,    // 18: use chroot()
        Capability::SysPtrace,    // 19: trace processes
        Capability::SysPacct,     // 20: process accounting
        Capability::SysAdmin,     // 21: various admin operations
        Capability::SysBoot,      // 22: reboot system
        Capability::SysNice,      // 23: modify process priorities
        Capability::SysResource,  // 24: set resource limits
        Capability::SysTime,      // 25: set system clock
        Capability::SysTtyConfig, // 26: configure TTY devices
        // Device operations (CAP 27)
        Capability::Mknod, // 27: create special files
        // File leases (CAP 28)
        Capability::Lease, // 28: establish leases on files
        // Audit capabilities (CAP 29-30)
        Capability::AuditWrite,   // 29: write audit logs
        Capability::AuditControl, // 30: control audit subsystem
        // Filesystem capabilities (CAP 31)
        Capability::Setfcap, // 31: set file capabilities
        // MAC (CAP 32-33)
        Capability::MacOverride, // 32: override MAC
        Capability::MacAdmin,    // 33: configure MAC
        // Modern capabilities (CAP 34-40)
        Capability::Syslog,            // 34: perform privileged syslog operations
        Capability::WakeAlarm,         // 35: trigger system wake alarms
        Capability::BlockSuspend,      // 36: prevent system suspend
        Capability::AuditRead,         // 37: read audit logs
        Capability::Perfmon,           // 38: performance monitoring (Linux 5.8+)
        Capability::Bpf,               // 39: BPF operations (Linux 5.8+)
        Capability::CheckpointRestore, // 40: checkpoint/restore (Linux 5.9+)
    ]
    .into_iter()
    .collect()
}

/// Convert capabilities to string names for libcontainer API
///
/// Returns capability names in "CAP_NAME" format (e.g., "CAP_CHOWN").
pub fn capability_names() -> Vec<String> {
    vec![
        // File operations (CAP 0-4)
        "CAP_CHOWN".to_string(),
        "CAP_DAC_OVERRIDE".to_string(),
        "CAP_DAC_READ_SEARCH".to_string(),
        "CAP_FOWNER".to_string(),
        "CAP_FSETID".to_string(),
        // Process capabilities (CAP 5-9)
        "CAP_KILL".to_string(),
        "CAP_SETGID".to_string(),
        "CAP_SETUID".to_string(),
        "CAP_SETPCAP".to_string(),
        "CAP_LINUX_IMMUTABLE".to_string(),
        // Network capabilities (CAP 10-13)
        "CAP_NET_BIND_SERVICE".to_string(),
        "CAP_NET_BROADCAST".to_string(),
        "CAP_NET_ADMIN".to_string(),
        "CAP_NET_RAW".to_string(),
        // IPC capabilities (CAP 14-15)
        "CAP_IPC_LOCK".to_string(),
        "CAP_IPC_OWNER".to_string(),
        // System operations (CAP 16-26)
        "CAP_SYS_MODULE".to_string(),
        "CAP_SYS_RAWIO".to_string(),
        "CAP_SYS_CHROOT".to_string(),
        "CAP_SYS_PTRACE".to_string(),
        "CAP_SYS_PACCT".to_string(),
        "CAP_SYS_ADMIN".to_string(),
        "CAP_SYS_BOOT".to_string(),
        "CAP_SYS_NICE".to_string(),
        "CAP_SYS_RESOURCE".to_string(),
        "CAP_SYS_TIME".to_string(),
        "CAP_SYS_TTY_CONFIG".to_string(),
        // Device operations (CAP 27)
        "CAP_MKNOD".to_string(),
        // File leases (CAP 28)
        "CAP_LEASE".to_string(),
        // Audit capabilities (CAP 29-30)
        "CAP_AUDIT_WRITE".to_string(),
        "CAP_AUDIT_CONTROL".to_string(),
        // Filesystem capabilities (CAP 31)
        "CAP_SETFCAP".to_string(),
        // MAC (CAP 32-33)
        "CAP_MAC_OVERRIDE".to_string(),
        "CAP_MAC_ADMIN".to_string(),
        // Modern capabilities (CAP 34-40)
        "CAP_SYSLOG".to_string(),
        "CAP_WAKE_ALARM".to_string(),
        "CAP_BLOCK_SUSPEND".to_string(),
        "CAP_AUDIT_READ".to_string(),
        "CAP_PERFMON".to_string(),
        "CAP_BPF".to_string(),
        "CAP_CHECKPOINT_RESTORE".to_string(),
    ]
}
