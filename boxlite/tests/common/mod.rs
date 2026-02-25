//! Shared test infrastructure for boxlite integration tests.
//!
//! Runtime flavors:
//! - [`ParallelRuntime`]: Per-test `TempDir` + symlinked image cache.
//!   Each test gets its own home dir → parallel-safe even for VM tests.
//! - [`IsolatedRuntime`]: Per-test `TempDir`, no image cache. For non-VM tests.
//! - [`warm_temp_dir()`]: Raw `TempDir` + image symlink. For recovery tests
//!   that create/drop multiple runtimes manually.
//!
//! Helper functions:
//! - [`alpine_opts()`]: Default `BoxOptions` with `alpine:latest`, `auto_remove=false`
//! - [`alpine_opts_auto()`]: Same but `auto_remove=true`

#![allow(dead_code)]

// Re-export shared warm-cache infrastructure from boxlite-test-utils.
pub use boxlite_test_utils::*;

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use std::path::PathBuf;
use tempfile::TempDir;

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

// ============================================================================
// PARALLEL RUNTIME (per-test TempDir, symlinked images)
// ============================================================================

/// Per-test runtime with isolated TempDir and symlinked image cache.
///
/// Parallel-safe: each test gets its own home dir (unique flock).
/// Drop order: `runtime` drops first (shutdown_sync), `_temp_dir` drops last (cleanup).
pub struct ParallelRuntime {
    pub runtime: BoxliteRuntime,
    pub home_dir: PathBuf,
    _temp_dir: TempDir,
}

impl ParallelRuntime {
    pub fn new() -> Self {
        let (temp_dir, home_dir) = warm_temp_dir();
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: test_registries(),
        })
        .expect("create parallel runtime");
        Self {
            runtime,
            home_dir,
            _temp_dir: temp_dir,
        }
    }

    /// Shut down the runtime with the standard test timeout.
    pub async fn shutdown(&self) {
        let _ = self.runtime.shutdown(Some(TEST_SHUTDOWN_TIMEOUT)).await;
    }
}

// ============================================================================
// ISOLATED RUNTIME (per-test TempDir, for non-VM tests)
// ============================================================================

/// Isolated runtime with per-test temp directory.
///
/// Safe for parallel execution. Use for tests that don't boot VMs:
/// locking behavior, shutdown idempotency, config validation.
pub struct IsolatedRuntime {
    pub runtime: BoxliteRuntime,
    pub home_dir: PathBuf,
    _temp_dir: TempDir,
}

impl IsolatedRuntime {
    /// Create isolated runtime with `TempDir` in system default location.
    pub fn new() -> Self {
        Self::new_in_base(None, false)
    }

    /// Create isolated runtime with `TempDir` under a specific base.
    /// Use `new_in("/tmp")` to keep Unix socket paths short on macOS.
    pub fn new_in(base: &str) -> Self {
        Self::new_in_base(Some(base), false)
    }

    /// Create isolated runtime with pre-warmed image cache.
    /// Use for tests that boot VMs but can't use `ParallelRuntime`.
    pub fn new_warm(base: &str) -> Self {
        Self::new_in_base(Some(base), true)
    }

    fn new_in_base(base: Option<&str>, warm: bool) -> Self {
        let temp_dir = match base {
            Some(b) => TempDir::new_in(b).expect("create temp dir"),
            None => TempDir::new().expect("create temp dir"),
        };
        let home_dir = temp_dir.path().to_path_buf();
        if warm {
            warm_dir(&home_dir);
        }
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: test_registries(),
        })
        .expect("create isolated runtime");
        Self {
            runtime,
            home_dir,
            _temp_dir: temp_dir,
        }
    }
}
