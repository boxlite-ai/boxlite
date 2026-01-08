//! Security configuration for the jailer.
//!
//! This module defines the security options that control how the boxlite-shim
//! process is isolated from the host system. The configuration supports both
//! Linux (seccomp, namespaces, chroot) and macOS (sandbox-exec/Seatbelt).
//!
//! ## macOS Sandbox Security Model
//!
//! On macOS, we implement a **strict whitelist-based** sandbox policy:
//!
//! - **File reads**: ONLY user-specified volume paths are allowed. NO system
//!   paths, NO ~/.boxlite access by default. This is stricter than most sandbox
//!   implementations (including Codex which allows reading everything).
//!
//! - **File writes**: Limited to:
//!   - `/tmp` and `/var/tmp` (temporary files)
//!   - `{box_dir}/shared/` (guest-visible directory only, not entire box_dir)
//!   - User volumes with `read_only=false`
//!
//! If the shim fails to start due to missing read permissions, check sandbox
//! violation logs: `log show --predicate 'subsystem == "com.apple.sandbox"'`
//! and add only the specific paths that are actually needed.

use crate::runtime::options::VolumeSpec;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Security isolation options for a box.
///
/// These options control how the boxlite-shim process is isolated from the host.
/// Different presets are available for different security requirements.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SecurityOptions {
    /// Enable jailer isolation.
    ///
    /// When true, applies platform-specific security isolation:
    /// - Linux: seccomp, namespaces, chroot, privilege drop
    /// - macOS: sandbox-exec profile
    ///
    /// Default: true on Linux, true on macOS (sandbox-exec only)
    #[serde(default = "default_jailer_enabled")]
    pub jailer_enabled: bool,

    /// Enable seccomp syscall filtering (Linux only).
    ///
    /// When true, applies a whitelist of allowed syscalls.
    /// Default: true on Linux, ignored on macOS
    #[serde(default = "default_seccomp_enabled")]
    pub seccomp_enabled: bool,

    /// UID to drop to after setup (Linux only).
    ///
    /// - None: Auto-allocate an unprivileged UID
    /// - Some(0): Don't drop privileges (not recommended)
    /// - Some(uid): Drop to specific UID
    #[serde(default)]
    pub uid: Option<u32>,

    /// GID to drop to after setup (Linux only).
    ///
    /// - None: Auto-allocate an unprivileged GID
    /// - Some(0): Don't drop privileges (not recommended)
    /// - Some(gid): Drop to specific GID
    #[serde(default)]
    pub gid: Option<u32>,

    /// Create new PID namespace (Linux only).
    ///
    /// When true, the shim becomes PID 1 in a new namespace.
    /// Default: false
    #[serde(default)]
    pub new_pid_ns: bool,

    /// Create new network namespace (Linux only).
    ///
    /// When true, creates isolated network namespace.
    /// Note: gvproxy handles networking, so this may not be needed.
    /// Default: false
    #[serde(default)]
    pub new_net_ns: bool,

    /// Base directory for chroot jails (Linux only).
    ///
    /// Default: /srv/boxlite
    #[serde(default = "default_chroot_base")]
    pub chroot_base: PathBuf,

    /// Enable chroot isolation (Linux only).
    ///
    /// When true, uses pivot_root to isolate filesystem.
    /// Default: true on Linux
    #[serde(default = "default_chroot_enabled")]
    pub chroot_enabled: bool,

    /// Close inherited file descriptors.
    ///
    /// When true, closes all FDs except stdin/stdout/stderr before VM start.
    /// Default: true
    #[serde(default = "default_close_fds")]
    pub close_fds: bool,

    /// Sanitize environment variables.
    ///
    /// When true, clears all environment variables except those in allowlist.
    /// Default: true
    #[serde(default = "default_sanitize_env")]
    pub sanitize_env: bool,

    /// Environment variables to preserve when sanitizing.
    ///
    /// Default: ["RUST_LOG", "PATH", "HOME", "USER", "LANG"]
    #[serde(default = "default_env_allowlist")]
    pub env_allowlist: Vec<String>,

    /// Resource limits to apply.
    #[serde(default)]
    pub resource_limits: ResourceLimits,

    /// Custom sandbox profile path (macOS only).
    ///
    /// If None, uses the built-in modular sandbox profile.
    #[serde(default)]
    pub sandbox_profile: Option<PathBuf>,

    /// Enable network access in sandbox (macOS only).
    ///
    /// When true, adds network policy to the sandbox.
    /// Default: true (needed for gvproxy VM networking)
    #[serde(default = "default_network_enabled")]
    pub network_enabled: bool,

    /// Volume mounts from BoxOptions (macOS sandbox path restrictions).
    ///
    /// These volumes control what the sandbox can access:
    /// - **All volumes** (read_only=true or false): Added to readable paths
    /// - **Writable volumes** (read_only=false only): Also added to writable paths
    ///
    /// ## Security Model
    ///
    /// This implements a strict whitelist - the shim can ONLY read/write paths
    /// explicitly listed here (plus /tmp, /var/tmp, and {box_dir}/shared for writes).
    ///
    /// NO system paths are allowed by default. If the shim fails to start,
    /// check sandbox logs and add minimal required paths.
    #[serde(default)]
    pub volumes: Vec<VolumeSpec>,
}

/// Resource limits for the jailed process.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ResourceLimits {
    /// Maximum number of open file descriptors (RLIMIT_NOFILE).
    #[serde(default)]
    pub max_open_files: Option<u64>,

    /// Maximum file size in bytes (RLIMIT_FSIZE).
    #[serde(default)]
    pub max_file_size: Option<u64>,

    /// Maximum number of processes (RLIMIT_NPROC).
    #[serde(default)]
    pub max_processes: Option<u64>,

    /// Maximum virtual memory in bytes (RLIMIT_AS).
    #[serde(default)]
    pub max_memory: Option<u64>,

    /// Maximum CPU time in seconds (RLIMIT_CPU).
    #[serde(default)]
    pub max_cpu_time: Option<u64>,
}

// Default value functions for serde

fn default_jailer_enabled() -> bool {
    // Enable by default on supported platforms
    cfg!(any(target_os = "linux", target_os = "macos"))
}

fn default_seccomp_enabled() -> bool {
    cfg!(target_os = "linux")
}

fn default_chroot_base() -> PathBuf {
    PathBuf::from("/srv/boxlite")
}

fn default_chroot_enabled() -> bool {
    cfg!(target_os = "linux")
}

fn default_close_fds() -> bool {
    true
}

fn default_sanitize_env() -> bool {
    true
}

fn default_env_allowlist() -> Vec<String> {
    vec![
        "RUST_LOG".to_string(),
        "PATH".to_string(),
        "HOME".to_string(),
        "USER".to_string(),
        "LANG".to_string(),
        "TERM".to_string(),
    ]
}

fn default_network_enabled() -> bool {
    // Default ON for BoxLite - needed for gvproxy VM networking
    true
}

impl Default for SecurityOptions {
    fn default() -> Self {
        Self {
            jailer_enabled: default_jailer_enabled(),
            seccomp_enabled: default_seccomp_enabled(),
            uid: None,
            gid: None,
            new_pid_ns: false,
            new_net_ns: false,
            chroot_base: default_chroot_base(),
            chroot_enabled: default_chroot_enabled(),
            close_fds: default_close_fds(),
            sanitize_env: default_sanitize_env(),
            env_allowlist: default_env_allowlist(),
            resource_limits: ResourceLimits::default(),
            sandbox_profile: None,
            network_enabled: default_network_enabled(),
            volumes: Vec::new(),
        }
    }
}

impl SecurityOptions {
    /// Development mode: minimal isolation for debugging.
    ///
    /// Use this when debugging issues where isolation interferes.
    pub fn development() -> Self {
        Self {
            jailer_enabled: false,
            seccomp_enabled: false,
            chroot_enabled: false,
            close_fds: false,
            sanitize_env: false,
            ..Default::default()
        }
    }

    /// Standard mode: recommended for most use cases.
    ///
    /// Provides good security without being overly restrictive.
    pub fn standard() -> Self {
        Self::default()
    }

    /// Maximum mode: all isolation features enabled.
    ///
    /// Use this for untrusted workloads (AI sandbox, multi-tenant).
    pub fn maximum() -> Self {
        Self {
            jailer_enabled: true,
            seccomp_enabled: cfg!(target_os = "linux"),
            uid: Some(65534), // nobody
            gid: Some(65534), // nogroup
            new_pid_ns: cfg!(target_os = "linux"),
            new_net_ns: false, // gvproxy needs network
            chroot_enabled: cfg!(target_os = "linux"),
            close_fds: true,
            sanitize_env: true,
            env_allowlist: vec!["RUST_LOG".to_string()],
            resource_limits: ResourceLimits {
                max_open_files: Some(1024),
                max_file_size: Some(1024 * 1024 * 1024), // 1GB
                max_processes: Some(100),
                max_memory: None,   // Let VM config handle this
                max_cpu_time: None, // Let VM config handle this
            },
            ..Default::default()
        }
    }

    /// Check if current platform supports full jailer features.
    pub fn is_full_isolation_available() -> bool {
        cfg!(target_os = "linux")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_options() {
        let opts = SecurityOptions::default();
        assert!(opts.close_fds);
        assert!(opts.sanitize_env);
        assert!(!opts.env_allowlist.is_empty());
    }

    #[test]
    fn test_development_mode() {
        let opts = SecurityOptions::development();
        assert!(!opts.jailer_enabled);
        assert!(!opts.seccomp_enabled);
        assert!(!opts.close_fds);
    }

    #[test]
    fn test_maximum_mode() {
        let opts = SecurityOptions::maximum();
        assert!(opts.jailer_enabled);
        assert!(opts.close_fds);
        assert!(opts.sanitize_env);
        assert_eq!(opts.uid, Some(65534));
    }

    #[test]
    fn test_serde_roundtrip() {
        let opts = SecurityOptions::maximum();
        let json = serde_json::to_string(&opts).unwrap();
        let opts2: SecurityOptions = serde_json::from_str(&json).unwrap();
        assert_eq!(opts.jailer_enabled, opts2.jailer_enabled);
        assert_eq!(opts.uid, opts2.uid);
    }
}
