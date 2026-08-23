//! Embedded runtime: binaries compiled into the library, extracted on first use.
//!
//! The build.rs generates a manifest of (filename, mode, bytes) entries via `include_bytes!`.
//! On first access, [`EmbeddedRuntime`] extracts them to a version-stamped directory
//! under the platform's local data dir, then serves that directory to
//! [`RuntimeBinaryFinder`](crate::util::RuntimeBinaryFinder) for binary discovery.
//!
//! Every profile uses `~/.local/share/boxlite/runtimes/v{VERSION}-{COMMIT}-{HASH}/`,
//! where `{HASH}` is a 12-character SHA256 prefix of all embedded file contents
//! and `{COMMIT}` the git commit the build came from. The hash prevents
//! same-version builds with different assets from sharing a stale cache; the
//! commit lets a cache directory say which checkout produced it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

// Build.rs generates: pub const MANIFEST: &[(&str, u32, &[u8])] = &[...];
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
///      ├─ cleanup stale versions (disuse TTL: 7d release, 1h debug)
///      └─ Ok(Self { dir })
/// ```
pub struct EmbeddedRuntime {
    dir: PathBuf,
}

impl EmbeddedRuntime {
    /// Stale-cache TTL for release builds: cache reclaimed after this much disuse.
    const STALE_TTL_RELEASE: Duration = Duration::from_secs(7 * 24 * 3600);
    /// Stale-cache TTL for non-release (debug) builds.
    const STALE_TTL_DEBUG: Duration = Duration::from_secs(3600);

    /// TTL for a cache dir, classified from *its own* `.complete` stamp.
    ///
    /// The stamp's 2nd line records the build profile that created the dir, so
    /// retention follows the dir's origin — not the profile of whatever process
    /// happens to run cleanup (both profiles share one parent dir). An
    /// unreadable / legacy (version-only) / unrecognized stamp falls back to the
    /// longest TTL: never over-delete a cache we cannot positively classify.
    fn ttl_for_stamp(stamp: &Path) -> Duration {
        let profile = std::fs::read_to_string(stamp);
        match profile.as_deref().map(|s| s.lines().nth(1)) {
            Ok(Some("debug")) => Self::STALE_TTL_DEBUG,
            _ => Self::STALE_TTL_RELEASE,
        }
    }

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
        Self::extract_into(dir)
    }

    fn extract_into(dir: PathBuf) -> BoxliteResult<Self> {
        // Fast path: already extracted by this or a previous process.
        let stamp = dir.join(".complete");
        if stamp.exists() {
            if !Self::has_all_manifest_files(&dir) {
                tracing::warn!(
                    dir = %dir.display(),
                    "Embedded runtime cache is incomplete; re-extracting"
                );
                Self::quarantine_incomplete_cache(&dir)?;
                // Another process may have replaced the cache while this
                // process was quarantining the incomplete copy.
                if stamp.exists() && Self::has_all_manifest_files(&dir) {
                    let now = filetime::FileTime::now();
                    let _ = filetime::set_file_mtime(&stamp, now);
                    return Ok(Self { dir });
                }
            } else {
                // Refresh mtime so stale cleanup measures "last used", not "first extracted"
                let now = filetime::FileTime::now();
                let _ = filetime::set_file_mtime(&stamp, now);
                return Ok(Self { dir });
            }
        }

        // PID-scoped temp dir avoids collision between concurrent processes.
        let tmp = dir.with_extension(format!("extracting.{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp)
            .map_err(|e| BoxliteError::Storage(format!("mkdir {}: {}", tmp.display(), e)))?;

        for (name, mode, data) in MANIFEST {
            let path = tmp.join(name);
            std::fs::write(&path, data)
                .map_err(|e| BoxliteError::Storage(format!("write {}: {}", path.display(), e)))?;
            #[cfg(unix)]
            Self::set_permissions(&path, *mode)?;
        }

        // Stamp marks extraction as complete — checked by the fast path above.
        // Line 1: version (human-readable). Line 2: build profile, read back by
        // `ttl_for_stamp` so each dir is pruned by the TTL of the profile that
        // created it. `\n` separated; readers use `str::lines` (CRLF-tolerant).
        let stamp_body = format!("{}\n{}\n", crate::VERSION, env!("BOXLITE_BUILD_PROFILE"));
        std::fs::write(tmp.join(".complete"), stamp_body)
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
                std::fs::remove_dir_all(&tmp).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "remove losing extraction directory {}: {}",
                        tmp.display(),
                        e
                    ))
                })?;
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
        let now = SystemTime::now();

        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path == self.dir || !path.is_dir() {
                continue;
            }
            let stamp = path.join(".complete");
            let Ok(mtime) = std::fs::metadata(&stamp).and_then(|m| m.modified()) else {
                continue;
            };
            // Each dir is judged by the TTL of the profile that created it.
            let ttl = Self::ttl_for_stamp(&stamp);
            let is_stale = now.duration_since(mtime).is_ok_and(|age| age > ttl);
            if is_stale {
                tracing::info!(dir = %path.display(), "Removing stale embedded cache");
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────

    /// Check that a completed cache contains every file produced by this build.
    ///
    /// The completion stamp can survive a cache being populated by a different
    /// build variant, so the stamp alone is not sufficient to trust the fast
    /// path.
    fn has_all_manifest_files(dir: &Path) -> bool {
        MANIFEST.iter().all(|(name, _, _)| {
            std::fs::symlink_metadata(dir.join(name))
                .map(|metadata| metadata.file_type().is_file())
                .unwrap_or(false)
        })
    }

    /// Atomically move an invalid cache out of the shared path.
    ///
    /// Removing the directory in place would race with another process that
    /// has already accepted or is replacing the cache. Renaming it first
    /// leaves the shared path either untouched or absent, so a new extraction
    /// can be published with the existing atomic rename below.
    fn quarantine_incomplete_cache(dir: &Path) -> BoxliteResult<()> {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let quarantine = dir.with_extension(format!("invalid.{}.{}", std::process::id(), nonce));

        match std::fs::rename(dir, &quarantine) {
            Ok(()) => std::fs::remove_dir_all(&quarantine).map_err(|e| {
                BoxliteError::Storage(format!(
                    "remove quarantined embedded runtime {}: {}",
                    quarantine.display(),
                    e
                ))
            }),
            Err(_error) if !dir.exists() => Ok(()),
            Err(_) if Self::has_all_manifest_files(dir) => Ok(()),
            Err(error) => Err(BoxliteError::Storage(format!(
                "quarantine incomplete embedded runtime {}: {}",
                dir.display(),
                error
            ))),
        }
    }

    fn versioned_dir() -> BoxliteResult<PathBuf> {
        let data_dir = dirs::data_local_dir()
            .ok_or_else(|| BoxliteError::Storage("No local data directory".into()))?;

        let dir_name = Self::dir_name(
            crate::VERSION,
            boxlite_shared::GIT_COMMIT,
            env!("BOXLITE_MANIFEST_HASH"),
        );

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

    /// Cache directory name: `v{version}-{commit}-{manifest_hash}`.
    ///
    /// `manifest_hash` is what makes the name *correct* — rebuilding the same
    /// version with different runtime assets must not reuse a stale extracted
    /// cache. `commit` makes it *legible*: the directory otherwise cannot say
    /// which checkout produced it. A build with no commit to report keeps the
    /// two-segment name rather than carrying a placeholder.
    ///
    /// Including it does split the cache for byte-identical assets, which is
    /// the same cost the guest rootfs key refuses to pay. The trade differs
    /// because the split is bounded here and unbounded there: [`cleanup_stale`]
    /// reclaims these directories on a disuse TTL, whereas a rootfs base is
    /// retained for as long as any box overlay backs onto it, so a per-commit
    /// split would accumulate for the life of those boxes.
    ///
    /// [`cleanup_stale`]: Self::cleanup_stale
    fn dir_name(version: &str, commit: Option<&str>, manifest_hash: &str) -> String {
        match commit {
            Some(commit) => format!("v{}-{}-{}", version, commit, manifest_hash),
            None => format!("v{}-{}", version, manifest_hash),
        }
    }

    #[cfg(unix)]
    fn set_permissions(path: &Path, mode: u32) -> BoxliteResult<()> {
        use std::os::unix::fs::PermissionsExt;
        let mode = match mode & 0o777 {
            0 => 0o644,
            mode => mode,
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

        // Verify path structure: .../boxlite/runtimes/v{VERSION}-[{COMMIT}-]{HASH}
        assert!(
            dir_str.contains("boxlite/runtimes/"),
            "Expected path to contain boxlite/runtimes/, got {}",
            dir.display()
        );
        let dir_name = dir.file_name().unwrap().to_string_lossy();
        assert!(
            dir_name.starts_with(&format!("v{}-", crate::VERSION)),
            "Runtime dir should be version-stamped: {dir_name}"
        );
        assert!(
            dir_name.ends_with(env!("BOXLITE_MANIFEST_HASH")),
            "Runtime dir should include the manifest hash: {dir_name}"
        );
        // This checks only that a stamped commit reaches the directory name;
        // that the build script stamps one at all is guarded by boxlite-shared's
        // `commit_is_stamped_when_built_from_a_tracked_checkout`.
        if let Some(commit) = boxlite_shared::GIT_COMMIT {
            assert!(
                dir_name.contains(&format!("-{commit}-")),
                "Runtime dir should name the commit it was built from: {dir_name}"
            );
        }
    }

    #[test]
    fn dir_name_carries_the_commit() {
        assert_eq!(
            EmbeddedRuntime::dir_name("0.9.8", Some("ea34a8c4"), "4e5f6a7b8c9d"),
            "v0.9.8-ea34a8c4-4e5f6a7b8c9d"
        );
        assert_ne!(
            EmbeddedRuntime::dir_name("0.9.8", Some("ea34a8c4"), "4e5f6a7b8c9d"),
            EmbeddedRuntime::dir_name("0.9.8", Some("8103b2cb"), "4e5f6a7b8c9d"),
            "byte-identical assets from different commits must not share a cache dir"
        );
    }

    #[test]
    fn dir_name_without_a_commit_keeps_the_two_segment_form() {
        assert_eq!(
            EmbeddedRuntime::dir_name("0.9.8", None, "4e5f6a7b8c9d"),
            "v0.9.8-4e5f6a7b8c9d"
        );
    }

    #[test]
    fn incomplete_cache_is_not_accepted_as_complete() {
        if MANIFEST.is_empty() {
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("runtime");
        std::fs::create_dir(&cache).unwrap();
        std::fs::write(cache.join(".complete"), "complete\n").unwrap();

        let runtime = EmbeddedRuntime::extract_into(cache.clone()).unwrap();
        assert_eq!(runtime.dir(), cache);
        assert!(EmbeddedRuntime::has_all_manifest_files(runtime.dir()));
    }

    #[cfg(unix)]
    #[test]
    fn manifest_symlink_is_not_accepted_as_a_runtime_file() {
        if MANIFEST.is_empty() {
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let (name, _, data) = MANIFEST[0];
        let target = tmp.path().join("outside");
        std::fs::write(&target, data).unwrap();
        let linked = tmp.path().join(name);
        std::fs::create_dir_all(linked.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &linked).unwrap();

        assert!(!EmbeddedRuntime::has_all_manifest_files(tmp.path()));
    }

    #[test]
    fn incomplete_cache_is_quarantined_before_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("runtime");
        std::fs::create_dir(&cache).unwrap();
        std::fs::write(cache.join(".complete"), "complete\n").unwrap();

        EmbeddedRuntime::quarantine_incomplete_cache(&cache).unwrap();

        assert!(!cache.exists());
        assert!(!tmp.path().read_dir().unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("invalid.")
        }));
    }

    #[test]
    fn ttl_for_stamp_classifies_by_recorded_profile() {
        let tmp = tempfile::tempdir().unwrap();
        let stamp = tmp.path().join(".complete");

        std::fs::write(&stamp, format!("{}\ndebug\n", crate::VERSION)).unwrap();
        assert_eq!(
            EmbeddedRuntime::ttl_for_stamp(&stamp),
            EmbeddedRuntime::STALE_TTL_DEBUG,
            "debug-stamped dir must use the short TTL"
        );

        std::fs::write(&stamp, format!("{}\nrelease\n", crate::VERSION)).unwrap();
        assert_eq!(
            EmbeddedRuntime::ttl_for_stamp(&stamp),
            EmbeddedRuntime::STALE_TTL_RELEASE,
            "release-stamped dir must use the long TTL"
        );

        // Legacy (pre-change) stamp: version only, no profile line.
        std::fs::write(&stamp, crate::VERSION).unwrap();
        assert_eq!(
            EmbeddedRuntime::ttl_for_stamp(&stamp),
            EmbeddedRuntime::STALE_TTL_RELEASE,
            "legacy version-only stamp must fall back to the long TTL"
        );

        // Missing stamp: unclassifiable, must not be over-deleted.
        assert_eq!(
            EmbeddedRuntime::ttl_for_stamp(&tmp.path().join("absent")),
            EmbeddedRuntime::STALE_TTL_RELEASE,
            "unreadable stamp must fall back to the long TTL"
        );
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
            for (name, _, _) in MANIFEST {
                assert!(
                    runtime.dir().join(name).exists(),
                    "Expected {} to exist in cache",
                    name
                );
            }
        }
    }
}
