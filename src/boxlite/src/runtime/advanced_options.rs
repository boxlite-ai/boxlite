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
#[derive(Clone, Debug, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AdvancedBoxOptions {
    /// Security isolation options (jailer, seccomp, namespaces, resource limits).
    ///
    /// Defaults are compatibility-focused (jailer enabled on macOS, disabled on Linux/other
    /// platforms; seccomp disabled). Use presets:
    /// - `SecurityOptions::default()` — compatibility-focused defaults
    /// - `SecurityOptions::standard()` — recommended for production
    /// - `SecurityOptions::development()` — minimal isolation for debugging
    /// - `SecurityOptions::maximum()` — maximum isolation for untrusted workloads
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

    /// Restart policy for automatic restart on crash.
    ///
    /// When set, the health check task will evaluate the policy when the
    /// shim process dies and automatically restart the box if the policy allows it.
    ///
    /// If `health_check` is not configured but `restart_policy` is, a default
    /// health check is auto-enabled (interval=5s, timeout=10s, retries=3, start_period=60s).
    #[serde(default)]
    pub restart_policy: Option<RestartPolicy>,
}

/// Restart policy for automatic restart on crash.
///
/// Similar to Docker's restart policy. Controls what happens when a box's
/// shim process crashes.
///
/// # Example
///
/// ```
/// use boxlite::runtime::advanced_options::{AdvancedBoxOptions, RestartPolicy};
///
/// let opts = AdvancedBoxOptions {
///     restart_policy: Some(RestartPolicy::Always),
///     ..Default::default()
/// };
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RestartPolicy {
    /// Never restart (default).
    No,
    /// Always restart regardless of exit status. Unlimited retries with exponential backoff.
    Always,
    /// Restart only on non-zero exit code, limited to max_retries consecutive failures.
    OnFailure {
        /// Maximum consecutive restart attempts before giving up.
        max_retries: u32,
    },
    /// Always restart unless user explicitly called stop(). Unlimited retries.
    UnlessStopped,
}

impl RestartPolicy {
    /// Evaluate whether a restart should happen based on exit code and restart count.
    ///
    /// # Arguments
    /// * `exit_code` - Exit code from the shim process (None = signal/unknown)
    /// * `restart_count` - Current consecutive restart attempt count
    ///
    /// # Returns
    /// `true` if the box should be restarted
    ///
    /// # Warning
    /// `Always` and `UnlessStopped` restart regardless of exit code. If the shim
    /// exits cleanly (exit_code == 0) repeatedly, this results in an infinite
    /// restart loop. Use `UnlessStopped` when you want a user-initiated `stop()`
    /// to break the loop (the only way to stop an `Always` loop is to remove the box).
    pub fn should_restart(&self, exit_code: Option<i32>, restart_count: u32) -> bool {
        match self {
            RestartPolicy::No => false,
            RestartPolicy::Always => true,
            RestartPolicy::OnFailure { max_retries } => {
                // Only restart on non-zero exit code (explicit failure)
                // None (no exit file) means normal/clean exit - no restart
                let is_failure = exit_code.is_some_and(|code| code != 0);
                is_failure && restart_count < *max_retries
            }
            RestartPolicy::UnlessStopped => true,
        }
    }

    /// Check if this policy has unlimited retries.
    pub fn is_unlimited_retries(&self) -> bool {
        matches!(self, RestartPolicy::Always | RestartPolicy::UnlessStopped)
    }

    /// Default health check config to use when restart_policy is set but health_check is not.
    pub fn default_health_check() -> HealthCheckOptions {
        HealthCheckOptions {
            interval: Duration::from_secs(5),
            timeout: Duration::from_secs(10),
            retries: 3,
            start_period: Duration::from_secs(60),
        }
    }
}

impl AdvancedBoxOptions {
    /// Get the effective health check config.
    ///
    /// Returns user-configured health check if set, or auto-enables default
    /// health check when restart_policy is configured without one.
    pub fn effective_health_check(&self) -> Option<HealthCheckOptions> {
        if let Some(ref hc) = self.health_check {
            Some(hc.clone())
        } else if self.restart_policy.is_some() {
            Some(RestartPolicy::default_health_check())
        } else {
            None
        }
    }
}

/// Calculate exponential backoff delay for restart attempts.
///
/// Base: 100ms, doubles each attempt, capped at 30s.
/// Sequence: 100ms, 200ms, 400ms, 800ms, 1.6s, 3.2s, 6.4s, 12.8s, 25.6s, 30s (capped)
pub fn calculate_backoff(restart_count: u32) -> Duration {
    let base_ms: u64 = 100;
    let max_ms: u64 = 30_000;
    let exp = 1u64.checked_shl(restart_count.min(18)).unwrap_or(u64::MAX); // Cap shift to avoid overflow
    Duration::from_millis(base_ms.saturating_mul(exp).min(max_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ====================================================================
    // RestartPolicy::should_restart tests
    // ====================================================================

    #[test]
    fn test_restart_policy_no_never_restarts() {
        let policy = RestartPolicy::No;
        assert!(!policy.should_restart(Some(0), 0));
        assert!(!policy.should_restart(Some(1), 0));
        assert!(!policy.should_restart(None, 0));
        assert!(!policy.should_restart(Some(0), 100));
    }

    #[test]
    fn test_restart_policy_always_always_restarts() {
        let policy = RestartPolicy::Always;
        assert!(policy.should_restart(Some(0), 0));
        assert!(policy.should_restart(Some(1), 0));
        assert!(policy.should_restart(None, 0));
        assert!(policy.should_restart(Some(0), 100)); // Unlimited retries
    }

    #[test]
    fn test_restart_policy_unless_stopped_always_restarts() {
        let policy = RestartPolicy::UnlessStopped;
        assert!(policy.should_restart(Some(0), 0));
        assert!(policy.should_restart(Some(1), 0));
        assert!(policy.should_restart(None, 0));
        assert!(policy.should_restart(Some(0), 100)); // Unlimited retries
    }

    #[test]
    fn test_restart_policy_on_failure_restarts_on_non_zero_exit() {
        let policy = RestartPolicy::OnFailure { max_retries: 3 };
        // Non-zero exit code should restart
        assert!(policy.should_restart(Some(1), 0));
        assert!(policy.should_restart(Some(127), 1));
        assert!(policy.should_restart(Some(-1), 2));
    }

    #[test]
    fn test_restart_policy_on_failure_no_restart_on_zero_exit() {
        let policy = RestartPolicy::OnFailure { max_retries: 3 };
        // Zero exit code should NOT restart
        assert!(!policy.should_restart(Some(0), 0));
        assert!(!policy.should_restart(Some(0), 2));
    }

    #[test]
    fn test_restart_policy_on_failure_no_restart_on_no_exit_file() {
        let policy = RestartPolicy::OnFailure { max_retries: 3 };
        // No exit file (None) means clean/normal exit - no restart
        assert!(!policy.should_restart(None, 0));
        assert!(!policy.should_restart(None, 1));
    }

    #[test]
    fn test_restart_policy_on_failure_respects_max_retries() {
        let policy = RestartPolicy::OnFailure { max_retries: 3 };
        // Should restart when under max_retries
        assert!(policy.should_restart(Some(1), 0));
        assert!(policy.should_restart(Some(1), 1));
        assert!(policy.should_restart(Some(1), 2));
        // Should NOT restart when at max_retries
        assert!(!policy.should_restart(Some(1), 3));
        assert!(!policy.should_restart(Some(1), 4));
    }

    #[test]
    fn test_restart_policy_on_failure_zero_max_retries() {
        let policy = RestartPolicy::OnFailure { max_retries: 0 };
        // With max_retries=0, should never restart
        assert!(!policy.should_restart(Some(1), 0));
        assert!(!policy.should_restart(None, 0));
    }

    // ====================================================================
    // RestartPolicy::is_unlimited_retries tests
    // ====================================================================

    #[test]
    fn test_is_unlimited_retries() {
        assert!(!RestartPolicy::No.is_unlimited_retries());
        assert!(RestartPolicy::Always.is_unlimited_retries());
        assert!(RestartPolicy::UnlessStopped.is_unlimited_retries());
        assert!(!RestartPolicy::OnFailure { max_retries: 3 }.is_unlimited_retries());
    }

    // ====================================================================
    // calculate_backoff tests
    // ====================================================================

    #[test]
    fn test_calculate_backoff_sequence() {
        assert_eq!(calculate_backoff(0), Duration::from_millis(100));
        assert_eq!(calculate_backoff(1), Duration::from_millis(200));
        assert_eq!(calculate_backoff(2), Duration::from_millis(400));
        assert_eq!(calculate_backoff(3), Duration::from_millis(800));
        assert_eq!(calculate_backoff(4), Duration::from_millis(1600));
        assert_eq!(calculate_backoff(5), Duration::from_millis(3200));
        assert_eq!(calculate_backoff(6), Duration::from_millis(6400));
        assert_eq!(calculate_backoff(7), Duration::from_millis(12800));
        assert_eq!(calculate_backoff(8), Duration::from_millis(25600));
    }

    #[test]
    fn test_calculate_backoff_capped_at_30s() {
        // After 30s cap is reached
        assert_eq!(calculate_backoff(9), Duration::from_millis(30000));
        assert_eq!(calculate_backoff(10), Duration::from_millis(30000));
        assert_eq!(calculate_backoff(100), Duration::from_millis(30000));
    }

    // ====================================================================
    // AdvancedBoxOptions::effective_health_check tests
    // ====================================================================

    #[test]
    fn test_effective_health_check_user_config() {
        let user_config = HealthCheckOptions {
            interval: Duration::from_secs(10),
            timeout: Duration::from_secs(5),
            retries: 5,
            start_period: Duration::from_secs(30),
        };
        let opts = AdvancedBoxOptions {
            health_check: Some(user_config.clone()),
            restart_policy: Some(RestartPolicy::Always),
            ..Default::default()
        };
        let effective = opts.effective_health_check().unwrap();
        assert_eq!(effective.interval, Duration::from_secs(10));
        assert_eq!(effective.retries, 5);
    }

    #[test]
    fn test_effective_health_check_auto_enabled_for_restart_policy() {
        let opts = AdvancedBoxOptions {
            health_check: None,
            restart_policy: Some(RestartPolicy::Always),
            ..Default::default()
        };
        let effective = opts.effective_health_check().unwrap();
        assert_eq!(effective.interval, Duration::from_secs(5));
        assert_eq!(effective.timeout, Duration::from_secs(10));
        assert_eq!(effective.retries, 3);
        assert_eq!(effective.start_period, Duration::from_secs(60));
    }

    #[test]
    fn test_effective_health_check_none_when_no_policy() {
        let opts = AdvancedBoxOptions {
            health_check: None,
            restart_policy: None,
            ..Default::default()
        };
        assert!(opts.effective_health_check().is_none());
    }
}
