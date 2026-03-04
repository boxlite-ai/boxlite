//! Per-test isolated home directory with shared cache linked in.
//!
//! Like RocksDB's `PerThreadDBPath` + `DestroyDB`. Each test gets a unique
//! directory under `/tmp/`. Drop cleans up.
//!
//! # Layout
//!
//! ```text
//! /tmp/boxlite-XXXXXX/
//! ├── images → target/boxlite-test/images/  (symlink, read-only)
//! ├── rootfs → target/boxlite-test/rootfs/  (symlink, read-only)
//! ├── tmp    → target/boxlite-test/tmp/XXXX (symlink, per-test subdir)
//! ├── db/boxlite.db                          (copy, per-test writable)
//! ├── boxes/                                  (per-test writable)
//! └── locks/                                  (per-test writable)
//! ```

use std::path::PathBuf;
use tempfile::TempDir;

use crate::cache::{LinkedCache, SharedResources};

/// Per-test home directory with shared cache linked in.
///
/// Each test gets a unique directory. Drop cleans up automatically.
/// The image cache is symlinked (shared read-only), the DB is copied
/// (independent writes per test).
pub struct PerTestBoxHome {
    /// Path to this test's home directory.
    pub path: PathBuf,
    _temp: TempDir,
    /// Cleanup handle for per-test cache resources (tmp dir under `target/boxlite-test/tmp/`).
    /// `None` for isolated homes that don't use shared cache.
    _cache: Option<LinkedCache>,
}

impl Default for PerTestBoxHome {
    fn default() -> Self {
        Self::new()
    }
}

impl PerTestBoxHome {
    /// Create a new per-test home with shared cache.
    ///
    /// Triggers `SharedResources::global()` initialization if needed
    /// (image pull, rootfs warm-up). This is the primary constructor.
    pub fn new() -> Self {
        let cache = SharedResources::global();
        let temp = TempDir::new_in("/tmp").expect("create temp dir");
        let path = temp.path().to_path_buf();
        let linked = cache.link_into(&path);
        Self {
            path,
            _temp: temp,
            _cache: Some(linked),
        }
    }

    /// Create a per-test home without warm cache.
    ///
    /// For non-VM tests (locking behavior, config validation, shutdown tests).
    /// Does not trigger image pulls or rootfs builds.
    pub fn isolated() -> Self {
        let temp = TempDir::new_in("/tmp").expect("create temp dir");
        let path = temp.path().to_path_buf();
        Self {
            path,
            _temp: temp,
            _cache: None,
        }
    }

    /// Create a per-test home under a specific base directory.
    ///
    /// Useful for tests that need short Unix socket paths (macOS 104-char limit).
    pub fn new_in(base: &str) -> Self {
        let cache = SharedResources::global();
        let temp = TempDir::new_in(base).expect("create temp dir");
        let path = temp.path().to_path_buf();
        let linked = cache.link_into(&path);
        Self {
            path,
            _temp: temp,
            _cache: Some(linked),
        }
    }

    /// Create an isolated home under a specific base directory.
    pub fn isolated_in(base: &str) -> Self {
        let temp = TempDir::new_in(base).expect("create temp dir");
        let path = temp.path().to_path_buf();
        Self {
            path,
            _temp: temp,
            _cache: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_creates_temp_dir() {
        let home = PerTestBoxHome::isolated();
        assert!(home.path.exists(), "home dir should exist");
        assert!(
            home.path.starts_with("/tmp"),
            "should be under /tmp: {:?}",
            home.path
        );
    }

    #[test]
    fn isolated_cleanup_on_drop() {
        let path;
        {
            let home = PerTestBoxHome::isolated();
            path = home.path.clone();
            assert!(path.exists());
        }
        // After drop, temp dir should be cleaned up
        assert!(!path.exists(), "temp dir should be cleaned up after drop");
    }

    #[test]
    fn isolated_home_has_no_tmp_symlink() {
        let home = PerTestBoxHome::isolated();
        let tmp_link = home.path.join("tmp");
        assert!(
            !tmp_link.exists(),
            "isolated home should not have a tmp symlink"
        );
    }
}
