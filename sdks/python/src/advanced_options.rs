use boxlite::runtime::advanced_options::{ResourceLimits, SecurityOptions};
use pyo3::prelude::*;

// ============================================================================
// Security Options
// ============================================================================

/// Security isolation options for a box.
///
/// Controls how the boxlite-shim process is isolated from the host.
/// Different presets are available: `development()`, `standard()`, `maximum()`.
///
/// Example:
///     ```python
///     from boxlite import SecurityOptions
///
///     # Use preset with customizations
///     security = SecurityOptions.standard()
///     security.max_open_files = 2048
///     security.max_memory = 1024 * 1024 * 1024  # 1 GiB
///
///     # Or create from scratch
///     security = SecurityOptions(
///         jailer_enabled=True,
///         seccomp_enabled=True,
///         max_open_files=1024,
///     )
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

#[pymethods]
impl PySecurityOptions {
    /// Create a new SecurityOptions with custom settings.
    #[new]
    #[pyo3(signature = (
        jailer_enabled=true,
        seccomp_enabled=false,
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
        seccomp_enabled: bool,
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
            seccomp_enabled,
            max_open_files,
            max_file_size,
            max_processes,
            max_memory,
            max_cpu_time,
            network_enabled,
            close_fds,
        }
    }

    /// Development mode: minimal isolation for debugging.
    ///
    /// Use this when debugging issues where isolation interferes.
    #[staticmethod]
    fn development() -> Self {
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

    /// Standard mode: recommended for most use cases.
    ///
    /// Equivalent to `SecurityOptions()` with no arguments.
    /// Provides good security without being overly restrictive.
    #[staticmethod]
    fn standard() -> Self {
        Self {
            jailer_enabled: cfg!(any(target_os = "linux", target_os = "macos")),
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

    /// Maximum mode: all isolation features enabled.
    ///
    /// Use this for untrusted workloads (AI sandbox, multi-tenant).
    #[staticmethod]
    fn maximum() -> Self {
        Self {
            jailer_enabled: true,
            seccomp_enabled: cfg!(target_os = "linux"),
            max_open_files: Some(1024),
            max_file_size: Some(1024 * 1024 * 1024), // 1 GiB
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

/// Advanced options for expert users.
///
/// Entry-level users can ignore this — defaults are secure and reasonable.
#[pyclass(name = "AdvancedBoxOptions")]
#[derive(Clone, Debug)]
pub struct PyAdvancedBoxOptions {
    /// Security isolation options.
    #[pyo3(get, set)]
    pub security: Option<PySecurityOptions>,
}

#[pymethods]
impl PyAdvancedBoxOptions {
    #[new]
    #[pyo3(signature = (security=None))]
    fn new(security: Option<PySecurityOptions>) -> Self {
        Self { security }
    }
}
