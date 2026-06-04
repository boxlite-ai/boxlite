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
//! ├── bases  → target/boxlite-test/bases/   (symlink, read-only)
//! ├── tmp    → target/boxlite-test/tmp/XXXX (symlink, per-test subdir)
//! ├── db/boxlite.db                          (copy, per-test writable)
//! ├── boxes/                                  (per-test writable)
//! └── locks/                                  (per-test writable)
//! ```

use std::path::PathBuf;
use tempfile::TempDir;

use crate::cache::{LinkedCache, SharedResources};
use boxlite::BoxID;
use boxlite::util::PidFileReader;

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

/// Fail the test if a shim is still alive when this home drops.
///
/// Detached shims are `setsid()`'d daemons (see `vmm/controller/spawn.rs`)
/// that intentionally outlive the parent process. The production
/// stop paths — `box.stop()`, `auto_remove`, `runtime.remove()` —
/// are what should kill them; if the shim is still alive at drop
/// time, something on the production side did not run.
///
/// We do NOT silently reap here. Reaping would mask the bug: the
/// orphan accumulation that motivated this would just move from
/// `/tmp/` (visible) into the implicit Drop cleanup (invisible).
/// Failing loudly forces the test author to find the missing stop
/// call (or the production cleanup gap).
///
/// `panic` during another panic would mask the real failure, so
/// the check is skipped when `std::thread::panicking()` is true —
/// the original test failure is the primary signal in that case.
impl Drop for PerTestBoxHome {
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        let leaks = live_shim_pids(&self.path.join("boxes"));
        assert!(
            leaks.is_empty(),
            "PerTestBoxHome dropped with {n} live shim(s): {leaks:?}. \
             Tests must stop boxes (e.g. `box.stop()`, `runtime.remove()`, \
             or `auto_remove=true`) before the home goes out of scope. A \
             live shim here means a production cleanup path did not run.",
            n = leaks.len(),
        );
    }
}

/// Return PIDs from `<boxes_dir>/<box_id>/shim.pid` that point at
/// processes still alive right now. Missing dirs, malformed PID
/// files, and dead PIDs are all skipped silently.
fn live_shim_pids(boxes_dir: &std::path::Path) -> Vec<u32> {
    let mut alive = Vec::new();
    let Ok(entries) = std::fs::read_dir(boxes_dir) else {
        return alive;
    };
    for entry in entries.flatten() {
        let box_home = entry.path();
        let Some(name) = box_home.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if BoxID::parse(name).is_none() {
            continue;
        }
        let pid_file = box_home.join("shim.pid");
        if !pid_file.exists() {
            continue;
        }
        let Ok(record) = PidFileReader::at(&pid_file).read() else {
            continue;
        };
        // `kill(pid, 0)` returns 0 if the process exists (alive or
        // zombie). Zombies are dead from a leak-accounting view, but
        // for a brand-new test stand-in they shouldn't appear — and
        // the cost of being conservative is one extra reported leak,
        // not a missed one.
        if unsafe { libc::kill(record.pid as i32, 0) } == 0 {
            alive.push(record.pid);
        }
    }
    alive
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

    /// `PerTestBoxHome::drop` must fail the test if a referenced
    /// shim is still alive — the production stop path (box.stop,
    /// auto_remove, runtime.remove) is what should have killed it.
    /// Silently reaping would mask that gap.
    ///
    /// Revert procedure: replace the `impl Drop` body with an empty
    /// `fn drop(&mut self) {}`. The `catch_unwind` below must then
    /// report `Ok(())` instead of `Err(_)` — i.e., the drop didn't
    /// panic, and the leak would have gone unnoticed.
    #[test]
    fn drop_panics_if_shim_still_alive() {
        use std::os::unix::process::CommandExt;
        use std::process::Command;

        let home = PerTestBoxHome::isolated();
        let home_path = home.path.clone();

        // Stand-in for a detached shim. argv[0] override + own
        // pgroup match what a real shim spawn looks like.
        let argv0 = "boxlite-shim testbox123abc".to_string();
        let child = Command::new("sleep")
            .arg("30")
            .arg0(&argv0)
            .process_group(0)
            .spawn()
            .expect("spawn stand-in shim");
        let shim_pid = child.id();

        // Forget Child so its own Drop doesn't kill the stand-in
        // before PerTestBoxHome::drop runs.
        std::mem::forget(child);

        // Write a fake shim.pid into a BoxID-shaped dir.
        let box_dir = home_path.join("boxes").join("boxtestabc12");
        std::fs::create_dir_all(&box_dir).expect("mkdir box dir");
        std::fs::write(box_dir.join("shim.pid"), format!("{shim_pid}\n"))
            .expect("write fake shim.pid");

        assert_eq!(
            unsafe { libc::kill(shim_pid as i32, 0) },
            0,
            "test precondition: stand-in PID {shim_pid} must be alive before drop"
        );

        // Drop must panic — the leak is real and unhandled.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            drop(home);
        }));

        // Test-only cleanup (the production code under test stays
        // hands-off the kill, but this test created the stand-in so
        // we reap it ourselves to avoid leaking into the next test).
        unsafe {
            libc::kill(shim_pid as i32, libc::SIGKILL);
            libc::waitpid(shim_pid as i32, std::ptr::null_mut(), 0);
        }

        assert!(
            result.is_err(),
            "PerTestBoxHome::drop should have panicked on a live shim. \
             Stand-in PID {shim_pid} was never reported."
        );
    }
}
