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
//! 4. **Post-exec (shim)**: Seccomp filter (two-phase when gvproxy is used)
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

/// Apply gvproxy seccomp filter with TSYNC (phase 1 of two-phase stacking).
///
/// Must be called **before** gvproxy creation so that Go runtime threads
/// inherit this permissive filter via clone(). The VMM filter is stacked
/// on the main thread later (phase 2) to restrict VMM/vCPU threads.
///
/// The gvproxy filter is a strict superset of the VMM filter, containing
/// both VMM syscalls and Go runtime syscalls.
pub fn apply_gvproxy_filter(box_id: &str) -> BoxliteResult<()> {
    use crate::jailer::error::{IsolationError, JailerError};

    let filters = load_filters(box_id)?;

    let gvproxy_filter =
        seccomp::get_filter(&filters, seccomp::SeccompRole::Gvproxy).ok_or_else(|| {
            tracing::error!(box_id = %box_id, "Gvproxy filter not found in compiled filters");
            BoxliteError::from(JailerError::Isolation(IsolationError::Seccomp(
                "Missing gvproxy filter".to_string(),
            )))
        })?;

    tracing::debug!(
        box_id = %box_id,
        bpf_instructions = gvproxy_filter.len(),
        "Applying gvproxy seccomp filter to all threads (TSYNC)"
    );

    seccomp::apply_filter_all_threads(gvproxy_filter).map_err(|e| {
        tracing::error!(
            box_id = %box_id,
            error = %e,
            "Failed to apply gvproxy seccomp filter (TSYNC)"
        );
        BoxliteError::from(JailerError::Isolation(IsolationError::Seccomp(
            e.to_string(),
        )))
    })?;

    tracing::info!(
        box_id = %box_id,
        gvproxy_filter_instructions = gvproxy_filter.len(),
        "Gvproxy seccomp filter applied to all threads (TSYNC)"
    );

    Ok(())
}

/// Apply VMM seccomp filter to the main thread only (phase 2 of two-phase stacking).
///
/// Must be called **after** gvproxy creation. This stacks the restrictive VMM
/// filter on top of the gvproxy filter on the main thread only (no TSYNC).
/// Go threads keep only the gvproxy filter. vCPU threads created later by
/// libkrun inherit both filters from the main thread (effective = vmm).
///
/// If `tsync` is true, applies to all threads (used when gvproxy is not active).
pub fn apply_vmm_filter(box_id: &str, tsync: bool) -> BoxliteResult<()> {
    use crate::jailer::error::{IsolationError, JailerError};

    let filters = load_filters(box_id)?;

    let vmm_filter = seccomp::get_filter(&filters, seccomp::SeccompRole::Vmm).ok_or_else(|| {
        tracing::error!(box_id = %box_id, "VMM filter not found in compiled filters");
        BoxliteError::from(JailerError::Isolation(IsolationError::Seccomp(
            "Missing vmm filter".to_string(),
        )))
    })?;

    if tsync {
        tracing::debug!(
            box_id = %box_id,
            bpf_instructions = vmm_filter.len(),
            "Applying VMM seccomp filter to all threads (TSYNC)"
        );
        seccomp::apply_filter_all_threads(vmm_filter)
    } else {
        tracing::debug!(
            box_id = %box_id,
            bpf_instructions = vmm_filter.len(),
            "Stacking VMM seccomp filter on main thread only (no TSYNC)"
        );
        seccomp::apply_filter(vmm_filter)
    }
    .map_err(|e| {
        tracing::error!(
            box_id = %box_id,
            error = %e,
            tsync = tsync,
            "Failed to apply VMM seccomp filter"
        );
        BoxliteError::from(JailerError::Isolation(IsolationError::Seccomp(
            e.to_string(),
        )))
    })?;

    tracing::info!(
        box_id = %box_id,
        vmm_filter_instructions = vmm_filter.len(),
        tsync = tsync,
        "VMM seccomp filter applied"
    );

    if let Some(vcpu_filter) = seccomp::get_filter(&filters, seccomp::SeccompRole::Vcpu) {
        tracing::debug!(
            box_id = %box_id,
            vcpu_filter_instructions = vcpu_filter.len(),
            "vCPU filter available (vCPU threads inherit from main thread)"
        );
    }

    Ok(())
}

/// Apply Linux-specific isolation (single-phase, VMM filter with TSYNC).
///
/// Convenience function for when gvproxy is not used.
/// Implements the `PlatformIsolation` trait interface.
pub fn apply_isolation(
    security: &crate::runtime::advanced_options::SecurityOptions,
    box_id: &str,
    _layout: &crate::runtime::layout::FilesystemLayout,
) -> BoxliteResult<()> {
    if security.seccomp_enabled {
        apply_vmm_filter(box_id, true)?;
    } else {
        tracing::warn!(
            box_id = %box_id,
            "Seccomp disabled - running without syscall filtering"
        );
    }
    Ok(())
}

/// Load pre-compiled BPF filters from embedded binary.
fn load_filters(box_id: &str) -> BoxliteResult<seccomp::BpfThreadMap> {
    use crate::jailer::error::{IsolationError, JailerError};

    let filter_bytes = include_bytes!(concat!(env!("OUT_DIR"), "/seccomp_filter.bpf"));
    seccomp::deserialize_binary(&filter_bytes[..]).map_err(|e| {
        tracing::error!(
            box_id = %box_id,
            error = %e,
            "Failed to deserialize seccomp filters"
        );
        BoxliteError::from(JailerError::Isolation(IsolationError::Seccomp(
            e.to_string(),
        )))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_available_checks_bwrap() {
        // is_available() should reflect bwrap availability
        let bwrap_available = crate::jailer::bwrap::is_available();
        assert_eq!(is_available(), bwrap_available);
    }

    // Note: Testing seccomp filter application is tricky because:
    // 1. Seccomp cannot be un-applied once set
    // 2. It would restrict syscalls for the test process itself
    // 3. Should be tested in isolated subprocess or on actual Linux
}
