//! Shared test cache: images, rootfs, DB snapshot.
//!
//! Created once per process ([`OnceLock`]), cross-process safe ([`flock`]).
//! Replaces the monolithic `warm_home()` function.
//!
//! # Layout
//!
//! ```text
//! target/boxlite-test/
//! ├── images/         ← pulled OCI images (shared read-only)
//! ├── rootfs/         ← built guest rootfs (shared read-only)
//! ├── tmp/            ← transient files (per-test subdirs)
//! └── db/boxlite.db   ← DB snapshot (copied per-test)
//! ```

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};

use tempfile::TempDir;

use crate::{TEST_IMAGES, TEST_SHUTDOWN_TIMEOUT, test_registries};

/// Cleanup handle for per-test resources linked into a home directory.
///
/// Owns the per-test tmp directory under `target/boxlite-test/tmp/`.
/// Dropping this removes it automatically via [`TempDir`]'s RAII cleanup.
pub struct LinkedCache {
    _per_test_tmp: TempDir,
}

static SHARED_RESOURCES: OnceLock<SharedResources> = OnceLock::new();

/// Shared test cache containing pre-pulled images, built rootfs, and DB snapshot.
///
/// Created once per process via [`SharedResources::global()`]. Cross-process safe
/// via `flock` (nextest runs each test in a separate process).
pub struct SharedResources {
    /// Root of the persistent cache: `target/boxlite-test/`.
    dir: PathBuf,
}

impl SharedResources {
    /// Get or create the global shared cache.
    ///
    /// On first call: creates cache directories, pulls images (with cross-process lock),
    /// warms rootfs, and snapshots the DB. Subsequent calls return the cached instance.
    pub fn global() -> &'static Self {
        SHARED_RESOURCES.get_or_init(Self::init)
    }

    /// Path to the shared images directory.
    pub fn images_dir(&self) -> PathBuf {
        self.dir.join("images")
    }

    /// Path to the shared rootfs directory.
    pub fn rootfs_dir(&self) -> PathBuf {
        self.dir.join("rootfs")
    }

    /// Path to the shared tmp directory.
    pub fn tmp_dir(&self) -> PathBuf {
        self.dir.join("tmp")
    }

    /// Path to the DB snapshot.
    pub fn db_snapshot(&self) -> PathBuf {
        self.dir.join("db/boxlite.db")
    }

    /// Symlink shared caches into a per-test home directory and copy the DB.
    ///
    /// Creates:
    /// - `home/images → target/boxlite-test/images/` (symlink, read-only)
    /// - `home/rootfs → target/boxlite-test/rootfs/` (symlink, read-only)
    /// - `home/tmp → target/boxlite-test/tmp/<unique>/` (symlink, per-test)
    /// - `home/db/boxlite.db` (copy, per-test writable)
    pub fn link_into(&self, home_dir: &Path) -> LinkedCache {
        // Symlink images, rootfs → cache dir (shared, read-only)
        for name in ["images", "rootfs"] {
            let link = home_dir.join(name);
            if !link.exists() {
                let target = self.dir.join(name);
                if target.exists() {
                    symlink_or_exists(&target, &link, name);
                }
            }
        }

        // Per-test tmp: unique subdir on same device as rootfs.
        // Avoids cross-test cleanup race when BoxliteRuntime::new() wipes temp_dir.
        let cache_tmp = self.tmp_dir();
        std::fs::create_dir_all(&cache_tmp).unwrap_or_default();
        let per_test_tmp = tempfile::tempdir_in(&cache_tmp).expect("create per-test tmp dir");
        symlink_or_exists(per_test_tmp.path(), &home_dir.join("tmp"), "tmp");

        // Copy DB from cache — each test gets its own writable copy.
        let cached_db = self.db_snapshot();
        if cached_db.exists() {
            let db_dir = home_dir.join("db");
            std::fs::create_dir_all(&db_dir).expect("create db dir");
            if let Err(e) = std::fs::copy(&cached_db, db_dir.join("boxlite.db")) {
                eprintln!("[test] warn: failed to copy cached DB: {e}");
            }
        }

        LinkedCache {
            _per_test_tmp: per_test_tmp,
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Private initialization
    // ────────────────────────────────────────────────────────────────────────

    fn init() -> Self {
        let dir = cache_dir();

        // Create persistent cache directories
        for subdir in ["images", "rootfs", "tmp"] {
            std::fs::create_dir_all(dir.join(subdir))
                .unwrap_or_else(|e| panic!("create cache/{subdir}: {e}"));
        }

        let resources = Self { dir: dir.clone() };

        // Fast path: cache already warm
        if resources.is_warm() {
            return resources;
        }

        // Cold path: cross-process lock serializes initial image pull.
        // nextest runs each test in a separate process, so OnceLock alone doesn't help.
        let lock_path = dir.join(".warmup.lock");
        let _lock_file = flock_exclusive(&lock_path);

        // Re-check after acquiring lock
        if resources.is_warm() {
            return resources;
        }

        // Ephemeral short-path home for warm-up runtime (macOS 104-char socket limit).
        // Symlinks {images,rootfs,tmp} → target/boxlite-test/ so data persists.
        let warm_home = TempDir::new_in("/tmp").expect("create warm home");
        for name in ["images", "rootfs", "tmp"] {
            symlink_or_exists(&dir.join(name), &warm_home.path().join(name), name);
        }

        // Pull images and warm rootfs on a dedicated thread.
        // #[tokio::test] already has a Tokio runtime; creating another inside
        // the same thread panics ("Cannot start a runtime from within a runtime").
        resources.warm_on_thread(warm_home.path());
        resources.snapshot_db(warm_home.path());
        // warm_home dropped here — cleaned up automatically

        resources
    }

    fn is_warm(&self) -> bool {
        let manifests_dir = self.images_dir().join("manifests");
        manifests_dir.exists()
            && std::fs::read_dir(&manifests_dir)
                .map(|d| d.count() > 0)
                .unwrap_or(false)
    }

    fn warm_on_thread(&self, warm_home: &Path) {
        eprintln!("[test] Warming image cache...");
        let home = warm_home.to_path_buf();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let runtime = BoxliteRuntime::new(BoxliteOptions {
                    home_dir: home.clone(),
                    image_registries: test_registries(),
                })
                .unwrap();

                // Pull test images
                let images = runtime.images().unwrap();
                for image in TEST_IMAGES {
                    match images.pull(image).await {
                        Ok(_) => eprintln!("[test]   pulled {image}"),
                        Err(e) => eprintln!("[test]   skip {image} ({e})"),
                    }
                }

                // Warm rootfs by starting a box
                eprintln!("[test] Warming guest rootfs pipeline...");
                let handle = runtime
                    .create(
                        BoxOptions {
                            rootfs: RootfsSpec::Image("alpine:latest".into()),
                            auto_remove: false,
                            ..Default::default()
                        },
                        None,
                    )
                    .await
                    .unwrap();
                handle.start().await.unwrap();
                handle.stop().await.unwrap();
                let _ = runtime.remove(handle.id().as_str(), false).await;

                // Clean up stale boxes from previous incomplete warm-ups
                let all_boxes = runtime.list_info().await.unwrap_or_default();
                for info in &all_boxes {
                    let _ = runtime.remove(info.id.as_str(), true).await;
                }

                eprintln!("[test] Guest rootfs pipeline warm.");
                let _ = runtime.shutdown(Some(TEST_SHUTDOWN_TIMEOUT)).await;
            });
        })
        .join()
        .expect("warm-cache thread panicked");
    }

    fn snapshot_db(&self, warm_home: &Path) {
        let cache_db = self.dir.join("db");
        std::fs::create_dir_all(&cache_db).expect("create target/boxlite-test/db");
        if let Err(e) = std::fs::copy(warm_home.join("db/boxlite.db"), cache_db.join("boxlite.db"))
        {
            eprintln!("[test] warn: failed to copy cached DB: {e}");
        }
    }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// Persistent cache directory in `target/boxlite-test/`.
fn cache_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("target")
        .join("boxlite-test")
}

/// Create a symlink, ignoring `AlreadyExists` errors (race-safe).
fn symlink_or_exists(target: &Path, link: &Path, label: &str) {
    match std::os::unix::fs::symlink(target, link) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => panic!("symlink {label}: {e}"),
    }
}

/// Acquire an exclusive `flock` on `path`, blocking until available.
fn flock_exclusive(path: &Path) -> std::fs::File {
    use std::os::unix::io::AsRawFd;

    let file = std::fs::File::create(path).expect("create lock file");
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    assert_eq!(ret, 0, "acquire flock on {}", path.display());
    file
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_dir_is_under_target() {
        let dir = cache_dir();
        assert!(
            dir.to_str().unwrap().contains("target/boxlite-test"),
            "cache_dir should be under target/: {:?}",
            dir
        );
    }

    #[test]
    fn shared_resources_paths_are_consistent() {
        // Test path construction without triggering full init
        let resources = SharedResources {
            dir: PathBuf::from("/test/cache"),
        };
        assert_eq!(resources.images_dir(), PathBuf::from("/test/cache/images"));
        assert_eq!(resources.rootfs_dir(), PathBuf::from("/test/cache/rootfs"));
        assert_eq!(resources.tmp_dir(), PathBuf::from("/test/cache/tmp"));
        assert_eq!(
            resources.db_snapshot(),
            PathBuf::from("/test/cache/db/boxlite.db")
        );
    }

    #[test]
    fn linked_cache_cleans_per_test_tmp_on_drop() {
        let base = tempfile::tempdir().expect("create base temp dir");
        let cache_dir = base.path().join("cache");
        for sub in ["images", "rootfs", "tmp"] {
            std::fs::create_dir_all(cache_dir.join(sub)).unwrap();
        }

        let resources = SharedResources {
            dir: cache_dir.clone(),
        };

        // Create a per-test home and link into it
        let home = tempfile::tempdir().expect("create home temp dir");
        let linked = resources.link_into(home.path());

        // The per-test tmp dir should exist under cache/tmp/
        let tmp_entries: Vec<_> = std::fs::read_dir(cache_dir.join("tmp"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(tmp_entries.len(), 1, "should have one per-test tmp dir");
        let per_test_tmp_path = tmp_entries[0].path();
        assert!(per_test_tmp_path.exists());

        // Drop the LinkedCache — per-test tmp should be cleaned up
        drop(linked);
        assert!(
            !per_test_tmp_path.exists(),
            "per-test tmp dir should be removed after LinkedCache drop"
        );
    }

    #[test]
    fn link_into_creates_tmp_symlink() {
        let base = tempfile::tempdir().expect("create base temp dir");
        let cache_dir = base.path().join("cache");
        for sub in ["images", "rootfs", "tmp"] {
            std::fs::create_dir_all(cache_dir.join(sub)).unwrap();
        }

        let resources = SharedResources { dir: cache_dir };

        let home = tempfile::tempdir().expect("create home temp dir");
        let _linked = resources.link_into(home.path());

        let tmp_link = home.path().join("tmp");
        assert!(
            tmp_link
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink(),
            "home/tmp should be a symlink"
        );
        assert!(
            tmp_link.exists(),
            "symlink target should exist while LinkedCache is alive"
        );
    }
}
