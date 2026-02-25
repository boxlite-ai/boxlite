//! Shared test infrastructure for boxlite integration tests.
//!
//! Provides a warm image cache in `target/boxlite-test/` and per-test `TempDir`
//! helpers that symlink the cache for parallel-safe test execution.
//!
//! # Key functions
//! - [`warm_temp_dir()`]: Per-test `TempDir` with symlinked image cache + copied DB.
//! - [`warm_dir()`]: Add warm caches to any existing directory.
//! - [`test_registries()`]: Docker Hub mirror registries for reliable pulls.

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tempfile::TempDir;

/// Shutdown timeout for test runtimes (seconds).
pub const TEST_SHUTDOWN_TIMEOUT: i32 = 10;

/// Images to pre-pull during cache warm-up.
pub const TEST_IMAGES: &[&str] = &["alpine:latest", "debian:bookworm-slim"];

/// Docker Hub mirror registries for reliable image pulls.
/// Mirrors are tried first; `docker.io` is the final fallback.
pub const TEST_REGISTRIES: &[&str] = &[
    "docker.m.daocloud.io",
    "docker.xuanyuan.me",
    "docker.1ms.run",
    "docker.io",
];

/// Convert `TEST_REGISTRIES` to `Vec<String>` for `BoxliteOptions::image_registries`.
pub fn test_registries() -> Vec<String> {
    TEST_REGISTRIES.iter().map(|s| s.to_string()).collect()
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// Create a symlink, ignoring `AlreadyExists` errors (race-safe).
fn symlink_or_exists(target: &Path, link: &Path, label: &str) {
    match std::os::unix::fs::symlink(target, link) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => panic!("symlink {label}: {e}"),
    }
}

/// Acquire an exclusive `flock` on `path`, blocking until the lock is available.
fn flock_exclusive(path: &Path) -> std::fs::File {
    use std::os::unix::io::AsRawFd;

    let file = std::fs::File::create(path).expect("create lock file");
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    assert_eq!(ret, 0, "acquire flock on {}", path.display());
    file
}

static WARM_HOME: OnceLock<PathBuf> = OnceLock::new();

/// Persistent cache directory in `target/boxlite-test/`.
/// Survives reboots; cleaned by `cargo clean`.
fn cache_dir() -> PathBuf {
    // Walk up from this crate's manifest dir to the workspace root.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("target")
        .join("boxlite-test")
}

/// Check whether image cache in `target/` is populated.
fn cache_is_warm() -> bool {
    let manifests_dir = cache_dir().join("images").join("manifests");
    manifests_dir.exists()
        && std::fs::read_dir(&manifests_dir)
            .map(|d| d.count() > 0)
            .unwrap_or(false)
}

fn warm_home() -> &'static PathBuf {
    WARM_HOME.get_or_init(|| {
        let home = PathBuf::from("/tmp/boxlite-test");
        std::fs::create_dir_all(&home).expect("create /tmp/boxlite-test");

        // Image + rootfs caches live in target/ (persist across reboots, cleaned by cargo clean).
        // Runtime home stays in /tmp/ for short Unix socket paths (macOS 104-char limit).
        let cache_images = cache_dir().join("images");
        std::fs::create_dir_all(&cache_images).expect("create target/boxlite-test/images");
        let cache_rootfs = cache_dir().join("rootfs");
        std::fs::create_dir_all(&cache_rootfs).expect("create target/boxlite-test/rootfs");
        let cache_tmp = cache_dir().join("tmp");
        std::fs::create_dir_all(&cache_tmp).expect("create target/boxlite-test/tmp");

        // Symlink /tmp/boxlite-test/{images,rootfs,tmp} → target/boxlite-test/{images,rootfs,tmp}.
        // Multiple processes may race here; symlink_or_exists handles AlreadyExists.
        for (target, name) in [
            (&cache_images, "images"),
            (&cache_rootfs, "rootfs"),
            (&cache_tmp, "tmp"),
        ] {
            symlink_or_exists(target, &home.join(name), name);
        }

        // Fast path: cache already warm (survives reboots)
        if cache_is_warm() {
            return home;
        }

        // Cold path: cross-process lock serializes the initial image pull.
        // nextest runs each test in a separate process, so OnceLock doesn't help.
        // Use a blocking flock — the winner pulls, losers wait then re-check.
        let lock_path = cache_dir().join(".warmup.lock");
        let _lock_file = flock_exclusive(&lock_path);

        // Re-check after acquiring lock (another process may have finished pulling)
        if cache_is_warm() {
            return home;
        }

        // We won the race — pull images on a dedicated thread.
        // #[tokio::test] already has a Tokio runtime; creating another inside
        // the same thread panics ("Cannot start a runtime from within a runtime").
        eprintln!("[test] Warming image cache...");
        std::thread::spawn({
            let home = home.clone();
            move || {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async {
                    let runtime = BoxliteRuntime::new(BoxliteOptions {
                        home_dir: home.clone(),
                        image_registries: test_registries(),
                    })
                    .unwrap();
                    let images = runtime.images().unwrap();
                    for image in TEST_IMAGES {
                        match images.pull(image).await {
                            Ok(_) => eprintln!("[test]   pulled {image}"),
                            Err(e) => eprintln!("[test]   skip {image} ({e})"),
                        }
                    }

                    // Warm the guest rootfs pipeline by starting a box.
                    // This triggers: pull debian:bookworm-slim → build image disk → build rootfs disk → boot VM.
                    // Pre-building these artifacts prevents concurrent builds during parallel tests.
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

                    // Force-remove any stale boxes from previous incomplete warm-ups.
                    // Only image index records should survive into the cached DB.
                    let all_boxes = runtime.list_info().await.unwrap_or_default();
                    for info in &all_boxes {
                        let _ = runtime.remove(info.id.as_str(), true).await;
                    }

                    eprintln!("[test] Guest rootfs pipeline warm.");

                    let _ = runtime.shutdown(Some(TEST_SHUTDOWN_TIMEOUT)).await;
                });
            }
        })
        .join()
        .expect("warm-cache thread panicked");

        // Cache the DB in target/ so warm_temp_dir() can copy it.
        // The DB contains image pull records that the runtime needs to find cached images.
        let cache_db = cache_dir().join("db");
        std::fs::create_dir_all(&cache_db).expect("create target/boxlite-test/db");
        if let Err(e) = std::fs::copy(home.join("db/boxlite.db"), cache_db.join("boxlite.db")) {
            eprintln!("[test] warn: failed to copy cached DB: {e}");
        }

        // lock_file dropped here → releases flock → waiting processes proceed
        home
    })
}

// ============================================================================
// PUBLIC API
// ============================================================================

/// Add warm caches (symlinked images/rootfs + copied DB) to any home directory.
///
/// Ensures `warm_home()` has run (images pulled and cached in `target/`), then:
/// - Symlinks `images/` → `target/boxlite-test/images/` (shared, read-only)
/// - Symlinks `rootfs/` → `target/boxlite-test/rootfs/` (shared, built on first box start)
/// - Copies `db/boxlite.db` from `target/` (independent writes per test)
pub fn warm_dir(home_dir: &Path) {
    let warm = warm_home();

    // Symlink images, rootfs → target/ cache (shared across tests, read-only).
    for name in ["images", "rootfs"] {
        let link = home_dir.join(name);
        if !link.exists() {
            let warm_target = warm.join(name);
            if warm_target.exists() {
                let real_dir =
                    std::fs::canonicalize(&warm_target).unwrap_or_else(|_| warm_target.clone());
                symlink_or_exists(&real_dir, &link, name);
            }
        }
    }

    // Per-test tmp: unique subdir on same device as rootfs, avoids cross-test cleanup race
    // when BoxliteRuntime::new() wipes temp_dir contents on startup.
    let cache_tmp = cache_dir().join("tmp");
    std::fs::create_dir_all(&cache_tmp).unwrap_or_default();
    let per_test_tmp = tempfile::tempdir_in(&cache_tmp).expect("create per-test tmp dir");
    let per_test_tmp_path = per_test_tmp.keep();
    symlink_or_exists(&per_test_tmp_path, &home_dir.join("tmp"), "tmp");

    // Copy DB from target/ cache so the runtime finds cached image records.
    // Each test gets its own DB copy — no SQLite locking conflicts.
    let cached_db = cache_dir().join("db").join("boxlite.db");
    if cached_db.exists() {
        let db_dir = home_dir.join("db");
        std::fs::create_dir_all(&db_dir).expect("create db dir");
        if let Err(e) = std::fs::copy(&cached_db, db_dir.join("boxlite.db")) {
            eprintln!("[test] warn: failed to copy cached DB: {e}");
        }
    }
}

/// Create a `TempDir` with symlinked image cache and copied DB from `target/`.
///
/// Each test gets its own home dir (parallel-safe). The image cache is symlinked
/// (shared read-only) and the DB is copied (independent writes per test).
pub fn warm_temp_dir() -> (TempDir, PathBuf) {
    let temp_dir = TempDir::new_in("/tmp").expect("create temp dir");
    let home_dir = temp_dir.path().to_path_buf();
    warm_dir(&home_dir);
    (temp_dir, home_dir)
}
