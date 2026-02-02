use std::path::PathBuf;

use boxlite::CopyOptions;
use boxlite::runtime::constants::images;
use boxlite::runtime::options::{
    BoxOptions, BoxliteOptions, NetworkSpec, PortProtocol, PortSpec, ResourceLimits, RootfsSpec,
    SecurityOptions, VolumeSpec,
};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyAnyMethods, PyDict, PyTuple};

#[pyclass(name = "Options")]
#[derive(Clone, Debug)]
pub(crate) struct PyOptions {
    #[pyo3(get, set)]
    pub(crate) home_dir: Option<String>,
    /// Registries to search for unqualified image references.
    /// Tried in order; first successful pull wins.
    #[pyo3(get, set)]
    pub(crate) image_registries: Vec<String>,
}

#[pymethods]
impl PyOptions {
    #[new]
    #[pyo3(signature = (home_dir=None, image_registries=vec![]))]
    fn new(home_dir: Option<String>, image_registries: Vec<String>) -> Self {
        Self {
            home_dir,
            image_registries,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "Options(home_dir={:?}, image_registries={:?})",
            self.home_dir, self.image_registries
        )
    }
}

impl From<PyOptions> for BoxliteOptions {
    fn from(py_opts: PyOptions) -> Self {
        let mut config = BoxliteOptions::default();

        if let Some(home_dir) = py_opts.home_dir {
            config.home_dir = PathBuf::from(home_dir);
        }

        config.image_registries = py_opts.image_registries;

        config
    }
}

// ============================================================================
// Copy Options
// ============================================================================

#[pyclass(name = "CopyOptions")]
#[derive(Clone, Debug)]
pub struct PyCopyOptions {
    #[pyo3(get, set)]
    pub recursive: bool,
    #[pyo3(get, set)]
    pub overwrite: bool,
    #[pyo3(get, set)]
    pub follow_symlinks: bool,
    #[pyo3(get, set)]
    pub include_parent: bool,
}

#[pymethods]
impl PyCopyOptions {
    #[new]
    #[pyo3(
        signature = (
            recursive = true,
            overwrite = true,
            follow_symlinks = false,
            include_parent = true
        )
    )]
    fn new(recursive: bool, overwrite: bool, follow_symlinks: bool, include_parent: bool) -> Self {
        Self {
            recursive,
            overwrite,
            follow_symlinks,
            include_parent,
        }
    }
}

impl From<PyCopyOptions> for CopyOptions {
    fn from(opt: PyCopyOptions) -> Self {
        Self {
            recursive: opt.recursive,
            overwrite: opt.overwrite,
            follow_symlinks: opt.follow_symlinks,
            include_parent: opt.include_parent,
        }
    }
}

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
pub(crate) struct PySecurityOptions {
    /// Enable jailer isolation (Linux/macOS).
    #[pyo3(get, set)]
    pub(crate) jailer_enabled: bool,

    /// Enable seccomp syscall filtering (Linux only).
    #[pyo3(get, set)]
    pub(crate) seccomp_enabled: bool,

    /// Maximum number of open file descriptors.
    #[pyo3(get, set)]
    pub(crate) max_open_files: Option<u64>,

    /// Maximum file size in bytes.
    #[pyo3(get, set)]
    pub(crate) max_file_size: Option<u64>,

    /// Maximum number of processes.
    #[pyo3(get, set)]
    pub(crate) max_processes: Option<u64>,

    /// Maximum virtual memory in bytes.
    #[pyo3(get, set)]
    pub(crate) max_memory: Option<u64>,

    /// Maximum CPU time in seconds.
    #[pyo3(get, set)]
    pub(crate) max_cpu_time: Option<u64>,

    /// Enable network access in sandbox (macOS only).
    #[pyo3(get, set)]
    pub(crate) network_enabled: bool,

    /// Close inherited file descriptors.
    #[pyo3(get, set)]
    pub(crate) close_fds: bool,
}

#[pymethods]
impl PySecurityOptions {
    /// Create a new SecurityOptions with custom settings.
    #[new]
    #[pyo3(signature = (
        jailer_enabled=false,
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
// Box Options
// ============================================================================

#[pyclass(name = "BoxOptions")]
#[derive(Clone, Debug)]
pub(crate) struct PyBoxOptions {
    #[pyo3(get, set)]
    pub(crate) image: Option<String>,
    #[pyo3(get, set)]
    pub(crate) rootfs_path: Option<String>,
    #[pyo3(get, set)]
    pub(crate) cpus: Option<u8>,
    #[pyo3(get, set)]
    pub(crate) memory_mib: Option<u32>,
    #[pyo3(get, set)]
    pub(crate) disk_size_gb: Option<u64>,
    #[pyo3(get, set)]
    pub(crate) working_dir: Option<String>,
    #[pyo3(get, set)]
    pub(crate) env: Vec<(String, String)>,
    pub(crate) volumes: Vec<PyVolumeSpec>,
    #[pyo3(get, set)]
    pub(crate) network: Option<String>,
    pub(crate) ports: Vec<PyPortSpec>,
    #[pyo3(get, set)]
    pub(crate) auto_remove: Option<bool>,
    #[pyo3(get, set)]
    pub(crate) detach: Option<bool>,
    /// Override the image's ENTRYPOINT directive.
    /// When set, completely replaces the image's ENTRYPOINT.
    /// Example: `entrypoint=["dockerd"]` with `docker:dind`
    #[pyo3(get, set)]
    pub(crate) entrypoint: Option<Vec<String>>,
    /// Override the image's CMD. ENTRYPOINT is preserved.
    /// Example: `cmd=["--iptables=false"]` with `docker:dind`
    #[pyo3(get, set)]
    pub(crate) cmd: Option<Vec<String>>,
    /// Username or UID (format: <name|uid>[:<group|gid>]).
    /// If None, uses the image's USER directive (defaults to root).
    #[pyo3(get, set)]
    pub(crate) user: Option<String>,
    /// Security isolation options for the box.
    #[pyo3(get, set)]
    pub(crate) security: Option<PySecurityOptions>,
}

#[pymethods]
impl PyBoxOptions {
    #[new]
    #[pyo3(signature = (
        image=None,
        rootfs_path=None,
        cpus=None,
        memory_mib=None,
        disk_size_gb=None,
        working_dir=None,
        env=vec![],
        volumes=vec![],
        network=None,
        ports=vec![],
        auto_remove=None,
        detach=None,
        entrypoint=None,
        cmd=None,
        user=None,
        security=None,
    ))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        image: Option<String>,
        rootfs_path: Option<String>,
        cpus: Option<u8>,
        memory_mib: Option<u32>,
        disk_size_gb: Option<u64>,
        working_dir: Option<String>,
        env: Vec<(String, String)>,
        volumes: Vec<PyVolumeSpec>,
        network: Option<String>,
        ports: Vec<PyPortSpec>,
        auto_remove: Option<bool>,
        detach: Option<bool>,
        entrypoint: Option<Vec<String>>,
        cmd: Option<Vec<String>>,
        user: Option<String>,
        security: Option<PySecurityOptions>,
    ) -> Self {
        Self {
            image,
            rootfs_path,
            cpus,
            memory_mib,
            disk_size_gb,
            working_dir,
            env,
            volumes,
            network,
            ports,
            auto_remove,
            detach,
            entrypoint,
            cmd,
            user,
            security,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "BoxOptions(image={:?}, rootfs_path={:?}, cpus={:?}, memory_mib={:?}, security={:?})",
            self.image,
            self.rootfs_path,
            self.cpus,
            self.memory_mib,
            self.security.is_some()
        )
    }
}

impl From<PyBoxOptions> for BoxOptions {
    fn from(py_opts: PyBoxOptions) -> Self {
        let volumes = py_opts.volumes.into_iter().map(VolumeSpec::from).collect();

        let network = match py_opts.network {
            // Some(ref s) if s.eq_ignore_ascii_case("host") => NetworkSpec::Host,
            Some(ref s) if s.eq_ignore_ascii_case("isolated") => NetworkSpec::Isolated,
            // Some(s) if !s.is_empty() => NetworkSpec::Custom(s),
            _ => NetworkSpec::Isolated,
        };

        let ports = py_opts.ports.into_iter().map(PortSpec::from).collect();

        // Convert image/rootfs_path to RootfsSpec
        let rootfs = match &py_opts.rootfs_path {
            Some(path) if !path.is_empty() => RootfsSpec::RootfsPath(path.clone()),
            _ => {
                let image = py_opts
                    .image
                    .clone()
                    .unwrap_or_else(|| images::DEFAULT.to_string());
                RootfsSpec::Image(image)
            }
        };

        let mut opts = BoxOptions {
            cpus: py_opts.cpus,
            memory_mib: py_opts.memory_mib,
            disk_size_gb: py_opts.disk_size_gb,
            working_dir: py_opts.working_dir,
            env: py_opts.env,
            rootfs,
            volumes,
            network,
            ports,
            entrypoint: py_opts.entrypoint,
            cmd: py_opts.cmd,
            user: py_opts.user,
            ..Default::default()
        };

        // These fields have non-None defaults (auto_remove=true, detach=false),
        // so None means "keep default" rather than "set to None".
        if let Some(auto_remove) = py_opts.auto_remove {
            opts.auto_remove = auto_remove;
        }

        if let Some(detach) = py_opts.detach {
            opts.detach = detach;
        }

        if let Some(security) = py_opts.security {
            opts.security = SecurityOptions::from(security);
        }

        opts
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PyVolumeSpec {
    host: String,
    guest: String,
    read_only: bool,
}

impl From<PyVolumeSpec> for VolumeSpec {
    fn from(v: PyVolumeSpec) -> Self {
        VolumeSpec {
            host_path: v.host,
            guest_path: v.guest,
            read_only: v.read_only,
        }
    }
}

impl<'a, 'py> pyo3::FromPyObject<'a, 'py> for PyVolumeSpec {
    type Error = PyErr;

    fn extract(ob: Borrowed<'a, 'py, PyAny>) -> PyResult<Self> {
        let obj = ob.to_owned();

        if let Ok(t) = obj.cast::<PyTuple>() {
            let len = t.len();
            let err =
                || PyRuntimeError::new_err("volumes tuples must be (host, guest[, read_only])");
            let host: String;
            let guest: String;
            let read_only: bool;

            match len {
                2 => {
                    host = t.get_item(0)?.extract()?;
                    guest = t.get_item(1)?.extract()?;
                    read_only = false;
                }
                3 => {
                    host = t.get_item(0)?.extract()?;
                    guest = t.get_item(1)?.extract()?;
                    read_only = t.get_item(2)?.extract()?;
                }
                _ => return Err(err()),
            }

            return Ok(PyVolumeSpec {
                host,
                guest,
                read_only,
            });
        }

        if let Ok(d) = obj.cast::<PyDict>() {
            let host: String = if let Ok(Some(v)) = d.get_item("host") {
                v.extract()?
            } else if let Ok(Some(v)) = d.get_item("host_path") {
                v.extract()?
            } else {
                return Err(PyRuntimeError::new_err(
                    "volume dict missing host/host_path",
                ));
            };

            let guest: String = if let Ok(Some(v)) = d.get_item("guest") {
                v.extract()?
            } else if let Ok(Some(v)) = d.get_item("guest_path") {
                v.extract()?
            } else {
                return Err(PyRuntimeError::new_err(
                    "volume dict missing guest/guest_path",
                ));
            };

            let read_only: bool = if let Ok(Some(v)) = d.get_item("read_only") {
                v.extract()?
            } else if let Ok(Some(v)) = d.get_item("ro") {
                v.extract()?
            } else {
                false
            };

            return Ok(PyVolumeSpec {
                host,
                guest,
                read_only,
            });
        }

        Err(PyRuntimeError::new_err(
            "volumes entries must be tuple or dict",
        ))
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PyPortSpec {
    host: Option<u16>,
    guest: u16,
    protocol: PortProtocol,
    host_ip: Option<String>,
}

impl From<PyPortSpec> for PortSpec {
    fn from(p: PyPortSpec) -> Self {
        PortSpec {
            host_port: p.host,
            guest_port: p.guest,
            protocol: p.protocol,
            host_ip: p.host_ip,
        }
    }
}

impl<'a, 'py> pyo3::FromPyObject<'a, 'py> for PyPortSpec {
    type Error = PyErr;

    fn extract(ob: Borrowed<'a, 'py, PyAny>) -> PyResult<Self> {
        let obj = ob.to_owned();

        if let Ok(t) = obj.cast::<PyTuple>() {
            let len = t.len();
            let err = || {
                PyRuntimeError::new_err("ports tuples must be (host, guest[, protocol[, host_ip]])")
            };
            let host_port: Option<u16>;
            let guest_port: u16;
            let protocol: Option<String>;
            let host_ip: Option<String>;

            match len {
                2 => {
                    host_port = Some(t.get_item(0)?.extract()?);
                    guest_port = t.get_item(1)?.extract()?;
                    protocol = None;
                    host_ip = None;
                }
                3 => {
                    host_port = Some(t.get_item(0)?.extract()?);
                    guest_port = t.get_item(1)?.extract()?;
                    protocol = Some(t.get_item(2)?.extract()?);
                    host_ip = None;
                }
                4 => {
                    host_port = Some(t.get_item(0)?.extract()?);
                    guest_port = t.get_item(1)?.extract()?;
                    protocol = Some(t.get_item(2)?.extract()?);
                    host_ip = Some(t.get_item(3)?.extract()?);
                }
                _ => return Err(err()),
            }

            return Ok(PyPortSpec {
                host: host_port,
                guest: guest_port,
                protocol: parse_protocol(protocol.as_deref().unwrap_or("tcp")),
                host_ip: host_ip.filter(|s| !s.is_empty()),
            });
        }

        if let Ok(d) = obj.cast::<PyDict>() {
            let guest_port: u16 = if let Ok(Some(v)) = d.get_item("guest_port") {
                v.extract()?
            } else if let Ok(Some(v)) = d.get_item("guest") {
                v.extract()?
            } else {
                return Err(PyRuntimeError::new_err("ports dict missing guest_port"));
            };

            let host_port: Option<u16> = if let Ok(Some(v)) = d.get_item("host_port") {
                Some(v.extract()?)
            } else if let Ok(Some(v)) = d.get_item("host") {
                Some(v.extract()?)
            } else {
                None
            };

            let protocol: Option<String> = if let Ok(Some(v)) = d.get_item("protocol") {
                Some(v.extract()?)
            } else {
                None
            };

            let host_ip: Option<String> = if let Ok(Some(v)) = d.get_item("host_ip") {
                Some(v.extract()?)
            } else {
                None
            };

            return Ok(PyPortSpec {
                host: host_port,
                guest: guest_port,
                protocol: parse_protocol(protocol.as_deref().unwrap_or("tcp")),
                host_ip: host_ip.filter(|s| !s.is_empty()),
            });
        }

        Err(PyRuntimeError::new_err(
            "ports entries must be tuple or dict",
        ))
    }
}

fn parse_protocol<S: AsRef<str>>(s: S) -> PortProtocol {
    match s.as_ref().to_ascii_lowercase().as_str() {
        "udp" => PortProtocol::Udp,
        // "sctp" => PortProtocol::Sctp,
        _ => PortProtocol::Tcp,
    }
}
