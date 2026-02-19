//! Configuration for Boxlite.

use crate::runtime::constants::envs as const_envs;
use crate::runtime::layout::dirs as const_dirs;
use boxlite_shared::errors::BoxliteResult;
use dirs::home_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};

// ============================================================================
// Runtime Options
// ============================================================================
/// Configuration options for BoxliteRuntime.
///
/// Users can create it with defaults and modify fields as needed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BoxliteOptions {
    #[serde(default = "default_home_dir")]
    pub home_dir: PathBuf,
    /// Registries to search for unqualified image references.
    ///
    /// When pulling an image without a registry prefix (e.g., `"alpine"`),
    /// these registries are tried in order until one succeeds.
    ///
    /// - Empty list (default): Uses docker.io as the implicit default
    /// - Non-empty list: Tries each registry in order, first success wins
    /// - Fully qualified refs (e.g., `"quay.io/foo"`) bypass this list
    ///
    /// # Example
    ///
    /// ```ignore
    /// BoxliteOptions {
    ///     image_registries: vec![
    ///         "ghcr.io/myorg".to_string(),
    ///         "docker.io".to_string(),
    ///     ],
    ///     ..Default::default()
    /// }
    /// // "alpine" → tries ghcr.io/myorg/alpine, then docker.io/alpine
    /// ```
    #[serde(default)]
    pub image_registries: Vec<String>,
}

fn default_home_dir() -> PathBuf {
    std::env::var(const_envs::BOXLITE_HOME)
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let mut path = home_dir().unwrap_or_else(|| PathBuf::from("."));
            path.push(const_dirs::BOXLITE_DIR);
            path
        })
}

impl Default for BoxliteOptions {
    fn default() -> Self {
        Self {
            home_dir: default_home_dir(),
            image_registries: Vec::new(),
        }
    }
}

/// Options used when constructing a box.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
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

    /// Advanced options for expert users (security, mount isolation).
    ///
    /// Defaults are secure — most users can ignore this entirely.
    /// See [`AdvancedBoxOptions`] for details.
    #[serde(default)]
    pub advanced: AdvancedBoxOptions,

    /// Override the image's ENTRYPOINT directive.
    ///
    /// When set, completely replaces the image's ENTRYPOINT.
    /// Use with `cmd` to build the full command:
    ///   Final execution = entrypoint + cmd
    ///
    /// Example: For `docker:dind`, bypass the failing entrypoint script:
    ///   `entrypoint = vec!["dockerd"]`, `cmd = vec!["--iptables=false"]`
    #[serde(default)]
    pub entrypoint: Option<Vec<String>>,

    /// Override the image's CMD directive.
    ///
    /// The image ENTRYPOINT is preserved; these args replace the image's CMD.
    /// Final execution = image_entrypoint + cmd.
    ///
    /// Example: For `docker:dind` (ENTRYPOINT=["dockerd-entrypoint.sh"]),
    /// setting `cmd = vec!["--iptables=false"]` produces:
    /// `["dockerd-entrypoint.sh", "--iptables=false"]`
    #[serde(default)]
    pub cmd: Option<Vec<String>>,

    /// Username or UID (format: <name|uid>[:<group|gid>]).
    /// If None, uses the image's USER directive (defaults to root).
    #[serde(default)]
    pub user: Option<String>,
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
            auto_remove: default_auto_remove(),
            detach: default_detach(),
            advanced: AdvancedBoxOptions::default(),
            entrypoint: None,
            cmd: None,
            user: None,
        }
    }
}

impl BoxOptions {
    /// Sanitize and validate options.
    ///
    /// Validates option combinations:
    /// - `auto_remove=true` with `detach=true` is invalid (detached boxes need manual lifecycle control)
    /// - `advanced.isolate_mounts=true` is only supported on Linux
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
        if self.advanced.isolate_mounts {
            return Err(boxlite_shared::errors::BoxliteError::Unsupported(
                "isolate_mounts is only supported on Linux".to_string(),
            ));
        }
        Ok(())
    }

    /// Set security options (convenience for `advanced.security`).
    pub fn with_security(mut self, security: SecurityOptions) -> Self {
        self.advanced.security = security;
        self
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

/// Options used when importing a box archive.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportOptions {
    /// Path to a `.boxsnap` or `.boxlite` archive.
    pub archive_path: PathBuf,
}

impl ImportOptions {
    /// Create import options with the required archive path.
    pub fn new(archive_path: impl Into<PathBuf>) -> Self {
        Self {
            archive_path: archive_path.into(),
        }
    }
}

/// Options for creating a snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotOptions {
    /// Whether to quiesce guest filesystems before snapshot (default: true).
    /// Currently a no-op; reserved for future guest-side FIFREEZE support.
    pub quiesce: bool,
    /// Timeout in seconds to wait for quiesce (default: 30).
    pub quiesce_timeout_secs: u64,
    /// Whether to abort the snapshot if quiesce fails (default: true).
    pub stop_on_quiesce_fail: bool,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            quiesce: true,
            quiesce_timeout_secs: 30,
            stop_on_quiesce_fail: true,
        }
    }
}

impl SnapshotOptions {
    /// Set whether to quiesce guest filesystems before snapshot.
    pub fn quiesce(&mut self, quiesce: bool) -> &mut Self {
        self.quiesce = quiesce;
        self
    }

    /// Set the quiesce timeout in seconds.
    pub fn quiesce_timeout_secs(&mut self, secs: u64) -> &mut Self {
        self.quiesce_timeout_secs = secs;
        self
    }

    /// Set whether to abort the snapshot if quiesce fails.
    pub fn stop_on_quiesce_fail(&mut self, stop: bool) -> &mut Self {
        self.stop_on_quiesce_fail = stop;
        self
    }
}

/// Options for exporting a box archive.
#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// Whether to compress the archive with zstd (default: true).
    pub compress: bool,
    /// Zstd compression level (default: 3, range: 1-22).
    pub compression_level: i32,
    /// Whether to include metadata in the archive (default: true).
    pub include_metadata: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            compress: true,
            compression_level: 3,
            include_metadata: true,
        }
    }
}

impl ExportOptions {
    /// Set whether to compress the archive.
    pub fn compress(&mut self, compress: bool) -> &mut Self {
        self.compress = compress;
        self
    }

    /// Set the zstd compression level (1-22).
    pub fn compression_level(&mut self, level: i32) -> &mut Self {
        self.compression_level = level;
        self
    }

    /// Set whether to include metadata.
    pub fn include_metadata(&mut self, include: bool) -> &mut Self {
        self.include_metadata = include;
        self
    }
}

/// Options for cloning a box.
#[derive(Debug, Clone)]
pub struct CloneOptions {
    /// Use COW (copy-on-write) for disk images (default: true).
    /// When false, performs a full copy (flattens COW chains).
    pub cow: bool,
    /// Start the cloned box after creation (default: false).
    pub start_after_clone: bool,
    /// Create clone from a named snapshot instead of current state.
    pub from_snapshot: Option<String>,
}

impl Default for CloneOptions {
    fn default() -> Self {
        Self {
            cow: true,
            start_after_clone: false,
            from_snapshot: None,
        }
    }
}

impl CloneOptions {
    /// Set whether to use COW for disk images.
    pub fn cow(&mut self, cow: bool) -> &mut Self {
        self.cow = cow;
        self
    }

    /// Set whether to start the clone after creation.
    pub fn start_after_clone(&mut self, start: bool) -> &mut Self {
        self.start_after_clone = start;
        self
    }

    /// Create clone from a named snapshot.
    pub fn from_snapshot(&mut self, name: impl Into<String>) -> &mut Self {
        self.from_snapshot = Some(name.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::advanced_options::SecurityOptionsBuilder;

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

    // ========================================================================
    // SecurityOptionsBuilder tests
    // ========================================================================

    #[test]
    fn test_security_builder_new() {
        let opts = SecurityOptionsBuilder::new().build();
        // Default should disable jailer/seccomp unless explicitly enabled.
        assert!(!opts.jailer_enabled);
        assert!(!opts.seccomp_enabled);
    }

    #[test]
    fn test_security_builder_presets() {
        let dev = SecurityOptionsBuilder::development().build();
        assert!(!dev.jailer_enabled);
        assert!(!dev.close_fds);

        let std = SecurityOptionsBuilder::standard().build();
        assert!(std.jailer_enabled || !cfg!(any(target_os = "linux", target_os = "macos")));

        let max = SecurityOptionsBuilder::maximum().build();
        assert!(max.jailer_enabled);
        assert!(max.close_fds);
        assert!(max.sanitize_env);
    }

    #[test]
    fn test_security_builder_chaining() {
        let opts = SecurityOptionsBuilder::standard()
            .jailer_enabled(true)
            .seccomp_enabled(false)
            .max_open_files(2048)
            .max_processes(50)
            .build();

        assert!(opts.jailer_enabled);
        assert!(!opts.seccomp_enabled);
        assert_eq!(opts.resource_limits.max_open_files, Some(2048));
        assert_eq!(opts.resource_limits.max_processes, Some(50));
    }

    #[test]
    fn test_security_builder_resource_limits() {
        let opts = SecurityOptionsBuilder::new()
            .max_open_files(1024)
            .max_file_size_bytes(1024 * 1024)
            .max_processes(100)
            .max_memory_bytes(512 * 1024 * 1024)
            .max_cpu_time_seconds(300)
            .build();

        assert_eq!(opts.resource_limits.max_open_files, Some(1024));
        assert_eq!(opts.resource_limits.max_file_size, Some(1024 * 1024));
        assert_eq!(opts.resource_limits.max_processes, Some(100));
        assert_eq!(opts.resource_limits.max_memory, Some(512 * 1024 * 1024));
        assert_eq!(opts.resource_limits.max_cpu_time, Some(300));
    }

    #[test]
    fn test_security_builder_env_allowlist() {
        let opts = SecurityOptionsBuilder::new()
            .env_allowlist(vec!["FOO".to_string()])
            .allow_env("BAR")
            .allow_env("BAZ")
            .build();

        assert_eq!(opts.env_allowlist.len(), 3);
        assert!(opts.env_allowlist.contains(&"FOO".to_string()));
        assert!(opts.env_allowlist.contains(&"BAR".to_string()));
        assert!(opts.env_allowlist.contains(&"BAZ".to_string()));
    }

    #[test]
    fn test_security_builder_via_security_options() {
        // Test the convenience method on SecurityOptions
        let opts = SecurityOptions::builder().jailer_enabled(true).build();

        assert!(opts.jailer_enabled);
    }

    // ========================================================================
    // cmd/user option tests
    // ========================================================================

    #[test]
    fn test_box_options_cmd_default_is_none() {
        let opts = BoxOptions::default();
        assert!(opts.cmd.is_none());
    }

    #[test]
    fn test_box_options_user_default_is_none() {
        let opts = BoxOptions::default();
        assert!(opts.user.is_none());
    }

    #[test]
    fn test_box_options_cmd_serde_roundtrip() {
        let opts = BoxOptions {
            cmd: Some(vec!["--flag".to_string(), "value".to_string()]),
            user: Some("1000:1000".to_string()),
            ..Default::default()
        };

        let json = serde_json::to_string(&opts).unwrap();
        let opts2: BoxOptions = serde_json::from_str(&json).unwrap();

        assert_eq!(
            opts2.cmd,
            Some(vec!["--flag".to_string(), "value".to_string()])
        );
        assert_eq!(opts2.user, Some("1000:1000".to_string()));
    }

    #[test]
    fn test_box_options_cmd_serde_missing_defaults_to_none() {
        let json = r#"{
            "rootfs": {"Image": "alpine:latest"},
            "env": [],
            "volumes": [],
            "network": "Isolated",
            "ports": []
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert!(
            opts.cmd.is_none(),
            "cmd should default to None when missing from JSON"
        );
        assert!(
            opts.user.is_none(),
            "user should default to None when missing from JSON"
        );
    }

    #[test]
    fn test_box_options_cmd_explicit_in_json() {
        let json = r#"{
            "rootfs": {"Image": "docker:dind"},
            "env": [],
            "volumes": [],
            "network": "Isolated",
            "ports": [],
            "cmd": ["--iptables=false"],
            "user": "1000:1000"
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.cmd, Some(vec!["--iptables=false".to_string()]));
        assert_eq!(opts.user, Some("1000:1000".to_string()));
    }

    #[test]
    fn test_box_options_entrypoint_default_is_none() {
        let opts = BoxOptions::default();
        assert!(opts.entrypoint.is_none());
    }

    #[test]
    fn test_box_options_entrypoint_serde_roundtrip() {
        let opts = BoxOptions {
            entrypoint: Some(vec!["dockerd".to_string()]),
            cmd: Some(vec!["--iptables=false".to_string()]),
            ..Default::default()
        };

        let json = serde_json::to_string(&opts).unwrap();
        let opts2: BoxOptions = serde_json::from_str(&json).unwrap();

        assert_eq!(opts2.entrypoint, Some(vec!["dockerd".to_string()]));
        assert_eq!(opts2.cmd, Some(vec!["--iptables=false".to_string()]));
    }

    #[test]
    fn test_box_options_entrypoint_missing_defaults_to_none() {
        let json = r#"{
            "rootfs": {"Image": "alpine:latest"},
            "env": [],
            "volumes": [],
            "network": "Isolated",
            "ports": []
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert!(
            opts.entrypoint.is_none(),
            "entrypoint should default to None when missing from JSON"
        );
    }

    #[test]
    fn test_box_options_entrypoint_explicit_in_json() {
        let json = r#"{
            "rootfs": {"Image": "docker:dind"},
            "env": [],
            "volumes": [],
            "network": "Isolated",
            "ports": [],
            "entrypoint": ["dockerd"],
            "cmd": ["--iptables=false"]
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.entrypoint, Some(vec!["dockerd".to_string()]));
        assert_eq!(opts.cmd, Some(vec!["--iptables=false".to_string()]));
    }

    #[test]
    fn test_security_builder_non_consuming() {
        // Verify builder can be reused (non-consuming pattern)
        let mut builder = SecurityOptionsBuilder::standard();
        builder.max_open_files(1024);

        let opts1 = builder.build();
        let opts2 = builder.max_processes(50).build();

        // Both should have max_open_files
        assert_eq!(opts1.resource_limits.max_open_files, Some(1024));
        assert_eq!(opts2.resource_limits.max_open_files, Some(1024));

        // Only opts2 should have max_processes
        assert!(opts1.resource_limits.max_processes.is_none());
        assert_eq!(opts2.resource_limits.max_processes, Some(50));
    }
}
