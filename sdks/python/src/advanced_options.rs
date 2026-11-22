use boxlite::runtime::advanced_options::{
    ContainerCapabilities, HealthCheckOptions, ResourceLimits, SecurityOptions,
};
use pyo3::prelude::*;

// ============================================================================
// Health Check Options
// ============================================================================

/// Health check options for boxes.
///
/// Defines how to periodically check if a box's guest agent is responsive.
/// Similar to Docker's HEALTHCHECK directive.
///
/// This is an advanced option - most users should rely on the defaults.
#[pyclass(name = "HealthCheckOptions")]
#[derive(Clone, Debug)]
pub struct PyHealthCheckOptions {
    /// Time between health checks (seconds).
    #[pyo3(get, set)]
    pub interval: u64,

    /// Time to wait before considering the check failed (seconds).
    #[pyo3(get, set)]
    pub timeout: u64,

    /// Number of consecutive failures before marking as unhealthy.
    #[pyo3(get, set)]
    pub retries: u32,

    /// Startup period before health checks count toward failures (seconds).
    #[pyo3(get, set)]
    pub start_period: u64,
}

#[pymethods]
impl PyHealthCheckOptions {
    #[new]
    #[pyo3(signature = (interval=30, timeout=10, retries=3, start_period=60))]
    fn new(interval: u64, timeout: u64, retries: u32, start_period: u64) -> Self {
        Self {
            interval,
            timeout,
            retries,
            start_period,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "HealthCheckOptions(interval={}s, timeout={}s, retries={}, start_period={}s)",
            self.interval, self.timeout, self.retries, self.start_period
        )
    }
}

impl From<PyHealthCheckOptions> for HealthCheckOptions {
    fn from(py_opts: PyHealthCheckOptions) -> Self {
        Self {
            interval: std::time::Duration::from_secs(py_opts.interval),
            timeout: std::time::Duration::from_secs(py_opts.timeout),
            retries: py_opts.retries,
            start_period: std::time::Duration::from_secs(py_opts.start_period),
        }
    }
}

// ============================================================================
// Security Options
// ============================================================================

/// Security isolation options for a box.
///
/// Controls how the boxlite-shim process is isolated from the host.
/// Different presets are available: `enabled()`, `disabled()`, `standard()`, `maximum()`, `development()`.
///
/// Example:
///     ```python
///     from boxlite import SecurityOptions
///
///     # Secure by default
///     security = SecurityOptions()
///     security.max_open_files = 2048
///     security.max_memory = 1024 * 1024 * 1024  # 1 GiB
///
///     # Or use presets
///     disabled = SecurityOptions.disabled()
///     standard = SecurityOptions.standard()
///     maximum = SecurityOptions.maximum()
///     ```
#[pyclass(name = "SecurityOptions")]
#[derive(Clone, Debug)]
pub struct PySecurityOptions {
    /// Enable jailer isolation (Linux/macOS).
    #[pyo3(get, set)]
    pub jailer_enabled: bool,

    /// Enable seccomp syscall filtering (Linux only).
    #[pyo3(get, set)]
    pub seccomp_enabled: bool,

    /// Maximum number of open file descriptors.
    #[pyo3(get, set)]
    pub max_open_files: Option<u64>,

    /// Maximum file size in bytes.
    #[pyo3(get, set)]
    pub max_file_size: Option<u64>,

    /// Maximum number of processes.
    #[pyo3(get, set)]
    pub max_processes: Option<u64>,

    /// Maximum virtual memory in bytes.
    #[pyo3(get, set)]
    pub max_memory: Option<u64>,

    /// Maximum CPU time in seconds.
    #[pyo3(get, set)]
    pub max_cpu_time: Option<u64>,

    /// Enable network access in sandbox (macOS only).
    #[pyo3(get, set)]
    pub network_enabled: bool,

    /// Close inherited file descriptors.
    #[pyo3(get, set)]
    pub close_fds: bool,
}

impl Default for PySecurityOptions {
    fn default() -> Self {
        Self {
            jailer_enabled: true,
            seccomp_enabled: cfg!(target_os = "linux"),
            max_open_files: None,
            max_file_size: None,
            max_processes: None,
            max_memory: None,
            max_cpu_time: None,
            network_enabled: true,
            close_fds: true,
        }
    }
}

#[pymethods]
impl PySecurityOptions {
    /// Create a new SecurityOptions with custom settings.
    ///
    /// By default, jailer is enabled and seccomp is enabled on Linux (secure by default).
    #[new]
    #[pyo3(signature = (
        jailer_enabled=true,
        seccomp_enabled=None,
        max_open_files=None,
        max_file_size=None,
        max_processes=None,
        max_memory=None,
        max_cpu_time=None,
        network_enabled=true,
        close_fds=true,
    ))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        jailer_enabled: bool,
        seccomp_enabled: Option<bool>,
        max_open_files: Option<u64>,
        max_file_size: Option<u64>,
        max_processes: Option<u64>,
        max_memory: Option<u64>,
        max_cpu_time: Option<u64>,
        network_enabled: bool,
        close_fds: bool,
    ) -> Self {
        Self {
            jailer_enabled,
            seccomp_enabled: seccomp_enabled.unwrap_or(cfg!(target_os = "linux")),
            max_open_files,
            max_file_size,
            max_processes,
            max_memory,
            max_cpu_time,
            network_enabled,
            close_fds,
        }
    }

    /// Enabled mode: full host isolation (default, secure by default).
    ///
    /// Enables jailer on supported platforms and seccomp syscall filtering on Linux.
    #[staticmethod]
    fn enabled() -> Self {
        Self::default()
    }

    /// Disabled mode: disables jailer and seccomp syscall filtering.
    ///
    /// Use this when debugging or in environments that cannot sandbox.
    #[staticmethod]
    fn disabled() -> Self {
        Self {
            jailer_enabled: false,
            seccomp_enabled: false,
            max_open_files: None,
            max_file_size: None,
            max_processes: None,
            max_memory: None,
            max_cpu_time: None,
            network_enabled: true,
            close_fds: false,
        }
    }

    /// Development mode: minimal isolation for debugging.
    ///
    /// Use this when debugging issues where isolation interferes.
    #[staticmethod]
    fn development() -> Self {
        Self::disabled()
    }

    /// Standard mode: recommended for most use cases.
    ///
    /// Enables jailer on supported platforms and seccomp syscall filtering on Linux.
    #[staticmethod]
    fn standard() -> Self {
        Self::default()
    }

    /// Maximum mode: all isolation features enabled.
    ///
    /// Use this for untrusted workloads (AI sandbox, multi-tenant).
    #[staticmethod]
    fn maximum() -> Self {
        Self {
            jailer_enabled: true,
            seccomp_enabled: cfg!(target_os = "linux"),
            max_open_files: Some(1024),
            max_file_size: None,
            max_processes: Some(100),
            max_memory: None,   // Let VM config handle this
            max_cpu_time: None, // Let VM config handle this
            network_enabled: true,
            close_fds: true,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "SecurityOptions(jailer_enabled={}, seccomp_enabled={}, max_open_files={:?})",
            self.jailer_enabled, self.seccomp_enabled, self.max_open_files
        )
    }
}

impl From<PySecurityOptions> for SecurityOptions {
    fn from(py_opts: PySecurityOptions) -> Self {
        SecurityOptions {
            jailer_enabled: py_opts.jailer_enabled,
            seccomp_enabled: py_opts.seccomp_enabled,
            network_enabled: py_opts.network_enabled,
            close_fds: py_opts.close_fds,
            resource_limits: ResourceLimits {
                max_open_files: py_opts.max_open_files,
                max_file_size: py_opts.max_file_size,
                max_processes: py_opts.max_processes,
                max_memory: py_opts.max_memory,
                max_cpu_time: py_opts.max_cpu_time,
            },
            ..Default::default()
        }
    }
}

// ============================================================================
// Advanced Options
// ============================================================================

/// Linux capability policy for the container process.
#[pyclass(name = "ContainerCapabilities")]
#[derive(Clone, Debug, Default)]
pub struct PyContainerCapabilities {
    /// Capabilities added to BoxLite's Docker-compatible baseline.
    #[pyo3(get, set)]
    pub add: Vec<String>,

    /// Capabilities removed from the resulting capability set.
    #[pyo3(get, set)]
    pub drop: Vec<String>,
}

#[pymethods]
impl PyContainerCapabilities {
    #[new]
    #[pyo3(signature = (add=vec![], drop=vec![]))]
    fn new(add: Vec<String>, drop: Vec<String>) -> Self {
        Self { add, drop }
    }

    fn __repr__(&self) -> String {
        format!(
            "ContainerCapabilities(add={:?}, drop={:?})",
            self.add, self.drop
        )
    }
}

impl From<PyContainerCapabilities> for ContainerCapabilities {
    fn from(capabilities: PyContainerCapabilities) -> Self {
        Self {
            add: capabilities.add,
            drop: capabilities.drop,
        }
    }
}

/// Advanced options for expert users.
///
/// Entry-level users can ignore this — defaults are compatibility-focused.
#[pyclass(name = "AdvancedBoxOptions")]
#[derive(Clone, Debug)]
pub struct PyAdvancedBoxOptions {
    /// Full privilege inside the guest; host sandbox policy is unchanged.
    #[pyo3(get, set)]
    pub privileged: bool,
    /// Security isolation options.
    #[pyo3(get, set)]
    pub security: Option<PySecurityOptions>,

    /// Health check options.
    #[pyo3(get, set)]
    pub health_check: Option<PyHealthCheckOptions>,

    /// Linux capability policy for the container process.
    ///
    /// `None` when the caller never passes `capabilities=` — distinct from
    /// an explicit, empty policy, the same distinction the core
    /// `AdvancedBoxOptions.capabilities` makes. Collapsing this to a
    /// concrete default here would make every security/health-check-only
    /// `AdvancedBoxOptions` look like it explicitly asked for an empty
    /// capability override.
    #[pyo3(get, set)]
    pub capabilities: Option<PyContainerCapabilities>,
}

#[pymethods]
impl PyAdvancedBoxOptions {
    #[new]
    #[pyo3(signature = (security=None, health_check=None, capabilities=None, privileged=false))]
    fn new(
        security: Option<PySecurityOptions>,
        health_check: Option<PyHealthCheckOptions>,
        capabilities: Option<PyContainerCapabilities>,
        privileged: bool,
    ) -> Self {
        Self {
            security,
            health_check,
            capabilities,
            privileged,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_security_options_default() {
        let opts = PySecurityOptions::default();
        assert!(opts.jailer_enabled);
        assert_eq!(opts.seccomp_enabled, cfg!(target_os = "linux"));
        assert!(opts.network_enabled);
        assert!(opts.close_fds);
        assert!(opts.max_open_files.is_none());
    }

    #[test]
    fn test_security_options_new_defaults() {
        let opts = PySecurityOptions::new(true, None, None, None, None, None, None, true, true);
        assert!(opts.jailer_enabled);
        assert_eq!(opts.seccomp_enabled, cfg!(target_os = "linux"));
        assert!(opts.network_enabled);
        assert!(opts.close_fds);
    }

    #[test]
    fn test_security_options_enabled_matches_default() {
        let enabled = PySecurityOptions::enabled();
        let default = PySecurityOptions::default();
        assert_eq!(enabled.jailer_enabled, default.jailer_enabled);
        assert_eq!(enabled.seccomp_enabled, default.seccomp_enabled);
        assert_eq!(enabled.close_fds, default.close_fds);
        assert_eq!(enabled.network_enabled, default.network_enabled);
    }

    #[test]
    fn test_security_options_disabled() {
        let disabled = PySecurityOptions::disabled();
        assert!(!disabled.jailer_enabled);
        assert!(!disabled.seccomp_enabled);
        assert!(!disabled.close_fds);
        assert!(disabled.network_enabled);
    }

    #[test]
    fn test_security_options_development_matches_disabled() {
        let dev = PySecurityOptions::development();
        let disabled = PySecurityOptions::disabled();
        assert_eq!(dev.jailer_enabled, disabled.jailer_enabled);
        assert_eq!(dev.seccomp_enabled, disabled.seccomp_enabled);
        assert_eq!(dev.close_fds, disabled.close_fds);
    }

    #[test]
    fn test_security_options_standard_matches_default() {
        let standard = PySecurityOptions::standard();
        let default = PySecurityOptions::default();
        assert_eq!(standard.jailer_enabled, default.jailer_enabled);
        assert_eq!(standard.seccomp_enabled, default.seccomp_enabled);
    }

    #[test]
    fn test_security_options_conversion_to_rust_core() {
        let py_opts = PySecurityOptions::default();
        let core: SecurityOptions = py_opts.into();
        assert!(core.jailer_enabled);
        assert_eq!(core.seccomp_enabled, cfg!(target_os = "linux"));
        // Core defaults like uid/gid 65534 and sanitize_env must remain intact.
        assert_eq!(core.uid, Some(65534));
        assert_eq!(core.gid, Some(65534));
        assert!(core.sanitize_env);
    }

    #[test]
    fn test_security_options_disabled_conversion_to_rust_core() {
        let py_opts = PySecurityOptions::disabled();
        let core: SecurityOptions = py_opts.into();
        assert!(!core.jailer_enabled);
        assert!(!core.seccomp_enabled);
        assert!(!core.close_fds);
        // Privilege drop remains intact from Default::default().
        assert_eq!(core.uid, Some(65534));
        assert_eq!(core.gid, Some(65534));
    }
}
