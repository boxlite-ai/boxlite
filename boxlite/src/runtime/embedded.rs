//! Embedded runtime: binaries compiled into the library, extracted on first use.
//!
//! The build.rs generates a manifest of (filename, bytes) pairs via `include_bytes!`.
//! On first access, [`EmbeddedRuntime`] extracts them to a version-stamped directory
//! under the platform's local data dir, then serves that directory to
//! [`RuntimeBinaryFinder`](crate::util::RuntimeBinaryFinder) for binary discovery.
//!
//! The extraction path depends on the build profile:
//! - **Release**: `~/.local/share/boxlite/runtimes/v{VERSION}/` — clean, predictable
//!   paths for published packages where all users on the same version have identical binaries.
//! - **Debug**: `~/.local/share/boxlite/runtimes/v{VERSION}-{HASH}/` — the `{HASH}` suffix
//!   is a 12-char SHA256 prefix of all embedded file contents, ensuring cache invalidation
//!   when binaries change during development without a version bump.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

// Build.rs generates: pub const MANIFEST: &[(&str, &[u8])] = &[...];
include!(concat!(env!("OUT_DIR"), "/embedded_manifest.rs"));

/// Embedded runtime binary cache.
///
/// Holds the path to the extracted cache directory. Created once via
/// [`get()`](Self::get) and reused for the process lifetime.
///
/// # Lifecycle
///
/// ```text
/// EmbeddedRuntime::get()
///   ├─ manifest empty? → None
///   ├─ already extracted? → Ok(Self { dir })
///   └─ extract to {dir}.extracting.{pid}/
///      ├─ write all files + .complete stamp
///      ├─ atomic rename → dir
///      ├─ cleanup stale versions (TTL 30d)
///      └─ Ok(Self { dir })
/// ```
pub struct EmbeddedRuntime {
    dir: PathBuf,
}

impl EmbeddedRuntime {
    /// Stale cache directories older than this are deleted after extraction.
    const STALE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

    /// Get the embedded runtime, extracting on first call.
    ///
    /// Returns `None` if no files are embedded (feature off) or extraction fails.
    /// Thread-safe: concurrent callers block on `OnceLock`; only one extracts.
    pub fn get() -> Option<&'static Self> {
        static INSTANCE: OnceLock<Option<EmbeddedRuntime>> = OnceLock::new();
        INSTANCE.get_or_init(Self::init).as_ref()
    }

    /// Directory containing the extracted runtime binaries.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    // ── Initialization ──────────────────────────────────────────────

    fn init() -> Option<Self> {
        if MANIFEST.is_empty() {
            return None;
        }
        match Self::extract() {
            Ok(runtime) => {
                runtime.cleanup_stale();
                Some(runtime)
            }
            Err(e) => {
                tracing::warn!("Embedded runtime extraction failed: {}", e);
                None
            }
        }
    }

    // ── Extraction ──────────────────────────────────────────────────

    fn extract() -> BoxliteResult<Self> {
        let dir = Self::versioned_dir()?;

        // Fast path: already extracted by this or a previous process.
        let stamp = dir.join(".complete");
        if stamp.exists() {
            // Refresh mtime so stale cleanup measures "last used", not "first extracted"
            let now = filetime::FileTime::now();
            let _ = filetime::set_file_mtime(&stamp, now);
            return Ok(Self { dir });
        }

        // PID-scoped temp dir avoids collision between concurrent processes.
        let tmp = dir.with_extension(format!("extracting.{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp)
            .map_err(|e| BoxliteError::Storage(format!("mkdir {}: {}", tmp.display(), e)))?;

        for (name, data) in MANIFEST {
            let path = tmp.join(name);
            std::fs::write(&path, data)
                .map_err(|e| BoxliteError::Storage(format!("write {}: {}", path.display(), e)))?;
            #[cfg(unix)]
            Self::set_permissions(&path, name)?;
        }

        // Stamp marks extraction as complete — checked by the fast path above.
        std::fs::write(tmp.join(".complete"), crate::VERSION)
            .map_err(|e| BoxliteError::Storage(format!("write stamp: {}", e)))?;

        // Atomic rename: loser detects winner's dir and cleans up.
        match std::fs::rename(&tmp, &dir) {
            Ok(()) => {
                tracing::info!(
                    dir = %dir.display(),
                    files = MANIFEST.len(),
                    manifest_hash = env!("BOXLITE_MANIFEST_HASH"),
                    "Extracted embedded runtime"
                );
            }
            Err(_) if dir.join(".complete").exists() => {
                let _ = std::fs::remove_dir_all(&tmp);
                tracing::debug!("Embedded runtime already extracted by another process");
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(BoxliteError::Storage(format!(
                    "rename {} → {}: {}",
                    tmp.display(),
                    dir.display(),
                    e
                )));
            }
        }

        Ok(Self { dir })
    }

    // ── Cache management ────────────────────────────────────────────

    /// Remove version directories whose `.complete` stamp is older than TTL.
    /// Best-effort: errors are logged, never propagated.
    fn cleanup_stale(&self) {
        let Some(parent) = self.dir.parent() else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(parent) else {
            return;
        };
        let cutoff = SystemTime::now() - Self::STALE_TTL;

        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path == self.dir || !path.is_dir() {
                continue;
            }
            let stamp = path.join(".complete");
            let is_stale = std::fs::metadata(&stamp)
                .and_then(|m| m.modified())
                .is_ok_and(|mtime| mtime < cutoff);
            if is_stale {
                tracing::info!(dir = %path.display(), "Removing stale embedded cache");
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────

    fn versioned_dir() -> BoxliteResult<PathBuf> {
        let data_dir = dirs::data_local_dir()
            .ok_or_else(|| BoxliteError::Storage("No local data directory".into()))?;

        // Release builds use clean version paths (all users on same version have identical
        // binaries). Debug builds include the manifest hash for cache invalidation during
        // development when binaries change without a version bump.
        let dir_name = if env!("BOXLITE_BUILD_PROFILE") == "release" {
            format!("v{}", crate::VERSION)
        } else {
            format!("v{}-{}", crate::VERSION, env!("BOXLITE_MANIFEST_HASH"))
        };

        let dir = data_dir.join("boxlite").join("runtimes").join(dir_name);
        let parent = dir.parent().ok_or_else(|| {
            BoxliteError::Storage(format!(
                "Embedded runtime path has no parent: {}",
                dir.display()
            ))
        })?;
        std::fs::create_dir_all(parent)
            .map_err(|e| BoxliteError::Storage(format!("mkdir {}: {}", parent.display(), e)))?;
        Ok(dir)
    }

    /// Known executable binary names that should get 0o755.
    /// Everything else (shared libraries) gets 0o644.
    const EXECUTABLES: &[&str] = &["boxlite-shim", "boxlite-guest", "mke2fs", "debugfs"];

    #[cfg(unix)]
    fn set_permissions(path: &Path, name: &str) -> BoxliteResult<()> {
        use std::os::unix::fs::PermissionsExt;
        let mode = if Self::EXECUTABLES.contains(&name) {
            0o755
        } else {
            0o644
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|e| {
            BoxliteError::Storage(format!("chmod {:o} {}: {}", mode, path.display(), e))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_available() {
        // MANIFEST is always defined (may be empty when feature is off)
        let _ = MANIFEST.len();
    }

    #[test]
    fn versioned_dir_uses_data_local_dir() {
        let dir = EmbeddedRuntime::versioned_dir().unwrap();
        let dir_str = dir.to_string_lossy();

        // Verify path structure: .../boxlite/runtimes/v{VERSION}[-{HASH}]
        assert!(
            dir_str.contains("boxlite/runtimes/"),
            "Expected path to contain boxlite/runtimes/, got {}",
            dir.display()
        );
        let dir_name = dir.file_name().unwrap().to_string_lossy();
        assert!(
            dir_name.starts_with(&format!("v{}", crate::VERSION)),
            "Expected dir to start with v{}, got {}",
            crate::VERSION,
            dir.display()
        );

        // Debug builds include manifest hash suffix for cache invalidation
        if env!("BOXLITE_BUILD_PROFILE") != "release" {
            let expected = format!("v{}-{}", crate::VERSION, env!("BOXLITE_MANIFEST_HASH"));
            assert_eq!(
                dir_name, expected,
                "Debug build dir should include hash suffix"
            );
        }
    }

    #[test]
    fn extraction_creates_complete_stamp() {
        if MANIFEST.is_empty() {
            // Nothing to extract when feature is off — skip
            return;
        }
        // Exercise the full extraction path
        if let Some(runtime) = EmbeddedRuntime::get() {
            assert!(runtime.dir().join(".complete").exists());
            // Verify all manifest entries were extracted
            for (name, _) in MANIFEST {
                assert!(
                    runtime.dir().join(name).exists(),
                    "Expected {} to exist in cache",
                    name
                );
            }
        }
    }
}
