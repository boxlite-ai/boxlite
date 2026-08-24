//! Advanced options for expert users.
//!
//! This module contains [`AdvancedBoxOptions`], [`ContainerCapabilities`],
//! [`SecurityOptions`], [`ResourceLimits`], and [`SecurityOptionsBuilder`] —
//! configuration that entry-level users can safely ignore. Defaults prioritize
//! compatibility. Direct custom-kernel boot is also grouped here because it
//! changes the VM boot contract.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

// ============================================================================
// Health Check Options
// ============================================================================

/// Health check options for boxes.
///
/// Defines how to periodically check if a box's guest agent is responsive.
/// Similar to Docker's HEALTHCHECK directive.
///
/// This is an advanced option - most users should rely on the defaults.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct HealthCheckOptions {
    /// Time between health checks.
    ///
    /// Default: 30 seconds
    #[serde(default = "default_health_interval")]
    pub interval: Duration,

    /// Time to wait before considering the check failed.
    ///
    /// Default: 10 seconds
    #[serde(default = "default_health_timeout")]
    pub timeout: Duration,

    /// Number of consecutive failures before marking as unhealthy.
    ///
    /// Default: 3
    #[serde(default = "default_health_retries")]
    pub retries: u32,

    /// Startup period before health checks count toward failures.
    ///
    /// During this period, failures don't count toward the retry limit.
    /// This gives the box time to boot up before being marked unhealthy.
    ///
    /// Default: 60 seconds
    #[serde(default = "default_health_start_period")]
    pub start_period: Duration,
}

fn default_health_interval() -> Duration {
    Duration::from_secs(30)
}

fn default_health_timeout() -> Duration {
    Duration::from_secs(10)
}

fn default_health_retries() -> u32 {
    3
}

fn default_health_start_period() -> Duration {
    Duration::from_secs(60)
}

impl Default for HealthCheckOptions {
    fn default() -> Self {
        Self {
            interval: default_health_interval(),
            timeout: default_health_timeout(),
            retries: default_health_retries(),
            start_period: default_health_start_period(),
        }
    }
}

// ============================================================================
// Security Options
// ============================================================================

/// Security isolation options for a box.
///
/// These options control how the boxlite-shim process is isolated from the host.
/// Different presets are available for different security requirements.
/// `#[serde(default)]` is at the struct level on purpose: any field missing
/// from the input falls back to `SecurityOptions::default()`, so deserializing
/// `{}` is identical to `SecurityOptions::default()`. There is exactly one
/// source of truth for "the default profile" — the `Default` impl below — and
/// `deserializing_empty_equals_default` pins it. (Previously each field carried
/// its own `#[serde(default = "...")]`, which silently diverged from `Default`
/// and let a partial JSON body land a *weaker* sandbox than `default()`.)
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SecurityOptions {
    /// Enable jailer isolation.
    ///
    /// When true, applies platform-specific security isolation:
    /// - Linux: seccomp, namespaces, chroot, privilege drop
    /// - macOS: sandbox-exec profile
    ///
    /// Default: on for Linux and macOS (see `SecurityOptions::default`).
    pub jailer_enabled: bool,

    /// Enable seccomp syscall filtering (Linux only).
    ///
    /// When true, applies a whitelist of allowed syscalls.
    pub seccomp_enabled: bool,

    /// UID to drop to after setup (Linux only).
    ///
    /// - None: Auto-allocate an unprivileged UID
    /// - Some(0): Don't drop privileges (not recommended)
    /// - Some(uid): Drop to specific UID
    pub uid: Option<u32>,

    /// GID to drop to after setup (Linux only).
    ///
    /// - None: Auto-allocate an unprivileged GID
    /// - Some(0): Don't drop privileges (not recommended)
    /// - Some(gid): Drop to specific GID
    pub gid: Option<u32>,

    /// Create new PID namespace (Linux only).
    ///
    /// When true, the shim becomes PID 1 in a new namespace.
    pub new_pid_ns: bool,

    /// Create new network namespace (Linux only).
    ///
    /// When true, creates isolated network namespace.
    /// Note: gvproxy handles networking, so this may not be needed.
    pub new_net_ns: bool,

    /// Base directory for chroot jails (Linux only).
    ///
    /// Default: /srv/boxlite
    pub chroot_base: PathBuf,

    /// Enable chroot isolation (Linux only).
    ///
    /// When true, uses pivot_root to isolate filesystem.
    pub chroot_enabled: bool,

    /// Close inherited file descriptors.
    ///
    /// When true, closes all FDs except stdin/stdout/stderr before VM start.
    pub close_fds: bool,

    /// Sanitize environment variables.
    ///
    /// When true, clears all environment variables except those in allowlist.
    pub sanitize_env: bool,

    /// Environment variables to preserve when sanitizing.
    ///
    /// See `SecurityOptions::default` for the default allowlist.
    pub env_allowlist: Vec<String>,

    /// Resource limits to apply.
    pub resource_limits: ResourceLimits,

    /// Custom sandbox profile path (macOS only).
    ///
    /// If None, uses the built-in modular sandbox profile.
    pub sandbox_profile: Option<PathBuf>,

    /// Allow network access inside the sandbox profile.
    ///
    /// Cross-platform: feeds the macOS seatbelt network policy and the Linux
    /// landlock TCP rules (false = deny all TCP).
    /// Default: true (needed for gvproxy VM networking).
    pub network_enabled: bool,
}

/// Resource limits for the jailed process.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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

// Internal helpers shared by `Default` and `disabled()`. The per-field serde
// defaults were removed in favour of the struct-level `#[serde(default)]`, so
// `Default` (below) is now the single source of truth for the default profile.

fn default_chroot_base() -> PathBuf {
    PathBuf::from("/srv/boxlite")
}

fn default_network_enabled() -> bool {
    true
}

impl Default for SecurityOptions {
    /// Default is the fully-enabled profile: secure by default.
    /// `enabled()` and `disabled()` are the two named starting profiles;
    /// callers needing something in between override individual fields (or use
    /// the builder / per-field FFI setters) on top of a profile.
    fn default() -> Self {
        Self {
            jailer_enabled: true,
            seccomp_enabled: cfg!(target_os = "linux"),
            uid: Some(65534), // nobody
            gid: Some(65534), // nogroup
            new_pid_ns: cfg!(target_os = "linux"),
            new_net_ns: false, // gvproxy provides networking
            chroot_base: default_chroot_base(),
            chroot_enabled: cfg!(target_os = "linux"),
            close_fds: true,
            sanitize_env: true,
            env_allowlist: vec!["RUST_LOG".to_string()],
            resource_limits: ResourceLimits {
                max_open_files: Some(1024),
                max_file_size: Some(1024 * 1024 * 1024), // 1GB
                // Per-box cgroup `pids.max` — the fork-bomb cap for the box's
                // host-side process tree (bwrap + shim + libkrun/gvproxy
                // threads), which sits well under this. Deliberately does NOT
                // set RLIMIT_NPROC anymore: that is per-host-UID and broke box
                // spawn on busy hosts (see jailer::common::rlimit::apply_limits_raw).
                max_processes: Some(1024),
                max_memory: None,   // VM config handles this
                max_cpu_time: None, // VM config handles this
            },
            sandbox_profile: None,
            network_enabled: default_network_enabled(),
        }
    }
}

impl SecurityOptions {
    /// Enabled ("enable"): full host isolation. This is the default — every
    /// protection the platform supports is on (jailer master switch + seccomp,
    /// chroot, new PID ns on Linux; unprivileged uid/gid; closed fds; sanitized
    /// env; resource limits).
    pub fn enabled() -> Self {
        Self::default()
    }

    /// Disabled: the jailer master switch is off and every sub-protection is
    /// off too. The opt-out for debugging / environments that can't sandbox.
    pub fn disabled() -> Self {
        Self {
            jailer_enabled: false,
            seccomp_enabled: false,
            uid: None,
            gid: None,
            new_pid_ns: false,
            new_net_ns: false,
            chroot_base: default_chroot_base(),
            chroot_enabled: false,
            close_fds: false,
            sanitize_env: false,
            env_allowlist: Vec::new(),
            resource_limits: ResourceLimits::default(),
            sandbox_profile: None,
            network_enabled: default_network_enabled(),
        }
    }

    /// Resolve one of the two named profiles by name (case-insensitive). Accepts
    /// `enable`/`enabled`/`on` and `disable`/`disabled`/`off`; anything else is
    /// an `InvalidArgument` so operator surfaces echo the typo back verbatim.
    /// This selects a starting profile; finer customization is done by setting
    /// individual fields on the result.
    pub fn from_preset(name: &str) -> boxlite_shared::errors::BoxliteResult<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "enable" | "enabled" | "on" => Ok(Self::enabled()),
            "disable" | "disabled" | "off" => Ok(Self::disabled()),
            other => Err(boxlite_shared::errors::BoxliteError::InvalidArgument(
                format!("unknown security setting {other:?}; expected one of enable|disable"),
            )),
        }
    }

    /// Check if current platform supports full jailer features.
    pub fn is_full_isolation_available() -> bool {
        cfg!(target_os = "linux")
    }

    /// Warn about fields set on this profile that the current platform silently
    /// ignores. The struct is a flat bag mixing Linux-only and macOS-only knobs;
    /// without this, a caller enabling e.g. `seccomp_enabled` on macOS gets no
    /// signal that it did nothing. Called at the jailer apply boundary.
    ///
    /// uid/gid are intentionally not warned on: `default()` sets them on every
    /// platform, so flagging them would fire on the default profile and be noise.
    pub fn warn_inert_fields(&self) {
        #[cfg(not(target_os = "linux"))]
        {
            let mut ignored = Vec::new();
            if self.seccomp_enabled {
                ignored.push("seccomp_enabled");
            }
            if self.new_pid_ns {
                ignored.push("new_pid_ns");
            }
            if self.new_net_ns {
                ignored.push("new_net_ns");
            }
            if self.chroot_enabled {
                ignored.push("chroot_enabled");
            }
            if !ignored.is_empty() {
                tracing::warn!(
                    ?ignored,
                    "SecurityOptions: Linux-only isolation requested but ignored on this non-Linux platform"
                );
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            if self.sandbox_profile.is_some() {
                tracing::warn!(
                    "SecurityOptions: sandbox_profile is macOS-only and ignored on this platform"
                );
            }
        }
    }

    /// Create a builder for customizing security options.
    ///
    /// Starts from `SecurityOptions::default()` (the fully-enabled profile).
    ///
    /// # Example
    ///
    /// ```
    /// use boxlite::runtime::advanced_options::SecurityOptions;
    ///
    /// let security = SecurityOptions::builder()
    ///     .max_open_files(1024)
    ///     .build();
    /// ```
    pub fn builder() -> SecurityOptionsBuilder {
        SecurityOptionsBuilder::new()
    }
}

// ============================================================================
// Security Options Builder (C-BUILDER: Non-consuming builder pattern)
// ============================================================================

/// Builder for customizing [`SecurityOptions`].
///
/// Provides a fluent API for configuring security isolation options.
/// Uses non-consuming methods per Rust API guidelines (C-BUILDER).
///
/// # Example
///
/// ```
/// use boxlite::runtime::advanced_options::SecurityOptionsBuilder;
///
/// let security = SecurityOptionsBuilder::enabled()
///     .max_open_files(2048)
///     .max_file_size_bytes(1024 * 1024 * 512) // 512 MiB
///     .build();
/// ```
#[derive(Debug, Clone)]
pub struct SecurityOptionsBuilder {
    inner: SecurityOptions,
}

impl Default for SecurityOptionsBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl SecurityOptionsBuilder {
    /// Create a builder starting from default options.
    pub fn new() -> Self {
        Self {
            inner: SecurityOptions::default(),
        }
    }

    /// Create a builder starting from the fully-enabled profile (the default).
    pub fn enabled() -> Self {
        Self {
            inner: SecurityOptions::enabled(),
        }
    }

    /// Create a builder starting from the disabled profile (master switch off,
    /// every sub-protection off).
    pub fn disabled() -> Self {
        Self {
            inner: SecurityOptions::disabled(),
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Core isolation settings
    // ─────────────────────────────────────────────────────────────────────

    /// Enable or disable jailer isolation.
    pub fn jailer_enabled(&mut self, enabled: bool) -> &mut Self {
        self.inner.jailer_enabled = enabled;
        self
    }

    /// Enable or disable seccomp syscall filtering (Linux only).
    pub fn seccomp_enabled(&mut self, enabled: bool) -> &mut Self {
        self.inner.seccomp_enabled = enabled;
        self
    }

    /// Set UID to drop to after setup (Linux only).
    pub fn uid(&mut self, uid: u32) -> &mut Self {
        self.inner.uid = Some(uid);
        self
    }

    /// Set GID to drop to after setup (Linux only).
    pub fn gid(&mut self, gid: u32) -> &mut Self {
        self.inner.gid = Some(gid);
        self
    }

    /// Enable or disable new PID namespace (Linux only).
    pub fn new_pid_ns(&mut self, enabled: bool) -> &mut Self {
        self.inner.new_pid_ns = enabled;
        self
    }

    /// Enable or disable new network namespace (Linux only).
    pub fn new_net_ns(&mut self, enabled: bool) -> &mut Self {
        self.inner.new_net_ns = enabled;
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Filesystem isolation
    // ─────────────────────────────────────────────────────────────────────

    /// Set base directory for chroot jails (Linux only).
    pub fn chroot_base(&mut self, path: impl Into<PathBuf>) -> &mut Self {
        self.inner.chroot_base = path.into();
        self
    }

    /// Enable or disable chroot isolation (Linux only).
    pub fn chroot_enabled(&mut self, enabled: bool) -> &mut Self {
        self.inner.chroot_enabled = enabled;
        self
    }

    /// Enable or disable closing inherited file descriptors.
    pub fn close_fds(&mut self, enabled: bool) -> &mut Self {
        self.inner.close_fds = enabled;
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Environment settings
    // ─────────────────────────────────────────────────────────────────────

    /// Enable or disable environment variable sanitization.
    pub fn sanitize_env(&mut self, enabled: bool) -> &mut Self {
        self.inner.sanitize_env = enabled;
        self
    }

    /// Set environment variables to preserve when sanitizing.
    pub fn env_allowlist(&mut self, vars: Vec<String>) -> &mut Self {
        self.inner.env_allowlist = vars;
        self
    }

    /// Add an environment variable to the allowlist.
    pub fn allow_env(&mut self, var: impl Into<String>) -> &mut Self {
        self.inner.env_allowlist.push(var.into());
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Resource limits (type-safe setters)
    // ─────────────────────────────────────────────────────────────────────

    /// Set all resource limits at once.
    pub fn resource_limits(&mut self, limits: ResourceLimits) -> &mut Self {
        self.inner.resource_limits = limits;
        self
    }

    /// Set maximum number of open file descriptors.
    pub fn max_open_files(&mut self, limit: u64) -> &mut Self {
        self.inner.resource_limits.max_open_files = Some(limit);
        self
    }

    /// Set maximum file size in bytes.
    pub fn max_file_size_bytes(&mut self, bytes: u64) -> &mut Self {
        self.inner.resource_limits.max_file_size = Some(bytes);
        self
    }

    /// Set maximum number of processes.
    pub fn max_processes(&mut self, limit: u64) -> &mut Self {
        self.inner.resource_limits.max_processes = Some(limit);
        self
    }

    /// Set maximum virtual memory in bytes.
    pub fn max_memory_bytes(&mut self, bytes: u64) -> &mut Self {
        self.inner.resource_limits.max_memory = Some(bytes);
        self
    }

    /// Set maximum CPU time in seconds.
    pub fn max_cpu_time_seconds(&mut self, seconds: u64) -> &mut Self {
        self.inner.resource_limits.max_cpu_time = Some(seconds);
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // macOS-specific settings
    // ─────────────────────────────────────────────────────────────────────

    /// Set custom sandbox profile path (macOS only).
    pub fn sandbox_profile(&mut self, path: impl Into<PathBuf>) -> &mut Self {
        self.inner.sandbox_profile = Some(path.into());
        self
    }

    /// Allow or deny network access inside the sandbox profile (Linux landlock
    /// + macOS seatbelt).
    pub fn network_enabled(&mut self, enabled: bool) -> &mut Self {
        self.inner.network_enabled = enabled;
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Build
    // ─────────────────────────────────────────────────────────────────────

    /// Build the configured [`SecurityOptions`].
    pub fn build(&self) -> SecurityOptions {
        self.inner.clone()
    }
}

// ============================================================================
// Advanced Options
// ============================================================================

/// Linux capability policy for the container process.
///
/// Capability names are case-insensitive and may include the `CAP_` prefix.
/// The special value `ALL` is accepted in either list. For named conflicts an
/// explicit addition wins; with `add = ["ALL"]`, named removals win. With
/// `drop = ["ALL"]`, explicit additions form the complete resulting set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ContainerCapabilities {
    /// Capabilities to add to BoxLite's Docker-compatible baseline.
    pub add: Vec<String>,

    /// Capabilities to remove from the resulting capability set.
    pub drop: Vec<String>,
}

impl ContainerCapabilities {
    /// Whether this policy leaves the default capability set unchanged.
    pub fn is_empty(&self) -> bool {
        self.add.is_empty() && self.drop.is_empty()
    }

    pub(crate) fn is_privileged_capability_shape(&self) -> bool {
        self.drop.is_empty()
            && self.add.len() == 1
            && canonical_capability_name(&self.add[0]) == "ALL"
    }

    pub(crate) fn validate(&self) -> boxlite_shared::errors::BoxliteResult<()> {
        validate_capability_names("advanced.capabilities.add", &self.add)?;
        validate_capability_names("advanced.capabilities.drop", &self.drop)
    }

    /// Check the requested policy against the one recorded for an existing box.
    pub(crate) fn check_compatibility(
        &self,
        actual: &Self,
        box_name: &str,
    ) -> boxlite_shared::errors::BoxliteResult<()> {
        let canonicalize = |capabilities: &[String]| {
            capabilities
                .iter()
                .map(|capability| canonical_capability_name(capability))
                .collect::<std::collections::BTreeSet<_>>()
        };

        if canonicalize(&self.add) == canonicalize(&actual.add)
            && canonicalize(&self.drop) == canonicalize(&actual.drop)
        {
            return Ok(());
        }

        Err(boxlite_shared::errors::BoxliteError::InvalidArgument(
            format!(
                "box '{box_name}' already exists with a different capability policy; reuse it \
                 with the same advanced.capabilities, or create a box under a new name"
            ),
        ))
    }
}

/// Uppercase a capability and strip its optional `CAP_` prefix.
///
/// Validation and reuse comparison share one canonical form so they cannot
/// disagree about whether `net_raw` and `CAP_NET_RAW` are the same policy.
fn canonical_capability_name(capability: &str) -> String {
    let normalized = capability.to_ascii_uppercase();
    normalized
        .strip_prefix("CAP_")
        .unwrap_or(&normalized)
        .to_string()
}

fn validate_capability_names(
    option: &str,
    capabilities: &[String],
) -> boxlite_shared::errors::BoxliteResult<()> {
    for capability in capabilities {
        let name = canonical_capability_name(capability);
        if name == "ALL" {
            continue;
        }

        if name.is_empty() {
            return Err(boxlite_shared::errors::BoxliteError::InvalidArgument(
                format!("empty Linux capability in {option}"),
            ));
        }
        let mut bytes = name.bytes();
        let starts_with_letter = bytes.next().is_some_and(|byte| byte.is_ascii_uppercase());
        let has_valid_tail =
            bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
        if !starts_with_letter || !has_valid_tail {
            return Err(boxlite_shared::errors::BoxliteError::InvalidArgument(
                format!("malformed Linux capability in {option}: {capability}"),
            ));
        }
    }

    Ok(())
}

/// Advanced options for expert users.
///
/// Entry-level users can ignore this — the defaults are secure and sensible.
/// Only modify these if you understand the security implications.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AdvancedBoxOptions {
    /// Linux capability policy for the container process.
    #[serde(default)]
    pub capabilities: ContainerCapabilities,

    /// Security isolation options (jailer, seccomp, namespaces, resource limits).
    ///
    /// Secure by default: the default is the fully-enabled profile
    /// (`SecurityOptions::default() == SecurityOptions::enabled()`) — on Linux
    /// that is jailer + seccomp + new PID ns + chroot + unprivileged uid/gid; on
    /// macOS, sandbox-exec. Named profiles:
    /// - `SecurityOptions::enabled()` (== `default()`) — full isolation
    /// - `SecurityOptions::disabled()` — master switch off, all sub-protections off
    ///
    /// For anything in between, override individual fields on top of a profile.
    #[serde(default)]
    pub security: SecurityOptions,

    /// Enable bind mount isolation for the shared mounts directory.
    ///
    /// When true, creates a read-only bind mount from `mounts/` to `shared/`,
    /// preventing the guest from modifying host-prepared files.
    ///
    /// Requires CAP_SYS_ADMIN (privileged) or FUSE (rootless) on Linux.
    /// Defaults to false.
    #[serde(default)]
    pub isolate_mounts: bool,

    /// Health check options.
    ///
    /// When set, a background task will periodically ping the guest agent
    /// to verify the box is healthy. Unhealthy boxes are marked and can
    /// trigger automatic recovery.
    ///
    /// Most users should rely on the defaults.
    #[serde(default)]
    pub health_check: Option<HealthCheckOptions>,

    /// Release-candidate direct Linux boot configuration.
    ///
    /// The runtime must explicitly enable
    /// [`ExperimentalFeature::CustomKernel`](crate::experimental::ExperimentalFeature::CustomKernel).
    #[doc(hidden)]
    #[serde(default)]
    pub kernel: Option<crate::experimental::custom_kernel::KernelOptions>,

    /// Release-candidate nested virtualization.
    ///
    /// The runtime must explicitly enable
    /// [`ExperimentalFeature::NestedVirtualization`](crate::experimental::ExperimentalFeature::NestedVirtualization).
    #[doc(hidden)]
    #[serde(default)]
    pub nested_virtualization: bool,

    /// Docker-style privileged OCI spec shape for DinD.
    #[serde(default)]
    pub privileged: bool,
}

impl AdvancedBoxOptions {
    /// Reject capability overrides that conflict with privileged mode.
    ///
    /// The canonical `add=["ALL"]` shape is allowed for persisted and FFI
    /// options that have already been normalized. Other explicit overrides
    /// must not be silently discarded by privileged mode.
    pub(crate) fn validate_privileged_capability_conflict(
        &self,
    ) -> boxlite_shared::errors::BoxliteResult<()> {
        if self.privileged
            && !self.capabilities.is_empty()
            && !self.capabilities.is_privileged_capability_shape()
        {
            return Err(boxlite_shared::errors::BoxliteError::InvalidArgument(
                "privileged mode cannot be combined with cap_add or cap_drop".to_string(),
            ));
        }

        Ok(())
    }

    /// Toggle privileged mode, keeping the capability policy consistent in
    /// both directions.
    ///
    /// Enabling expands to the canonical shape; disabling withdraws it again,
    /// so a handle that is toggled off does not leave a non-privileged box
    /// holding `ALL`. An explicit policy the caller set themselves is left
    /// alone — only the shape this method produced is taken back.
    pub fn set_privileged(&mut self, enabled: bool) {
        self.privileged = enabled;

        if enabled {
            self.normalize_privileged();
        } else if self.capabilities.is_privileged_capability_shape() {
            self.capabilities = ContainerCapabilities::default();
        }
    }

    /// Expand the high-level privileged mode into the explicit capability
    /// policy consumed by the guest. Call
    /// `validate_privileged_capability_conflict` before this method; a
    /// conflicting explicit override is deliberately left untouched so it
    /// cannot be silently discarded.
    pub(crate) fn normalize_privileged(&mut self) {
        if self.privileged
            && (self.capabilities.is_empty() || self.capabilities.is_privileged_capability_shape())
        {
            self.capabilities.add = vec!["ALL".to_string()];
            self.capabilities.drop.clear();
        }
    }

    /// Resolve the container security request before it crosses into the guest.
    ///
    /// The host owns the public option semantics *and* the literal OCI values
    /// that follow from it — the readonly-path list and the `/sys` bind's
    /// mount options are resolved here, not re-derived by the guest from a
    /// flag (see docs/architecture/privileged-mode-design.md, Trade-offs,
    /// option F). Masked paths are deliberately not part of this: nothing in
    /// DinD reads a masked path, so the guest keeps applying its own oci-spec
    /// default unconditionally, the same way it did before `privileged`
    /// existed — see the Trade-offs note on the finding that motivated
    /// dropping it. The guest still resolves the canonical capability names
    /// against its own kernel ceiling, but it must not reinterpret
    /// `privileged` or silently discard capability overrides.
    pub(crate) fn resolve_container_security(
        &self,
    ) -> boxlite_shared::errors::BoxliteResult<ResolvedContainerSecurityConfig> {
        self.validate_privileged_capability_conflict()?;

        let mut normalized = self.clone();
        normalized.normalize_privileged();

        let readonly_paths = if normalized.privileged {
            Vec::new()
        } else {
            default_readonly_paths()
        };

        Ok(ResolvedContainerSecurityConfig {
            capabilities: normalized.capabilities,
            linux: ResolvedLinuxSecurity { readonly_paths },
            mount: ResolvedMountSecurity {
                options: mount_options(normalized.privileged),
            },
        })
    }
}

/// Default OCI readonly-path list for a non-privileged container. Sourced
/// from `oci_spec::runtime::get_default_readonly_paths()` for the same
/// no-drift reason `advanced_options.rs`'s other host-resolved values follow.
fn default_readonly_paths() -> Vec<String> {
    oci_spec::runtime::get_default_readonly_paths()
}

/// Full resolved option list for the guest's `/sys` recursive bind mount.
/// Recursive: `/sys` is an rbind, and OCI's plain `ro` is applied without
/// `AT_RECURSIVE`, which would leave the guest's cgroup2 submount writable
/// inside the container — hence `rro`, not `ro`, for the non-privileged case.
fn mount_options(privileged: bool) -> Vec<String> {
    let mut options: Vec<String> = ["rbind", "nosuid", "noexec", "nodev"]
        .into_iter()
        .map(String::from)
        .collect();
    if !privileged {
        options.push("rro".to_string());
    }
    options
}

/// Atomic container security configuration crossing the host-to-guest
/// boundary. `readonly_paths`/`mount.options` are literal, host-resolved
/// OCI values the guest assigns verbatim — matching how Docker, Podman, and
/// Kata Containers all hand the enforcing side a finished shape rather than a
/// flag to reinterpret (see docs/architecture/privileged-mode-design.md,
/// Trade-offs, option F). `capabilities` is the one exception: only the
/// guest, across the VM boundary, knows its own kernel's capability ceiling,
/// so it stays as add/drop deltas the guest resolves itself.
///
/// No masked-path field, no cgroup namespace, no allow-all device-cgroup
/// rule: all three were tested and found unnecessary for DinD — nothing in
/// the DinD workflow reads a masked path, the guest never enforced a
/// restrictive device-cgroup default in the first place, and `dockerd`
/// tolerated running without a private cgroup namespace view. The guest keeps
/// applying its own oci-spec masked-path default unconditionally.
///
/// `linux`/`mount` are grouped the same way OCI runtime-spec groups the
/// fields they resolve to — parallel top-level fields of one Spec — rather
/// than flattened across a level of structure that doesn't exist in the
/// source concept. Matches the wire shape (`ContainerAdvancedOptions`) it
/// eventually becomes verbatim. `capabilities` stays flat, not nested under
/// a matching `process` field: it predates this grouping (added in #1047,
/// guest version floor 0.9.8) as a plain field on the wire message, and
/// wrapping it now would collide with what already-deployed guests expect
/// there — see `ContainerAdvancedOptions.capabilities` in service.proto.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ResolvedContainerSecurityConfig {
    pub(crate) capabilities: ContainerCapabilities,
    pub(crate) linux: ResolvedLinuxSecurity,
    pub(crate) mount: ResolvedMountSecurity,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ResolvedLinuxSecurity {
    pub(crate) readonly_paths: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ResolvedMountSecurity {
    pub(crate) options: Vec<String>,
}

#[cfg(test)]
mod resolved_security_tests {
    use super::*;

    /// `default_readonly_paths` calls straight into
    /// `oci_spec::runtime::get_default_readonly_paths()` — a caret
    /// dependency, so a semver-compatible release could change what that
    /// returns without BoxLite choosing to. Pinned to the exact list so that
    /// happening is a decision to review, not a silent security-posture
    /// change picked up on the next `cargo update`.
    #[test]
    fn unprivileged_resolves_hardened_path_defaults() {
        let resolved = AdvancedBoxOptions::default()
            .resolve_container_security()
            .expect("default (unprivileged) security should resolve");

        assert_eq!(
            resolved.linux.readonly_paths,
            [
                "/proc/bus",
                "/proc/fs",
                "/proc/irq",
                "/proc/sys",
                "/proc/sysrq-trigger",
            ]
            .map(String::from)
        );
        assert!(resolved.mount.options.contains(&"rro".to_string()));
    }

    #[test]
    fn privileged_resolves_cleared_readonly_paths_and_writable_sys() {
        let mut options = AdvancedBoxOptions::default();
        options.set_privileged(true);

        let resolved = options
            .resolve_container_security()
            .expect("privileged security should resolve");

        assert!(resolved.linux.readonly_paths.is_empty());
        assert!(!resolved.mount.options.contains(&"rro".to_string()));
        assert_eq!(resolved.capabilities.add, ["ALL"]);
    }

    /// Capabilities and the OCI path/mount shape are resolved from the same
    /// `privileged` bool but are otherwise independent knobs: a capability
    /// override alone (no `privileged`) must not relax the hardened paths.
    #[test]
    fn capability_override_without_privileged_keeps_hardened_paths() {
        let options = AdvancedBoxOptions {
            capabilities: ContainerCapabilities {
                add: vec!["SYS_ADMIN".to_string()],
                ..Default::default()
            },
            ..Default::default()
        };

        let resolved = options
            .resolve_container_security()
            .expect("capability-only options should resolve");

        assert!(!resolved.linux.readonly_paths.is_empty());
        assert!(resolved.mount.options.contains(&"rro".to_string()));
    }
}
