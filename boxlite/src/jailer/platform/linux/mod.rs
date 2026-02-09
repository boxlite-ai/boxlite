//! Linux-specific jailer implementation.
//!
//! This module provides Linux isolation using:
//! - Namespaces (mount, PID, network) - handled by bubblewrap at spawn time
//! - Chroot/pivot_root - handled by bubblewrap at spawn time
//! - Seccomp filtering - applied here after exec
//! - Resource limits - handled via cgroups and rlimit in pre_exec hook
//!
//! # Architecture
//!
//! Linux isolation is split across multiple phases:
//!
//! 1. **Pre-spawn (parent)**: Cgroup creation (`setup_pre_spawn()`)
//! 2. **Spawn-time**: Namespace + chroot via bubblewrap (`build_command()`)
//! 3. **Pre-exec hook**: FD cleanup, rlimits, cgroup join
//! 4. **Post-exec (shim)**: Seccomp filter (`apply_isolation()`)
//!
//! Seccomp must be applied after exec because the seccompiler library
//! is not async-signal-safe (cannot be used in pre_exec hook).

use crate::jailer::seccomp;
use crate::runtime::advanced_options::SecurityOptions;
use crate::runtime::layout::FilesystemLayout;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Check if Linux jailer is available.
///
/// Returns `true` if bubblewrap is available on the system.
/// Bubblewrap handles namespace isolation and chroot at spawn time.
/// Seccomp is always available on Linux kernel >= 3.5.
pub fn is_available() -> bool {
    crate::jailer::bwrap::is_available()
}

/// Apply Linux-specific isolation to the current process.
///
/// This function should be called from the shim process after it has been
/// spawned inside the bwrap namespace. It applies seccomp filtering to
/// restrict available syscalls.
///
/// # Isolation Layers
///
/// By the time this is called, the following isolation is already in place:
/// - **Namespaces**: Mount, user, PID, IPC, UTS (via bwrap at spawn)
/// - **Filesystem**: Chroot/pivot_root with minimal mounts (via bwrap)
/// - **Environment**: Sanitized (clearenv via bwrap)
/// - **FDs**: Closed except stdin/stdout/stderr (via pre_exec hook)
/// - **Resource limits**: rlimits and cgroups (via pre_exec hook)
///
/// This function adds:
/// - **Seccomp**: Syscall filtering (if enabled)
///
/// # Arguments
///
/// * `security` - Security configuration options
/// * `box_id` - Unique identifier for logging
/// * `_layout` - Filesystem layout (unused, kept for API compatibility)
///
/// # Errors
///
/// Returns an error if seccomp filter generation or application fails.
pub fn apply_isolation(
    security: &SecurityOptions,
    box_id: &str,
    _layout: &FilesystemLayout,
) -> BoxliteResult<()> {
    tracing::info!(
        box_id = %box_id,
        seccomp_enabled = security.seccomp_enabled,
        "Applying Linux jailer isolation"
    );

    // Apply seccomp filter if enabled
    if security.seccomp_enabled {
        apply_seccomp_filter(box_id)?;
    } else {
        tracing::warn!(
            box_id = %box_id,
            "Seccomp disabled - running without syscall filtering. \
             This reduces security but may be useful for debugging."
        );
    }

    tracing::info!(
        box_id = %box_id,
        "Linux jailer isolation complete"
    );

    Ok(())
}

/// Apply seccomp BPF filter to the current process.
///
/// Loads pre-compiled BPF filters from embedded binary and applies
/// the VMM filter to the main thread (before libkrun takeover).
///
/// ## Filter Application
///
/// - **VMM filter**: Applied to all threads via TSYNC (defense-in-depth)
/// - **vCPU filter**: Compiled; vCPU threads inherit VMM filter
///
/// vCPU threads created by libkrun inherit the VMM filter. The vCPU filter
/// is compiled and available for future per-thread application.
///
/// Once applied, the filter cannot be removed.
fn apply_seccomp_filter(box_id: &str) -> BoxliteResult<()> {
    use crate::jailer::error::{IsolationError, JailerError};

    tracing::debug!(
        box_id = %box_id,
        "Loading pre-compiled seccomp filters"
    );

    // Load compiled filters from embedded binary
    let filter_bytes = include_bytes!(concat!(env!("OUT_DIR"), "/seccomp_filter.bpf"));
    let filters = seccomp::deserialize_binary(&filter_bytes[..]).map_err(|e| {
        tracing::error!(
            box_id = %box_id,
            error = %e,
            "Failed to deserialize seccomp filters"
        );
        BoxliteError::from(JailerError::Isolation(IsolationError::Seccomp(
            e.to_string(),
        )))
    })?;

    // Apply VMM filter to main thread (before libkrun takeover)
    let vmm_filter = seccomp::get_filter(&filters, seccomp::SeccompRole::Vmm).ok_or_else(|| {
        tracing::error!(
            box_id = %box_id,
            "VMM filter not found in compiled filters"
        );
        JailerError::Isolation(IsolationError::Seccomp("Missing vmm filter".to_string()))
    })?;

    tracing::debug!(
        box_id = %box_id,
        bpf_instructions = vmm_filter.len(),
        "Applying VMM seccomp filter to all threads (TSYNC)"
    );

    seccomp::apply_filter_all_threads(vmm_filter).map_err(|e| {
        tracing::error!(
            box_id = %box_id,
            error = %e,
            "Failed to apply VMM seccomp filter (TSYNC)"
        );
        JailerError::Isolation(IsolationError::Seccomp(e.to_string()))
    })?;

    tracing::info!(
        box_id = %box_id,
        vmm_filter_instructions = vmm_filter.len(),
        "Seccomp VMM filter applied to all threads (TSYNC)"
    );

    if let Some(vcpu_filter) = seccomp::get_filter(&filters, seccomp::SeccompRole::Vcpu) {
        tracing::debug!(
            box_id = %box_id,
            vcpu_filter_instructions = vcpu_filter.len(),
            "vCPU filter available (vCPU threads inherit vmm filter via TSYNC)"
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_is_available_checks_bwrap() {
        // is_available() should reflect bwrap availability
        let bwrap_available = crate::jailer::bwrap::is_available();
        assert_eq!(is_available(), bwrap_available);
    }

    #[test]
    fn test_apply_isolation_with_seccomp_disabled() {
        use crate::runtime::layout::FsLayoutConfig;

        let security = SecurityOptions {
            seccomp_enabled: false,
            ..Default::default()
        };

        let layout = FilesystemLayout::new(PathBuf::from("/tmp/test"), FsLayoutConfig::default());

        // With seccomp disabled, apply_isolation should succeed
        let result = apply_isolation(&security, "test-box", &layout);
        assert!(result.is_ok(), "Should succeed with seccomp disabled");
    }

    // Note: Testing apply_isolation with seccomp enabled is tricky because:
    // 1. Seccomp cannot be un-applied once set
    // 2. It would restrict syscalls for the test process itself
    // 3. Should be tested in isolated subprocess or on actual Linux
}
