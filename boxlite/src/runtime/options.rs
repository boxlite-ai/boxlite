//! Configuration for Boxlite.

use crate::runtime::constants::envs as const_envs;
use crate::runtime::layout::dirs as const_dirs;
use boxlite_shared::errors::BoxliteResult;
use dirs::home_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ============================================================================
// Security Options
// ============================================================================

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
    /// Default: false (use `SecurityOptions::standard()` or `maximum()` to enable)
    #[serde(default = "default_jailer_enabled")]
    pub jailer_enabled: bool,

    /// Enable seccomp syscall filtering (Linux only).
    ///
    /// When true, applies a whitelist of allowed syscalls.
    /// Default: false (use `SecurityOptions::standard()` or `maximum()` to enable)
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

// Default value functions for SecurityOptions

fn default_jailer_enabled() -> bool {
    false
}

fn default_seccomp_enabled() -> bool {
    false
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
    /// Enables jailer on Linux/macOS, seccomp on Linux.
    pub fn standard() -> Self {
        Self {
            jailer_enabled: cfg!(any(target_os = "linux", target_os = "macos")),
            seccomp_enabled: cfg!(target_os = "linux"),
            ..Default::default()
        }
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

// ============================================================================
// Runtime Options
// ============================================================================
/// Configuration options for BoxliteRuntime.
///
/// Users can create it with defaults and modify fields as needed.
#[derive(Clone, Debug)]
pub struct BoxliteOptions {
    pub home_dir: PathBuf,
}

impl Default for BoxliteOptions {
    fn default() -> Self {
        let home_dir = std::env::var(const_envs::BOXLITE_HOME)
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let mut path = home_dir().unwrap_or_else(|| PathBuf::from("."));
                path.push(const_dirs::BOXLITE_DIR);
                path
            });

        Self { home_dir }
    }
}

/// Options used when constructing a box.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BoxOptions {
    pub cpus: Option<u8>,
    pub memory_mib: Option<u32>,
    /// Disk size in GB for the container rootfs (sparse, grows as needed).
    ///
    /// The actual disk will be at least as large as the base image.
    /// If set, the COW overlay will have this virtual size, allowing
    /// the container to write more data than the base image size.
    pub disk_size_gb: Option<u64>,
    pub working_dir: Option<String>,
    pub env: Vec<(String, String)>,
    pub rootfs: RootfsSpec,
    pub volumes: Vec<VolumeSpec>,
    pub network: NetworkSpec,
    pub ports: Vec<PortSpec>,
    /// Enable bind mount isolation for the shared mounts directory.
    ///
    /// When true, creates a read-only bind mount from `mounts/` to `shared/`,
    /// preventing the guest from modifying host-prepared files.
    ///
    /// Requires CAP_SYS_ADMIN (privileged) or FUSE (rootless) on Linux.
    /// Defaults to false.
    #[serde(default)]
    pub isolate_mounts: bool,

    /// Automatically remove box when stopped.
    ///
    /// When true (default), the box is removed from the database and its
    /// files are deleted when `stop()` is called. This is similar to
    /// Docker's `--rm` flag.
    ///
    /// When false, the box is preserved after stop and can be restarted
    /// with `runtime.get(box_id)`.
    #[serde(default = "default_auto_remove")]
    pub auto_remove: bool,

    /// Whether the box should continue running when the parent process exits.
    ///
    /// When false (default), the box will automatically stop when the process
    /// that created it exits. This ensures orphan boxes don't accumulate.
    /// Similar to running a process in the foreground.
    ///
    /// When true, the box runs independently and survives parent process exit.
    /// The box can be reattached using `runtime.get(box_id)`. Similar to
    /// Docker's `-d` (detach) flag.
    #[serde(default = "default_detach")]
    pub detach: bool,

    /// Security isolation options for the box.
    ///
    /// Controls how the boxlite-shim process is isolated from the host.
    /// Different presets are available: `SecurityOptions::development()`,
    /// `SecurityOptions::standard()`, `SecurityOptions::maximum()`.
    #[serde(default)]
    pub security: SecurityOptions,
}

fn default_auto_remove() -> bool {
    true
}

fn default_detach() -> bool {
    false
}

impl Default for BoxOptions {
    fn default() -> Self {
        Self {
            cpus: None,
            memory_mib: None,
            disk_size_gb: None,
            working_dir: None,
            env: Vec::new(),
            rootfs: RootfsSpec::default(),
            volumes: Vec::new(),
            network: NetworkSpec::default(),
            ports: Vec::new(),
            isolate_mounts: false,
            auto_remove: default_auto_remove(),
            detach: default_detach(),
            security: SecurityOptions::default(),
        }
    }
}

impl BoxOptions {
    /// Sanitize and validate options.
    ///
    /// Validates option combinations:
    /// - `auto_remove=true` with `detach=true` is invalid (detached boxes need manual lifecycle control)
    /// - `isolate_mounts=true` is only supported on Linux
    pub fn sanitize(&self) -> BoxliteResult<()> {
        // Validate auto_remove + detach combination
        // A detached box that auto-removes doesn't make practical sense:
        // - detach=true: box survives parent exit
        // - auto_remove=true: box removed on stop
        // This combination is confusing - detached boxes should have manual lifecycle control
        if self.auto_remove && self.detach {
            return Err(boxlite_shared::errors::BoxliteError::Config(
                "auto_remove=true is incompatible with detach=true. \
                 Detached boxes should use auto_remove=false for manual lifecycle control."
                    .to_string(),
            ));
        }

        #[cfg(not(target_os = "linux"))]
        if self.isolate_mounts {
            return Err(boxlite_shared::errors::BoxliteError::Unsupported(
                "isolate_mounts is only supported on Linux".to_string(),
            ));
        }
        Ok(())
    }
}

/// How to populate the box root filesystem.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum RootfsSpec {
    /// Pull/resolve this registry image reference.
    Image(String),
    /// Use an already prepared rootfs at the given host path.
    RootfsPath(String),
}

impl Default for RootfsSpec {
    fn default() -> Self {
        Self::Image("alpine:latest".into())
    }
}

/// Filesystem mount specification.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct VolumeSpec {
    pub host_path: String,
    pub guest_path: String,
    pub read_only: bool,
}

/// Network isolation options.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum NetworkSpec {
    #[default]
    Isolated,
    // Host,
    // Custom(String),
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum PortProtocol {
    #[default]
    Tcp,
    Udp,
    // Sctp,
}

fn default_protocol() -> PortProtocol {
    PortProtocol::Tcp
}

/// Port mapping specification (host -> guest).
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct PortSpec {
    pub host_port: Option<u16>, // None/0 => dynamically assigned
    pub guest_port: u16,
    #[serde(default = "default_protocol")]
    pub protocol: PortProtocol,
    pub host_ip: Option<String>, // Optional bind IP, defaults to 0.0.0.0/:: if None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_box_options_defaults() {
        let opts = BoxOptions::default();
        assert!(opts.auto_remove, "auto_remove should default to true");
        assert!(!opts.detach, "detach should default to false");
    }

    #[test]
    fn test_box_options_serde_defaults() {
        // Test that serde uses correct defaults for missing fields
        // Must include all required fields that don't have serde defaults
        let json = r#"{
            "rootfs": {"Image": "alpine:latest"},
            "env": [],
            "volumes": [],
            "network": "Isolated",
            "ports": []
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert!(
            opts.auto_remove,
            "auto_remove should default to true via serde"
        );
        assert!(!opts.detach, "detach should default to false via serde");
    }

    #[test]
    fn test_box_options_serde_explicit_values() {
        let json = r#"{
            "rootfs": {"Image": "alpine"},
            "env": [],
            "volumes": [],
            "network": "Isolated",
            "ports": [],
            "auto_remove": false,
            "detach": true
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert!(
            !opts.auto_remove,
            "explicit auto_remove=false should be respected"
        );
        assert!(opts.detach, "explicit detach=true should be respected");
    }

    #[test]
    fn test_box_options_roundtrip() {
        let opts = BoxOptions {
            auto_remove: false,
            detach: true,
            ..Default::default()
        };

        let json = serde_json::to_string(&opts).unwrap();
        let opts2: BoxOptions = serde_json::from_str(&json).unwrap();

        assert_eq!(opts.auto_remove, opts2.auto_remove);
        assert_eq!(opts.detach, opts2.detach);
    }

    #[test]
    fn test_sanitize_auto_remove_detach_incompatible() {
        // auto_remove=true + detach=true is invalid
        let opts = BoxOptions {
            auto_remove: true,
            detach: true,
            ..Default::default()
        };
        let result = opts.sanitize();
        assert!(
            result.is_err(),
            "auto_remove=true + detach=true should fail"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("incompatible"),
            "Error should mention incompatibility"
        );
    }

    #[test]
    fn test_sanitize_valid_combinations() {
        // auto_remove=true, detach=false (default) - valid
        let opts1 = BoxOptions {
            auto_remove: true,
            detach: false,
            ..Default::default()
        };
        assert!(opts1.sanitize().is_ok());

        // auto_remove=false, detach=true - valid
        let opts2 = BoxOptions {
            auto_remove: false,
            detach: true,
            ..Default::default()
        };
        assert!(opts2.sanitize().is_ok());

        // auto_remove=false, detach=false - valid
        let opts3 = BoxOptions {
            auto_remove: false,
            detach: false,
            ..Default::default()
        };
        assert!(opts3.sanitize().is_ok());
    }
}
