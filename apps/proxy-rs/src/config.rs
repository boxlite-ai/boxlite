// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Environment-driven configuration, validated once at startup.

use std::env::{self, VarError};
use std::time::Duration;

/// Version stamped in at build time (`VERSION=… cargo build`), matching how the
/// container image is tagged.
pub const VERSION: &str = match option_env!("VERSION") {
    Some(version) => version,
    None => "v0.0.0-dev",
};

const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),

    #[error("{name} is invalid: {reason}")]
    Invalid { name: &'static str, reason: String },
}

#[derive(Debug, Clone)]
pub struct Config {
    pub proxy_port: u16,
    pub proxy_protocol: String,
    pub proxy_api_key: String,
    pub cookie_domain: Option<String>,
    pub tls: Option<TlsConfig>,
    pub boxlite_api_url: String,
    pub oidc: OidcConfig,
    pub redis: Option<RedisConfig>,
    pub preview_warning_enabled: bool,
    pub shutdown_timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct TlsConfig {
    pub cert_file: String,
    pub key_file: String,
}

#[derive(Debug, Clone, Default)]
pub struct OidcConfig {
    pub client_id: String,
    pub client_secret: String,
    /// Issuer the proxy talks to. In split-horizon deployments this is the
    /// internal address and differs from [`OidcConfig::public_domain`].
    pub domain: String,
    pub public_domain: Option<String>,
    pub audience: String,
}

#[derive(Debug, Clone)]
pub struct RedisConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub tls: bool,
}

/// Loads `.env`, `.env.local`, and `.env.production` from the working directory,
/// each overriding the last and all overriding already-exported variables, as
/// the Go proxy did.
///
/// Separate from [`Config::from_env`] and idempotent because telemetry reads the
/// environment before the rest of the configuration is parsed; both need the
/// files already applied.
///
/// Returns a description of every file that existed but could not be read, for
/// the caller to log. They are returned rather than logged because this runs
/// before there is a subscriber to log to — the level it would be logged at
/// comes from the very files being read — and memoised alongside the load so a
/// later caller still sees them.
pub fn load_env_files() -> Vec<String> {
    static PROBLEMS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

    PROBLEMS
        .get_or_init(|| {
            let mut problems = Vec::new();
            for file in [".env", ".env.local", ".env.production"] {
                match dotenvy::from_filename_override(file) {
                    Ok(_) => {}
                    // Absent is the normal case, not a problem.
                    Err(err) if err.not_found() => {}
                    Err(err) => problems.push(format!("{file}: {err}")),
                }
            }
            problems
        })
        .clone()
}

impl Config {
    /// Reads and validates the environment. `.env` files are loaded first, and
    /// override already-exported variables, matching the Go proxy's behaviour so
    /// local `.env` files keep working unchanged.
    pub fn from_env() -> Result<Self, ConfigError> {
        let _ = load_env_files();

        let enable_tls = optional_bool("ENABLE_TLS")?.unwrap_or(false);

        Ok(Self {
            proxy_port: required("PROXY_PORT")?
                .parse()
                .map_err(|err| invalid("PROXY_PORT", err))?,
            proxy_protocol: required("PROXY_PROTOCOL")?,
            proxy_api_key: required("PROXY_API_KEY")?,
            cookie_domain: optional("COOKIE_DOMAIN"),
            tls: if enable_tls {
                Some(TlsConfig {
                    cert_file: required("TLS_CERT_FILE")?,
                    key_file: required("TLS_KEY_FILE")?,
                })
            } else {
                None
            },
            boxlite_api_url: required("BOXLITE_API_URL")?,
            oidc: OidcConfig {
                client_id: optional("OIDC_CLIENT_ID").unwrap_or_default(),
                client_secret: optional("OIDC_CLIENT_SECRET").unwrap_or_default(),
                domain: optional("OIDC_DOMAIN").unwrap_or_default(),
                public_domain: optional("OIDC_PUBLIC_DOMAIN"),
                audience: optional("OIDC_AUDIENCE").unwrap_or_default(),
            },
            redis: RedisConfig::from_env()?,
            preview_warning_enabled: optional_bool("PREVIEW_WARNING_ENABLED")?.unwrap_or(false),
            shutdown_timeout: match optional("SHUTDOWN_TIMEOUT_SEC") {
                Some(raw) => Duration::from_secs(
                    raw.parse()
                        .map_err(|err| invalid("SHUTDOWN_TIMEOUT_SEC", err))?,
                ),
                None => DEFAULT_SHUTDOWN_TIMEOUT,
            },
        })
    }

    pub fn serves_https(&self) -> bool {
        self.proxy_protocol.eq_ignore_ascii_case("https")
    }

    /// Fills in whatever OIDC settings the environment did not pin, using the
    /// values the control-plane API reports. Explicit environment values win.
    pub fn apply_discovered_oidc(&mut self, discovered: DiscoveredOidc) {
        if self.oidc.client_id.is_empty() {
            self.oidc.client_id = discovered.client_id;
        }
        if self.oidc.domain.is_empty() {
            self.oidc.domain = discovered.issuer;
            if !self.oidc.domain.ends_with('/') {
                self.oidc.domain.push('/');
            }
        }
        if self.oidc.audience.is_empty() {
            self.oidc.audience = discovered.audience;
        }
    }
}

/// The OIDC block of the control-plane `/config` response.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DiscoveredOidc {
    pub issuer: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub audience: String,
}

impl RedisConfig {
    /// Redis is opt-in: no `REDIS_HOST` means per-process caching.
    fn from_env() -> Result<Option<Self>, ConfigError> {
        let Some(host) = optional("REDIS_HOST") else {
            return Ok(None);
        };

        Ok(Some(Self {
            host,
            port: required("REDIS_PORT")?
                .parse()
                .map_err(|err| invalid("REDIS_PORT", err))?,
            username: optional("REDIS_USERNAME"),
            password: optional("REDIS_PASSWORD"),
            tls: optional_bool("REDIS_TLS")?.unwrap_or(false),
        }))
    }
}

fn optional(name: &'static str) -> Option<String> {
    match env::var(name) {
        Ok(value) if !value.is_empty() => Some(value),
        Ok(_) | Err(VarError::NotPresent) => None,
        Err(VarError::NotUnicode(_)) => None,
    }
}

fn required(name: &'static str) -> Result<String, ConfigError> {
    optional(name).ok_or(ConfigError::Missing(name))
}

/// Accepts the same spellings as Go's `strconv.ParseBool`, so existing
/// deployment manifests keep working verbatim.
fn optional_bool(name: &'static str) -> Result<Option<bool>, ConfigError> {
    let Some(raw) = optional(name) else {
        return Ok(None);
    };
    match raw.as_str() {
        "1" | "t" | "T" | "true" | "TRUE" | "True" => Ok(Some(true)),
        "0" | "f" | "F" | "false" | "FALSE" | "False" => Ok(Some(false)),
        other => Err(ConfigError::Invalid {
            name,
            reason: format!("expected a boolean, got {other:?}"),
        }),
    }
}

fn invalid(name: &'static str, reason: impl std::fmt::Display) -> ConfigError {
    ConfigError::Invalid {
        name,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovered_oidc_only_fills_unset_values() {
        let mut config = Config {
            proxy_port: 4000,
            proxy_protocol: "https".into(),
            proxy_api_key: "key".into(),
            cookie_domain: None,
            tls: None,
            boxlite_api_url: "https://api.test/api".into(),
            oidc: OidcConfig {
                client_id: "from-env".into(),
                ..OidcConfig::default()
            },
            redis: None,
            preview_warning_enabled: false,
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
        };

        config.apply_discovered_oidc(DiscoveredOidc {
            issuer: "https://issuer.test".into(),
            client_id: "from-api".into(),
            audience: "boxlite".into(),
        });

        assert_eq!(config.oidc.client_id, "from-env", "env value must win");
        assert_eq!(
            config.oidc.domain, "https://issuer.test/",
            "issuer must gain a trailing slash for well-known discovery"
        );
        assert_eq!(config.oidc.audience, "boxlite");
    }
}
