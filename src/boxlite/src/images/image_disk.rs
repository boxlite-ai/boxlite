//! Image disk manager.
//!
//! Builds and caches pure ext4 disk images from OCI images.
//! These disks contain only image content (no guest binary).

use std::fs;
use std::path::PathBuf;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::disk::{Disk, DiskFormat, create_ext4_from_dir};
use crate::rootfs::RootfsBuilder;

use super::ImageObject;

/// Builds and caches ext4 disk images from OCI images.
///
/// Image disks are pure: only OCI image content, no guest binary injected.
/// Cache key is the image digest (SHA256 of layer digests).
///
/// Follows the staged install pattern: build in temp → atomic rename to cache.
/// No half-written files ever appear in the cache directory.
///
/// # Concurrency
///
/// Thread-safety is provided by the caller:
/// - Multi-process: `RuntimeLock` ensures single-process access per BOXLITE_HOME
/// - In-process: `OnceCell<GuestRootfs>` serializes all calls to `get_or_create()`
///
/// No internal locking is needed.
///
/// Cache location: `~/.boxlite/images/disk-images/`
pub struct ImageDiskManager {
    cache_dir: PathBuf,
    temp_dir: PathBuf,
}

impl ImageDiskManager {
    pub fn new(cache_dir: PathBuf, temp_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            temp_dir,
        }
    }

    /// Get or create an ext4 disk image for the given OCI image.
    ///
    /// Returns a persistent `Disk` (won't be cleaned up on drop).
    /// If a cached disk exists for this image digest, returns it immediately.
    /// Otherwise: extracts layers → creates ext4 → atomically installs to cache.
    pub async fn get_or_create(&self, image: &ImageObject) -> BoxliteResult<Disk> {
        let digest = image.compute_image_digest();

        if let Some(disk) = self.find(&digest) {
            tracing::debug!("Found cached image disk for {}", digest);
            return Ok(disk);
        }

        tracing::info!("Building image disk for {} (first time)", digest);
        self.build_and_install(image, &digest).await
    }

    /// Look up a cached disk by image digest.
    fn find(&self, digest: &str) -> Option<Disk> {
        let path = self.disk_path(digest);
        path.exists()
            .then(|| Disk::new(path, DiskFormat::Ext4, true))
    }

    /// Build ext4 from image layers and atomically install to cache.
    async fn build_and_install(&self, image: &ImageObject, digest: &str) -> BoxliteResult<Disk> {
        // All work happens in a temp directory (staged)
        let temp = tempfile::tempdir_in(&self.temp_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp directory in {}: {}",
                self.temp_dir.display(),
                e
            ))
        })?;

        // Extract image layers to merged directory
        let merged_path = temp.path().join("merged");
        let prepared = RootfsBuilder::new().prepare(merged_path, image).await?;

        // Create ext4 from merged directory (blocking I/O)
        let temp_disk_path = temp.path().join("image.ext4");
        let prepared_path = prepared.path.clone();
        let disk_clone = temp_disk_path.clone();
        let temp_disk =
            tokio::task::spawn_blocking(move || create_ext4_from_dir(&prepared_path, &disk_clone))
                .await
                .map_err(|e| {
                    BoxliteError::Internal(format!("Disk creation task failed: {}", e))
                })??;

        // Atomically install staged disk to cache
        self.install(digest, temp_disk)
    }

    /// Atomically install a staged disk to the cache directory.
    ///
    /// Takes ownership of the temp `Disk`, renames it to the final cache path,
    /// and returns a new persistent `Disk` pointing to the installed location.
    fn install(&self, digest: &str, staged_disk: Disk) -> BoxliteResult<Disk> {
        let target = self.disk_path(digest);

        // Defensive: target may already exist from a previous run
        if target.exists() {
            tracing::debug!("Image disk already exists: {}", target.display());
            return Ok(Disk::new(target, DiskFormat::Ext4, true));
        }

        fs::create_dir_all(&self.cache_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create disk image directory {}: {}",
                self.cache_dir.display(),
                e
            ))
        })?;

        let source = staged_disk.path().to_path_buf();

        // Atomic rename (same filesystem guaranteed by startup validation)
        fs::rename(&source, &target).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to install disk image from {} to {}: {}",
                source.display(),
                target.display(),
                e
            ))
        })?;

        // Prevent staged_disk from cleaning up the now-moved file
        let _ = staged_disk.leak();

        tracing::info!("Installed image disk to cache: {}", target.display());
        Ok(Disk::new(target, DiskFormat::Ext4, true))
    }

    /// Compute the cache path for a given image digest.
    ///
    /// Format matches `storage.rs:disk_image_path()`: `{digest}.ext4`
    fn disk_path(&self, digest: &str) -> PathBuf {
        let filename = digest.replace(':', "-");
        self.cache_dir.join(format!("{}.ext4", filename))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_disk_path_replaces_colon() {
        let mgr = ImageDiskManager::new(PathBuf::from("/cache/disk-images"), PathBuf::from("/tmp"));
        let path = mgr.disk_path("sha256:abc123def456");
        assert_eq!(
            path,
            PathBuf::from("/cache/disk-images/sha256-abc123def456.ext4")
        );
    }

    #[test]
    fn test_disk_path_no_colon() {
        let mgr = ImageDiskManager::new(PathBuf::from("/cache"), PathBuf::from("/tmp"));
        let path = mgr.disk_path("plaindigest");
        assert_eq!(path, PathBuf::from("/cache/plaindigest.ext4"));
    }

    #[test]
    fn test_find_returns_none_when_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = ImageDiskManager::new(dir.path().to_path_buf(), dir.path().to_path_buf());

        assert!(mgr.find("sha256:nonexistent").is_none());
    }

    #[test]
    fn test_find_returns_disk_when_cached() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = ImageDiskManager::new(dir.path().to_path_buf(), dir.path().to_path_buf());

        // Create a fake cached disk
        let cached = dir.path().join("sha256-abc123.ext4");
        std::fs::write(&cached, "fake disk").unwrap();

        let disk = mgr.find("sha256:abc123");
        assert!(disk.is_some());
        let disk = disk.unwrap();
        assert_eq!(disk.path(), cached);
        assert_eq!(disk.format(), DiskFormat::Ext4);
        let _ = disk.leak();
    }

    #[test]
    fn test_install_creates_dir_and_moves_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("disk-images");
        let mgr = ImageDiskManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Create staged file
        let staged_path = dir.path().join("staged.ext4");
        std::fs::write(&staged_path, "staged content").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("sha256:test", staged_disk).unwrap();
        let expected = cache_dir.join("sha256-test.ext4");

        assert!(expected.exists());
        assert_eq!(result.path(), expected);
        let _ = result.leak();
    }

    #[test]
    fn test_install_race_safe() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("disk-images");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let mgr = ImageDiskManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Pre-create target (another process won the race)
        let target = cache_dir.join("sha256-raced.ext4");
        std::fs::write(&target, "first").unwrap();

        // Try to install over it
        let staged_path = dir.path().join("staged.ext4");
        std::fs::write(&staged_path, "second").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("sha256:raced", staged_disk).unwrap();
        assert_eq!(result.path(), target);
        assert_eq!(std::fs::read_to_string(result.path()).unwrap(), "first");
        let _ = result.leak();
    }
}
