//! Advanced options for expert users.
//!
//! This module contains [`AdvancedBoxOptions`], [`SecurityOptions`], [`ResourceLimits`],
//! and [`SecurityOptionsBuilder`] — configuration that entry-level users can safely
//! ignore. Defaults prioritize compatibility.

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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecurityOptions {
    /// Enable jailer isolation.
    ///
    /// When true, applies platform-specific security isolation:
    /// - Linux: seccomp, namespaces, chroot, privilege drop
    /// - macOS: sandbox-exec profile
    ///
    /// Default: true on macOS, false on Linux and other platforms
    #[serde(default = "default_jailer_enabled")]
    pub jailer_enabled: bool,

    /// Enable seccomp syscall filtering (Linux only).
    ///
    /// When true, applies a whitelist of allowed syscalls.
    /// Default: false
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
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    cfg!(target_os = "macos")
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
    /// Enables jailer on Linux/macOS and seccomp on Linux.
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

    /// Create a builder for customizing security options.
    ///
    /// Starts with default settings (jailer enabled on macOS, disabled on Linux/other platforms;
    /// seccomp disabled by default).
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
/// let security = SecurityOptionsBuilder::standard()
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

    /// Create a builder starting from development settings.
    ///
    /// Minimal isolation for debugging.
    pub fn development() -> Self {
        Self {
            inner: SecurityOptions::development(),
        }
    }

    /// Create a builder starting from standard settings.
    ///
    /// Recommended for most use cases.
    pub fn standard() -> Self {
        Self {
            inner: SecurityOptions::standard(),
        }
    }

    /// Create a builder starting from maximum security settings.
    ///
    /// All isolation features enabled.
    pub fn maximum() -> Self {
        Self {
            inner: SecurityOptions::maximum(),
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

    /// Enable or disable network access in sandbox (macOS only).
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

/// Advanced options for expert users.
///
/// Entry-level users can ignore this — defaults are compatibility-focused.
/// Only modify these if you understand the security implications.
///
/// # Construction
///
/// All fields are public. Use struct literal syntax with `..Default::default()` spread,
/// or the builder methods (`with_security`, `with_health_check`, `with_isolate_mounts`)
/// for a more ergonomic API.
///
/// # Security field semantics
///
/// `security` is `None` by default, meaning the REST layer omits the field from the API
/// request and old runners remain eligible for warm-pool reuse. Set it to `Some(...)` via
/// `BoxOptions::with_security()` (or direct field assignment) to opt in to v2-runner
/// enforcement. Only runners that support security options will be selected.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AdvancedBoxOptions {
    /// Security isolation options (jailer, seccomp, namespaces, resource limits).
    ///
    /// `None` (default) — not sent to the API. The runner uses platform defaults, and
    /// warm-pool reuse is unaffected. Use when you do not need to control isolation.
    ///
    /// `Some(opts)` — sent to the API. Only v2 runners that support security options
    /// are selected; warm-pool boxes that pre-date security support are bypassed.
    ///
    /// Available presets:
    /// - `SecurityOptions::default()` — compatibility-focused defaults
    /// - `SecurityOptions::standard()` — recommended for production
    /// - `SecurityOptions::development()` — minimal isolation for debugging
    /// - `SecurityOptions::maximum()` — maximum isolation for untrusted workloads
    #[serde(default)]
    pub security: Option<SecurityOptions>,

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
}

impl AdvancedBoxOptions {
    /// Return the effective security options.
    ///
    /// Returns the explicitly configured security if set, or platform defaults otherwise.
    /// Call sites that need the concrete security value (e.g., jailer, shim config) use
    /// this to avoid spreading `unwrap_or_default()` everywhere.
    pub fn security(&self) -> SecurityOptions {
        self.security.clone().unwrap_or_default()
    }

    /// Set security options and mark them as explicitly configured.
    ///
    /// Sets `security` to `Some(security)` so the REST layer forwards the field.
    /// When `security` is `None` (the default), the REST layer omits the field from
    /// the API request to avoid triggering v2-runner enforcement on old runners.
    ///
    /// # Example
    ///
    /// ```
    /// use boxlite::runtime::options::BoxOptions;
    /// use boxlite::runtime::advanced_options::SecurityOptions;
    ///
    /// let opts = BoxOptions::default().with_security(SecurityOptions::maximum());
    /// assert!(opts.security_explicit());
    /// ```
    pub fn with_security(mut self, security: SecurityOptions) -> Self {
        self.security = Some(security);
        self
    }

    /// Set health check options.
    pub fn with_health_check(mut self, health_check: HealthCheckOptions) -> Self {
        self.health_check = Some(health_check);
        self
    }

    /// Enable or disable mount isolation.
    pub fn with_isolate_mounts(mut self, isolate: bool) -> Self {
        self.isolate_mounts = isolate;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_security_is_none() {
        // Default: security is None (not sent to API, warm-pool reuse unaffected).
        let advanced = AdvancedBoxOptions::default();
        assert!(advanced.security.is_none(), "default security must be None");
    }

    #[test]
    fn with_security_sets_some() {
        // After with_security: security is Some(...) and getter returns configured values.
        let advanced = AdvancedBoxOptions::default().with_security(SecurityOptions::maximum());
        assert!(
            advanced.security.is_some(),
            "with_security must set security to Some(...)"
        );
        assert!(
            advanced.security().jailer_enabled,
            "security() getter must return maximum() preset (jailer_enabled=true)"
        );
    }

    #[test]
    fn struct_literal_with_spread_compiles() {
        // Regression: private fields on AdvancedBoxOptions blocked struct literal
        // construction from outside the module (including external crates).
        // All fields are now public; this pattern must compile and work correctly.
        let hc = HealthCheckOptions::default();
        let advanced = AdvancedBoxOptions {
            health_check: Some(hc),
            security: Some(SecurityOptions::maximum()),
            ..Default::default()
        };
        assert!(advanced.health_check.is_some());
        assert!(advanced.security.is_some());
    }

    #[test]
    fn struct_literal_with_none_security_compiles() {
        // External crates can construct AdvancedBoxOptions with security=None (the default).
        let hc = HealthCheckOptions::default();
        let advanced = AdvancedBoxOptions {
            health_check: Some(hc),
            ..Default::default()
        };
        assert!(advanced.health_check.is_some());
        assert!(advanced.security.is_none());
    }

    #[test]
    fn box_options_with_security_sets_explicit() {
        use crate::runtime::options::BoxOptions;

        let opts = BoxOptions::default().with_security(SecurityOptions::maximum());
        assert!(
            opts.security_explicit(),
            "BoxOptions::with_security must make security_explicit() return true"
        );
        assert!(
            opts.advanced.security().jailer_enabled,
            "BoxOptions::with_security must forward jailer_enabled from maximum()"
        );
    }

    #[test]
    fn direct_field_assignment_also_sets_explicit() {
        use crate::runtime::options::BoxOptions;

        // Direct field assignment to Some(...) is equivalent to with_security().
        // security_explicit() is derived from advanced.security.is_some().
        let mut opts = BoxOptions::default();
        opts.advanced.security = Some(SecurityOptions::maximum());
        assert!(
            opts.security_explicit(),
            "setting advanced.security = Some(...) makes security_explicit() true"
        );
    }

    #[test]
    fn security_accessor_returns_default_when_none() {
        // Callers such as JailerBuilder use `.advanced.security()` rather than
        // spreading `unwrap_or_default()` at every call site.  When the field
        // is None, the accessor must be equivalent to SecurityOptions::default()
        // — the exact value is platform-specific (jailer_enabled is true on
        // macOS, false on Linux), so we compare structurally rather than
        // asserting individual fields.
        let advanced = AdvancedBoxOptions::default();
        assert!(
            advanced.security.is_none(),
            "pre-condition: security field must be None for default AdvancedBoxOptions"
        );
        assert_eq!(
            advanced.security(),
            SecurityOptions::default(),
            "security() with None field must equal SecurityOptions::default()"
        );
    }

    #[test]
    fn none_security_leaves_explicit_false() {
        use crate::runtime::options::BoxOptions;

        let opts = BoxOptions::default();
        assert!(
            !opts.security_explicit(),
            "default BoxOptions must have security_explicit() == false"
        );
    }

    // ── Preset field value tests ──────────────────────────────────────────────

    #[test]
    fn maximum_preset_sets_resource_limits() {
        let s = SecurityOptions::maximum();
        assert_eq!(
            s.resource_limits.max_open_files,
            Some(1024),
            "maximum() must set max_open_files=1024"
        );
        assert_eq!(
            s.resource_limits.max_processes,
            Some(100),
            "maximum() must set max_processes=100"
        );
        assert_eq!(
            s.resource_limits.max_file_size,
            Some(1024 * 1024 * 1024),
            "maximum() must set max_file_size=1GiB"
        );
        // cpu_time and memory are intentionally unset — VM config governs these.
        assert!(
            s.resource_limits.max_cpu_time.is_none(),
            "maximum() should leave max_cpu_time unset"
        );
        assert!(
            s.resource_limits.max_memory.is_none(),
            "maximum() should leave max_memory unset"
        );
    }

    #[test]
    fn maximum_preset_sets_privilege_drop() {
        let s = SecurityOptions::maximum();
        assert_eq!(
            s.uid,
            Some(65534),
            "maximum() must drop to uid=65534 (nobody)"
        );
        assert_eq!(
            s.gid,
            Some(65534),
            "maximum() must drop to gid=65534 (nogroup)"
        );
    }

    #[test]
    fn maximum_preset_enables_isolation() {
        let s = SecurityOptions::maximum();
        assert!(s.jailer_enabled, "maximum() must enable jailer");
        assert!(s.close_fds, "maximum() must close inherited fds");
        assert!(s.sanitize_env, "maximum() must sanitize environment");
    }

    #[test]
    fn standard_preset_enables_sanitize_env_and_close_fds() {
        let s = SecurityOptions::standard();
        assert!(s.sanitize_env, "standard() must sanitize environment");
        assert!(s.close_fds, "standard() must close inherited fds");
    }

    #[test]
    fn standard_preset_has_no_resource_limits() {
        // standard() is for normal use; resource limits are an opt-in.
        let s = SecurityOptions::standard();
        assert!(
            s.resource_limits.max_open_files.is_none(),
            "standard() must not restrict max_open_files"
        );
        assert!(
            s.resource_limits.max_processes.is_none(),
            "standard() must not restrict max_processes"
        );
    }

    #[test]
    fn development_preset_disables_all_isolation() {
        let s = SecurityOptions::development();
        assert!(!s.jailer_enabled, "development() must disable jailer");
        assert!(!s.seccomp_enabled, "development() must disable seccomp");
        assert!(!s.sanitize_env, "development() must not sanitize env");
        assert!(!s.close_fds, "development() must not close fds");
        assert!(!s.chroot_enabled, "development() must disable chroot");
    }

    #[test]
    fn development_preset_has_no_resource_limits() {
        let s = SecurityOptions::development();
        assert!(
            s.resource_limits.max_open_files.is_none(),
            "development() must not restrict max_open_files"
        );
        assert!(
            s.resource_limits.max_processes.is_none(),
            "development() must not restrict max_processes"
        );
    }

    #[test]
    fn builder_max_open_files_overrides_default() {
        let s = SecurityOptionsBuilder::new().max_open_files(512).build();
        assert_eq!(s.resource_limits.max_open_files, Some(512));
    }

    #[test]
    fn builder_standard_plus_resource_limit() {
        // Common pattern: take standard preset, add file descriptor limit.
        let s = SecurityOptionsBuilder::standard()
            .max_open_files(2048)
            .build();
        assert!(s.jailer_enabled, "standard base must enable jailer");
        assert!(s.sanitize_env, "standard base must sanitize env");
        assert_eq!(
            s.resource_limits.max_open_files,
            Some(2048),
            "explicit limit must override standard default (none)"
        );
    }
}
