// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Logging and OpenTelemetry export.
//!
//! Console logging is always on. OTLP export of traces and logs is opt-in and
//! independently switchable, using the same environment contract as
//! `apps/runner` so one deployment configures the fleet the same way:
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `OTEL_TRACING_ENABLED` | export spans |
//! | `OTEL_LOGGING_ENABLED` | export log records |
//! | `OTEL_EXPORTER_OTLP_ENDPOINT` | collector base URL; nothing is exported without it |
//! | `OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k=v` sent with every export, e.g. an auth token |
//! | `ENVIRONMENT` | `deployment.environment.name` resource attribute |
//! | `LOG_LEVEL` / `RUST_LOG` | console verbosity |

use std::collections::HashMap;
use std::io::IsTerminal;
use std::time::Duration;

use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{LogExporter, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

pub const SERVICE_NAME: &str = "boxlite-proxy";

/// Deliberately below the 5s budget `opentelemetry_sdk` allows itself when
/// shutting a batch processor down: a longer timeout means the final flush is
/// cut off rather than completed.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub endpoint: Option<String>,
    pub headers: HashMap<String, String>,
    pub tracing_enabled: bool,
    pub logging_enabled: bool,
    pub environment: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            endpoint: std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .ok()
                .filter(|endpoint| !endpoint.is_empty()),
            headers: parse_headers(
                &std::env::var("OTEL_EXPORTER_OTLP_HEADERS").unwrap_or_default(),
            ),
            tracing_enabled: env_flag("OTEL_TRACING_ENABLED"),
            logging_enabled: env_flag("OTEL_LOGGING_ENABLED"),
            environment: std::env::var("ENVIRONMENT").unwrap_or_else(|_| "unknown".to_string()),
        }
    }

    /// Export needs both a switch and somewhere to send to. Enabling one without
    /// the other is a misconfiguration, not a request to guess a destination.
    fn exports_traces(&self) -> bool {
        self.tracing_enabled && self.endpoint.is_some()
    }

    fn exports_logs(&self) -> bool {
        self.logging_enabled && self.endpoint.is_some()
    }
}

/// Owns the exporters.
///
/// Nothing is flushed on drop — the installed subscriber holds its own clone of
/// each provider, so the last-Arc `Drop` never runs while the process is alive.
/// [`Telemetry::shutdown`] is the only thing that flushes, and it has to be
/// called explicitly.
pub struct Telemetry {
    tracer_provider: Option<SdkTracerProvider>,
    logger_provider: Option<SdkLoggerProvider>,
}

impl Telemetry {
    /// Flushes and shuts the exporters down. Called explicitly at the end of a
    /// clean run so buffered spans are not lost with the process.
    pub fn shutdown(self) {
        if let Some(provider) = &self.tracer_provider
            && let Err(err) = provider.shutdown()
        {
            tracing::warn!(error = %err, "failed to flush traces");
        }
        if let Some(provider) = &self.logger_provider
            && let Err(err) = provider.shutdown()
        {
            tracing::warn!(error = %err, "failed to flush log records");
        }
    }
}

/// Installs the global subscriber. Must be called once, before anything logs.
pub fn init(config: &Config, version: &str) -> Telemetry {
    let client = (config.exports_traces() || config.exports_logs())
        .then(http_client)
        .flatten();
    let tracer_provider = client
        .clone()
        .filter(|_| config.exports_traces())
        .and_then(|client| build_tracer_provider(config, version, client));
    let logger_provider = client
        .filter(|_| config.exports_logs())
        .and_then(|client| build_logger_provider(config, version, client));

    let console = tracing_subscriber::fmt::layer()
        // Colour codes are for a human at a terminal. Under a container runtime
        // stdout is a pipe, and the escapes become noise in every stored line.
        .with_ansi(std::io::stdout().is_terminal())
        .with_target(true);

    tracing_subscriber::registry()
        .with(console_filter())
        .with(console)
        .with(tracer_provider.as_ref().map(|provider| {
            tracing_opentelemetry::layer().with_tracer(provider.tracer(SERVICE_NAME))
        }))
        .with(logger_provider.as_ref().map(|provider| {
            OpenTelemetryTracingBridge::new(provider).with_filter(console_filter())
        }))
        .init();

    if config.endpoint.is_some() {
        tracing::info!(
            traces = config.exports_traces(),
            logs = config.exports_logs(),
            "OpenTelemetry export configured"
        );
    } else if config.tracing_enabled || config.logging_enabled {
        tracing::warn!(
            "OTEL_TRACING_ENABLED/OTEL_LOGGING_ENABLED set without OTEL_EXPORTER_OTLP_ENDPOINT; nothing will be exported"
        );
    }

    Telemetry {
        tracer_provider,
        logger_provider,
    }
}

/// `LOG_LEVEL` matches the rest of the fleet; `RUST_LOG` wins when set, because
/// it is the only way to raise verbosity for one module while debugging.
fn console_filter() -> EnvFilter {
    if let Ok(filter) = EnvFilter::try_from_default_env() {
        return filter;
    }
    EnvFilter::new(std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string()))
}

/// The HTTP client the exporters share. Cloning one keeps a single connection
/// pool and a single background thread rather than one of each per signal.
///
/// Supplied explicitly rather than letting `opentelemetry-otlp` construct its
/// own, because `opentelemetry-http` implements `HttpClient` only for the
/// `reqwest` major *it* depends on — which is not the one the rest of this crate
/// uses. Handing it a client from the `otlp-tls` dependency therefore makes the
/// two a compile-time constraint: if they ever diverge this stops building,
/// instead of silently reverting to an exporter with no TLS.
///
/// The timeout lives here rather than on the exporter builders: those apply
/// theirs only to a client they build themselves, so it would be inert.
///
/// Blocking, because the batch processors that call it run on threads with no
/// reactor. It must therefore be built outside an async runtime, which is why
/// telemetry is initialised before the runtime exists.
fn http_client() -> Option<otlp_tls::blocking::Client> {
    // Self-sufficient: with `rustls-no-provider`, reqwest panics rather than
    // erroring if no provider is installed, and `init` is callable from
    // anywhere.
    crate::install_crypto_provider();

    otlp_tls::blocking::Client::builder()
        .timeout(EXPORT_TIMEOUT)
        .build()
        .inspect_err(|err| tracing::warn!(error = %err, "failed to build the OTLP HTTP client"))
        .ok()
}

fn build_tracer_provider(
    config: &Config,
    version: &str,
    client: otlp_tls::blocking::Client,
) -> Option<SdkTracerProvider> {
    let exporter = SpanExporter::builder()
        .with_http()
        .with_http_client(client)
        .with_endpoint(traces_endpoint(config.endpoint.as_deref()?))
        .with_headers(config.headers.clone())
        .build()
        .inspect_err(|err| tracing::warn!(error = %err, "failed to build the trace exporter"))
        .ok()?;

    Some(
        SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(resource(config, version))
            .build(),
    )
}

fn build_logger_provider(
    config: &Config,
    version: &str,
    client: otlp_tls::blocking::Client,
) -> Option<SdkLoggerProvider> {
    let exporter = LogExporter::builder()
        .with_http()
        .with_http_client(client)
        .with_endpoint(logs_endpoint(config.endpoint.as_deref()?))
        .with_headers(config.headers.clone())
        .build()
        .inspect_err(|err| tracing::warn!(error = %err, "failed to build the log exporter"))
        .ok()?;

    Some(
        SdkLoggerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(resource(config, version))
            .build(),
    )
}

fn resource(config: &Config, version: &str) -> Resource {
    Resource::builder()
        .with_attributes([
            KeyValue::new(
                opentelemetry_semantic_conventions::resource::SERVICE_NAME,
                SERVICE_NAME,
            ),
            KeyValue::new(
                opentelemetry_semantic_conventions::resource::SERVICE_VERSION,
                version.to_string(),
            ),
            KeyValue::new(
                opentelemetry_semantic_conventions::resource::SERVICE_INSTANCE_ID,
                instance_id(),
            ),
            KeyValue::new(
                opentelemetry_semantic_conventions::resource::DEPLOYMENT_ENVIRONMENT_NAME,
                config.environment.clone(),
            ),
        ])
        .build()
}

/// Matches the Go side, which reports the hostname and falls back to "unknown".
fn instance_id() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|hostname| !hostname.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// The OTLP/HTTP signal paths. Callers configure a base URL, as the Go services
/// do, rather than a per-signal one.
fn traces_endpoint(base: &str) -> String {
    format!("{}/v1/traces", base.trim_end_matches('/'))
}

fn logs_endpoint(base: &str) -> String {
    format!("{}/v1/logs", base.trim_end_matches('/'))
}

/// Parses the `k=v,k=v` form the OTLP spec and the Go services both use.
fn parse_headers(raw: &str) -> HashMap<String, String> {
    raw.split(',')
        .filter_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).unwrap_or_default().as_str(),
        "1" | "t" | "T" | "true" | "TRUE" | "True"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_parse_the_go_side_format() {
        let parsed = parse_headers("box-auth-token=abc123, x-tenant = t1 ,,broken");

        assert_eq!(
            parsed.get("box-auth-token").map(String::as_str),
            Some("abc123")
        );
        assert_eq!(parsed.get("x-tenant").map(String::as_str), Some("t1"));
        assert_eq!(
            parsed.len(),
            2,
            "entries without '=' are skipped: {parsed:?}"
        );
        assert!(parse_headers("").is_empty());
    }

    #[test]
    fn signal_paths_are_appended_to_the_base_endpoint() {
        assert_eq!(
            traces_endpoint("http://otel:4318"),
            "http://otel:4318/v1/traces"
        );
        assert_eq!(
            logs_endpoint("http://otel:4318/"),
            "http://otel:4318/v1/logs"
        );
    }

    #[test]
    fn export_needs_both_a_switch_and_an_endpoint() {
        let base = Config {
            endpoint: None,
            headers: HashMap::new(),
            tracing_enabled: true,
            logging_enabled: true,
            environment: "dev".into(),
        };
        assert!(!base.exports_traces(), "no endpoint means no export");
        assert!(!base.exports_logs());

        let addressed = Config {
            endpoint: Some("http://otel:4318".into()),
            ..base.clone()
        };
        assert!(addressed.exports_traces());
        assert!(addressed.exports_logs());

        let switched_off = Config {
            tracing_enabled: false,
            logging_enabled: false,
            ..addressed.clone()
        };
        assert!(
            !switched_off.exports_traces(),
            "an endpoint alone must not export"
        );
        assert!(!switched_off.exports_logs());
    }

    #[test]
    fn flags_accept_the_same_spellings_as_the_go_services() {
        for truthy in ["1", "t", "true", "TRUE", "True"] {
            unsafe { std::env::set_var("BOXLITE_TEST_FLAG", truthy) };
            assert!(env_flag("BOXLITE_TEST_FLAG"), "{truthy}");
        }
        for falsy in ["0", "false", "", "no"] {
            unsafe { std::env::set_var("BOXLITE_TEST_FLAG", falsy) };
            assert!(!env_flag("BOXLITE_TEST_FLAG"), "{falsy}");
        }
        unsafe { std::env::remove_var("BOXLITE_TEST_FLAG") };
    }
}
