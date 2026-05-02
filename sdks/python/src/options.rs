use std::path::PathBuf;

use boxlite::BoxliteRestOptions;
use boxlite::litebox::copy::CopyOptions;
use boxlite::runtime::advanced_options::{HealthCheckOptions, SecurityOptions};
use boxlite::runtime::constants::images;
use boxlite::runtime::options::{
    BoxOptions, BoxliteOptions, ImageRegistry, ImageRegistryAuth, NetworkConfig, NetworkMode,
    NetworkSpec, PortProtocol, PortSpec, RegistryTransport, RootfsSpec, VolumeSpec,
};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyAnyMethods, PyDict, PyTuple};

use crate::advanced_options::PyAdvancedBoxOptions;

#[pyclass(name = "Options")]
#[derive(Clone, Debug)]
pub(crate) struct PyOptions {
    #[pyo3(get, set)]
    pub(crate) home_dir: Option<String>,
    /// Registry transport, TLS, search, and auth configuration.
    #[pyo3(get, set)]
    pub(crate) image_registries: Vec<PyImageRegistry>,
}

#[pymethods]
impl PyOptions {
    #[new]
    #[pyo3(signature = (home_dir=None, image_registries=vec![]))]
    fn new(home_dir: Option<String>, image_registries: Vec<PyImageRegistry>) -> Self {
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

impl PyOptions {
    pub(crate) fn into_core(self) -> PyResult<BoxliteOptions> {
        let mut config = BoxliteOptions::default();

        if let Some(home_dir) = self.home_dir {
            config.home_dir = PathBuf::from(home_dir);
        }

        config.image_registries = self
            .image_registries
            .into_iter()
            .map(PyImageRegistry::into_core)
            .collect::<PyResult<Vec<_>>>()?;

        Ok(config)
    }
}

#[pyclass(name = "ImageRegistry")]
#[derive(Clone)]
pub(crate) struct PyImageRegistry {
    #[pyo3(get, set)]
    pub(crate) host: String,
    #[pyo3(get, set)]
    pub(crate) transport: String,
    #[pyo3(get, set)]
    pub(crate) skip_verify: bool,
    #[pyo3(get, set)]
    pub(crate) search: bool,
    #[pyo3(get, set)]
    pub(crate) username: Option<String>,
    #[pyo3(get, set)]
    pub(crate) password: Option<String>,
    #[pyo3(get, set)]
    pub(crate) bearer_token: Option<String>,
}

impl std::fmt::Debug for PyImageRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageRegistry")
            .field("host", &self.host)
            .field("transport", &self.transport)
            .field("skip_verify", &self.skip_verify)
            .field("search", &self.search)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "***"))
            .field("bearer_token", &self.bearer_token.as_ref().map(|_| "***"))
            .finish()
    }
}

#[pymethods]
impl PyImageRegistry {
    #[new]
    #[pyo3(signature = (
        host,
        transport = "https".to_string(),
        skip_verify = false,
        search = false,
        username = None,
        password = None,
        bearer_token = None
    ))]
    fn new(
        host: String,
        transport: String,
        skip_verify: bool,
        search: bool,
        username: Option<String>,
        password: Option<String>,
        bearer_token: Option<String>,
    ) -> PyResult<Self> {
        validate_registry_host(&host)?;
        parse_registry_transport(&transport)?;
        validate_registry_auth(&username, &password)?;

        Ok(Self {
            host,
            transport,
            skip_verify,
            search,
            username,
            password,
            bearer_token,
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "ImageRegistry(host={:?}, transport={:?}, skip_verify={}, search={})",
            self.host, self.transport, self.skip_verify, self.search
        )
    }
}

impl PyImageRegistry {
    fn into_core(self) -> PyResult<ImageRegistry> {
        validate_registry_host(&self.host)?;
        let transport = parse_registry_transport(&self.transport)?;
        validate_registry_auth(&self.username, &self.password)?;

        let auth = if let Some(token) = self.bearer_token {
            ImageRegistryAuth::Bearer { token }
        } else if let (Some(username), Some(password)) = (self.username, self.password) {
            ImageRegistryAuth::Basic { username, password }
        } else {
            ImageRegistryAuth::Anonymous
        };

        Ok(ImageRegistry {
            host: self.host,
            transport,
            skip_verify: self.skip_verify,
            search: self.search,
            auth,
        })
    }
}

fn validate_registry_host(host: &str) -> PyResult<()> {
    if host.trim().is_empty() {
        return Err(PyRuntimeError::new_err("image registry host is required"));
    }
    if host.contains("://") || host.contains('/') {
        return Err(PyRuntimeError::new_err(format!(
            "image registry host must be host[:port], not a URL: {host}"
        )));
    }
    Ok(())
}

fn parse_registry_transport(transport: &str) -> PyResult<RegistryTransport> {
    match transport {
        "" | "https" => Ok(RegistryTransport::Https),
        "http" => Ok(RegistryTransport::Http),
        _ => Err(PyRuntimeError::new_err(format!(
            "unsupported registry transport: {transport}"
        ))),
    }
}

fn validate_registry_auth(username: &Option<String>, password: &Option<String>) -> PyResult<()> {
    if username.is_some() != password.is_some() {
        return Err(PyRuntimeError::new_err(
            "registry username and password must be provided together",
        ));
    }
    Ok(())
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
// NetworkSpec
// ============================================================================

#[pyclass(name = "NetworkSpec")]
#[derive(Clone, Debug)]
pub(crate) struct PyNetworkSpec {
    #[pyo3(get, set)]
    pub(crate) mode: String,
    #[pyo3(get, set)]
    pub(crate) allow_net: Vec<String>,
}

#[pymethods]
impl PyNetworkSpec {
    #[new]
    #[pyo3(signature = (mode, allow_net=vec![]))]
    fn new(mode: String, allow_net: Vec<String>) -> Self {
        Self { mode, allow_net }
    }

    fn __repr__(&self) -> String {
        format!(
            "NetworkSpec(mode={:?}, allow_net={:?})",
            self.mode, self.allow_net
        )
    }
}

impl TryFrom<PyNetworkSpec> for NetworkSpec {
    type Error = boxlite::BoxliteError;

    fn try_from(py_spec: PyNetworkSpec) -> Result<Self, Self::Error> {
        let mode = py_spec.mode.parse::<NetworkMode>()?;
        NetworkSpec::try_from(NetworkConfig {
            mode,
            allow_net: py_spec.allow_net,
        })
    }
}

// ============================================================================
// Secret
// ============================================================================

/// A secret to inject into outbound HTTPS requests via MITM proxy.
///
/// The guest code uses a placeholder string (e.g., ``<BOXLITE_SECRET:openai>``)
/// in HTTP headers. The host-side proxy replaces the placeholder with the
/// real secret value before forwarding the request. The actual secret never
/// enters the guest VM.
///
/// Example::
///
///     from boxlite import Secret
///
///     secret = Secret(
///         name="openai",
///         value="sk-...",
///         hosts=["api.openai.com"],
///     )
///     # Pass to BoxOptions:
///     opts = BoxOptions(image="python:3.12", secrets=[secret])
///
#[pyclass(name = "Secret")]
#[derive(Clone, Debug)]
pub(crate) struct PySecret {
    /// Human-readable name for the secret (e.g., "openai").
    #[pyo3(get, set)]
    pub(crate) name: String,

    /// The real secret value (never sent to the guest).
    #[pyo3(get, set)]
    pub(crate) value: String,

    /// Hostnames where this secret should be injected.
    /// Supports exact matches ("api.openai.com") and wildcards ("*.openai.com").
    #[pyo3(get, set)]
    pub(crate) hosts: Vec<String>,

    /// The placeholder string that appears in guest HTTP headers.
    /// Defaults to ``<BOXLITE_SECRET:{name}>`` if not set explicitly.
    #[pyo3(get, set)]
    pub(crate) placeholder: Option<String>,
}

#[pymethods]
impl PySecret {
    #[new]
    #[pyo3(signature = (name, value, hosts=vec![], placeholder=None))]
    fn new(name: String, value: String, hosts: Vec<String>, placeholder: Option<String>) -> Self {
        Self {
            name,
            value,
            hosts,
            placeholder,
        }
    }

    /// Return the effective placeholder string.
    fn get_placeholder(&self) -> String {
        self.placeholder
            .clone()
            .unwrap_or_else(|| format!("<BOXLITE_SECRET:{}>", self.name))
    }

    fn __repr__(&self) -> String {
        format!(
            "Secret(name={:?}, hosts={:?}, placeholder={:?}, value=[REDACTED])",
            self.name,
            self.hosts,
            self.get_placeholder(),
        )
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
    pub(crate) network: Option<PyNetworkSpec>,
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

    /// Advanced options for expert users (security, mount isolation, health check).
    #[pyo3(get, set)]
    pub(crate) advanced: Option<PyAdvancedBoxOptions>,

    /// Secrets to inject into outbound HTTPS requests via MITM proxy.
    #[pyo3(get, set)]
    pub(crate) secrets: Vec<PySecret>,
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
        advanced=None,
        secrets=vec![],
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
        network: Option<PyNetworkSpec>,
        ports: Vec<PyPortSpec>,
        auto_remove: Option<bool>,
        detach: Option<bool>,
        entrypoint: Option<Vec<String>>,
        cmd: Option<Vec<String>>,
        user: Option<String>,
        advanced: Option<PyAdvancedBoxOptions>,
        secrets: Vec<PySecret>,
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
            advanced,
            secrets,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "BoxOptions(image={:?}, rootfs_path={:?}, cpus={:?}, memory_mib={:?}, advanced={:?})",
            self.image,
            self.rootfs_path,
            self.cpus,
            self.memory_mib,
            self.advanced.is_some()
        )
    }
}

impl TryFrom<PyBoxOptions> for BoxOptions {
    type Error = boxlite::BoxliteError;

    fn try_from(py_opts: PyBoxOptions) -> Result<Self, Self::Error> {
        let volumes = py_opts.volumes.into_iter().map(VolumeSpec::from).collect();

        let network = match py_opts.network {
            Some(spec) => NetworkSpec::try_from(spec)?,
            None => NetworkSpec::default(),
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

        if let Some(advanced) = py_opts.advanced {
            if let Some(security) = advanced.security {
                opts.advanced.security = SecurityOptions::from(security);
            }
            if let Some(health_check) = advanced.health_check {
                opts.advanced.health_check = Some(HealthCheckOptions::from(health_check));
            }
        }

        // Convert Python secrets to Rust secrets
        opts.secrets = py_opts
            .secrets
            .into_iter()
            .map(|s| boxlite::runtime::options::Secret {
                name: s.name.clone(),
                hosts: s.hosts,
                placeholder: s
                    .placeholder
                    .unwrap_or_else(|| format!("<BOXLITE_SECRET:{}>", s.name)),
                value: s.value,
            })
            .collect();

        Ok(opts)
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

// ============================================================================
// REST Options
// ============================================================================

/// Configuration for connecting to a remote BoxLite REST API server.
///
/// Example::
///
///     opts = BoxliteRestOptions(url="https://api.example.com")
///     opts = BoxliteRestOptions(
///         url="https://api.example.com",
///         client_id="my-client",
///         client_secret="my-secret",
///     )
///     opts = BoxliteRestOptions.from_env()
///
#[pyclass(name = "BoxliteRestOptions")]
#[derive(Clone, Debug)]
pub(crate) struct PyBoxliteRestOptions {
    #[pyo3(get, set)]
    pub(crate) url: String,
    #[pyo3(get, set)]
    pub(crate) client_id: Option<String>,
    #[pyo3(get, set)]
    pub(crate) client_secret: Option<String>,
    #[pyo3(get, set)]
    pub(crate) prefix: Option<String>,
}

#[pymethods]
impl PyBoxliteRestOptions {
    #[new]
    #[pyo3(signature = (url, client_id=None, client_secret=None, prefix=None))]
    fn new(
        url: String,
        client_id: Option<String>,
        client_secret: Option<String>,
        prefix: Option<String>,
    ) -> Self {
        Self {
            url,
            client_id,
            client_secret,
            prefix,
        }
    }

    /// Create BoxliteRestOptions from environment variables.
    ///
    /// Reads: BOXLITE_REST_URL (required), BOXLITE_REST_CLIENT_ID,
    ///        BOXLITE_REST_CLIENT_SECRET, BOXLITE_REST_PREFIX
    #[staticmethod]
    fn from_env() -> PyResult<Self> {
        let opts = BoxliteRestOptions::from_env().map_err(crate::util::map_err)?;
        Ok(Self {
            url: opts.url,
            client_id: opts.client_id,
            client_secret: opts.client_secret,
            prefix: opts.prefix,
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "BoxliteRestOptions(url={:?}, client_id={:?}, prefix={:?})",
            self.url,
            self.client_id.as_deref().map(|_| "***"),
            self.prefix,
        )
    }
}

impl From<PyBoxliteRestOptions> for BoxliteRestOptions {
    fn from(py_opts: PyBoxliteRestOptions) -> Self {
        let mut opts = BoxliteRestOptions::new(py_opts.url);
        opts.client_id = py_opts.client_id;
        opts.client_secret = py_opts.client_secret;
        opts.prefix = py_opts.prefix;
        opts
    }
}
