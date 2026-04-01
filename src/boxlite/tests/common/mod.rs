//! Shared test infrastructure for boxlite integration tests.
//!
//! Runtime setup:
//! - [`PerTestBoxHome::new()`]: Per-test home with image cache (for VM tests).
//! - [`PerTestBoxHome::isolated()`]: Per-test home without cache (for non-VM tests).
//!
//! Helper functions:
//! - [`alpine_opts()`]: Default `BoxOptions` with `alpine:latest`, `auto_remove=false`
//! - [`alpine_opts_auto()`]: Same but `auto_remove=true`

#![allow(dead_code)]

// Re-export shared infrastructure from boxlite-test-utils.
pub use boxlite_test_utils::*;

use boxlite::runtime::options::{BoxOptions, RootfsSpec};

// ============================================================================
// BOX OPTIONS HELPERS
// ============================================================================

/// Default test box options: `alpine:latest`, `auto_remove=false`.
pub fn alpine_opts() -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: false,
        ..Default::default()
    }
}

/// Alpine box with `auto_remove=true` (cleaned up on stop).
pub fn alpine_opts_auto() -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: true,
        ..Default::default()
    }
}
