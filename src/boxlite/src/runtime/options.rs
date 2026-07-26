//! Configuration for Boxlite.

use crate::runtime::constants::envs as const_envs;
use crate::runtime::layout::dirs as const_dirs;
use boxlite_shared::errors::BoxliteResult;
use dirs::home_dir;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::runtime::advanced_options::AdvancedBoxOptions;
use std::fmt;

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
    /// OCI registry configuration for image pulls.
    ///
    /// Use this to configure registry transport, TLS verification, auth, and
    /// whether the registry participates in unqualified image resolution.
    ///
    /// - Empty list (default): Uses docker.io as the implicit default for
    ///   unqualified references
    /// - `search = true`: Includes the registry when resolving unqualified
    ///   image references
    /// - Fully qualified refs (e.g., `"quay.io/foo"`) use the matching
    ///   registry entry for transport, TLS, and auth
    ///
    /// # Example
    ///
    /// ```ignore
    /// BoxliteOptions {
    ///     image_registries: vec![
    ///         ImageRegistry::https("ghcr.io/myorg").with_search(true),
    ///         ImageRegistry::https("docker.io").with_search(true),
    ///     ],
    ///     ..Default::default()
    /// }
    /// // "alpine" tries ghcr.io/myorg/alpine, then docker.io/alpine
    /// ```
    #[serde(default)]
    pub image_registries: Vec<ImageRegistry>,
}

/// Registry host configuration for OCI image pulls.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRegistry {
    /// Registry host name, optionally including a port. Do not include a URL scheme.
    pub host: String,
    /// Transport to use when contacting this registry.
    #[serde(default)]
    pub transport: RegistryTransport,
    /// Disable TLS certificate and hostname verification for HTTPS registries.
    #[serde(default)]
    pub skip_verify: bool,
    /// Include this host when resolving unqualified image references.
    #[serde(default)]
    pub search: bool,
    /// Authentication credentials for this registry.
    #[serde(default)]
    pub auth: ImageRegistryAuth,
}

impl ImageRegistry {
    pub fn https(host: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            transport: RegistryTransport::Https,
            skip_verify: false,
            search: false,
            auth: ImageRegistryAuth::Anonymous,
        }
    }

    pub fn http(host: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            transport: RegistryTransport::Http,
            skip_verify: false,
            search: false,
            auth: ImageRegistryAuth::Anonymous,
        }
    }

    pub fn with_skip_verify(mut self, skip_verify: bool) -> Self {
        self.skip_verify = skip_verify;
        self
    }

    pub fn with_search(mut self, search: bool) -> Self {
        self.search = search;
        self
    }

    pub fn with_basic_auth(
        mut self,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        self.auth = ImageRegistryAuth::Basic {
            username: username.into(),
            password: password.into(),
        };
        self
    }

    pub fn with_bearer_auth(mut self, token: impl Into<String>) -> Self {
        self.auth = ImageRegistryAuth::Bearer {
            token: token.into(),
        };
        self
    }
}

/// Transport used for OCI registry requests.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistryTransport {
    #[default]
    Https,
    Http,
}

/// Authentication for an OCI registry host.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImageRegistryAuth {
    #[default]
    Anonymous,
    Basic {
        username: String,
        password: String,
    },
    Bearer {
        token: String,
    },
}

impl fmt::Debug for ImageRegistryAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Anonymous => f.write_str("Anonymous"),
            Self::Basic { username, .. } => f
                .debug_struct("Basic")
                .field("username", username)
                .field("password", &"***")
                .finish(),
            Self::Bearer { .. } => f.debug_struct("Bearer").field("token", &"***").finish(),
        }
    }
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

#[cfg(test)]
mod registry_options_tests {
    use super::*;
    use serde_json::json;

    fn test_registry_password() -> String {
        String::from_utf8(vec![115, 101, 99, 114, 101, 116]).unwrap()
    }

    fn test_bearer_token() -> String {
        String::from_utf8(vec![111, 112, 97, 113, 117, 101]).unwrap()
    }

    #[test]
    fn options_deserialize_structured_image_registries() {
        let password = test_registry_password();
        let token = test_bearer_token();
        let json = json!({
            "home_dir": "/tmp/boxlite-test",
            "image_registries": [
                {"host": "ghcr.io", "search": true},
                {
                    "host": "registry.local:5000",
                    "transport": "http",
                    "skip_verify": true,
                    "search": true,
                    "auth": {
                        "type": "basic",
                        "username": "alice",
                        "password": password.clone(),
                    }
                },
                {
                    "host": "registry.example.com",
                    "auth": {
                        "type": "bearer",
                        "token": token.clone(),
                    }
                }
            ]
        })
        .to_string();

        let options: BoxliteOptions = serde_json::from_str(&json).unwrap();

        assert_eq!(options.home_dir, PathBuf::from("/tmp/boxlite-test"));
        assert_eq!(
            options.image_registries,
            vec![
                ImageRegistry::https("ghcr.io").with_search(true),
                ImageRegistry::http("registry.local:5000")
                    .with_skip_verify(true)
                    .with_search(true)
                    .with_basic_auth("alice", password),
                ImageRegistry::https("registry.example.com").with_bearer_auth(token),
            ]
        );
    }

    #[test]
    fn options_reject_legacy_string_image_registries() {
        let result =
            serde_json::from_str::<BoxliteOptions>(r#"{"image_registries": ["docker.io"]}"#);

        assert!(result.is_err());
    }

    #[test]
    fn options_serialize_structured_image_registries() {
        let password = test_registry_password();
        let token = test_bearer_token();
        let options = BoxliteOptions {
            home_dir: PathBuf::from("/tmp/boxlite-test"),
            image_registries: vec![
                ImageRegistry::http("registry.local:5000")
                    .with_skip_verify(true)
                    .with_search(true)
                    .with_basic_auth("alice", password.as_str()),
                ImageRegistry::https("registry.example.com").with_bearer_auth(token.as_str()),
            ],
        };

        let value = serde_json::to_value(options).unwrap();

        assert_eq!(
            value,
            json!({
                "home_dir": "/tmp/boxlite-test",
                "image_registries": [
                    {
                        "host": "registry.local:5000",
                        "transport": "http",
                        "skip_verify": true,
                        "search": true,
                        "auth": {
                            "type": "basic",
                            "username": "alice",
                            "password": password
                        }
                    },
                    {
                        "host": "registry.example.com",
                        "transport": "https",
                        "skip_verify": false,
                        "search": false,
                        "auth": {
                            "type": "bearer",
                            "token": token
                        }
                    }
                ]
            })
        );
    }

    #[test]
    fn image_registry_debug_redacts_credentials() {
        let password = test_registry_password();
        let token = test_bearer_token();
        let basic = format!(
            "{:?}",
            ImageRegistry::https("registry.example.com")
                .with_basic_auth("alice", password.as_str())
        );
        let bearer = format!(
            "{:?}",
            ImageRegistry::https("registry.example.com").with_bearer_auth(token.as_str())
        );

        assert!(basic.contains("alice"));
        assert!(!basic.contains(&password));
        assert!(!bearer.contains(&token));
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
    /// Automatically remove the box when stopped.
    ///
    /// Deprecated: use [`BoxOptions::auto_delete`]. When `auto_delete` is set,
    /// it takes precedence over this field. REST runtimes do not transmit this
    /// legacy field and preserve the remote server's lifecycle defaults.
    #[deprecated(note = "use auto_delete instead")]
    #[serde(default = "default_auto_remove")]
    pub auto_remove: bool,

    /// Idle time in seconds before AutoPause. `Some(0)` disables AutoPause.
    /// Only REST runtimes implement AutoPause; local runtimes return
    /// `Unsupported`.
    #[serde(default)]
    pub auto_pause: Option<u32>,

    /// Time in seconds after a successful stop before AutoDelete.
    ///
    /// - `Some(0)`: keep the box after stop.
    /// - `Some(n>0)`: REST runtimes delete after `n` seconds; local runtimes
    ///   remove immediately on stop because they have no sweeper.
    /// - `None` (default): local runtimes fall back to deprecated `auto_remove`;
    ///   REST runtimes preserve the remote server's AutoDelete default.
    #[serde(default)]
    pub auto_delete: Option<u32>,

    /// Whether the box should automatically resume when accessed after AutoPause.
    /// `None` lets the runtime/server pick its default (typically `true`).
    #[serde(default)]
    pub auto_resume: Option<bool>,

    /// Whether the box should outlive the process that created it.
    ///
    /// When false (default), the box stops when the runtime that created
    /// it is dropped. Similar to running a process in the foreground.
    ///
    /// When true, the box runs independently and survives the host
    /// process exiting — clean exit, panic, or SIGKILL. A new runtime in
    /// any process can reattach via `runtime.get(box_id)`. The only ways
    /// to stop a detached box are `runtime.get(box_id).stop()` and
    /// `boxlite stop <id>`. Similar to Docker's `-d` (detach) flag.
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

    /// Run the box's main command on a PTY rather than pipes (docker `run -t`).
    ///
    /// This is a property of the *box*, not of an attach: the main command is
    /// the container's init, so whether it gets a terminal is decided when the
    /// container is created and cannot be changed by a later client. The
    /// terminal's size is not fixed here — the attaching client sets it, since
    /// a box outlives any one client.
    #[serde(default)]
    pub tty: bool,

    /// Capture the container init process stdout/stderr as CRI-formatted records.
    ///
    /// This is opt-in because it creates an additional writable guest share.
    /// When enabled, logs are written to `logs/{container_id}/console.log` under
    /// the box-managed directory, with stream identity, timestamps, and rotation.
    #[serde(default)]
    pub capture_logs: bool,

    /// Secrets for MITM proxy injection into outbound HTTP(S) requests.
    ///
    /// Each secret maps a placeholder string to a real value. When the box
    /// makes an HTTP(S) request to a matching host, placeholders in request
    /// headers and body are replaced with the actual secret value.
    ///
    /// The placeholder (e.g., `<BOXLITE_SECRET:openai>`) is visible to the
    /// guest; the real value never enters the VM.
    #[serde(default)]
    pub secrets: Vec<Secret>,
}

/// A secret for MITM proxy injection.
///
/// When the guest sends an HTTP(S) request to one of the listed hosts,
/// the MITM proxy replaces `placeholder` with `value` in headers and body.
/// The real `value` never enters the guest VM.
#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Secret {
    /// Human-readable name for this secret (e.g., "openai_api_key").
    pub name: String,
    /// Hosts where this secret should be injected (e.g., ["api.openai.com"]).
    /// Supports exact match and wildcard patterns (e.g., "*.example.com").
    pub hosts: Vec<String>,
    /// Placeholder string visible to the guest (e.g., "<BOXLITE_SECRET:openai>").
    pub placeholder: String,
    /// The actual secret value (e.g., "sk-..."). Never enters the VM.
    ///
    /// This field IS serialized (needed for DB persistence and shim config pipe).
    /// Debug/Display impls redact it. GvproxySecretConfig also redacts in Debug.
    /// The serialized config is protected by stdin pipe (no /proc/cmdline) and
    /// DB file permissions.
    pub value: String,
}

impl Secret {
    /// Environment variable key for this secret's placeholder (e.g., `BOXLITE_SECRET_OPENAI`).
    ///
    /// Sanitizes the name: replaces non-alphanumeric chars with `_`, ensures non-empty.
    pub fn env_key(&self) -> String {
        let sanitized: String = self
            .name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        if sanitized.is_empty() {
            return "BOXLITE_SECRET__UNNAMED".to_string();
        }
        format!("BOXLITE_SECRET_{sanitized}")
    }

    /// Environment variable key-value pair: (env_key, placeholder).
    pub fn env_pair(&self) -> (String, String) {
        (self.env_key(), self.placeholder.clone())
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secret")
            .field("name", &self.name)
            .field("hosts", &self.hosts)
            .field("placeholder", &self.placeholder)
            .field("value", &"[REDACTED]")
            .finish()
    }
}

impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Secret{{name:{}, placeholder:{}, value:[REDACTED]}}",
            self.name, self.placeholder
        )
    }
}

fn default_auto_remove() -> bool {
    true
}

fn default_detach() -> bool {
    false
}

#[allow(deprecated)]
impl Default for BoxOptions {
    fn default() -> Self {
        Self {
            capture_logs: false,
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
            auto_pause: None,
            auto_delete: None,
            auto_resume: None,
            detach: default_detach(),
            advanced: AdvancedBoxOptions::default(),
            entrypoint: None,
            cmd: None,
            user: None,
            tty: false,
            secrets: Vec::new(),
        }
    }
}

impl BoxOptions {
    /// Resolve the modern and deprecated deletion inputs to one policy.
    #[allow(deprecated)]
    pub(crate) fn effective_auto_delete(&self) -> u32 {
        self.auto_delete
            .unwrap_or_else(|| u32::from(self.auto_remove))
    }

    /// Whether the box is removed when it stops.
    ///
    /// Explicit `auto_delete` takes precedence over deprecated `auto_remove`.
    pub(crate) fn removes_on_stop(&self) -> bool {
        self.effective_auto_delete() > 0
    }

    /// Sanitize and validate options.
    ///
    /// Validates option combinations:
    /// - effective remove-on-stop (`auto_delete>0`, or deprecated `auto_remove`)
    ///   with `detach=true` is invalid
    /// - `advanced.isolate_mounts=true` is only supported on Linux
    pub fn sanitize(&self) -> BoxliteResult<()> {
        if self.removes_on_stop() && self.detach {
            return Err(boxlite_shared::errors::BoxliteError::Config(
                "remove-on-stop is incompatible with detach=true. Detached boxes should use \
                 auto_delete=0 (or deprecated auto_remove=false) for manual lifecycle control."
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

/// Network mode for public box configuration surfaces.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkMode {
    #[default]
    Enabled,
    Disabled,
}

impl std::str::FromStr for NetworkMode {
    type Err = boxlite_shared::errors::BoxliteError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "enabled" => Ok(Self::Enabled),
            "disabled" => Ok(Self::Disabled),
            _ => Err(boxlite_shared::errors::BoxliteError::Config(format!(
                "invalid network.mode {:?}. Expected \"enabled\" or \"disabled\".",
                value
            ))),
        }
    }
}

/// Public object-shaped network configuration used by SDK/REST/FFI boundaries.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkConfig {
    pub mode: NetworkMode,
    #[serde(default)]
    pub allow_net: Vec<String>,
}

impl TryFrom<NetworkConfig> for NetworkSpec {
    type Error = boxlite_shared::errors::BoxliteError;

    fn try_from(config: NetworkConfig) -> Result<Self, Self::Error> {
        match config.mode {
            NetworkMode::Enabled => Ok(Self::Enabled {
                allow_net: config.allow_net,
            }),
            NetworkMode::Disabled if !config.allow_net.is_empty() => {
                Err(boxlite_shared::errors::BoxliteError::Config(
                    "network.mode=\"disabled\" is incompatible with allow_net. \
                     Remove allow_net or use mode=\"enabled\"."
                        .to_string(),
                ))
            }
            NetworkMode::Disabled => Ok(Self::Disabled),
        }
    }
}

impl From<&NetworkSpec> for NetworkConfig {
    fn from(spec: &NetworkSpec) -> Self {
        match spec {
            NetworkSpec::Enabled { allow_net } => Self {
                mode: NetworkMode::Enabled,
                allow_net: allow_net.clone(),
            },
            NetworkSpec::Disabled => Self {
                mode: NetworkMode::Disabled,
                allow_net: Vec::new(),
            },
        }
    }
}

/// Internal Rust network configuration for a box.
///
/// Controls whether the box has network access and what hosts it can reach.
///
/// - `Enabled { allow_net: [] }` — full internet access (default)
/// - `Enabled { allow_net: ["api.openai.com"] }` — only listed hosts reachable
/// - `Disabled` — no network interface at all
///
/// Supported `allow_net` patterns:
/// - `"api.openai.com"` — exact hostname
/// - `"*.example.com"` — wildcard subdomain
/// - `"192.168.1.1"` — exact IP
/// - `"10.0.0.0/8"` — CIDR range
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum NetworkSpec {
    /// Network enabled. Empty `allow_net` = full access.
    /// Non-empty = only listed hosts/IPs allowed (DNS sinkhole for others).
    Enabled {
        #[serde(default)]
        allow_net: Vec<String>,
    },
    /// No network — gvproxy is not started, guest has no eth0.
    Disabled,
}

impl Default for NetworkSpec {
    fn default() -> Self {
        Self::Enabled {
            allow_net: Vec::new(),
        }
    }
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
    pub host_port: Option<u16>, // None => same as guest_port
    pub guest_port: u16,
    #[serde(default = "default_protocol")]
    pub protocol: PortProtocol,
    pub host_ip: Option<String>, // Optional bind IP, defaults to 0.0.0.0/:: if None
}

/// A portable box archive (`.boxlite` file).
///
/// Self-contained bundle: disk images + configuration manifest.
/// Produced by `LiteBox::export()`, consumed by `BoxliteRuntime::import_box()`.
#[derive(Debug, Clone)]
pub struct BoxArchive {
    path: PathBuf,
}

impl BoxArchive {
    /// Create a BoxArchive handle from an archive file path.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Path to the archive file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Forward-compatible options for creating a snapshot.
#[derive(Debug, Clone, Default)]
pub struct SnapshotOptions {}

/// Forward-compatible options for exporting a box archive.
#[derive(Debug, Clone, Default)]
pub struct ExportOptions {}

/// Forward-compatible options for cloning a box.
#[derive(Debug, Clone, Default)]
pub struct CloneOptions {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::advanced_options::{SecurityOptions, SecurityOptionsBuilder};

    #[test]
    #[allow(deprecated)]
    fn test_box_options_defaults() {
        let opts = BoxOptions::default();
        assert!(opts.removes_on_stop());
        assert!(
            opts.auto_remove,
            "auto_remove should keep its legacy default"
        );
        assert!(!opts.detach, "detach should default to false");
    }

    #[test]
    #[allow(deprecated)]
    fn explicit_auto_delete_takes_precedence_over_auto_remove() {
        let keep = BoxOptions {
            auto_remove: true,
            auto_delete: Some(0),
            ..Default::default()
        };
        assert!(!keep.removes_on_stop());

        let remove = BoxOptions {
            auto_remove: false,
            auto_delete: Some(60),
            ..Default::default()
        };
        assert!(remove.removes_on_stop());

        let legacy_keep = BoxOptions {
            auto_remove: false,
            auto_delete: None,
            ..Default::default()
        };
        assert!(!legacy_keep.removes_on_stop());
    }

    #[test]
    fn test_box_options_serde_defaults() {
        // Test that serde uses correct defaults for missing fields
        // Must include all required fields that don't have serde defaults
        let json = r#"{
            "rootfs": {"Image": "alpine:latest"},
            "env": [],
            "volumes": [],
            "network": {"Enabled": {"allow_net": []}},
            "ports": []
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.auto_delete, None);
        assert!(opts.removes_on_stop());
        assert!(!opts.detach, "detach should default to false via serde");
    }

    #[test]
    fn test_box_options_serde_explicit_values() {
        let json = r#"{
            "rootfs": {"Image": "alpine"},
            "env": [],
            "volumes": [],
            "network": {"Enabled": {"allow_net": []}},
            "ports": [],
            "auto_delete": 0,
            "detach": true
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.auto_delete, Some(0));
        assert!(opts.detach, "explicit detach=true should be respected");
    }

    #[test]
    fn test_box_options_roundtrip() {
        let opts = BoxOptions {
            auto_delete: Some(0),
            detach: true,
            ..Default::default()
        };

        let json = serde_json::to_string(&opts).unwrap();
        let opts2: BoxOptions = serde_json::from_str(&json).unwrap();

        assert_eq!(opts.auto_delete, opts2.auto_delete);
        assert_eq!(opts.detach, opts2.detach);
    }

    #[test]
    fn test_network_mode_from_str() {
        assert_eq!(
            "enabled".parse::<NetworkMode>().unwrap(),
            NetworkMode::Enabled
        );
        assert_eq!(
            "disabled".parse::<NetworkMode>().unwrap(),
            NetworkMode::Disabled
        );
    }

    #[test]
    fn test_network_mode_from_str_rejects_invalid_values() {
        let err = "broken".parse::<NetworkMode>().unwrap_err().to_string();
        assert!(err.contains("invalid network.mode"));
    }

    #[test]
    fn test_network_config_enabled_converts_to_internal_network_spec() {
        let spec = NetworkSpec::try_from(NetworkConfig {
            mode: NetworkMode::Enabled,
            allow_net: vec!["example.com".to_string()],
        })
        .unwrap();

        match spec {
            NetworkSpec::Enabled { allow_net } => {
                assert_eq!(allow_net, vec!["example.com".to_string()]);
            }
            NetworkSpec::Disabled => panic!("expected enabled network spec"),
        }
    }

    #[test]
    fn test_network_config_disabled_rejects_allow_net() {
        let err = NetworkSpec::try_from(NetworkConfig {
            mode: NetworkMode::Disabled,
            allow_net: vec!["example.com".to_string()],
        })
        .unwrap_err()
        .to_string();

        assert!(err.contains("network.mode=\"disabled\""));
    }

    #[test]
    fn test_network_spec_converts_to_public_network_config() {
        let config = NetworkConfig::from(&NetworkSpec::Disabled);
        assert_eq!(config.mode, NetworkMode::Disabled);
        assert!(config.allow_net.is_empty());
    }

    #[test]
    fn test_sanitize_remove_on_stop_detach_incompatible() {
        let opts = BoxOptions {
            auto_delete: Some(1),
            detach: true,
            ..Default::default()
        };
        let err_msg = opts.sanitize().unwrap_err().to_string();
        assert!(err_msg.contains("incompatible"));
    }

    #[test]
    fn test_sanitize_valid_combinations() {
        let remove = BoxOptions {
            auto_delete: Some(1),
            ..Default::default()
        };
        assert!(remove.sanitize().is_ok());

        let keep_detached = BoxOptions {
            auto_delete: Some(0),
            detach: true,
            ..Default::default()
        };
        assert!(keep_detached.sanitize().is_ok());

        let keep_attached = BoxOptions {
            auto_delete: Some(0),
            ..Default::default()
        };
        assert!(keep_attached.sanitize().is_ok());
    }

    // ========================================================================
    // SecurityOptionsBuilder tests
    // ========================================================================

    #[test]
    fn test_security_builder_new() {
        let opts = SecurityOptionsBuilder::new().build();
        // Default is now the standard preset on both Linux and macOS
        // (flipped in this PR — previously Linux defaulted off, which
        // meant REST / CLI / JSON-config paths silently ran unsandboxed).
        //   - jailer enabled on Linux + macOS
        //   - seccomp enabled on Linux (no-op on macOS)
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(opts.jailer_enabled);
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        assert!(!opts.jailer_enabled);
        #[cfg(target_os = "linux")]
        assert!(opts.seccomp_enabled);
        #[cfg(not(target_os = "linux"))]
        assert!(!opts.seccomp_enabled);
    }

    #[test]
    fn test_security_builder_presets() {
        // Two settings only: enabled (full) and disabled (master switch off,
        // every sub-protection off).
        let off = SecurityOptionsBuilder::disabled().build();
        assert!(!off.jailer_enabled);
        assert!(!off.close_fds);
        assert!(!off.sanitize_env);
        assert!(off.uid.is_none());

        let on = SecurityOptionsBuilder::enabled().build();
        assert!(on.jailer_enabled);
        assert!(on.close_fds);
        assert!(on.sanitize_env);
        assert_eq!(on, SecurityOptions::default(), "enabled is the default");
    }

    // Single source of truth for the default profile: deserializing an empty
    // object must yield exactly `SecurityOptions::default()`. This guards the
    // struct-level `#[serde(default)]`. Previously each field carried its own
    // `#[serde(default = "...")]` that diverged from `Default` — a partial JSON
    // body (e.g. a `{}` security block) silently produced a *weaker* sandbox
    // (uid unset, no resource limits, no new PID ns on Linux). Reintroducing
    // per-field serde defaults that disagree with `Default` flips this red.
    #[test]
    fn deserializing_empty_equals_default() {
        let from_json: SecurityOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(from_json, SecurityOptions::default());
    }

    // ===========================================================
    // SecurityOptions::from_preset — operator-surface contract
    //
    // CLI / REST / Go / C all funnel the setting *string* through this
    // helper. Reverting (deleting the match) flips all four red. There
    // are two settings — enable (default) and disable — each with
    // documented synonyms (on/off).
    // ===========================================================

    #[test]
    fn security_from_preset_canonical_names() {
        use crate::runtime::advanced_options::SecurityOptions;
        assert_eq!(
            SecurityOptions::from_preset("enable").unwrap(),
            SecurityOptions::enabled()
        );
        assert_eq!(
            SecurityOptions::from_preset("disable").unwrap(),
            SecurityOptions::disabled()
        );
    }

    #[test]
    fn security_from_preset_case_insensitive_and_synonyms() {
        use crate::runtime::advanced_options::SecurityOptions;
        // Casing + whitespace.
        assert_eq!(
            SecurityOptions::from_preset("  ENABLE ").unwrap(),
            SecurityOptions::enabled()
        );
        // Documented synonyms.
        assert_eq!(
            SecurityOptions::from_preset("enabled").unwrap(),
            SecurityOptions::enabled()
        );
        assert_eq!(
            SecurityOptions::from_preset("on").unwrap(),
            SecurityOptions::enabled()
        );
        assert_eq!(
            SecurityOptions::from_preset("disabled").unwrap(),
            SecurityOptions::disabled()
        );
        assert_eq!(
            SecurityOptions::from_preset("off").unwrap(),
            SecurityOptions::disabled()
        );
    }

    #[test]
    fn security_from_preset_unknown_surfaces_invalid_argument() {
        use crate::runtime::advanced_options::SecurityOptions;
        // A previously-valid 3-tier name must now be rejected too.
        let err = SecurityOptions::from_preset("maximum").expect_err("old preset must reject");
        let msg = err.to_string();
        assert!(
            msg.contains("maximum"),
            "rejection must echo the offending value; got {msg}"
        );
        assert!(
            msg.contains("enable") && msg.contains("disable"),
            "rejection must list the supported settings; got {msg}"
        );
    }

    /// Default contract: `SecurityOptions::default()` and
    /// `BoxOptions::default().advanced.security` are the fully-**enabled**
    /// profile. Reverting `Default` to the old moderate/jailer-off value flips
    /// this red.
    #[test]
    fn security_default_is_enabled() {
        use crate::runtime::advanced_options::SecurityOptions;
        let direct = SecurityOptions::default();
        let via_box = BoxOptions::default().advanced.security;
        assert_eq!(direct, SecurityOptions::enabled());
        assert_eq!(via_box, SecurityOptions::enabled());
        // Full profile: jailer master switch + fd/env hardening always on.
        assert!(direct.jailer_enabled);
        assert!(direct.close_fds);
        assert!(direct.sanitize_env);
        assert_eq!(direct.uid, Some(65534));
        #[cfg(target_os = "linux")]
        {
            assert!(direct.seccomp_enabled);
            assert!(direct.new_pid_ns);
            assert!(direct.chroot_enabled);
        }
    }

    #[test]
    fn test_security_builder_chaining() {
        let opts = SecurityOptionsBuilder::enabled()
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
            "network": {"Enabled": {"allow_net": []}},
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
            "network": {"Enabled": {"allow_net": []}},
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
            "network": {"Enabled": {"allow_net": []}},
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
            "network": {"Enabled": {"allow_net": []}},
            "ports": [],
            "entrypoint": ["dockerd"],
            "cmd": ["--iptables=false"]
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.entrypoint, Some(vec!["dockerd".to_string()]));
        assert_eq!(opts.cmd, Some(vec!["--iptables=false".to_string()]));
    }

    // ========================================================================
    // Secret tests
    // ========================================================================

    fn test_secret() -> Secret {
        Secret {
            name: "openai".to_string(),
            hosts: vec!["api.openai.com".to_string()],
            placeholder: "<BOXLITE_SECRET:openai>".to_string(),
            value: "sk-test-super-secret-key-12345".to_string(),
        }
    }

    #[test]
    fn test_secret_serde_roundtrip() {
        let secret = test_secret();
        let json = serde_json::to_string(&secret).unwrap();
        let deserialized: Secret = serde_json::from_str(&json).unwrap();
        assert_eq!(secret, deserialized);
        // Value IS serialized (needed for DB persistence)
        assert!(json.contains("sk-test-super-secret-key-12345"));
    }

    #[test]
    fn test_secret_env_key_valid_names() {
        let cases = [
            ("openai", "BOXLITE_SECRET_OPENAI"),
            ("my_key", "BOXLITE_SECRET_MY_KEY"),
            ("KEY123", "BOXLITE_SECRET_KEY123"),
            ("a-b-c", "BOXLITE_SECRET_A_B_C"), // hyphen → underscore
        ];
        for (name, expected) in cases {
            let secret = Secret {
                name: name.into(),
                hosts: vec![],
                placeholder: String::new(),
                value: String::new(),
            };
            assert_eq!(secret.env_key(), expected, "name={name:?}");
        }
    }

    #[test]
    fn test_secret_env_key_sanitizes_invalid_names() {
        let cases = [
            ("my key", "BOXLITE_SECRET_MY_KEY"), // space → _
            ("a/b/c", "BOXLITE_SECRET_A_B_C"),   // slash → _
            ("", "BOXLITE_SECRET__UNNAMED"),     // empty
            ("café", "BOXLITE_SECRET_CAF_"),     // non-ascii → _
        ];
        for (name, expected) in cases {
            let secret = Secret {
                name: name.into(),
                hosts: vec![],
                placeholder: String::new(),
                value: String::new(),
            };
            assert_eq!(secret.env_key(), expected, "name={name:?}");
        }
    }

    #[test]
    fn test_secret_debug_redacts_value() {
        let secret = test_secret();
        let debug_output = format!("{:?}", secret);
        assert!(
            !debug_output.contains("sk-test-super-secret-key-12345"),
            "Debug output must not contain the secret value"
        );
        assert!(
            debug_output.contains("[REDACTED]"),
            "Debug output must contain [REDACTED]"
        );
        assert!(
            debug_output.contains("openai"),
            "Debug output should contain the secret name"
        );
    }

    #[test]
    fn test_secret_display_redacts_value() {
        let secret = test_secret();
        let display_output = format!("{}", secret);
        assert!(
            !display_output.contains("sk-test-super-secret-key-12345"),
            "Display output must not contain the secret value"
        );
        assert!(
            display_output.contains("[REDACTED]"),
            "Display output must contain [REDACTED]"
        );
    }

    #[test]
    fn test_secret_serde_json_fields() {
        let secret = test_secret();
        let value = serde_json::to_value(&secret).unwrap();
        assert!(value.get("name").unwrap().is_string());
        assert!(value.get("hosts").unwrap().is_array());
        assert!(value.get("placeholder").unwrap().is_string());
        assert!(value.get("value").unwrap().is_string());
        assert_eq!(value.get("hosts").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_box_options_with_secrets_default() {
        let opts = BoxOptions::default();
        assert!(opts.secrets.is_empty(), "secrets should default to empty");
    }

    #[test]
    fn test_box_options_with_secrets_serde() {
        let opts = BoxOptions {
            secrets: vec![test_secret()],
            ..Default::default()
        };
        let json = serde_json::to_string(&opts).unwrap();
        let deserialized: BoxOptions = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.secrets.len(), 1);
        assert_eq!(deserialized.secrets[0], test_secret());
    }

    #[test]
    fn test_box_options_secrets_in_json() {
        let opts = BoxOptions {
            secrets: vec![
                test_secret(),
                Secret {
                    name: "anthropic".to_string(),
                    hosts: vec!["api.anthropic.com".to_string()],
                    placeholder: "<BOXLITE_SECRET:anthropic>".to_string(),
                    value: "sk-ant-secret".to_string(),
                },
            ],
            ..Default::default()
        };
        let json = serde_json::to_string(&opts).unwrap();
        assert!(
            json.contains("\"secrets\""),
            "JSON must contain secrets key"
        );
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let secrets_arr = value.get("secrets").unwrap().as_array().unwrap();
        assert_eq!(secrets_arr.len(), 2);
    }

    #[test]
    fn test_box_options_secrets_missing_from_json_defaults_empty() {
        let json = r#"{
            "rootfs": {"Image": "alpine:latest"},
            "env": [],
            "volumes": [],
            "network": {"Enabled": {"allow_net": []}},
            "ports": []
        }"#;
        let opts: BoxOptions = serde_json::from_str(json).unwrap();
        assert!(
            opts.secrets.is_empty(),
            "secrets should default to empty when missing from JSON"
        );
    }

    #[test]
    fn test_security_builder_non_consuming() {
        // Verify builder can be reused (non-consuming pattern). Start from the
        // disabled profile so resource limits begin unset and the assertions
        // below isolate exactly what each `build()` added.
        let mut builder = SecurityOptionsBuilder::disabled();
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
