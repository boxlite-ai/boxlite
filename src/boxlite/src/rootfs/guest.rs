//! Guest rootfs types and metadata.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::disk::{
    BaseDisk, BaseDiskKind, BaseDiskManager, Disk, DiskFormat, create_ext4_from_dir,
    inject_file_into_ext4, read_backing_file_path,
};
use crate::runtime::constants::init_rootfs as init_rootfs_const;
#[cfg(test)]
use crate::runtime::id::BaseDiskID;
use crate::runtime::id::BaseDiskIDMint;
use crate::util;

/// A fully resolved and ready-to-use guest rootfs.
///
/// This struct represents the box's guest rootfs that runs boxlite-guest:
/// - Image pulled (if needed)
/// - Layers extracted/overlayed
/// - Guest binary injected and validated
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GuestRootfs {
    /// Path to the merged/final rootfs directory
    pub path: PathBuf,

    /// How this rootfs was prepared
    pub strategy: Strategy,

    /// Kernel images path (for Firecracker/microVM)
    pub kernel: Option<PathBuf>,

    /// Initrd path (optional)
    pub initrd: Option<PathBuf>,

    /// Environment variables from the init image config (e.g., PATH)
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

/// Strategy used to prepare the rootfs.
///
/// This tracks how the rootfs was assembled, which is important for:
/// - Cleanup logic (overlayfs mounts need unmounting)
/// - Debugging (understand which strategy was used)
/// - Performance metrics (compare overlay vs extraction)
#[derive(Clone, Debug, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub enum Strategy {
    /// Direct path provided by user (no processing needed)
    #[default]
    Direct,

    /// Layers extracted into a single directory
    ///
    /// Used on macOS (no overlayfs) and as fallback on Linux
    Extracted {
        /// Number of layers extracted
        layers: usize,
    },

    /// Linux overlayfs mount (requires cleanup on drop)
    ///
    /// This is the preferred strategy on Linux when CAP_SYS_ADMIN is available
    OverlayMount {
        /// Lower directories (read-only layers)
        lower: Vec<PathBuf>,
        /// Upper directory (writable layer)
        upper: PathBuf,
        /// Work directory (required by overlayfs)
        work: PathBuf,
    },

    /// Disk-based rootfs (ext4 disk image)
    ///
    /// The guest rootfs is stored in an ext4 disk image that the box boots from.
    /// This provides better performance than virtiofs for the guest rootfs.
    Disk {
        /// Path to the ext4 disk image
        disk_path: PathBuf,
        /// Device path in guest (e.g., "/dev/vdc").
        /// Set by build_disk_attachments when disks are configured.
        device_path: Option<String>,
    },
}

impl GuestRootfs {
    /// Create a new GuestRootfs, injecting the guest binary if needed.
    pub fn new(
        path: PathBuf,
        strategy: Strategy,
        kernel: Option<PathBuf>,
        initrd: Option<PathBuf>,
        env: Vec<(String, String)>,
    ) -> BoxliteResult<Self> {
        // Inject guest binary for directory-based strategies only.
        // For disk-based strategies, the guest binary was already included
        // during disk creation from the merged layers.
        match &strategy {
            Strategy::Disk { disk_path, .. } => {
                tracing::debug!(
                    "Skipping guest binary injection for disk-based rootfs: {}",
                    disk_path.display()
                );
            }
            _ => {
                crate::util::inject_guest_binary(&path)?;
            }
        }

        Ok(Self {
            path,
            strategy,
            kernel,
            initrd,
            env,
        })
    }

    /// Clean up this rootfs.
    ///
    /// Behavior depends on strategy:
    /// - `Direct`: No-op (user-provided path, don't delete)
    /// - `Extracted`: Remove the directory
    /// - `OverlayMount`: Unmount, then remove the directory
    ///
    /// Returns Ok(()) if cleanup succeeded or wasn't needed.
    pub fn cleanup(&self) -> BoxliteResult<()> {
        match &self.strategy {
            Strategy::Direct => {
                // User-provided path - don't clean up
                tracing::debug!(
                    "Skipping cleanup for direct rootfs: {}",
                    self.path.display()
                );
                Ok(())
            }
            Strategy::Extracted { layers } => {
                tracing::info!(
                    "Cleaning up extracted rootfs ({} layers): {}",
                    layers,
                    self.path.display()
                );
                // Remove parent directory (contains merged/)
                if let Some(parent) = self.path.parent() {
                    Self::remove_directory(parent)
                } else {
                    Self::remove_directory(&self.path)
                }
            }
            Strategy::OverlayMount { .. } => {
                tracing::info!("Cleaning up overlay mount: {}", self.path.display());

                #[cfg(target_os = "linux")]
                {
                    // Unmount overlay first
                    Self::unmount_overlay(&self.path)?;
                }

                // Remove parent directory (contains merged/, upper/, work/, patch/)
                if let Some(parent) = self.path.parent() {
                    Self::remove_directory(parent)
                } else {
                    Ok(())
                }
            }
            Strategy::Disk { disk_path, .. } => {
                // Disk-based rootfs: disk is managed by the cache, don't clean up
                tracing::debug!(
                    "Skipping cleanup for disk-based rootfs: {} (managed by cache)",
                    disk_path.display()
                );
                Ok(())
            }
        }
    }

    /// Unmount overlayfs (Linux only)
    #[cfg(target_os = "linux")]
    fn unmount_overlay(merged_dir: &Path) -> BoxliteResult<()> {
        if !merged_dir.exists() {
            return Ok(());
        }

        match std::process::Command::new("umount")
            .arg(merged_dir)
            .status()
        {
            Ok(status) if status.success() => {
                tracing::debug!("Unmounted overlay: {}", merged_dir.display());
                Ok(())
            }
            Ok(status) => {
                tracing::warn!(
                    "Failed to unmount overlay {}: exit status {}",
                    merged_dir.display(),
                    status
                );
                Err(BoxliteError::Storage(format!(
                    "umount failed with status {}",
                    status
                )))
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to execute umount for {}: {}",
                    merged_dir.display(),
                    e
                );
                Err(BoxliteError::Storage(format!(
                    "umount execution failed: {}",
                    e
                )))
            }
        }
    }

    /// Remove directory recursively
    fn remove_directory(path: &Path) -> BoxliteResult<()> {
        if let Err(e) = std::fs::remove_dir_all(path) {
            tracing::warn!(
                "Failed to cleanup rootfs directory {}: {}",
                path.display(),
                e
            );
            Err(BoxliteError::Storage(format!("cleanup failed: {}", e)))
        } else {
            tracing::info!("Cleaned up rootfs directory: {}", path.display());
            Ok(())
        }
    }
}

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
/// Cache location: `~/.boxlite/bases/`
///
/// Rootfs entries use `BaseDiskID` filenames (e.g., `bases/a7Kx9mPq.ext4`) and are
/// tracked in the `base_disk` table with `kind = 'rootfs'` and
/// `source_box_id = "__global__"`. The `name` field stores the version key
/// for content-addressable lookup.
pub struct GuestRootfsManager {
    base_disk_mgr: BaseDiskManager,
    temp_dir: PathBuf,
    guest_hash: OnceLock<Result<String, String>>,
}

/// Sentinel source_box_id for global rootfs cache entries.
const GLOBAL_SOURCE: &str = "__global__";

impl GuestRootfsManager {
    pub fn new(base_disk_mgr: BaseDiskManager, temp_dir: PathBuf) -> Self {
        Self {
            base_disk_mgr,
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

    /// Get or create the **init rootfs** — a self-contained ext4 disk that
    /// hosts `boxlite-guest` as PID 1, with no dependency on any external
    /// container image (no docker.io, no private registry, no network).
    ///
    /// This replaces the previous flow that pulled `debian:bookworm-slim`
    /// from docker.io; see issue #591 for the bug that motivated the change.
    /// debian provided ~95 MB of files that boxlite-guest never touched —
    /// libkrun mounts `/dev /proc /sys` itself before exec, and
    /// `boxlite-guest` auto-creates `/tmp /var/tmp /run` at startup. The
    /// only thing the rootfs has to carry is `/boxlite/bin/boxlite-guest`,
    /// which is injected via `inject_file_into_ext4` (and which mints its
    /// own `/boxlite/bin/` parent dirs via debugfs).
    ///
    /// Version key shape: `init-v{N}-{guest_hash_12}`. The schema version
    /// guards against future layout changes; the guest hash suffix lets the
    /// existing GC code in `gc_inner` preserve current-version entries.
    pub async fn get_or_create_init_rootfs(
        &self,
        env: Vec<(String, String)>,
    ) -> BoxliteResult<GuestRootfs> {
        let total_start = std::time::Instant::now();

        let guest_hash = self.cached_guest_hash()?;
        let expected_version_key = Self::init_version_key(guest_hash);

        if let Some(disk) = self.find(&expected_version_key) {
            tracing::info!(
                version_key = %expected_version_key,
                total_ms = total_start.elapsed().as_millis() as u64,
                "get_or_create_init_rootfs: CACHE HIT"
            );
            return Self::disk_to_guest_rootfs(disk, env);
        }

        tracing::info!(
            version_key = %expected_version_key,
            "get_or_create_init_rootfs: CACHE MISS — building from embedded template"
        );
        let disk = self.build_and_install_init(&expected_version_key).await?;

        tracing::info!(
            total_ms = total_start.elapsed().as_millis() as u64,
            cache_hit = false,
            "get_or_create_init_rootfs: completed"
        );

        Self::disk_to_guest_rootfs(disk, env)
    }

    /// Build the init rootfs from scratch and atomically install it.
    ///
    /// Mirrors `build_and_install` but skips Stage 1 (image disk) entirely —
    /// we run `mke2fs -d` over an empty directory to produce a fresh ext4
    /// image, then `inject_file_into_ext4` writes `boxlite-guest` into it.
    ///
    /// The guest-hash-mismatch handling mirrors `build_and_install` so a
    /// stale compile-time hash from `build.rs` does not corrupt the cache.
    async fn build_and_install_init(&self, expected_version_key: &str) -> BoxliteResult<Disk> {
        let build_start = std::time::Instant::now();

        // Empty source dir: libkrun creates /dev /proc /sys before exec,
        // boxlite-guest creates /tmp /var/tmp /run, inject creates /boxlite/bin.
        let temp = tempfile::tempdir_in(&self.temp_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp directory in {}: {}",
                self.temp_dir.display(),
                e
            ))
        })?;
        let source_dir = temp.path().join("init-rootfs-src");
        fs::create_dir(&source_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create init rootfs source dir {}: {}",
                source_dir.display(),
                e
            ))
        })?;

        let staged_path = temp.path().join("init-rootfs.ext4");

        let mkfs_start = std::time::Instant::now();
        let staged_disk = create_ext4_from_dir(&source_dir, &staged_path)?;
        tracing::info!(
            elapsed_ms = mkfs_start.elapsed().as_millis() as u64,
            "build_and_install_init: mke2fs done"
        );

        // Inject boxlite-guest binary; verify hash matches the version key.
        let inject_start = std::time::Instant::now();
        let guest_bin = util::find_binary("boxlite-guest")?;
        crate::vmm::guest_check::validate_guest_binary(&guest_bin)?;

        let actual_hash = Self::sha256_file(&guest_bin)?;
        let actual_version_key = Self::init_version_key(&actual_hash);

        if actual_version_key != expected_version_key {
            if option_env!("BOXLITE_GUEST_HASH").is_some() {
                return Err(BoxliteError::Internal(format!(
                    "Guest binary hash mismatch: compile-time key {} but actual key {}. \
                     Rebuild boxlite to fix.",
                    expected_version_key, actual_version_key
                )));
            }
            tracing::info!(
                expected = %expected_version_key,
                actual = %actual_version_key,
                "No compile-time hash, using actual guest hash"
            );
            // Race: another process may have produced the actual-key entry.
            if let Some(disk) = self.find(&actual_version_key) {
                return Ok(disk);
            }
        }

        inject_file_into_ext4(&staged_path, &guest_bin, "boxlite/bin/boxlite-guest")?;
        tracing::info!(
            elapsed_ms = inject_start.elapsed().as_millis() as u64,
            "build_and_install_init: inject guest binary done"
        );

        let result = self.install(&actual_version_key, staged_disk);

        tracing::info!(
            version_key = %actual_version_key,
            total_ms = build_start.elapsed().as_millis() as u64,
            "build_and_install_init: completed"
        );

        result
    }

    /// Compute the init rootfs version key.
    ///
    /// Format: `init-v{schema}-{guest_hash_12}`. The trailing `-{guest_12}`
    /// suffix matches the pattern recognized by `gc_inner`, so init entries
    /// produced for the current guest binary are preserved across GC.
    fn init_version_key(guest_hash: &str) -> String {
        let g = &guest_hash[..12.min(guest_hash.len())];
        format!("init-v{}-{}", init_rootfs_const::VERSION, g)
    }

    /// Convert a persistent `Disk` into a `GuestRootfs` with `Strategy::Disk`.
    ///
    /// Leaks the disk (prevents drop cleanup) since ownership transfers to
    /// the `OnceCell<GuestRootfs>` in the runtime.
    fn disk_to_guest_rootfs(disk: Disk, env: Vec<(String, String)>) -> BoxliteResult<GuestRootfs> {
        let disk_path = disk.path().to_path_buf();
        let _ = disk.leak();
        GuestRootfs::new(
            disk_path.clone(),
            Strategy::Disk {
                disk_path,
                device_path: None,
            },
            None,
            None,
            env,
        )
    }

    /// Look up a cached guest rootfs by version key (DB-backed).
    fn find(&self, version_key: &str) -> Option<Disk> {
        let record = self
            .base_disk_mgr
            .store()
            .find_by_name(GLOBAL_SOURCE, version_key)
            .ok()
            .flatten()?;
        let path = PathBuf::from(record.base_path());
        if path.exists() {
            Some(Disk::new(path, DiskFormat::Ext4, true))
        } else {
            tracing::warn!(
                version_key = %version_key,
                base_path = %record.base_path(),
                "DB record exists but file missing, removing stale record"
            );
            let _ = self.base_disk_mgr.store().delete(record.id());
            None
        }
    }

    /// Atomically install a staged guest rootfs to the bases directory.
    ///
    /// Generates a `BaseDiskID` filename and inserts a DB record for tracking.
    fn install(&self, version_key: &str, staged_disk: Disk) -> BoxliteResult<Disk> {
        // Defensive: another process may have installed while we were building.
        if let Some(disk) = self.find(version_key) {
            tracing::debug!(version_key = %version_key, "Guest rootfs already installed (race)");
            return Ok(disk);
        }

        let bases_dir = self.base_disk_mgr.bases_dir();
        fs::create_dir_all(bases_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create bases directory {}: {}",
                bases_dir.display(),
                e
            ))
        })?;

        let layer_id = BaseDiskIDMint::mint();
        let target = bases_dir.join(format!("{}.ext4", layer_id));
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

        // File size for the record.
        let size_bytes = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);

        let disk = BaseDisk {
            id: layer_id.clone(),
            source_box_id: GLOBAL_SOURCE.to_string(),
            name: Some(version_key.to_string()),
            kind: BaseDiskKind::Rootfs,
            disk_info: crate::disk::DiskInfo {
                base_path: target.to_string_lossy().to_string(),
                container_disk_bytes: 0,
                size_bytes,
            },
            created_at: chrono::Utc::now().timestamp(),
        };

        if let Err(e) = self.base_disk_mgr.store().insert(&disk) {
            // UNIQUE constraint violation means another process inserted first.
            // Clean up our file and return the existing entry.
            tracing::warn!(
                version_key = %version_key,
                error = %e,
                "DB insert failed (possible race), checking for existing entry"
            );
            let _ = fs::remove_file(&target);
            if let Some(disk) = self.find(version_key) {
                return Ok(disk);
            }
            return Err(e);
        }

        tracing::info!(
            layer_id = %layer_id,
            version_key = %version_key,
            path = %target.display(),
            "Installed guest rootfs to cache"
        );
        Ok(Disk::new(target, DiskFormat::Ext4, true))
    }

    /// Garbage-collect stale guest rootfs entries.
    ///
    /// Uses DB records to identify rootfs entries. Preserves entries whose
    /// version key contains the current guest binary hash (valid for future boxes).
    /// Only deletes entries with outdated guest hashes that no existing box references.
    ///
    /// Returns the number of entries removed.
    pub fn gc(&self, boxes_dir: &Path) -> BoxliteResult<usize> {
        let gc_start = std::time::Instant::now();

        // Compute current guest hash prefix to identify current-version entries.
        // Version keys are "{image_12}-{guest_12}", so entries whose name ends
        // with the current guest hash suffix are still valid for future boxes.
        let current_guest_suffix = match self.cached_guest_hash() {
            Ok(hash) => {
                let g = &hash[..12.min(hash.len())];
                format!("-{}", g)
            }
            Err(e) => {
                tracing::warn!("GC: cannot determine current guest hash, skipping: {}", e);
                return Ok(0);
            }
        };

        let result = self.gc_inner(boxes_dir, &current_guest_suffix);

        tracing::info!(
            elapsed_ms = gc_start.elapsed().as_millis() as u64,
            suffix = %current_guest_suffix,
            "GC completed"
        );

        result
    }

    /// Inner GC logic, separated for testability.
    ///
    /// Queries the DB for all rootfs entries, then determines which to keep:
    /// - Entries whose version key (name) ends with `current_guest_suffix`
    /// - Entries whose base_path is referenced by a box's `disks/guest-rootfs.qcow2`
    fn gc_inner(&self, boxes_dir: &Path, current_guest_suffix: &str) -> BoxliteResult<usize> {
        let records = self
            .base_disk_mgr
            .store()
            .list_by_box(GLOBAL_SOURCE, Some(BaseDiskKind::Rootfs))?;

        if records.is_empty() {
            return Ok(0);
        }

        // Collect all referenced backing file paths from box qcow2 overlays.
        let referenced = Self::collect_referenced_rootfs_paths(boxes_dir);

        tracing::info!(
            referenced_count = referenced.len(),
            total_records = records.len(),
            "gc_inner: scanned boxes for references"
        );

        let mut removed = 0;
        let mut preserved_current = 0;
        let mut preserved_referenced = 0;

        for record in &records {
            let base_path = PathBuf::from(record.base_path());
            let version_key = record.name().unwrap_or("");

            // Keep entries referenced by existing boxes
            if referenced.contains(&base_path) {
                preserved_referenced += 1;
                continue;
            }

            // Keep entries matching current guest binary version
            if version_key.ends_with(current_guest_suffix) {
                preserved_current += 1;
                tracing::debug!(
                    version_key = %version_key,
                    "GC: keeping current-version entry"
                );
                continue;
            }

            // Delete stale entries (old guest version, no box references)
            tracing::info!(
                id = %record.id(),
                version_key = %version_key,
                path = %record.base_path(),
                "GC: removing stale guest rootfs"
            );
            if let Err(e) = fs::remove_file(&base_path)
                && base_path.exists()
            {
                tracing::warn!("GC: failed to remove {}: {}", base_path.display(), e);
            }
            if let Err(e) = self.base_disk_mgr.store().delete(record.id()) {
                tracing::warn!("GC: failed to delete DB record {}: {}", record.id(), e);
            } else {
                removed += 1;
            }
        }

        tracing::info!(
            total_entries = records.len(),
            preserved_current,
            preserved_referenced,
            removed,
            "gc_inner: summary"
        );

        Ok(removed)
    }

    /// Collect all backing file paths referenced by boxes' guest-rootfs.qcow2 overlays.
    fn collect_referenced_rootfs_paths(boxes_dir: &Path) -> HashSet<PathBuf> {
        let mut referenced = HashSet::new();

        if !boxes_dir.exists() {
            return referenced;
        }

        let entries = match fs::read_dir(boxes_dir) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(
                    "GC: failed to read boxes dir {}: {}",
                    boxes_dir.display(),
                    e
                );
                return referenced;
            }
        };

        for entry in entries.flatten() {
            // Correct path: boxes/{box_id}/disks/guest-rootfs.qcow2
            let qcow2_path = entry.path().join("disks").join("guest-rootfs.qcow2");
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

        referenced
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::db::base_disk::BaseDiskStore;

    fn id(s: &str) -> BaseDiskID {
        BaseDiskID::parse(s).expect("test ID must be valid Base62 length-8")
    }

    fn test_store() -> BaseDiskStore {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.keep().join("test.db");
        let db = Database::open(&db_path).unwrap();
        BaseDiskStore::new(db)
    }

    fn make_mgr(bases_dir: PathBuf, temp_dir: PathBuf) -> GuestRootfsManager {
        let base_disk_mgr = BaseDiskManager::new(bases_dir, test_store());
        GuestRootfsManager::new(base_disk_mgr, temp_dir)
    }

    /// Insert a rootfs record directly for test setup.
    fn insert_rootfs_record(store: &BaseDiskStore, rootfs_id: &str, version_key: &str, path: &str) {
        store
            .insert(&BaseDisk {
                id: id(rootfs_id),
                source_box_id: GLOBAL_SOURCE.to_string(),
                name: Some(version_key.to_string()),
                kind: BaseDiskKind::Rootfs,
                disk_info: crate::disk::DiskInfo {
                    base_path: path.to_string(),
                    container_disk_bytes: 0,
                    size_bytes: 100,
                },
                created_at: chrono::Utc::now().timestamp(),
            })
            .unwrap();
    }

    #[test]
    fn test_init_version_key_format() {
        // The init rootfs version key encodes the schema version and a
        // 12-char prefix of the guest binary hash. The trailing
        // `-{guest_12}` suffix must match the pattern recognized by
        // `gc_inner` so current-version entries are preserved across GC.
        let key = GuestRootfsManager::init_version_key("fedcba987654321012345678");
        assert_eq!(key, "init-v1-fedcba987654");
        assert!(
            key.ends_with("-fedcba987654"),
            "GC pattern requires trailing -{{guest_12}} suffix"
        );
    }

    #[test]
    fn test_init_version_key_short_input() {
        let key = GuestRootfsManager::init_version_key("def");
        assert_eq!(key, "init-v1-def");
    }

    #[test]
    fn test_find_returns_none_for_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = make_mgr(dir.path().to_path_buf(), dir.path().to_path_buf());

        assert!(mgr.find("nonexistent-key").is_none());
    }

    #[test]
    fn test_find_returns_disk_for_existing_db_record() {
        let dir = tempfile::TempDir::new().unwrap();
        let bases_dir = dir.path().to_path_buf();
        let store = test_store();

        // Create a fake cached file with BaseDiskID name
        let cached = bases_dir.join("aB3xQ9mP.ext4");
        std::fs::write(&cached, "fake disk").unwrap();

        // Insert DB record mapping version_key → file path
        insert_rootfs_record(&store, "aB3xQ9mP", "test-version", cached.to_str().unwrap());

        let base_disk_mgr = BaseDiskManager::new(bases_dir, store);
        let mgr = GuestRootfsManager::new(base_disk_mgr, dir.path().to_path_buf());

        let disk = mgr.find("test-version");
        assert!(disk.is_some());
        let disk = disk.unwrap();
        assert_eq!(disk.path(), cached);
        assert_eq!(disk.format(), DiskFormat::Ext4);
        let _ = disk.leak();
    }

    #[test]
    fn test_find_returns_none_when_file_missing_despite_db_record() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = test_store();

        // Insert DB record but DON'T create the file
        insert_rootfs_record(
            &store,
            "aB3xQ9mP",
            "ghost-key",
            dir.path().join("ghost.ext4").to_str().unwrap(),
        );

        let base_disk_mgr = BaseDiskManager::new(dir.path().to_path_buf(), store.clone());
        let mgr = GuestRootfsManager::new(base_disk_mgr, dir.path().to_path_buf());
        assert!(mgr.find("ghost-key").is_none());

        // Stale DB record should have been deleted
        assert!(
            store
                .find_by_name(GLOBAL_SOURCE, "ghost-key")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn test_install_creates_bases_dir_and_moves_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let bases_dir = dir.path().join("bases");
        let store = test_store();
        let base_disk_mgr = BaseDiskManager::new(bases_dir.clone(), store.clone());
        let mgr = GuestRootfsManager::new(base_disk_mgr, dir.path().to_path_buf());

        // Create staged file
        let staged_path = dir.path().join("staged.ext4");
        std::fs::write(&staged_path, "staged disk content").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("ver-key", staged_disk).unwrap();

        // File should be in bases/ with .ext4 extension (BaseDiskID name)
        assert!(result.path().starts_with(&bases_dir));
        assert_eq!(result.path().extension().unwrap(), "ext4");
        assert!(result.path().exists());
        let stem = result.path().file_stem().unwrap().to_string_lossy();
        assert!(
            BaseDiskID::parse(&stem).is_some(),
            "rootfs filename should be valid BaseDiskID"
        );

        // DB record should exist
        let record = store.find_by_name(GLOBAL_SOURCE, "ver-key").unwrap();
        assert!(record.is_some());
        let record = record.unwrap();
        assert_eq!(record.kind(), BaseDiskKind::Rootfs);
        assert_eq!(record.base_path(), result.path().to_string_lossy());

        let _ = result.leak();
    }

    #[test]
    fn test_install_race_safe_returns_existing() {
        let dir = tempfile::TempDir::new().unwrap();
        let bases_dir = dir.path().join("bases");
        std::fs::create_dir_all(&bases_dir).unwrap();
        let store = test_store();

        // Pre-install via DB (simulating another process)
        let existing = bases_dir.join("first123.ext4");
        std::fs::write(&existing, "first install").unwrap();
        insert_rootfs_record(&store, "first123", "raced-key", existing.to_str().unwrap());

        let base_disk_mgr = BaseDiskManager::new(bases_dir, store);
        let mgr = GuestRootfsManager::new(base_disk_mgr, dir.path().to_path_buf());

        // Try to install again with same version_key
        let staged_path = dir.path().join("staged.ext4");
        std::fs::write(&staged_path, "second install").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("raced-key", staged_disk).unwrap();
        assert_eq!(result.path(), existing);

        // Original content preserved (first install wins)
        assert_eq!(
            std::fs::read_to_string(result.path()).unwrap(),
            "first install"
        );
        let _ = result.leak();
    }

    #[test]
    fn test_gc_removes_stale_entries() {
        let dir = tempfile::TempDir::new().unwrap();
        let bases_dir = dir.path().join("bases");
        let boxes_dir = dir.path().join("boxes");
        std::fs::create_dir_all(&bases_dir).unwrap();
        std::fs::create_dir_all(&boxes_dir).unwrap();

        let store = test_store();

        // Create entries with old guest hash via DB + filesystem
        let file1 = bases_dir.join("aaa11111.ext4");
        let file2 = bases_dir.join("bbb22222.ext4");
        std::fs::write(&file1, "old1").unwrap();
        std::fs::write(&file2, "old2").unwrap();
        insert_rootfs_record(
            &store,
            "aaa11111",
            "img123-oldguest1",
            file1.to_str().unwrap(),
        );
        insert_rootfs_record(
            &store,
            "bbb22222",
            "img456-oldguest2",
            file2.to_str().unwrap(),
        );

        let base_disk_mgr = BaseDiskManager::new(bases_dir, store);
        let mgr = GuestRootfsManager::new(base_disk_mgr, dir.path().to_path_buf());

        // No boxes reference anything, old guest hash → both removed
        let removed = mgr.gc_inner(&boxes_dir, "-currentguest").unwrap();
        assert_eq!(removed, 2);
        assert!(!file1.exists());
        assert!(!file2.exists());
    }

    #[test]
    fn test_gc_preserves_current_version_entries() {
        let dir = tempfile::TempDir::new().unwrap();
        let bases_dir = dir.path().join("bases");
        let boxes_dir = dir.path().join("boxes");
        std::fs::create_dir_all(&bases_dir).unwrap();
        std::fs::create_dir_all(&boxes_dir).unwrap();

        let store = test_store();

        // Current-version entry (version_key ends with current guest suffix)
        let current_file = bases_dir.join("ccc33333.ext4");
        std::fs::write(&current_file, "current version").unwrap();
        insert_rootfs_record(
            &store,
            "ccc33333",
            "img123-currentguest",
            current_file.to_str().unwrap(),
        );

        // Stale entry (old guest hash)
        let stale_file = bases_dir.join("ddd44444.ext4");
        std::fs::write(&stale_file, "old version").unwrap();
        insert_rootfs_record(
            &store,
            "ddd44444",
            "img123-oldguest",
            stale_file.to_str().unwrap(),
        );

        let base_disk_mgr = BaseDiskManager::new(bases_dir, store);
        let mgr = GuestRootfsManager::new(base_disk_mgr, dir.path().to_path_buf());

        let removed = mgr.gc_inner(&boxes_dir, "-currentguest").unwrap();
        assert_eq!(removed, 1);
        assert!(
            current_file.exists(),
            "Current-version entry should be kept"
        );
        assert!(!stale_file.exists(), "Stale entry should be removed");
    }

    #[test]
    fn test_gc_preserves_referenced_entries() {
        let dir = tempfile::TempDir::new().unwrap();
        let bases_dir = dir.path().join("bases");
        let boxes_dir = dir.path().join("boxes");
        std::fs::create_dir_all(&bases_dir).unwrap();

        let store = test_store();

        // Old-version entry referenced by a box (should survive)
        let referenced_file = bases_dir.join("eee55555.ext4");
        std::fs::write(&referenced_file, "keep me").unwrap();
        insert_rootfs_record(
            &store,
            "eee55555",
            "img123-oldguest",
            referenced_file.to_str().unwrap(),
        );

        // Old-version entry not referenced (should be deleted)
        let unreferenced_file = bases_dir.join("fff66666.ext4");
        std::fs::write(&unreferenced_file, "delete me").unwrap();
        insert_rootfs_record(
            &store,
            "fff66666",
            "img456-oldguest",
            unreferenced_file.to_str().unwrap(),
        );

        // Create a box with a qcow2 that references one of them.
        // Note: correct path is boxes/{box_id}/disks/guest-rootfs.qcow2
        let box_disks = boxes_dir.join("box-1").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        let qcow2_path = box_disks.join("guest-rootfs.qcow2");

        // Write a minimal qcow2 header with backing file pointing to referenced_file
        let backing_str = referenced_file.to_str().unwrap();
        let backing_bytes = backing_str.as_bytes();
        let mut buf = vec![0u8; 1024];
        buf[0..4].copy_from_slice(&0x514649fbu32.to_be_bytes()); // Magic
        buf[4..8].copy_from_slice(&3u32.to_be_bytes()); // Version
        buf[8..16].copy_from_slice(&512u64.to_be_bytes()); // Backing offset
        buf[16..20].copy_from_slice(&(backing_bytes.len() as u32).to_be_bytes());
        buf[512..512 + backing_bytes.len()].copy_from_slice(backing_bytes);
        std::fs::write(&qcow2_path, &buf).unwrap();

        let base_disk_mgr = BaseDiskManager::new(bases_dir, store);
        let mgr = GuestRootfsManager::new(base_disk_mgr, dir.path().to_path_buf());

        let removed = mgr.gc_inner(&boxes_dir, "-currentguest").unwrap();
        assert_eq!(removed, 1);
        assert!(referenced_file.exists(), "Referenced entry should be kept");
        assert!(
            !unreferenced_file.exists(),
            "Unreferenced stale entry should be removed"
        );
    }

    #[test]
    fn test_gc_no_records() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = make_mgr(dir.path().join("bases"), dir.path().to_path_buf());

        let removed = mgr.gc_inner(dir.path(), "-anything").unwrap();
        assert_eq!(removed, 0);
    }

    #[test]
    fn test_gc_no_boxes_dir() {
        let dir = tempfile::TempDir::new().unwrap();
        let bases_dir = dir.path().join("bases");
        std::fs::create_dir_all(&bases_dir).unwrap();

        let store = test_store();

        // Stale entry (doesn't match current suffix)
        let stale = bases_dir.join("ggg77777.ext4");
        std::fs::write(&stale, "orphan").unwrap();
        insert_rootfs_record(&store, "ggg77777", "img-oldguest", stale.to_str().unwrap());

        let base_disk_mgr = BaseDiskManager::new(bases_dir, store);
        let mgr = GuestRootfsManager::new(base_disk_mgr, dir.path().to_path_buf());

        let removed = mgr
            .gc_inner(&dir.path().join("nonexistent-boxes"), "-currentguest")
            .unwrap();
        assert_eq!(removed, 1);
    }
}
