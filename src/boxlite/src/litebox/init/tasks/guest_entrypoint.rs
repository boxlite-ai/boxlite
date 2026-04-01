//! Guest entrypoint builder for managing env vars within kernel cmdline size limits.
//!
//! The kernel cmdline has architecture-specific size limits (2KB on ARM64, 64KB on x86_64).
//! This builder manages env var accumulation while respecting these limits using FILO
//! (First In, Last Out) semantics - later additions override earlier ones with the same key.

use crate::util::is_printable_ascii;
use crate::vmm::Entrypoint;

/// Builds guest entrypoint with env vars constrained by kernel cmdline size limits.
///
/// Uses FILO (First In, Last Out) semantics: later `with_env` calls override earlier
/// ones with the same key, automatically reclaiming the space.
///
/// # Usage
///
/// ```ignore
/// let mut builder = GuestEntrypointBuilder::new(executable, args);
/// builder.with_env("PATH", "/usr/bin");       // From image
/// builder.with_env("PATH", "/custom/bin");    // Override - automatically wins
/// builder.with_env("RUST_LOG", &std::env::var("RUST_LOG").unwrap()); // Pass through from host
/// let entrypoint = builder.build();
/// ```
pub(crate) struct GuestEntrypointBuilder {
    executable: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    total_size: usize,
    limit: usize,
}

impl GuestEntrypointBuilder {
    /// Kernel cmdline size limit for ARM64 (Apple Silicon).
    ///
    /// ARM64 Macs using Hypervisor.framework have a much smaller command line
    /// buffer (2KB) compared to x86_64 (64KB). With ~20-30 env vars from a
    /// typical shell, this limit is easily exceeded.
    ///
    /// Source: `libkrun/src/arch/src/aarch64/layout.rs`
    #[cfg(target_arch = "aarch64")]
    const KERNEL_CMDLINE_MAX_SIZE: usize = 2048;

    /// Kernel cmdline size limit for x86_64.
    ///
    /// x86_64 has a generous 64KB buffer, enough for most use cases.
    ///
    /// Source: `libkrun/src/arch/src/x86_64/layout.rs`
    #[cfg(target_arch = "x86_64")]
    const KERNEL_CMDLINE_MAX_SIZE: usize = 65536;

    /// Per env var overhead in kernel cmdline: `"KEY=VALUE" ` (quote + equals + quote + space).
    /// libkrun wraps each env var in quotes when building the cmdline.
    const ENV_VAR_OVERHEAD: usize = 4;

    /// Fixed overhead in libkrun's kernel cmdline.
    ///
    /// The kernel cmdline structure is:
    /// `{DEFAULT_KERNEL_CMDLINE} init=/init.krun KRUN_INIT={exec} KRUN_WORKDIR={wd} {env} -- {args}`
    ///
    /// Fixed components (from libkrun source):
    /// - DEFAULT_KERNEL_CMDLINE: ~91 bytes (macOS: "reboot=k panic=-1 ... no-kvmapf")
    /// - ` init=/init.krun`: ~15 bytes
    /// - `KRUN_INIT=` prefix: ~10 bytes (exec path counted separately)
    /// - ` KRUN_WORKDIR=/`: ~15 bytes
    /// - ` -- ` separator: ~4 bytes
    /// - Formatting/spaces: ~15 bytes
    /// - Safety margin: ~150 bytes (for platform variations)
    ///
    /// Total calculated: ~140 bytes, but testing showed 200 was insufficient.
    /// Using 300 bytes to prevent TooLarge while not over-trimming env vars.
    const LIBKRUN_CMDLINE_FIXED_OVERHEAD: usize = 300;

    /// Create a new builder with the given executable.
    ///
    /// The available env space is calculated based on the arch limit minus
    /// the space used by executable and fixed overhead.
    pub fn new(executable: String) -> Self {
        let limit = Self::calculate_limit(&executable);
        tracing::debug!(
            arch_limit = Self::KERNEL_CMDLINE_MAX_SIZE,
            env_space_limit = limit,
            "Calculated env space limit for kernel cmdline"
        );
        Self {
            executable,
            args: Vec::new(),
            env: Vec::new(),
            total_size: 0,
            limit,
        }
    }

    /// Add an env var, using FILO semantics (later calls override earlier ones).
    ///
    /// If a var with the same key exists, it's removed and its space is reclaimed
    /// before adding the new value.
    ///
    /// Returns `true` if added, `false` if skipped (logged as warning).
    pub fn with_env(&mut self, key: &str, value: &str) -> bool {
        // FILO: Remove existing key if present, reclaim space
        if let Some(pos) = self.env.iter().position(|(k, _)| k == key) {
            let (old_key, old_value) = &self.env[pos];
            let old_size = old_key.len() + old_value.len() + Self::ENV_VAR_OVERHEAD;
            self.total_size = self.total_size.saturating_sub(old_size);
            self.env.remove(pos);
            tracing::trace!(env_key = %key, "Overriding existing env var");
        }

        // Check ASCII
        if !is_printable_ascii(key) || !is_printable_ascii(value) {
            tracing::warn!(
                env_key = %key,
                env_value = %Self::redact_for_log(value),
                "Skipping env var: contains non-ASCII characters"
            );
            return false;
        }

        // Check size limit
        let var_size = key.len() + value.len() + Self::ENV_VAR_OVERHEAD;
        if self.total_size + var_size > self.limit {
            tracing::warn!(
                env_key = %key,
                env_value = %Self::redact_for_log(value),
                total_size = self.total_size,
                var_size,
                limit = self.limit,
                "Skipping env var: kernel cmdline size limit reached"
            );
            return false;
        }

        self.total_size += var_size;
        self.env.push((key.to_string(), value.to_string()));
        tracing::trace!(env_key = %key, var_size, "Added env var");
        true
    }

    /// Add an argument to the entrypoint.
    ///
    /// Arguments are appended after the initial args passed to `new()`.
    /// The limit is reduced to account for the new arg's size.
    pub fn with_arg(&mut self, arg: &str) {
        let arg_size = arg.len() + 1; // arg + space
        self.limit = self.limit.saturating_sub(arg_size);
        self.args.push(arg.to_string());
        tracing::trace!(arg, arg_size, new_limit = self.limit, "Added arg");
    }

    /// Build the final Entrypoint, consuming the builder.
    pub fn build(self) -> Entrypoint {
        tracing::debug!(
            env_count = self.env.len(),
            total_size = self.total_size,
            limit = self.limit,
            "Final env vars for guest entrypoint"
        );
        Entrypoint {
            executable: self.executable,
            args: self.args,
            env: self.env,
        }
    }

    /// Calculate available space for env vars.
    fn calculate_limit(executable: &str) -> usize {
        let exec_size = executable.len() + 1; // executable + space
        Self::KERNEL_CMDLINE_MAX_SIZE
            .saturating_sub(exec_size)
            .saturating_sub(Self::LIBKRUN_CMDLINE_FIXED_OVERHEAD)
    }

    /// Redact a value for safe logging, preventing secret leakage.
    fn redact_for_log(value: &str) -> String {
        if value.len() <= 8 {
            "***".to_string()
        } else {
            format!(
                "{}...{} ({} chars)",
                &value[..4],
                &value[value.len() - 4..],
                value.len()
            )
        }
    }
}
