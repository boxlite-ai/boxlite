//! Guest rootfs manager.
//!
//! Manages versioned guest rootfs disks: image ext4 + injected boxlite-guest binary.
//! Old versions persist for existing boxes. GC removes unreferenced entries.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::disk::{Disk, DiskFormat, inject_file_into_ext4, read_backing_file_path};
use crate::images::{ImageDiskManager, ImageObject};
use crate::util;

/// Manages versioned guest rootfs disks.
///
/// A guest rootfs = pure image disk + injected `boxlite-guest` binary.
/// Version key = `{image_digest_short}-{guest_hash_short}`.
///
/// Old versions are kept alive as long as existing box qcow2 overlays
/// reference them. GC removes unreferenced entries on startup.
///
/// Follows the staged install pattern: copy to temp → inject → atomic rename.
///
/// # Concurrency
///
/// Thread-safety is provided by the caller:
/// - Multi-process: `RuntimeLock` ensures single-process access per BOXLITE_HOME
/// - In-process: `OnceCell<GuestRootfs>` serializes all calls to `get_or_create()`
/// - GC runs at startup (in `recover_boxes()`) before any box creation
///
/// No internal locking is needed.
///
/// Cache location: `~/.boxlite/rootfs/`
pub struct GuestRootfsManager {
    cache_dir: PathBuf,
    temp_dir: PathBuf,
    guest_hash: OnceLock<Result<String, String>>,
}

impl GuestRootfsManager {
    pub fn new(cache_dir: PathBuf, temp_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            temp_dir,
            guest_hash: OnceLock::new(),
        }
    }

    /// Get the cached guest binary hash, computing it once on first access.
    fn cached_guest_hash(&self) -> BoxliteResult<&str> {
        let cached = self
            .guest_hash
            .get_or_init(|| Self::guest_binary_hash().map_err(|e| e.to_string()));
        match cached {
            Ok(hash) => Ok(hash.as_str()),
            Err(msg) => Err(BoxliteError::Storage(msg.clone())),
        }
    }

    /// Get or create a versioned guest rootfs disk.
    ///
    /// Stage 1 (via `ImageDiskManager`): ensure pure image ext4 exists.
    /// Stage 2: copy image disk → inject guest binary via debugfs → cache.
    ///
    /// Returns a persistent `Disk` (won't be cleaned up on drop).
    pub async fn get_or_create(
        &self,
        image: &ImageObject,
        image_disk_mgr: &ImageDiskManager,
    ) -> BoxliteResult<Disk> {
        let total_start = std::time::Instant::now();

        // Stage 1: ensure pure image disk exists
        let stage1_start = std::time::Instant::now();
        let image_disk = image_disk_mgr.get_or_create(image).await?;
        tracing::info!(
            elapsed_ms = stage1_start.elapsed().as_millis() as u64,
            "get_or_create: stage1 image_disk done"
        );

        // Stage 2: versioned guest rootfs
        let digest = image.compute_image_digest();
        let hash_start = std::time::Instant::now();
        let guest_hash = self.cached_guest_hash()?;
        tracing::info!(
            elapsed_ms = hash_start.elapsed().as_millis() as u64,
            "get_or_create: cached_guest_hash done"
        );
        let version_key = Self::version_key(&digest, guest_hash);

        if let Some(disk) = self.find(&version_key) {
            tracing::info!(
                version_key = %version_key,
                total_ms = total_start.elapsed().as_millis() as u64,
                "get_or_create: CACHE HIT"
            );
            return Ok(disk);
        }

        tracing::info!(
            version_key = %version_key,
            "get_or_create: CACHE MISS — building guest rootfs"
        );
        let result = self
            .build_and_install(&image_disk, &digest, &version_key)
            .await;

        tracing::info!(
            total_ms = total_start.elapsed().as_millis() as u64,
            cache_hit = false,
            "get_or_create: completed"
        );

        result
    }

    /// Look up a cached guest rootfs by version key.
    fn find(&self, version_key: &str) -> Option<Disk> {
        let path = self.cache_path(version_key);
        path.exists()
            .then(|| Disk::new(path, DiskFormat::Ext4, true))
    }

    /// Build guest rootfs from image disk and atomically install.
    ///
    /// Verifies the actual guest binary hash against the expected version key.
    /// If the compile-time hash is stale, uses the actual hash for the version key.
    async fn build_and_install(
        &self,
        image_disk: &Disk,
        digest: &str,
        expected_version_key: &str,
    ) -> BoxliteResult<Disk> {
        let build_start = std::time::Instant::now();

        // Stage: copy image disk to temp, inject guest binary there
        let temp = tempfile::tempdir_in(&self.temp_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp directory in {}: {}",
                self.temp_dir.display(),
                e
            ))
        })?;
        let staged_path = temp.path().join("guest-rootfs.ext4");

        let copy_start = std::time::Instant::now();
        let copy_bytes = fs::copy(image_disk.path(), &staged_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to copy image disk {} to staged path {}: {}",
                image_disk.path().display(),
                staged_path.display(),
                e
            ))
        })?;
        tracing::info!(
            elapsed_ms = copy_start.elapsed().as_millis() as u64,
            size_mb = copy_bytes / (1024 * 1024),
            "build_and_install: copy image disk done"
        );

        // Inject guest binary into staged disk via debugfs
        let inject_start = std::time::Instant::now();
        let guest_bin = util::find_binary("boxlite-guest")?;

        // Verify the actual guest binary hash matches what we expected.
        // The compile-time hash (from build.rs) may be stale if the guest
        // binary was rebuilt after boxlite was compiled.
        let actual_hash = Self::sha256_file(&guest_bin)?;
        let actual_version_key = Self::version_key(digest, &actual_hash);

        if actual_version_key != expected_version_key {
            if option_env!("BOXLITE_GUEST_HASH").is_some() {
                // Compile-time hash exists but doesn't match the actual binary.
                // This means boxlite was compiled against a different guest binary
                // than what's found at runtime — an inconsistent build.
                return Err(BoxliteError::Internal(format!(
                    "Guest binary hash mismatch: compile-time key {} but actual key {}. \
                     Rebuild boxlite to fix.",
                    expected_version_key, actual_version_key
                )));
            }
            // No compile-time hash (fallback mode) — use actual hash
            tracing::info!(
                expected = %expected_version_key,
                actual = %actual_version_key,
                "No compile-time hash, using actual guest hash"
            );
            // Check cache with actual key — might already exist
            if let Some(disk) = self.find(&actual_version_key) {
                return Ok(disk);
            }
        }

        inject_file_into_ext4(&staged_path, &guest_bin, "boxlite/bin/boxlite-guest")?;
        tracing::info!(
            elapsed_ms = inject_start.elapsed().as_millis() as u64,
            "build_and_install: inject guest binary done"
        );

        // Atomic install: use the actual version key (may differ from expected)
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);
        let result = self.install(&actual_version_key, staged_disk);

        tracing::info!(
            version_key = %actual_version_key,
            total_ms = build_start.elapsed().as_millis() as u64,
            "build_and_install: completed"
        );

        result
    }

    /// Atomically install a staged guest rootfs to the cache directory.
    fn install(&self, version_key: &str, staged_disk: Disk) -> BoxliteResult<Disk> {
        let target = self.cache_path(version_key);

        // Defensive: target may already exist from a previous run
        if target.exists() {
            tracing::debug!("Guest rootfs already exists: {}", target.display());
            return Ok(Disk::new(target, DiskFormat::Ext4, true));
        }

        fs::create_dir_all(&self.cache_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create rootfs directory {}: {}",
                self.cache_dir.display(),
                e
            ))
        })?;

        let source = staged_disk.path().to_path_buf();

        // Atomic rename (same filesystem guaranteed by startup validation)
        fs::rename(&source, &target).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to install guest rootfs from {} to {}: {}",
                source.display(),
                target.display(),
                e
            ))
        })?;

        let _ = staged_disk.leak();

        tracing::info!("Installed guest rootfs to cache: {}", target.display());
        Ok(Disk::new(target, DiskFormat::Ext4, true))
    }

    /// Garbage-collect stale guest rootfs entries.
    ///
    /// Preserves entries matching the current guest binary version (they're valid
    /// for future boxes). Only deletes entries with outdated guest hashes that no
    /// existing box references.
    ///
    /// Returns the number of entries removed.
    pub fn gc(&self, boxes_dir: &Path) -> BoxliteResult<usize> {
        let gc_start = std::time::Instant::now();

        // Compute current guest hash suffix to identify current-version entries.
        // Cache filenames are "{image_12}-{guest_12}.ext4", so entries ending with
        // the current guest hash suffix are still valid for future boxes.
        let current_guest_suffix = match self.cached_guest_hash() {
            Ok(hash) => {
                let g = &hash[..12.min(hash.len())];
                format!("-{}.ext4", g)
            }
            Err(e) => {
                tracing::warn!("GC: cannot determine current guest hash, skipping: {}", e);
                return Ok(0);
            }
        };

        let result = self.gc_with_suffix(boxes_dir, &current_guest_suffix);

        tracing::info!(
            elapsed_ms = gc_start.elapsed().as_millis() as u64,
            suffix = %current_guest_suffix,
            "GC completed"
        );

        result
    }

    /// Inner GC logic, separated for testability.
    ///
    /// `current_guest_suffix` identifies current-version entries (e.g. "-8310374f82d7.ext4").
    /// Entries whose filename ends with this suffix are preserved.
    fn gc_with_suffix(&self, boxes_dir: &Path, current_guest_suffix: &str) -> BoxliteResult<usize> {
        if !self.cache_dir.exists() {
            return Ok(0);
        }

        // Collect all referenced backing file paths from box qcow2 overlays
        let mut referenced: HashSet<PathBuf> = HashSet::new();

        if boxes_dir.exists() {
            let entries = fs::read_dir(boxes_dir).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to read boxes directory {}: {}",
                    boxes_dir.display(),
                    e
                ))
            })?;

            for entry in entries {
                let entry = entry.map_err(|e| {
                    BoxliteError::Storage(format!("Failed to read box directory entry: {}", e))
                })?;

                let qcow2_path = entry.path().join("guest-rootfs.qcow2");
                if !qcow2_path.exists() {
                    continue;
                }

                match read_backing_file_path(&qcow2_path) {
                    Ok(Some(backing_path)) => {
                        referenced.insert(PathBuf::from(backing_path));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        tracing::warn!(
                            "Failed to read backing file from {}: {}",
                            qcow2_path.display(),
                            e
                        );
                    }
                }
            }
        }

        tracing::info!(
            referenced_count = referenced.len(),
            cache_dir = %self.cache_dir.display(),
            "gc_with_suffix: scanned boxes for references"
        );

        // Remove stale entries: old guest version AND not referenced by any box
        let mut removed = 0;
        let mut preserved_current = 0;
        let mut preserved_referenced = 0;
        let mut total_entries = 0;

        let cache_entries = fs::read_dir(&self.cache_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read rootfs cache directory {}: {}",
                self.cache_dir.display(),
                e
            ))
        })?;

        for entry in cache_entries {
            let entry = entry.map_err(|e| {
                BoxliteError::Storage(format!("Failed to read rootfs cache entry: {}", e))
            })?;

            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            total_entries += 1;

            // Keep entries referenced by existing boxes
            if referenced.contains(&path) {
                preserved_referenced += 1;
                continue;
            }

            // Keep entries matching current guest binary version
            let filename = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
            if filename.ends_with(current_guest_suffix) {
                preserved_current += 1;
                tracing::debug!("GC: keeping current-version entry: {}", path.display());
                continue;
            }

            // Delete stale entries (old guest version, no box references)
            tracing::info!("GC: removing stale guest rootfs: {}", path.display());
            if let Err(e) = fs::remove_file(&path) {
                tracing::warn!("GC: failed to remove {}: {}", path.display(), e);
            } else {
                removed += 1;
            }
        }

        tracing::info!(
            total_entries,
            preserved_current,
            preserved_referenced,
            removed,
            "gc_with_suffix: summary"
        );

        Ok(removed)
    }

    /// Compute SHA256 hash of the boxlite-guest binary.
    ///
    /// Uses compile-time hash (embedded by build.rs) when available,
    /// falling back to runtime computation.
    fn guest_binary_hash() -> BoxliteResult<String> {
        // Fast path: use compile-time hash embedded by build.rs
        if let Some(hash) = option_env!("BOXLITE_GUEST_HASH") {
            tracing::info!(
                hash_prefix = &hash[..12.min(hash.len())],
                "guest_binary_hash: using compile-time hash"
            );
            return Ok(hash.to_string());
        }

        let guest_bin = util::find_binary("boxlite-guest")?;
        Self::sha256_file(&guest_bin)
    }

    /// Compute SHA256 hex digest of a file.
    fn sha256_file(path: &Path) -> BoxliteResult<String> {
        use sha2::{Digest, Sha256};
        use std::io::Read;

        let start = std::time::Instant::now();
        let mut file = fs::File::open(path).map_err(|e| {
            BoxliteError::Storage(format!("Failed to open {}: {}", path.display(), e))
        })?;

        let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);

        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buffer).map_err(|e| {
                BoxliteError::Storage(format!("Failed to read {}: {}", path.display(), e))
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }

        let hash = format!("{:x}", hasher.finalize());
        tracing::info!(
            path = %path.display(),
            size_mb = file_size / (1024 * 1024),
            elapsed_ms = start.elapsed().as_millis() as u64,
            hash_prefix = &hash[..12.min(hash.len())],
            "sha256_file computed"
        );

        Ok(hash)
    }

    /// Compute the version key from image digest and guest binary hash.
    fn version_key(digest: &str, guest_hash: &str) -> String {
        let d = digest.strip_prefix("sha256:").unwrap_or(digest);
        let d = &d[..12.min(d.len())];
        let g = &guest_hash[..12.min(guest_hash.len())];
        format!("{}-{}", d, g)
    }

    /// Compute the cache path for a given version key.
    fn cache_path(&self, version_key: &str) -> PathBuf {
        self.cache_dir.join(format!("{}.ext4", version_key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_key_strips_sha256_prefix() {
        let key = GuestRootfsManager::version_key(
            "sha256:abcdef123456789012345678",
            "fedcba987654321012345678",
        );
        // First 12 chars of digest (without sha256: prefix) + first 12 chars of guest hash
        assert_eq!(key, "abcdef123456-fedcba987654");
    }

    #[test]
    fn test_version_key_no_prefix() {
        let key = GuestRootfsManager::version_key("abcdef123456789012", "111222333444555666");
        assert_eq!(key, "abcdef123456-111222333444");
    }

    #[test]
    fn test_version_key_short_inputs() {
        let key = GuestRootfsManager::version_key("abc", "def");
        assert_eq!(key, "abc-def");
    }

    #[test]
    fn test_cache_path() {
        let mgr = GuestRootfsManager::new(
            PathBuf::from("/home/user/.boxlite/rootfs"),
            PathBuf::from("/tmp"),
        );
        let path = mgr.cache_path("abc123-def456");
        assert_eq!(
            path,
            PathBuf::from("/home/user/.boxlite/rootfs/abc123-def456.ext4")
        );
    }

    #[test]
    fn test_find_returns_none_for_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = GuestRootfsManager::new(dir.path().to_path_buf(), dir.path().to_path_buf());

        assert!(mgr.find("nonexistent-key").is_none());
    }

    #[test]
    fn test_find_returns_disk_for_existing() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = GuestRootfsManager::new(dir.path().to_path_buf(), dir.path().to_path_buf());

        // Create a fake cached file
        let cached = dir.path().join("test-version.ext4");
        std::fs::write(&cached, "fake disk").unwrap();

        let disk = mgr.find("test-version");
        assert!(disk.is_some());
        let disk = disk.unwrap();
        assert_eq!(disk.path(), cached);
        assert_eq!(disk.format(), DiskFormat::Ext4);
        // Leak to prevent cleanup of our test file
        let _ = disk.leak();
    }

    #[test]
    fn test_install_creates_cache_dir_and_moves_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("rootfs");
        let mgr = GuestRootfsManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Create staged file
        let staged_path = dir.path().join("staged.ext4");
        std::fs::write(&staged_path, "staged disk content").unwrap();
        let staged_disk = Disk::new(staged_path.clone(), DiskFormat::Ext4, false);

        let result = mgr.install("ver-key", staged_disk).unwrap();
        let expected_target = cache_dir.join("ver-key.ext4");

        assert!(expected_target.exists());
        assert_eq!(result.path(), expected_target);
        // Leak to prevent cleanup
        let _ = result.leak();
    }

    #[test]
    fn test_install_race_safe_returns_existing() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("rootfs");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let mgr = GuestRootfsManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Pre-create the target (simulating another process)
        let target = cache_dir.join("raced-key.ext4");
        std::fs::write(&target, "first install").unwrap();

        // Try to install over it
        let staged_path = dir.path().join("staged.ext4");
        std::fs::write(&staged_path, "second install").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("raced-key", staged_disk).unwrap();
        assert_eq!(result.path(), target);

        // Original content should be preserved (first install wins)
        assert_eq!(
            std::fs::read_to_string(result.path()).unwrap(),
            "first install"
        );
        let _ = result.leak();
    }

    #[test]
    fn test_gc_removes_stale_entries() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("rootfs");
        let boxes_dir = dir.path().join("boxes");
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::create_dir_all(&boxes_dir).unwrap();

        let mgr = GuestRootfsManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Create entries with old guest hash (doesn't match current suffix)
        std::fs::write(cache_dir.join("img123-oldguest1.ext4"), "old").unwrap();
        std::fs::write(cache_dir.join("img456-oldguest2.ext4"), "old").unwrap();

        // No boxes reference anything, old guest hash → both removed
        let removed = mgr
            .gc_with_suffix(&boxes_dir, "-currentguest.ext4")
            .unwrap();
        assert_eq!(removed, 2);
        assert!(!cache_dir.join("img123-oldguest1.ext4").exists());
        assert!(!cache_dir.join("img456-oldguest2.ext4").exists());
    }

    #[test]
    fn test_gc_preserves_current_version_entries() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("rootfs");
        let boxes_dir = dir.path().join("boxes");
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::create_dir_all(&boxes_dir).unwrap();

        let mgr = GuestRootfsManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Current-version entry (matches suffix)
        let current = cache_dir.join("img123-currentguest.ext4");
        std::fs::write(&current, "current version").unwrap();
        // Stale entry (old guest hash)
        let stale = cache_dir.join("img123-oldguest.ext4");
        std::fs::write(&stale, "old version").unwrap();

        // No boxes → stale deleted, current preserved
        let removed = mgr
            .gc_with_suffix(&boxes_dir, "-currentguest.ext4")
            .unwrap();
        assert_eq!(removed, 1);
        assert!(current.exists(), "Current-version entry should be kept");
        assert!(!stale.exists(), "Stale entry should be removed");
    }

    #[test]
    fn test_gc_preserves_referenced_entries() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("rootfs");
        let boxes_dir = dir.path().join("boxes");
        std::fs::create_dir_all(&cache_dir).unwrap();

        let mgr = GuestRootfsManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Old-version entry referenced by a box (should survive)
        let referenced_path = cache_dir.join("img123-oldguest.ext4");
        std::fs::write(&referenced_path, "keep me").unwrap();
        // Old-version entry not referenced (should be deleted)
        let unreferenced_path = cache_dir.join("img456-oldguest.ext4");
        std::fs::write(&unreferenced_path, "delete me").unwrap();

        // Create a box with a qcow2 that references one of them
        let box_dir = boxes_dir.join("box-1");
        std::fs::create_dir_all(&box_dir).unwrap();
        let qcow2_path = box_dir.join("guest-rootfs.qcow2");

        // Write a minimal qcow2 header with backing file pointing to referenced_path
        let backing_str = referenced_path.to_str().unwrap();
        let backing_bytes = backing_str.as_bytes();
        let mut buf = vec![0u8; 1024];
        // Magic
        buf[0..4].copy_from_slice(&0x514649fbu32.to_be_bytes());
        // Version
        buf[4..8].copy_from_slice(&3u32.to_be_bytes());
        // Backing offset
        buf[8..16].copy_from_slice(&512u64.to_be_bytes());
        // Backing size
        buf[16..20].copy_from_slice(&(backing_bytes.len() as u32).to_be_bytes());
        // Backing path at offset 512
        buf[512..512 + backing_bytes.len()].copy_from_slice(backing_bytes);
        std::fs::write(&qcow2_path, &buf).unwrap();

        let removed = mgr
            .gc_with_suffix(&boxes_dir, "-currentguest.ext4")
            .unwrap();
        assert_eq!(removed, 1);
        assert!(referenced_path.exists(), "Referenced entry should be kept");
        assert!(
            !unreferenced_path.exists(),
            "Unreferenced stale entry should be removed"
        );
    }

    #[test]
    fn test_gc_no_cache_dir() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = GuestRootfsManager::new(dir.path().join("nonexistent"), dir.path().to_path_buf());

        let removed = mgr.gc_with_suffix(dir.path(), "-anything.ext4").unwrap();
        assert_eq!(removed, 0);
    }

    #[test]
    fn test_gc_no_boxes_dir() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("rootfs");
        std::fs::create_dir_all(&cache_dir).unwrap();
        // Stale entry (doesn't match current suffix)
        std::fs::write(cache_dir.join("img-oldguest.ext4"), "orphan").unwrap();

        let mgr = GuestRootfsManager::new(cache_dir.clone(), dir.path().to_path_buf());

        let removed = mgr
            .gc_with_suffix(&dir.path().join("nonexistent-boxes"), "-currentguest.ext4")
            .unwrap();
        assert_eq!(removed, 1);
    }
}
