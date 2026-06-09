use std::path::PathBuf;

use boxlite::runtime::advanced_options::{ResourceLimits, SecurityOptions};
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

    /// UID to drop shim process to (Linux only). None = auto-allocate.
    pub uid: Option<u32>,

    /// GID to drop shim process to (Linux only). None = auto-allocate.
    pub gid: Option<u32>,

    /// Create new PID namespace (Linux only).
    pub new_pid_ns: Option<bool>,

    /// Create new network namespace (Linux only).
    pub new_net_ns: Option<bool>,

    /// Base directory for chroot jails (Linux only).
    pub chroot_base: Option<String>,

    /// Enable chroot filesystem isolation (Linux only).
    pub chroot_enabled: Option<bool>,

    /// Sanitize environment variables before shim exec.
    pub sanitize_env: Option<bool>,

    /// Environment variables to preserve when sanitize_env is true.
    pub env_allowlist: Option<Vec<String>>,

    /// macOS sandbox profile path. None = built-in profile.
    pub sandbox_profile: Option<String>,
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
        if let Some(uid) = js_opts.uid {
            opts.uid = Some(uid);
        }
        if let Some(gid) = js_opts.gid {
            opts.gid = Some(gid);
        }
        if let Some(new_pid_ns) = js_opts.new_pid_ns {
            opts.new_pid_ns = new_pid_ns;
        }
        if let Some(new_net_ns) = js_opts.new_net_ns {
            opts.new_net_ns = new_net_ns;
        }
        if let Some(chroot_base) = js_opts.chroot_base {
            opts.chroot_base = PathBuf::from(chroot_base);
        }
        if let Some(chroot_enabled) = js_opts.chroot_enabled {
            opts.chroot_enabled = chroot_enabled;
        }
        if let Some(sanitize_env) = js_opts.sanitize_env {
            opts.sanitize_env = sanitize_env;
        }
        if let Some(env_allowlist) = js_opts.env_allowlist {
            opts.env_allowlist = env_allowlist;
        }
        if let Some(sandbox_profile) = js_opts.sandbox_profile {
            opts.sandbox_profile = Some(PathBuf::from(sandbox_profile));
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
