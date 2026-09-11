use boxlite::runtime::advanced_options::{
    ContainerCapabilities, NetworkRateLimit, ResourceLimits, SecurityOptions,
};
use boxlite_shared::errors::BoxliteError;
use napi_derive::napi;

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

pub(crate) fn coerce_u64_limit(number: f64) -> Option<u64> {
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

/// Linux capability policy for the container process.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsContainerCapabilities {
    /// Capabilities added to BoxLite's Docker-compatible baseline.
    pub add: Option<Vec<String>>,

    /// Capabilities removed from the resulting capability set.
    pub drop: Option<Vec<String>>,
}

impl From<JsContainerCapabilities> for ContainerCapabilities {
    fn from(capabilities: JsContainerCapabilities) -> Self {
        Self {
            add: capabilities.add.unwrap_or_default(),
            drop: capabilities.drop.unwrap_or_default(),
        }
    }
}

/// Per-direction bandwidth cap for the box's network interface, in kilobits
/// per second, from the box's point of view: `txKbps` is what the box sends,
/// `rxKbps` what reaches it. Omitting a direction, or `0`, leaves it uncapped.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsNetworkRateLimit {
    pub tx_kbps: Option<f64>,
    pub rx_kbps: Option<f64>,
}

impl TryFrom<JsNetworkRateLimit> for NetworkRateLimit {
    type Error = BoxliteError;

    fn try_from(limit: JsNetworkRateLimit) -> Result<Self, BoxliteError> {
        Ok(Self {
            tx_kbps: kbps_from_js("networkRateLimit.txKbps", limit.tx_kbps)?,
            rx_kbps: kbps_from_js("networkRateLimit.rxKbps", limit.rx_kbps)?,
        })
    }
}

/// Unlike the security resource limits above, a value that does not fit a
/// `u64` is an error rather than `None`: coercing a bad cap to "unset" would
/// hand back an uncapped box, fail-open on the one thing the caller asked to
/// constrain.
fn kbps_from_js(field: &str, value: Option<f64>) -> Result<Option<u64>, BoxliteError> {
    let Some(number) = value else {
        return Ok(None);
    };
    coerce_u64_limit(number).map(Some).ok_or_else(|| {
        BoxliteError::InvalidArgument(format!(
            "{field} must be a non-negative safe integer in kbit/s (got {number})"
        ))
    })
}

/// Expert-only box options. Released top-level security and health-check
/// fields remain on `JsBoxOptions`; capability policy and the network rate
/// limit are nested here.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsAdvancedBoxOptions {
    pub capabilities: Option<JsContainerCapabilities>,
    pub network_rate_limit: Option<JsNetworkRateLimit>,
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
