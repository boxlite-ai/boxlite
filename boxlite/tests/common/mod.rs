//! Shared test infrastructure for boxlite integration tests.
//!
//! Two runtime flavors:
//! - [`WarmRuntime`]: Shared `/tmp/boxlite-test/` home with pre-warmed image cache.
//!   Use for VM-booting tests. Serial execution (nextest `serial-vm` group).
//! - [`IsolatedRuntime`]: Per-test `TempDir`. Use for non-VM tests (parallel-safe).
//!
//! Helper functions:
//! - [`alpine_opts()`]: Default `BoxOptions` with `alpine:latest`, `auto_remove=false`
//! - [`alpine_opts_auto()`]: Same but `auto_remove=true`

#![allow(dead_code)]

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use std::path::PathBuf;
use std::sync::OnceLock;
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
// WARM RUNTIME (shared image cache, for VM tests)
// ============================================================================

const TEST_IMAGES: &[&str] = &["alpine:latest"];

static WARM_HOME: OnceLock<PathBuf> = OnceLock::new();

fn warm_home() -> &'static PathBuf {
    WARM_HOME.get_or_init(|| {
        let home = PathBuf::from("/tmp/boxlite-test");
        std::fs::create_dir_all(&home).expect("create /tmp/boxlite-test");

        // Fast path: image cache already warm
        let manifests_dir = home.join("images").join("manifests");
        if manifests_dir.exists()
            && std::fs::read_dir(&manifests_dir)
                .map(|d| d.count() > 0)
                .unwrap_or(false)
        {
            return home;
        }

        // Cold path: pull images (only happens once per test session)
        eprintln!("[test] Warming image cache...");
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let runtime = BoxliteRuntime::new(BoxliteOptions {
                home_dir: home.clone(),
                image_registries: vec![],
            })
            .unwrap();
            let images = runtime.images().unwrap();
            for image in TEST_IMAGES {
                match images.pull(image).await {
                    Ok(_) => eprintln!("[test]   pulled {image}"),
                    Err(e) => eprintln!("[test]   skip {image} ({e})"),
                }
            }
            let _ = runtime.shutdown(Some(5)).await;
        });
        home
    })
}

/// Warm runtime with pre-warmed image cache at `/tmp/boxlite-test/`.
///
/// VM tests run serially (nextest `serial-vm`, `max-threads=1`), so sharing
/// this directory is safe. The image cache persists across test processes;
/// box state is cleaned up per-test via [`cleanup()`](WarmRuntime::cleanup).
pub struct WarmRuntime {
    pub runtime: BoxliteRuntime,
    pub home_dir: &'static PathBuf,
}

impl WarmRuntime {
    pub fn new() -> Self {
        let home = warm_home();
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.clone(),
            image_registries: vec![],
        })
        .expect("create warm runtime");
        Self {
            runtime,
            home_dir: home,
        }
    }

    /// Stop all boxes and release runtime lock.
    /// Call at end of every VM test to leave clean state for next test.
    pub async fn cleanup(&self) {
        let _ = self.runtime.shutdown(Some(10)).await;
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
        Self::new_in_base(None)
    }

    /// Create isolated runtime with `TempDir` under a specific base.
    /// Use `new_in("/tmp")` to keep Unix socket paths short on macOS.
    pub fn new_in(base: &str) -> Self {
        Self::new_in_base(Some(base))
    }

    fn new_in_base(base: Option<&str>) -> Self {
        let temp_dir = match base {
            Some(b) => TempDir::new_in(b).expect("create temp dir"),
            None => TempDir::new().expect("create temp dir"),
        };
        let home_dir = temp_dir.path().to_path_buf();
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .expect("create isolated runtime");
        Self {
            runtime,
            home_dir,
            _temp_dir: temp_dir,
        }
    }
}
