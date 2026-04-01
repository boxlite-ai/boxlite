//! Unix socket path shortening via symlinks.
//!
//! Unix domain sockets have a `sun_path` limit of 104 bytes (macOS) / 108 bytes (Linux).
//! When `BOXLITE_HOME` is a long path, socket paths like
//! `~/.boxlite/boxes/{box_id}/sockets/box.sock` can exceed this limit.
//!
//! Solution: Create a short symlink `/tmp/bl_{short_id}` → real sockets directory.
//! The kernel resolves symlinks during VFS path lookup AFTER the `sun_path` length
//! check, so the short symlink path satisfies the buffer size constraint while the
//! socket file physically lives at the real (long) path.
//!
//! This is the same pattern used by Open vSwitch (`shorten_name_via_symlink()` in
//! `lib/socket-util-unix.c`).
//!
//! **Library safety**: BoxLite is a library — we must NEVER change the host process's
//! CWD. The symlink approach avoids any process-global state mutation.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::{Path, PathBuf};

/// Maximum allowed socket path length.
/// macOS = 104, Linux = 108. Use the smaller value for cross-platform safety.
const MAX_SUN_PATH: usize = 104;

/// Prefix for shortener symlinks in the temp directory.
const SYMLINK_PREFIX: &str = "bl_";

/// Manages a short symlink in `/tmp` that aliases a box's sockets directory.
///
/// When the real socket path exceeds [`MAX_SUN_PATH`], this creates:
/// ```text
/// /tmp/bl_{short_id}  →  ~/.boxlite/boxes/{box_id}/sockets/
/// ```
///
/// Use [`short_path()`](Self::short_path) to get a short path for `bind()`/`connect()`.
/// The symlink is automatically removed on [`Drop`].
///
/// Returns `None` from [`new()`](Self::new) if paths already fit — no symlink created.
#[derive(Debug)]
pub struct SocketShortener {
    /// The short symlink path: `/tmp/bl_{short_id}`
    symlink_path: PathBuf,
    /// The real sockets directory this symlink points to.
    real_dir: PathBuf,
}

impl SocketShortener {
    /// Create a shortener if the socket paths exceed the `sun_path` limit.
    ///
    /// Returns `Ok(None)` if all socket paths already fit within [`MAX_SUN_PATH`].
    /// Returns `Ok(Some(shortener))` if a symlink was created.
    /// Returns `Err` if the symlink cannot be created or paths are too long even with shortening.
    pub fn new(short_id: &str, sockets_dir: &Path) -> BoxliteResult<Option<Self>> {
        // Check if shortening is needed (ready.sock is the longest socket name)
        let longest_real = sockets_dir.join("ready.sock");
        if longest_real.as_os_str().len() < MAX_SUN_PATH {
            return Ok(None);
        }

        let symlink_path = std::env::temp_dir().join(format!("{SYMLINK_PREFIX}{short_id}"));

        // Verify the short path actually fits
        let longest_short = symlink_path.join("ready.sock");
        if longest_short.as_os_str().len() >= MAX_SUN_PATH {
            return Err(BoxliteError::Internal(format!(
                "Socket path '{}' ({} bytes) exceeds sun_path limit ({} bytes) \
                 even with symlink shortening. Use a shorter temp directory.",
                longest_short.display(),
                longest_short.as_os_str().len(),
                MAX_SUN_PATH,
            )));
        }

        // Handle existing path at the symlink location
        match std::fs::symlink_metadata(&symlink_path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                // Stale symlink — safe to replace
                let _ = std::fs::remove_file(&symlink_path);
            }
            Ok(_) => {
                // Regular file or directory — refuse to overwrite
                return Err(BoxliteError::Internal(format!(
                    "{} exists but is not a symlink — refusing to overwrite",
                    symlink_path.display(),
                )));
            }
            Err(_) => {
                // Doesn't exist — good
            }
        }

        std::os::unix::fs::symlink(sockets_dir, &symlink_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create socket symlink {} → {}: {}",
                symlink_path.display(),
                sockets_dir.display(),
                e,
            ))
        })?;

        tracing::debug!(
            symlink = %symlink_path.display(),
            target = %sockets_dir.display(),
            "Created socket path shortener symlink"
        );

        Ok(Some(Self {
            symlink_path,
            real_dir: sockets_dir.to_path_buf(),
        }))
    }

    /// Get the short path for a socket file.
    ///
    /// Example: `shortener.short_path("box.sock")` → `/tmp/bl_aB3xK9Lm/box.sock`
    pub fn short_path(&self, socket_name: &str) -> PathBuf {
        self.symlink_path.join(socket_name)
    }

    /// The symlink directory path.
    pub fn symlink_dir(&self) -> &Path {
        &self.symlink_path
    }

    /// The real sockets directory this symlink points to.
    pub fn real_dir(&self) -> &Path {
        &self.real_dir
    }

    /// Remove the symlink. Also called automatically on [`Drop`].
    #[allow(clippy::collapsible_if)]
    pub fn cleanup(&self) {
        if let Err(e) = std::fs::remove_file(&self.symlink_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %self.symlink_path.display(),
                    error = %e,
                    "Failed to remove socket shortener symlink"
                );
            }
        }
    }
}

impl Drop for SocketShortener {
    fn drop(&mut self) {
        self.cleanup();
    }
}

/// Resolve a socket path, using the shortener if available.
///
/// When a [`SocketShortener`] is present, returns the short symlinked path.
/// Otherwise, returns the real path unchanged.
pub fn resolve_socket_path(
    shortener: Option<&SocketShortener>,
    real_path: &Path,
    socket_name: &str,
) -> PathBuf {
    match shortener {
        Some(s) => s.short_path(socket_name),
        None => real_path.to_path_buf(),
    }
}

/// Remove stale `/tmp/bl_*` symlinks whose targets no longer exist.
///
/// Called during runtime startup to clean up symlinks left behind by
/// crashed or improperly shutdown box instances.
pub fn cleanup_stale_symlinks() {
    let tmp_dir = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&tmp_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with(SYMLINK_PREFIX) {
            continue;
        }

        let path = entry.path();
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            // Only remove symlinks (not regular files/dirs that happen to match)
            // and only if the target no longer exists (stale)
            if meta.file_type().is_symlink() && !path.exists() {
                tracing::debug!(
                    path = %path.display(),
                    "Removing stale socket shortener symlink"
                );
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// Create a sockets directory deep enough that its paths exceed MAX_SUN_PATH.
    fn create_deep_sockets_dir(base: &Path) -> PathBuf {
        let deep = base
            .join("very_long_directory_name_that_keeps_going")
            .join("and_another_long_segment_here_too")
            .join("sockets");
        std::fs::create_dir_all(&deep).unwrap();
        assert!(
            deep.join("ready.sock").as_os_str().len() >= MAX_SUN_PATH,
            "Test setup: deep path {} ({} bytes) must exceed {} bytes",
            deep.join("ready.sock").display(),
            deep.join("ready.sock").as_os_str().len(),
            MAX_SUN_PATH,
        );
        deep
    }

    // ========================================================================
    // SocketShortener::new
    // ========================================================================

    #[test]
    fn new_returns_none_when_path_fits() {
        let tmp = tempfile::TempDir::new().unwrap();
        let sockets_dir = tmp.path().join("sockets");
        std::fs::create_dir_all(&sockets_dir).unwrap();

        let result = SocketShortener::new("abcd1234", &sockets_dir).unwrap();
        assert!(
            result.is_none(),
            "Should not create symlink for short paths"
        );
    }

    #[test]
    fn new_creates_symlink_when_path_too_long() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        let shortener = SocketShortener::new("long1234", &deep)
            .unwrap()
            .expect("Should create symlink for long paths");

        // Symlink should exist and be a symlink
        let meta = std::fs::symlink_metadata(shortener.symlink_dir()).unwrap();
        assert!(meta.file_type().is_symlink());

        // Should point to the real directory
        let target = std::fs::read_link(shortener.symlink_dir()).unwrap();
        assert_eq!(target, deep);
    }

    #[test]
    fn new_short_path_within_limit_for_all_sockets() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        if let Some(shortener) = SocketShortener::new("limit123", &deep).unwrap() {
            for name in ["box.sock", "ready.sock", "net.sock"] {
                let short = shortener.short_path(name);
                assert!(
                    short.as_os_str().len() < MAX_SUN_PATH,
                    "Short path '{}' ({} bytes) must be < {} bytes",
                    short.display(),
                    short.as_os_str().len(),
                    MAX_SUN_PATH,
                );
            }
        }
    }

    #[test]
    fn new_replaces_stale_symlink() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        // Create and drop a shortener to get the symlink path
        let s1 = SocketShortener::new("stale123", &deep).unwrap().unwrap();
        let symlink_path = s1.symlink_dir().to_path_buf();
        drop(s1); // Drop removes the symlink

        // Manually create a stale symlink pointing to a nonexistent target
        symlink(Path::new("/nonexistent/stale/path"), &symlink_path).unwrap();
        assert!(
            std::fs::symlink_metadata(&symlink_path)
                .unwrap()
                .file_type()
                .is_symlink()
        );

        // New shortener with same ID should replace the stale symlink
        let s2 = SocketShortener::new("stale123", &deep).unwrap().unwrap();
        let target = std::fs::read_link(s2.symlink_dir()).unwrap();
        assert_eq!(
            target, deep,
            "Should point to the new target, not the stale one"
        );
    }

    #[test]
    fn new_refuses_to_overwrite_regular_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        // Create a regular file where the symlink would go
        let blocker_path = std::env::temp_dir().join(format!("{SYMLINK_PREFIX}block123"));
        std::fs::write(&blocker_path, "I am not a symlink").unwrap();

        let result = SocketShortener::new("block123", &deep);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("not a symlink"),
            "Error should mention 'not a symlink', got: {err}"
        );

        // Cleanup
        let _ = std::fs::remove_file(&blocker_path);
    }

    #[test]
    fn new_refuses_to_overwrite_directory() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        // Create a directory where the symlink would go
        let dir_path = std::env::temp_dir().join(format!("{SYMLINK_PREFIX}dir_1234"));
        let _ = std::fs::remove_dir_all(&dir_path);
        std::fs::create_dir_all(&dir_path).unwrap();

        let result = SocketShortener::new("dir_1234", &deep);
        assert!(result.is_err());

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir_path);
    }

    // ========================================================================
    // SocketShortener::cleanup / Drop
    // ========================================================================

    #[test]
    fn cleanup_removes_symlink() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        let shortener = SocketShortener::new("cln_1234", &deep).unwrap().unwrap();
        let path = shortener.symlink_dir().to_path_buf();
        assert!(std::fs::symlink_metadata(&path).is_ok());

        shortener.cleanup();
        assert!(
            std::fs::symlink_metadata(&path).is_err(),
            "Symlink should be removed after cleanup"
        );
    }

    #[test]
    fn cleanup_is_idempotent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        let shortener = SocketShortener::new("idem1234", &deep).unwrap().unwrap();
        shortener.cleanup();
        shortener.cleanup(); // Second call should not panic
    }

    #[test]
    fn drop_removes_symlink() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        let shortener = SocketShortener::new("drp_1234", &deep).unwrap().unwrap();
        let path = shortener.symlink_dir().to_path_buf();
        drop(shortener);

        assert!(
            std::fs::symlink_metadata(&path).is_err(),
            "Symlink should be removed on Drop"
        );
    }

    // ========================================================================
    // SocketShortener accessors
    // ========================================================================

    #[test]
    fn real_dir_returns_original_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        let shortener = SocketShortener::new("real1234", &deep).unwrap().unwrap();
        assert_eq!(shortener.real_dir(), deep);
    }

    #[test]
    fn symlink_dir_is_in_temp() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        let shortener = SocketShortener::new("temp1234", &deep).unwrap().unwrap();
        assert!(shortener.symlink_dir().starts_with(std::env::temp_dir()));
    }

    // ========================================================================
    // resolve_socket_path
    // ========================================================================

    #[test]
    fn resolve_returns_short_path_with_shortener() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        let shortener = SocketShortener::new("res_1234", &deep).unwrap().unwrap();
        let real_path = deep.join("box.sock");
        let resolved = resolve_socket_path(Some(&shortener), &real_path, "box.sock");

        assert!(resolved.starts_with(std::env::temp_dir()));
        assert!(resolved.ends_with("box.sock"));
        assert!(resolved.as_os_str().len() < MAX_SUN_PATH);
    }

    #[test]
    fn resolve_returns_real_path_without_shortener() {
        let real = PathBuf::from("/some/long/path/sockets/box.sock");
        let resolved = resolve_socket_path(None, &real, "box.sock");
        assert_eq!(resolved, real);
    }

    // ========================================================================
    // cleanup_stale_symlinks
    // ========================================================================

    #[test]
    fn stale_cleanup_removes_dead_symlinks() {
        let dead_link = std::env::temp_dir().join(format!("{SYMLINK_PREFIX}dead_test"));
        let _ = std::fs::remove_file(&dead_link);
        symlink(Path::new("/nonexistent/target/for/test"), &dead_link).unwrap();

        cleanup_stale_symlinks();

        assert!(
            std::fs::symlink_metadata(&dead_link).is_err(),
            "Dead symlink should be removed"
        );
    }

    #[test]
    fn stale_cleanup_keeps_live_symlinks() {
        let tmp = tempfile::TempDir::new().unwrap();
        let live_target = tmp.path().join("live_target");
        std::fs::create_dir_all(&live_target).unwrap();

        let live_link = std::env::temp_dir().join(format!("{SYMLINK_PREFIX}live_test"));
        let _ = std::fs::remove_file(&live_link);
        symlink(&live_target, &live_link).unwrap();

        cleanup_stale_symlinks();

        assert!(
            std::fs::symlink_metadata(&live_link).is_ok(),
            "Live symlink should be kept"
        );

        let _ = std::fs::remove_file(&live_link);
    }

    #[test]
    fn stale_cleanup_ignores_non_prefixed_entries() {
        let dead_link = std::env::temp_dir().join("not_bl_prefixed_test_link");
        let _ = std::fs::remove_file(&dead_link);
        symlink(Path::new("/nonexistent/unrelated"), &dead_link).unwrap();

        cleanup_stale_symlinks();

        assert!(
            std::fs::symlink_metadata(&dead_link).is_ok(),
            "Non-prefixed symlink should NOT be removed"
        );

        let _ = std::fs::remove_file(&dead_link);
    }

    // ========================================================================
    // Kernel behavior: bind/connect through symlinks
    // ========================================================================

    #[test]
    fn bind_and_connect_through_symlink_works() {
        let tmp = tempfile::TempDir::new().unwrap();
        let real_dir = tmp.path().join("real_sockets");
        std::fs::create_dir_all(&real_dir).unwrap();

        let short_link = tmp.path().join("s");
        symlink(&real_dir, &short_link).unwrap();

        let sock_path = short_link.join("test.sock");

        // Bind through symlinked directory
        let listener = std::os::unix::net::UnixListener::bind(&sock_path).unwrap();

        // Socket file should physically exist in the real directory
        assert!(
            real_dir.join("test.sock").exists(),
            "Socket file should exist in real directory, not just via symlink"
        );

        // Connect through the same symlinked path
        let _stream = std::os::unix::net::UnixStream::connect(&sock_path).unwrap();

        drop(listener);
    }

    #[test]
    fn bind_through_symlink_with_long_real_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = create_deep_sockets_dir(tmp.path());

        // Create a short symlink to the deep directory
        let short_link = tmp.path().join("s");
        symlink(&deep, &short_link).unwrap();

        let short_path = short_link.join("kernel_test.sock");
        assert!(
            short_path.as_os_str().len() < MAX_SUN_PATH,
            "Short path should be within sun_path limit"
        );

        // This is the core assumption: bind() with the short path succeeds
        // even though the resolved real path exceeds MAX_SUN_PATH
        let listener = std::os::unix::net::UnixListener::bind(&short_path).unwrap();

        // Connect also works through the short symlinked path
        let _stream = std::os::unix::net::UnixStream::connect(&short_path).unwrap();

        // The socket physically exists at the long real path
        assert!(deep.join("kernel_test.sock").exists());

        drop(listener);
    }
}
