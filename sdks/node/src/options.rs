use std::path::PathBuf;

use boxlite::runtime::advanced_options::{AdvancedBoxOptions, ResourceLimits, SecurityOptions};
use boxlite::runtime::constants::images;
use boxlite::runtime::options::{
    BoxOptions, BoxliteOptions, NetworkSpec, PortProtocol, PortSpec, RootfsSpec, VolumeSpec,
};
use napi_derive::napi;

/// Runtime configuration options.
///
/// Controls where BoxLite stores runtime data (images, boxes, databases).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsOptions {
    /// Home directory for BoxLite data (defaults to ~/.boxlite)
    pub home_dir: Option<String>,
    /// Registries to search for unqualified image references.
    /// Tried in order; first successful pull wins.
    /// Example: ["ghcr.io", "quay.io", "docker.io"]
    pub image_registries: Option<Vec<String>>,
}

impl From<JsOptions> for BoxliteOptions {
    fn from(js_opts: JsOptions) -> Self {
        let mut config = BoxliteOptions::default();

        if let Some(home_dir) = js_opts.home_dir {
            config.home_dir = PathBuf::from(home_dir);
        }

        if let Some(registries) = js_opts.image_registries {
            config.image_registries = registries;
        }

        config
    }
}

// ============================================================================
// Security Options
// ============================================================================

/// Security isolation options for a box.
///
/// Controls how the boxlite-shim process is isolated from the host.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsSecurityOptions {
    /// Enable jailer isolation (Linux/macOS).
    pub jailer_enabled: Option<bool>,

    /// Enable seccomp syscall filtering (Linux only).
    pub seccomp_enabled: Option<bool>,

    /// Maximum number of open file descriptors.
    pub max_open_files: Option<f64>,

    /// Maximum file size in bytes.
    pub max_file_size: Option<f64>,

    /// Maximum number of processes.
    pub max_processes: Option<f64>,

    /// Maximum virtual memory in bytes.
    pub max_memory: Option<f64>,

    /// Maximum CPU time in seconds.
    pub max_cpu_time: Option<f64>,

    /// Enable network access in sandbox (macOS only).
    pub network_enabled: Option<bool>,

    /// Close inherited file descriptors.
    pub close_fds: Option<bool>,
}

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn coerce_u64_limit(number: f64) -> Option<u64> {
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 {
        return None;
    }

    if number > JS_MAX_SAFE_INTEGER as f64 {
        return None;
    }

    Some(number as u64)
}

fn coerce_optional_u64_limit(value: Option<f64>) -> Option<u64> {
    value.and_then(coerce_u64_limit)
}

impl From<JsSecurityOptions> for SecurityOptions {
    fn from(js_opts: JsSecurityOptions) -> Self {
        let mut opts = SecurityOptions::default();

        if let Some(jailer_enabled) = js_opts.jailer_enabled {
            opts.jailer_enabled = jailer_enabled;
        }

        if let Some(seccomp_enabled) = js_opts.seccomp_enabled {
            opts.seccomp_enabled = seccomp_enabled;
        }

        if let Some(network_enabled) = js_opts.network_enabled {
            opts.network_enabled = network_enabled;
        }

        if let Some(close_fds) = js_opts.close_fds {
            opts.close_fds = close_fds;
        }

        opts.resource_limits = ResourceLimits {
            max_open_files: coerce_optional_u64_limit(js_opts.max_open_files),
            max_file_size: coerce_optional_u64_limit(js_opts.max_file_size),
            max_processes: coerce_optional_u64_limit(js_opts.max_processes),
            max_memory: coerce_optional_u64_limit(js_opts.max_memory),
            max_cpu_time: coerce_optional_u64_limit(js_opts.max_cpu_time),
        };

        opts
    }
}

/// Box creation options.
///
/// Specifies container image, resource limits, environment, volumes, and networking.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsBoxOptions {
    /// OCI image reference (e.g., "python:slim", "ghcr.io/owner/image:tag")
    pub image: Option<String>,

    /// Path to pre-prepared rootfs directory (alternative to image)
    pub rootfs_path: Option<String>,

    /// Number of CPU cores (default: 1)
    pub cpus: Option<u8>,

    /// Memory limit in MiB (default: 512)
    pub memory_mib: Option<u32>,

    /// Disk size in GB for container rootfs (sparse, grows as needed)
    pub disk_size_gb: Option<f64>,

    /// Working directory inside container (default: /root)
    pub working_dir: Option<String>,

    /// Environment variables as array of {key, value} objects
    pub env: Option<Vec<JsEnvVar>>,

    /// Volume mounts as array of volume specs
    pub volumes: Option<Vec<JsVolumeSpec>>,

    /// Network mode ("isolated" - only option currently)
    pub network: Option<String>,

    /// Port mappings as array of port specs
    pub ports: Option<Vec<JsPortSpec>>,

    /// Automatically remove box when stopped (default: false)
    pub auto_remove: Option<bool>,

    /// Run box in detached mode (survives parent process exit, default: false)
    pub detach: Option<bool>,

    /// Override image ENTRYPOINT directive.
    ///
    /// When set, completely replaces the image's ENTRYPOINT.
    /// Use with `cmd` to build the full command:
    ///   Final execution = entrypoint + cmd
    pub entrypoint: Option<Vec<String>>,

    /// Override image CMD directive.
    ///
    /// The image ENTRYPOINT is preserved; these args replace the image's CMD.
    /// Final execution = image_entrypoint + cmd.
    pub cmd: Option<Vec<String>>,

    /// Username or UID (format: <name|uid>[:<group|gid>]).
    /// If None, uses the image's USER directive (defaults to root).
    pub user: Option<String>,

    /// Security isolation options for the box.
    pub security: Option<JsSecurityOptions>,
}

/// Environment variable specification.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsEnvVar {
    pub key: String,
    pub value: String,
}

/// Volume mount specification.
///
/// Maps a host directory to a guest path inside the container.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsVolumeSpec {
    /// Path on host machine
    pub host_path: String,

    /// Path inside container
    pub guest_path: String,

    /// Mount as read-only (default: false)
    pub read_only: Option<bool>,
}

impl From<JsVolumeSpec> for VolumeSpec {
    fn from(v: JsVolumeSpec) -> Self {
        VolumeSpec {
            host_path: v.host_path,
            guest_path: v.guest_path,
            read_only: v.read_only.unwrap_or(false),
        }
    }
}

/// Port mapping specification.
///
/// Maps a host port to a container port for network access.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsPortSpec {
    /// Port on host (None = auto-assign)
    #[napi(js_name = "hostPort")]
    pub host_port: Option<u16>,

    /// Port inside container
    #[napi(js_name = "guestPort")]
    pub guest_port: u16,

    /// Protocol ("tcp" or "udp", default: "tcp")
    pub protocol: Option<String>,

    /// Bind IP address (default: 0.0.0.0)
    #[napi(js_name = "hostIp")]
    pub host_ip: Option<String>,
}

impl From<JsPortSpec> for PortSpec {
    fn from(p: JsPortSpec) -> Self {
        let protocol = match p.protocol.as_deref() {
            Some("udp") => PortProtocol::Udp,
            _ => PortProtocol::Tcp,
        };

        PortSpec {
            host_port: p.host_port,
            guest_port: p.guest_port,
            protocol,
            host_ip: p.host_ip,
        }
    }
}

impl From<JsBoxOptions> for BoxOptions {
    fn from(js_opts: JsBoxOptions) -> Self {
        // Convert volumes
        let volumes = js_opts
            .volumes
            .unwrap_or_default()
            .into_iter()
            .map(VolumeSpec::from)
            .collect();

        // Convert network spec
        let network = match js_opts.network.as_deref() {
            Some(s) if s.eq_ignore_ascii_case("isolated") => NetworkSpec::Isolated,
            _ => NetworkSpec::Isolated,
        };

        // Convert ports
        let ports = js_opts
            .ports
            .unwrap_or_default()
            .into_iter()
            .map(PortSpec::from)
            .collect();

        // Convert image/rootfs_path to RootfsSpec
        let rootfs = match &js_opts.rootfs_path {
            Some(path) if !path.is_empty() => RootfsSpec::RootfsPath(path.clone()),
            _ => {
                let image = js_opts
                    .image
                    .clone()
                    .unwrap_or_else(|| images::DEFAULT.to_string());
                RootfsSpec::Image(image)
            }
        };

        // Convert environment variables
        let env = js_opts
            .env
            .unwrap_or_default()
            .into_iter()
            .map(|e| (e.key, e.value))
            .collect();

        let security = js_opts
            .security
            .map(SecurityOptions::from)
            .unwrap_or_default();

        BoxOptions {
            cpus: js_opts.cpus,
            memory_mib: js_opts.memory_mib,
            disk_size_gb: js_opts.disk_size_gb.map(|v| v as u64),
            working_dir: js_opts.working_dir,
            env,
            rootfs,
            volumes,
            network,
            ports,
            advanced: AdvancedBoxOptions {
                security,
                ..Default::default()
            },
            auto_remove: js_opts.auto_remove.unwrap_or(false),
            detach: js_opts.detach.unwrap_or(false),
            entrypoint: js_opts.entrypoint,
            cmd: js_opts.cmd,
            user: js_opts.user,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coerces_safe_integer_number_limit() {
        let parsed = coerce_u64_limit(1024.0);
        assert_eq!(parsed, Some(1024));
    }

    #[test]
    fn drops_fractional_number_limit() {
        let parsed = coerce_u64_limit(12.5);
        assert_eq!(parsed, None);
    }

    #[test]
    fn drops_negative_number_limit() {
        let parsed = coerce_u64_limit(-1.0);
        assert_eq!(parsed, None);
    }

    #[test]
    fn drops_unsafe_integer_number_limit() {
        let too_large_for_number = JS_MAX_SAFE_INTEGER as f64 + 1.0;
        let parsed = coerce_u64_limit(too_large_for_number);
        assert_eq!(parsed, None);
    }

    #[test]
    fn drops_non_finite_number_limit() {
        let parsed = coerce_u64_limit(f64::INFINITY);
        assert_eq!(parsed, None);
    }
}
