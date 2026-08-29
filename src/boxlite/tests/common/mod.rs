//! Shared test infrastructure for boxlite integration tests.
//!
//! Runtime setup:
//! - [`PerTestBoxHome::new()`]: Per-test home with image cache (for VM tests).
//! - [`PerTestBoxHome::isolated()`]: Per-test home without cache (for non-VM tests).
//!
//! Helper functions:
//! - [`alpine_opts()`]: Default `BoxOptions` with `alpine:latest`, kept on stop
//! - [`alpine_opts_auto()`]: Same but removed as soon as it stops (`--rm`)

#![allow(dead_code)]

// Re-export shared infrastructure from boxlite-test-utils.
pub use boxlite_test_utils::*;

use boxlite::runtime::options::{BoxOptions, RootfsSpec};

// ============================================================================
// BOX OPTIONS HELPERS
// ============================================================================

/// Default test box options: `alpine:latest`, kept when it stops.
pub fn alpine_opts() -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: false,
        ..Default::default()
    }
}

/// Alpine box removed as soon as it stops (`--rm` semantics).
pub fn alpine_opts_auto() -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: true,
        ..Default::default()
    }
}
