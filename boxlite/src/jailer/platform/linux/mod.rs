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
//! 4. **Post-exec (shim)**: Seccomp filter (VMM filter with TSYNC)
//!
//! Seccomp must be applied after exec because the seccompiler library
//! is not async-signal-safe (cannot be used in pre_exec hook).

use crate::jailer::seccomp;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Check if Linux jailer is available.
///
/// Returns `true` if bubblewrap is available on the system.
/// Bubblewrap handles namespace isolation and chroot at spawn time.
/// Seccomp is always available on Linux kernel >= 3.5.
pub fn is_available() -> bool {
    crate::jailer::bwrap::is_available()
}

/// Apply VMM seccomp filter to all threads (TSYNC).
///
/// The VMM filter covers both libkrun and Go runtime (gvproxy) syscalls.
/// TSYNC ensures all existing threads receive the filter; new threads
/// created after this call inherit it automatically via clone().
pub fn apply_vmm_filter(box_id: &str) -> BoxliteResult<()> {
    use crate::jailer::error::{IsolationError, JailerError};

    let filters = load_filters(box_id)?;

    let vmm_filter = seccomp::get_filter(&filters, seccomp::SeccompRole::Vmm).ok_or_else(|| {
        tracing::error!(box_id = %box_id, "VMM filter not found in compiled filters");
        BoxliteError::from(JailerError::Isolation(IsolationError::Seccomp(
            "Missing vmm filter".to_string(),
        )))
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
        BoxliteError::from(JailerError::Isolation(IsolationError::Seccomp(
            e.to_string(),
        )))
    })?;

    tracing::info!(
        box_id = %box_id,
        vmm_filter_instructions = vmm_filter.len(),
        "VMM seccomp filter applied to all threads (TSYNC)"
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
