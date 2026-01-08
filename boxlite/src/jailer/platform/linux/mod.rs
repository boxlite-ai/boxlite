//! Linux-specific jailer implementation.
//!
//! This module provides Linux isolation using:
//! - Namespaces (mount, PID, network)
//! - Chroot/pivot_root
//! - Seccomp filtering
//! - Privilege dropping
//! - Cgroups v2
//!
//! **Status**: Not yet implemented. Returns `UnsupportedPlatform` error.

use crate::jailer::config::SecurityOptions;
use crate::jailer::error::JailerError;
use crate::runtime::layout::FilesystemLayout;
use boxlite_shared::errors::BoxliteResult;

/// Check if Linux jailer is available.
///
/// Currently returns `false` as Linux isolation is not yet implemented.
pub fn is_available() -> bool {
    // TODO: Check for required capabilities (CAP_SYS_ADMIN, etc.)
    false
}

/// Apply Linux-specific isolation to the current process.
///
/// # Errors
///
/// Currently returns `UnsupportedPlatform` as Linux isolation is not
/// yet implemented. When implemented, the isolation order will be:
///
/// 1. Setup cgroups (before namespace isolation)
/// 2. Create namespaces (mount, optionally PID/network)
/// 3. Setup chroot/pivot_root
/// 4. Create device nodes
/// 5. Apply seccomp filter
/// 6. Drop privileges (must be last)
pub fn apply_isolation(
    _security: &SecurityOptions,
    box_id: &str,
    _layout: &FilesystemLayout,
) -> BoxliteResult<()> {
    tracing::warn!(
        box_id = %box_id,
        "Linux jailer not yet implemented, skipping isolation"
    );

    // Be explicit: Linux jailer is not implemented
    // Callers should handle this appropriately
    Err(JailerError::UnsupportedPlatform.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_available() {
        // Currently not implemented
        assert!(!is_available());
    }

    #[test]
    fn test_apply_isolation_returns_error() {
        use crate::jailer::config::SecurityOptions;
        use crate::runtime::layout::{FilesystemLayout, FsLayoutConfig};
        use std::path::PathBuf;

        let security = SecurityOptions::default();
        let layout = FilesystemLayout::new(PathBuf::from("/tmp/test"), FsLayoutConfig::default());

        let result = apply_isolation(&security, "test-box", &layout);
        assert!(result.is_err());
    }
}
