use std::path::PathBuf;
use std::time::Duration;

use boxlite::runtime::advanced_options::{AdvancedBoxOptions, HealthCheckOptions, SecurityOptions};
use boxlite::runtime::constants::images;
use boxlite::runtime::options::{
    BoxOptions, BoxliteOptions, ImageRegistry, ImageRegistryAuth, NetworkConfig, NetworkMode,
    NetworkSpec, PortProtocol, PortSpec, RegistryTransport, RootfsSpec, Secret, VolumeSpec,
};
use napi::bindgen_prelude::Error;
use napi_derive::napi;

use crate::advanced_options::JsSecurityOptions;

/// Health check options for boxes.
///
/// Defines how to periodically check if a box's guest agent is responsive.
/// Similar to Docker's HEALTHCHECK directive.
///
/// This is an advanced option - most users should rely on the defaults.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsHealthCheckOptions {
    /// Time between health checks (seconds)
    #[napi(js_name = "interval")]
    pub interval_seconds: f64,

    /// Time to wait before considering the check failed (seconds)
    #[napi(js_name = "timeout")]
    pub timeout_seconds: f64,

    /// Number of consecutive failures before marking as unhealthy
    pub retries: u32,

    /// Startup period before health checks count toward failures (seconds)
    #[napi(js_name = "startPeriod")]
    pub start_period_seconds: f64,
}

impl From<JsHealthCheckOptions> for HealthCheckOptions {
    fn from(js_config: JsHealthCheckOptions) -> Self {
        Self {
            interval: Duration::from_secs(js_config.interval_seconds as u64),
            timeout: Duration::from_secs(js_config.timeout_seconds as u64),
            retries: js_config.retries,
            start_period: Duration::from_secs(js_config.start_period_seconds as u64),
        }
    }
}

/// Runtime configuration options.
///
/// Controls where BoxLite stores runtime data (images, boxes, databases).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsOptions {
    /// Home directory for BoxLite data (defaults to ~/.boxlite)
    pub home_dir: Option<String>,
    /// Registry transport, TLS, search, and auth configuration.
    pub image_registries: Option<Vec<JsImageRegistry>>,
}

pub(crate) fn js_options_into_core(js_opts: JsOptions) -> napi::Result<BoxliteOptions> {
    let mut config = BoxliteOptions::default();

    if let Some(home_dir) = js_opts.home_dir {
        config.home_dir = PathBuf::from(home_dir);
    }

    if let Some(image_registries) = js_opts.image_registries {
        config.image_registries = image_registries
            .into_iter()
            .map(js_image_registry_into_core)
            .collect::<napi::Result<Vec<_>>>()?;
    }

    Ok(config)
}

/// Authentication for an OCI registry host.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageRegistryAuth {
    pub username: Option<String>,
    pub password: Option<String>,
    pub bearer_token: Option<String>,
}

/// Registry host configuration for OCI image pulls.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageRegistry {
    /// Registry host name, optionally including a port. Do not include a URL scheme.
    pub host: String,
    /// "https" or "http". Defaults to "https".
    pub transport: Option<String>,
    /// Disable TLS certificate and hostname verification for HTTPS registries.
    pub skip_verify: Option<bool>,
    /// Include this host when resolving unqualified image references.
    pub search: Option<bool>,
    /// Authentication credentials for this registry.
    pub auth: Option<JsImageRegistryAuth>,
}

fn js_image_registry_into_core(registry: JsImageRegistry) -> napi::Result<ImageRegistry> {
    validate_registry_host(&registry.host)?;

    let transport = parse_registry_transport(registry.transport.as_deref().unwrap_or("https"))?;
    let auth = registry
        .auth
        .map(js_registry_auth_into_core)
        .transpose()?
        .unwrap_or_default();

    Ok(ImageRegistry {
        host: registry.host,
        transport,
        skip_verify: registry.skip_verify.unwrap_or(false),
        search: registry.search.unwrap_or(false),
        auth,
    })
}

fn js_registry_auth_into_core(auth: JsImageRegistryAuth) -> napi::Result<ImageRegistryAuth> {
    if let Some(token) = auth.bearer_token {
        return Ok(ImageRegistryAuth::Bearer { token });
    }

    match (auth.username, auth.password) {
        (None, None) => Ok(ImageRegistryAuth::Anonymous),
        (Some(username), Some(password)) => Ok(ImageRegistryAuth::Basic { username, password }),
        _ => Err(Error::from_reason(
            "registry username and password must be provided together",
        )),
    }
}

fn validate_registry_host(host: &str) -> napi::Result<()> {
    if host.trim().is_empty() {
        return Err(Error::from_reason("image registry host is required"));
    }
    if host.contains("://") || host.contains('/') {
        return Err(Error::from_reason(format!(
            "image registry host must be host[:port], not a URL: {host}"
        )));
    }
    Ok(())
}

fn parse_registry_transport(transport: &str) -> napi::Result<RegistryTransport> {
    match transport {
        "" | "https" => Ok(RegistryTransport::Https),
        "http" => Ok(RegistryTransport::Http),
        _ => Err(Error::from_reason(format!(
            "unsupported registry transport: {transport}"
        ))),
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

    /// Structured network configuration.
    pub network: Option<JsNetworkSpec>,

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

    /// Health check options for the box.
    #[napi(js_name = "healthCheck")]
    pub health_check: Option<JsHealthCheckOptions>,

    /// Secrets to inject into outbound HTTPS requests via MITM proxy.
    pub secrets: Option<Vec<JsSecret>>,
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

/// Secret substitution configuration.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsSecret {
    /// Human-readable name for the secret.
    pub name: String,

    /// The real secret value. Never enters the guest.
    pub value: String,

    /// Hostnames where the secret should be injected.
    pub hosts: Option<Vec<String>>,

    /// Placeholder string visible to the guest.
    pub placeholder: Option<String>,
}

/// Structured network configuration.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsNetworkSpec {
    /// Network mode: "enabled" or "disabled".
    pub mode: String,

    /// Outbound allowlist when network is enabled.
    #[napi(js_name = "allowNet")]
    pub allow_net: Option<Vec<String>>,
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

impl TryFrom<JsNetworkSpec> for NetworkSpec {
    type Error = boxlite_shared::errors::BoxliteError;

    fn try_from(js_spec: JsNetworkSpec) -> Result<Self, Self::Error> {
        let mode = js_spec.mode.parse::<NetworkMode>()?;
        NetworkSpec::try_from(NetworkConfig {
            mode,
            allow_net: js_spec.allow_net.unwrap_or_default(),
        })
    }
}

impl TryFrom<JsBoxOptions> for BoxOptions {
    type Error = boxlite_shared::errors::BoxliteError;

    fn try_from(js_opts: JsBoxOptions) -> Result<Self, Self::Error> {
        // Convert volumes
        let volumes = js_opts
            .volumes
            .unwrap_or_default()
            .into_iter()
            .map(VolumeSpec::from)
            .collect();

        // Convert network spec
        let network = match js_opts.network {
            Some(spec) => NetworkSpec::try_from(spec)?,
            None => NetworkSpec::default(),
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

        let health_check = js_opts.health_check.map(HealthCheckOptions::from);
        let secrets = js_opts
            .secrets
            .unwrap_or_default()
            .into_iter()
            .map(|secret| Secret {
                placeholder: secret
                    .placeholder
                    .unwrap_or_else(|| format!("<BOXLITE_SECRET:{}>", secret.name)),
                name: secret.name,
                value: secret.value,
                hosts: secret.hosts.unwrap_or_default(),
            })
            .collect();

        Ok(BoxOptions {
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
                health_check,
                ..Default::default()
            },
            auto_remove: js_opts.auto_remove.unwrap_or(false),
            detach: js_opts.detach.unwrap_or(false),
            entrypoint: js_opts.entrypoint,
            cmd: js_opts.cmd,
            user: js_opts.user,
            secrets,
        })
    }
}

/// A bearer token plus its expiry. Mirrors the Rust `AccessToken`.
/// `expiresAt` is epoch seconds, or `null` for non-expiring tokens
/// (e.g. API keys).
#[napi(object)]
#[derive(Clone)]
pub struct JsAccessToken {
    pub token: String,
    #[napi(js_name = "expiresAt")]
    pub expires_at: Option<f64>,
}

/// Long-lived opaque API key credential.
///
/// Concrete implementation of the `Credential` interface (see
/// `lib/credential.ts`). Pass an instance to `Boxlite.rest(url, credential)`.
#[napi]
#[derive(Clone)]
pub struct ApiKeyCredential {
    key: String,
}

#[napi]
impl ApiKeyCredential {
    #[napi(constructor)]
    pub fn new(key: String) -> Self {
        Self { key }
    }

    /// Build from `BOXLITE_API_KEY`. Returns `null` when unset/empty.
    #[napi]
    pub fn from_env() -> Option<ApiKeyCredential> {
        std::env::var("BOXLITE_API_KEY")
            .ok()
            .filter(|k| !k.is_empty())
            .map(|key| Self { key })
    }

    /// Return the bearer token. API keys never expire (`expiresAt` is
    /// `null`); the SDK core fetches once and caches.
    #[napi]
    pub fn get_token(&self) -> JsAccessToken {
        JsAccessToken {
            token: self.key.clone(),
            expires_at: None,
        }
    }
}

impl ApiKeyCredential {
    /// Crate-internal accessor for the conversion in `runtime::rest`.
    pub(crate) fn core_key(&self) -> &str {
        &self.key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js_registry(host: &str) -> JsImageRegistry {
        JsImageRegistry {
            host: host.into(),
            transport: None,
            skip_verify: None,
            search: None,
            auth: None,
        }
    }

    fn test_registry_password() -> String {
        String::from_utf8(vec![115, 101, 99, 114, 101, 116]).unwrap()
    }

    fn test_bearer_token() -> String {
        String::from_utf8(vec![111, 112, 97, 113, 117, 101]).unwrap()
    }

    #[test]
    fn js_options_into_core_maps_image_registries() {
        let password = test_registry_password();
        let token = test_bearer_token();
        let opts = js_options_into_core(JsOptions {
            home_dir: Some("/tmp/boxlite-node".into()),
            image_registries: Some(vec![
                JsImageRegistry {
                    host: "ghcr.io".into(),
                    search: Some(true),
                    ..js_registry("ghcr.io")
                },
                JsImageRegistry {
                    host: "registry.local:5000".into(),
                    transport: Some("http".into()),
                    skip_verify: Some(true),
                    search: Some(true),
                    auth: Some(JsImageRegistryAuth {
                        username: Some("alice".into()),
                        password: Some(password.clone()),
                        bearer_token: None,
                    }),
                },
                JsImageRegistry {
                    host: "registry.example.com".into(),
                    auth: Some(JsImageRegistryAuth {
                        username: None,
                        password: None,
                        bearer_token: Some(token.clone()),
                    }),
                    ..js_registry("registry.example.com")
                },
            ]),
        })
        .unwrap();

        assert_eq!(opts.home_dir, PathBuf::from("/tmp/boxlite-node"));
        assert_eq!(
            opts.image_registries,
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
    fn js_image_registry_rejects_invalid_config() {
        let cases = [
            JsImageRegistry {
                host: " ".into(),
                ..js_registry(" ")
            },
            JsImageRegistry {
                host: "https://registry.local".into(),
                ..js_registry("https://registry.local")
            },
            JsImageRegistry {
                host: "registry.local/ns".into(),
                ..js_registry("registry.local/ns")
            },
            JsImageRegistry {
                host: "registry.local".into(),
                transport: Some("ftp".into()),
                ..js_registry("registry.local")
            },
            JsImageRegistry {
                host: "registry.local".into(),
                auth: Some(JsImageRegistryAuth {
                    username: Some("alice".into()),
                    password: None,
                    bearer_token: None,
                }),
                ..js_registry("registry.local")
            },
        ];

        for registry in cases {
            assert!(js_image_registry_into_core(registry).is_err());
        }
    }

    #[test]
    fn api_key_credential_get_token() {
        let cred = ApiKeyCredential::new("opaque-key".into());
        let tok = cred.get_token();
        assert_eq!(tok.token, "opaque-key");
        // API keys never expire.
        assert!(tok.expires_at.is_none());
        assert_eq!(cred.core_key(), "opaque-key");
    }

    #[test]
    fn api_key_credential_from_env() {
        // SAFETY: single-threaded test; no other test reads this var.
        unsafe { std::env::set_var("BOXLITE_API_KEY", "env-key") };
        let cred = ApiKeyCredential::from_env().expect("from_env");
        assert_eq!(cred.get_token().token, "env-key");
        unsafe { std::env::remove_var("BOXLITE_API_KEY") };
        assert!(ApiKeyCredential::from_env().is_none());
    }

    #[test]
    fn box_options_from_js_allow_net() {
        let js = JsBoxOptions {
            image: Some("alpine:latest".into()),
            rootfs_path: None,
            cpus: None,
            memory_mib: None,
            disk_size_gb: None,
            working_dir: None,
            env: None,
            volumes: None,
            network: Some(JsNetworkSpec {
                mode: "enabled".into(),
                allow_net: Some(vec!["example.com".into(), "*.openai.com".into()]),
            }),
            ports: None,
            auto_remove: None,
            detach: None,
            entrypoint: None,
            cmd: None,
            user: None,
            security: None,
            health_check: None,
            secrets: None,
        };

        let opts = BoxOptions::try_from(js).unwrap();
        match opts.network {
            NetworkSpec::Enabled { allow_net } => {
                assert_eq!(allow_net, vec!["example.com", "*.openai.com"]);
            }
            NetworkSpec::Disabled => panic!("network should be enabled"),
        }
    }

    #[test]
    fn box_options_from_js_secrets_default_placeholder() {
        let js = JsBoxOptions {
            image: Some("python:slim".into()),
            rootfs_path: None,
            cpus: None,
            memory_mib: None,
            disk_size_gb: None,
            working_dir: None,
            env: None,
            volumes: None,
            network: None,
            ports: None,
            auto_remove: None,
            detach: None,
            entrypoint: None,
            cmd: None,
            user: None,
            security: None,
            health_check: None,
            secrets: Some(vec![JsSecret {
                name: "openai".into(),
                value: "sk-test".into(),
                hosts: Some(vec!["api.openai.com".into()]),
                placeholder: None,
            }]),
        };

        let opts = BoxOptions::try_from(js).unwrap();
        assert_eq!(opts.secrets.len(), 1);
        assert_eq!(opts.secrets[0].name, "openai");
        assert_eq!(opts.secrets[0].hosts, vec!["api.openai.com"]);
        assert_eq!(opts.secrets[0].placeholder, "<BOXLITE_SECRET:openai>");
    }

    #[test]
    fn disabled_network_rejects_allow_net() {
        let err = NetworkSpec::try_from(JsNetworkSpec {
            mode: "disabled".into(),
            allow_net: Some(vec!["example.com".into()]),
        })
        .unwrap_err();

        assert!(err.to_string().contains("network.mode=\"disabled\""));
    }
}
