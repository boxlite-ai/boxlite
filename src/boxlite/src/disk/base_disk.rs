//! Base disk management — fork-point tracking for clone bases and rootfs cache.
//!
//! `BaseDiskManager` creates, tracks, and cleans up immutable base disks
//! (fork points) for clone operations. Snapshots have their own manager
//! (`SnapshotManager` in `litebox/snapshot_mgr.rs`).
//!
//! # Flat File Layout
//!
//! All backing files live as flat files in `bases/` with Base62 8-char IDs:
//! - `bases/{base_disk_id}.qcow2` — clone base container disk
//!
//! # DB-Based Ref Tracking
//!
//! Box→base dependencies are tracked in the `base_disk_ref` table.
//! `try_gc_base()` queries the DB to determine if a clone base has any
//! dependents. If none exist, the base is deleted and GC cascades to the
//! parent base disk.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

use crate::db::base_disk::BaseDiskStore;
use crate::runtime::id::{BaseDiskID, BaseDiskIDMint};

// ============================================================================
// Domain Types
// ============================================================================

/// Kind of base disk — determines lifecycle rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BaseDiskKind {
    /// User-named snapshot. NOT auto-deleted by GC.
    Snapshot,
    /// Clone base. Auto-deleted via index-find GC when no dependents exist.
    CloneBase,
    /// Global guest rootfs cache (`source_box_id = "__global__"`).
    Rootfs,
}

impl BaseDiskKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::CloneBase => "clone_base",
            Self::Rootfs => "rootfs",
        }
    }
}

/// Base disk data (serialized to JSON blob in the database).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseDisk {
    pub id: BaseDiskID,
    pub source_box_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub kind: BaseDiskKind,
    #[serde(flatten)]
    pub disk_info: super::DiskInfo,
    pub created_at: i64,
}
use crate::disk::constants::filenames as disk_filenames;

/// Manages the lifecycle of clone base disks.
///
/// All base disks are flat files under `bases_dir/` named by `BaseDiskID`.
/// Clone operations use `create_base_disk()` for the rename-and-COW operation.
///
/// Cleanup uses DB-based ref tracking: `try_gc_base()` queries the
/// `base_disk_ref` table to check for dependents before deleting.
#[derive(Clone)]
pub(crate) struct BaseDiskManager {
    bases_dir: PathBuf,
    store: BaseDiskStore,
}

impl BaseDiskManager {
    /// How long a base file must sit untouched before the orphan sweep may
    /// consider it. Covers the window between `install`'s rename and its insert.
    const ORPHAN_GRACE: Duration = Duration::from_secs(300);

    pub(crate) fn new(bases_dir: PathBuf, store: BaseDiskStore) -> Self {
        // Canonicalize once at construction so all path comparisons are consistent
        // with the canonical backing paths written by write_cow_child_header().
        let bases_dir = bases_dir
            .canonicalize()
            .unwrap_or_else(|_| bases_dir.clone());
        Self { bases_dir, store }
    }

    /// Expose the underlying store for direct queries (list, find, etc.).
    pub(crate) fn store(&self) -> &BaseDiskStore {
        &self.store
    }

    /// The bases root directory.
    #[allow(dead_code)] // used in tests
    pub(crate) fn bases_dir(&self) -> &Path {
        &self.bases_dir
    }

    /// Every base file something still depends on, following chains to the end.
    ///
    /// Three dimensions have to be covered or live data becomes reachable:
    /// - **Both** overlays a box owns — `disk.qcow2`, backed by a clone base or
    ///   snapshot, and `guest-rootfs.qcow2`, backed by a rootfs base. Reading one
    ///   makes live bases of the other kind look unclaimed.
    /// - The **full** chain, not just the immediate backing file, since clone
    ///   bases nest (see `find_parent_base` and `try_gc_base`'s parent cascade).
    /// - Chains rooted at the **bases themselves**, not only at box overlays. A
    ///   clone base points at its parent (`test_create_base_disk_tracks_ancestry`
    ///   builds exactly that), so a parent whose row went missing would otherwise
    ///   be deleted out from under a child that still has one.
    ///
    /// Over-reporting is the safe direction: if a whole chain is orphaned, the
    /// leaf is collected on this pass and its parent on the next, so the sweep
    /// still converges.
    ///
    /// `read_backing_chain` returns partial results on a read error and caps at
    /// `MAX_BACKING_CHAIN_DEPTH`, so this can under-report. It is one of two
    /// independent guards in [`Self::gc_orphans`], never the sole authority.
    pub(crate) fn referenced_backing_paths(&self, boxes_dir: &Path) -> HashSet<PathBuf> {
        let mut referenced = HashSet::new();

        match fs::read_dir(boxes_dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let disks_dir = entry.path().join("disks");
                    for overlay in [
                        disk_filenames::CONTAINER_DISK,
                        disk_filenames::GUEST_ROOTFS_DISK,
                    ] {
                        let overlay_path = disks_dir.join(overlay);
                        if overlay_path.exists() {
                            referenced.extend(super::read_backing_chain(&overlay_path));
                        }
                    }
                }
            }
            Err(e) => {
                if boxes_dir.exists() {
                    tracing::warn!(
                        "GC: failed to read boxes dir {}: {}",
                        boxes_dir.display(),
                        e
                    );
                }
            }
        }

        // Ancestry between bases themselves.
        match fs::read_dir(&self.bases_dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    referenced.extend(super::read_backing_chain(&entry.path()));
                }
            }
            Err(e) => {
                if self.bases_dir.exists() {
                    tracing::warn!(
                        "GC: failed to read bases dir {}: {}",
                        self.bases_dir.display(),
                        e
                    );
                }
            }
        }

        referenced
    }

    /// Delete base files that nothing claims.
    ///
    /// The per-kind collectors work from DB records, so a file whose row is gone
    /// — a crash between the rename and the insert, a hand-edited database, a
    /// schema reset — becomes permanently invisible to them and is never
    /// reclaimed. This sweep starts from the filesystem instead.
    ///
    /// A file is deleted only when **both** hold, because snapshots are user data
    /// that no collector may remove:
    /// - no `base_disk` row of *any* kind names it, and
    /// - nothing backs onto it — see [`Self::referenced_backing_paths`], which
    ///   covers box overlays and base-to-base ancestry alike.
    ///
    /// The two guards are independent on purpose: each can miss (a lost row, an
    /// unreadable qcow2 header, a chain deeper than the walk), so a file has to
    /// look unclaimed to *both* before it is removed.
    ///
    /// Files younger than [`Self::ORPHAN_GRACE`] are skipped: `install` renames a
    /// file into place before inserting its row, so a fresh entry looks unclaimed
    /// for a moment. `RuntimeLock` already excludes a concurrent installer; the
    /// grace period costs nothing and removes the reliance on that.
    pub(crate) fn gc_orphans(&self, boxes_dir: &Path) -> BoxliteResult<usize> {
        let entries = match fs::read_dir(&self.bases_dir) {
            Ok(entries) => entries,
            Err(e) => {
                if self.bases_dir.exists() {
                    tracing::warn!(
                        "GC: failed to read bases dir {}: {}",
                        self.bases_dir.display(),
                        e
                    );
                }
                return Ok(0);
            }
        };
        let referenced = self.referenced_backing_paths(boxes_dir);
        let now = SystemTime::now();

        let mut removed = 0;
        let mut reclaimed_bytes = 0u64;

        for entry in entries.flatten() {
            let path = entry.path();
            let Some(extension) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            // Only the two shapes this manager creates; never touch anything else
            // that happens to sit in the directory.
            if !matches!(extension, "ext4" | "qcow2") {
                continue;
            }

            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }

            let settled = metadata
                .modified()
                .ok()
                .and_then(|mtime| now.duration_since(mtime).ok())
                .is_some_and(|age| age >= Self::ORPHAN_GRACE);
            if !settled {
                continue;
            }

            if referenced.contains(&path) {
                continue;
            }
            // Fail closed, as `try_gc_base` does: a DB error must never read as
            // "unclaimed". One SQLITE_BUSY during `recover_boxes` would otherwise
            // sweep every settled file here, snapshots included.
            let claimed = match self.store.find_by_base_path(&path.to_string_lossy()) {
                Ok(record) => record.is_some(),
                Err(e) => {
                    tracing::warn!(
                        path = %path.display(),
                        "GC: cannot determine whether a base disk is claimed, keeping it: {}",
                        e
                    );
                    true
                }
            };
            if claimed {
                continue;
            }

            let Some(disk_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            // A qcow2 another disk still parents is not free. Leave the file
            // so this sweep does not strand `disk.root` on a path it removed.
            if crate::db::shared_disk::child_blocks(self.store.database(), disk_id)? {
                continue;
            }

            tracing::info!(
                path = %path.display(),
                size_mb = metadata.len() / (1024 * 1024),
                "GC: removing orphaned base disk (no DB record, no overlay reference)"
            );
            match fs::remove_file(&path) {
                Ok(()) => {
                    match crate::db::shared_disk::delete_disk_if_free(
                        self.store.database(),
                        disk_id,
                    )? {
                        crate::db::shared_disk::DiskDelete::Blocked => {
                            return Err(crate::db::shared_disk::blocked_disk(disk_id));
                        }
                        crate::db::shared_disk::DiskDelete::Removed
                        | crate::db::shared_disk::DiskDelete::Absent => {
                            removed += 1;
                            reclaimed_bytes += metadata.len();
                        }
                    }
                }
                Err(e) => tracing::warn!("GC: failed to remove {}: {}", path.display(), e),
            }
        }

        if removed > 0 {
            tracing::info!(
                removed,
                reclaimed_mb = reclaimed_bytes / (1024 * 1024),
                "GC: reclaimed orphaned base disks"
            );
        }
        Ok(removed)
    }

    /// Core operation: create a base disk from a box's live container disk.
    ///
    /// 1. Move container disk → `bases/{base_disk_id}.qcow2` (makes it immutable)
    /// 2. Create COW child at original path (so the source box keeps running)
    /// 3. Insert DB record (with JSON blob)
    ///
    /// Used by clone operations. Snapshots use `SnapshotManager` instead.
    pub(crate) fn create_base_disk(
        &self,
        source_disks_dir: &Path,
        kind: BaseDiskKind,
        name: Option<&str>,
        source_box_id: &str,
    ) -> BoxliteResult<BaseDisk> {
        let base_disk_id = BaseDiskIDMint::mint();

        let container = source_disks_dir.join(disk_filenames::CONTAINER_DISK);

        // Record the clone-base disk row before the qcow2 fork. The source
        // container's parent becomes this base; both roots stay the ext4.
        let fork_commit = crate::db::shared_disk::commit_fork(
            self.store.database(),
            source_box_id,
            base_disk_id.as_str(),
        )?;
        if matches!(fork_commit, crate::db::shared_disk::ForkCommit::NotReady) {
            return Err(boxlite_shared::errors::BoxliteError::InvalidState(format!(
                "refusing to clone box {source_box_id}: its ext4 is not ready"
            )));
        }

        // Fork: move container → bases/{id}.qcow2, create COW child at original path
        let base_file = self.bases_dir.join(format!("{}.qcow2", base_disk_id));
        let forked = match super::fork_qcow2(&container, &base_file) {
            Ok(forked) => forked,
            Err(err) => {
                if let crate::db::shared_disk::ForkCommit::Committed { previous_parent } =
                    fork_commit
                {
                    crate::db::shared_disk::abort_fork(
                        self.store.database(),
                        source_box_id,
                        base_disk_id.as_str(),
                        &previous_parent,
                    )?;
                }
                return Err(err);
            }
        };
        let disk_info = super::DiskInfo::from(&forked);
        // forked is persistent (won't be deleted on drop)

        // Insert DB record
        let now = chrono::Utc::now().timestamp();
        let disk = BaseDisk {
            id: base_disk_id,
            source_box_id: source_box_id.to_string(),
            name: name.map(|s| s.to_string()),
            kind,
            disk_info,
            created_at: now,
        };
        self.store.insert(&disk)?;

        // Track the source box's dependency on this base disk.
        self.store.add_ref(&disk.id, source_box_id)?;

        Ok(disk)
    }

    /// Attempt to garbage-collect a clone base by ID and cascade to parent.
    ///
    /// Queries the `base_disk_ref` table for dependents. If none exist, unlinks
    /// the qcow2 first. A failed unlink leaves the file, the base-disk record,
    /// and the disk row. After the file is gone, the disk row is deleted when
    /// no `disk.parent` points at it, then the base-disk record. A database
    /// error from that disk-row delete is returned.
    pub(crate) fn try_gc_base(&self, base_disk_id: &BaseDiskID) -> BoxliteResult<()> {
        let record = match self.store.find_by_id(base_disk_id)? {
            Some(r) => r,
            None => return Ok(()),
        };

        // Only auto-cleanup clone bases (snapshots/rootfs require explicit removal)
        if record.kind() != BaseDiskKind::CloneBase {
            return Ok(());
        }

        // DB query for dependents — if any exist, keep the base
        if self.store.has_dependents(base_disk_id)? {
            return Ok(());
        }

        // Read parent BEFORE deleting file (we need the qcow2 header)
        let base_file = record.disk_info().to_path_buf();
        let parent = self.find_parent_base(&base_file);

        // A qcow2 another disk still parents is not free, even when no
        // base_disk_ref row remains. Leave the file and both rows.
        if crate::db::shared_disk::child_blocks(self.store.database(), base_disk_id.as_str())? {
            return Ok(());
        }

        match std::fs::remove_file(&base_file) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(BoxliteError::Storage(format!(
                    "failed to remove {}: {err}",
                    base_file.display()
                )));
            }
        }

        match crate::db::shared_disk::delete_disk_if_free(
            self.store.database(),
            base_disk_id.as_str(),
        )? {
            crate::db::shared_disk::DiskDelete::Blocked => {
                return Err(crate::db::shared_disk::blocked_disk(base_disk_id.as_str()));
            }
            crate::db::shared_disk::DiskDelete::Removed
            | crate::db::shared_disk::DiskDelete::Absent => {}
        }
        self.store.delete(record.id())?;

        tracing::info!(
            base_disk_id = %record.id(),
            "Garbage-collected clone base (no dependents)"
        );

        // Cascade to parent base disk
        if let Some(parent_path) = parent
            && let Ok(Some(parent_record)) =
                self.store.find_by_base_path(&parent_path.to_string_lossy())
        {
            self.try_gc_base(parent_record.id())?;
        }
        Ok(())
    }

    /// Walk the qcow2 backing chain to find the first parent that lives in bases_dir.
    ///
    /// Returns the backing file path directly (flat file, not a directory).
    pub(crate) fn find_parent_base(&self, qcow2_path: &Path) -> Option<PathBuf> {
        let chain = super::read_backing_chain(qcow2_path);
        let bases_dir_str = self.bases_dir.to_string_lossy();

        for backing in chain {
            let backing_str = backing.to_string_lossy();
            if backing_str.starts_with(bases_dir_str.as_ref()) {
                return Some(backing);
            }
        }
        None
    }

    /// Identify which layer a box's disks reference (if any).
    ///
    /// Reads the container disk's backing file path and checks if it's in bases/.
    /// Returns the base file path (not a directory).
    #[allow(dead_code)] // used in tests
    pub(crate) fn identify_layer(&self, box_disks_dir: &Path) -> Option<String> {
        let container = box_disks_dir.join(disk_filenames::CONTAINER_DISK);
        if !container.exists() {
            return None;
        }

        match super::read_backing_file_path(&container) {
            Ok(Some(backing_path)) => {
                let bases_dir_str = self.bases_dir.to_string_lossy();
                if backing_path.starts_with(bases_dir_str.as_ref()) {
                    Some(backing_path)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::disk::DiskInfo;
    use tempfile::TempDir;

    fn base_id(id: &str) -> BaseDiskID {
        BaseDiskID::parse(id).expect("test ID must be valid Base62 length-8")
    }

    fn setup() -> (TempDir, BaseDiskManager) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("db").join("test.db");
        let db = Database::open(&db_path).unwrap();
        let bases_dir = dir.path().join("bases");
        std::fs::create_dir_all(&bases_dir).unwrap();
        let store = BaseDiskStore::new(db);
        let mgr = BaseDiskManager::new(bases_dir, store);
        (dir, mgr)
    }

    /// Helper: create a minimal qcow2 file with an optional backing file path.
    fn write_qcow2_with_backing(path: &Path, backing: Option<&str>) {
        use std::io::Write;
        let mut buf = vec![0u8; 1024];
        // Magic: QFI\xfb
        buf[0..4].copy_from_slice(&0x514649fbu32.to_be_bytes());
        // Version: 3
        buf[4..8].copy_from_slice(&3u32.to_be_bytes());
        // Virtual size at offset 24: 1 GiB
        buf[24..32].copy_from_slice(&(1024u64 * 1024 * 1024).to_be_bytes());

        if let Some(backing_str) = backing {
            let backing_bytes = backing_str.as_bytes();
            // Backing offset: 512
            buf[8..16].copy_from_slice(&512u64.to_be_bytes());
            // Backing size
            buf[16..20].copy_from_slice(&(backing_bytes.len() as u32).to_be_bytes());
            // Backing path at offset 512
            buf[512..512 + backing_bytes.len()].copy_from_slice(backing_bytes);
        }

        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(&buf).unwrap();
    }

    #[test]
    fn test_create_base_disk_moves_disk() {
        let (dir, mgr) = setup();

        let box_disks = dir.path().join("boxes").join("box-1").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        write_qcow2_with_backing(&box_disks.join(disk_filenames::CONTAINER_DISK), None);

        let disk = mgr
            .create_base_disk(&box_disks, BaseDiskKind::Snapshot, Some("snap-1"), "box-1")
            .unwrap();

        // Source disk should be replaced with a COW child
        assert!(box_disks.join(disk_filenames::CONTAINER_DISK).exists());

        // Base file should exist as flat file in bases/
        let base_file = disk.disk_info.to_path_buf();
        assert!(base_file.exists());
        assert!(base_file.extension().is_some_and(|ext| ext == "qcow2"));
        assert_eq!(base_file.parent().unwrap(), mgr.bases_dir());

        // base_path should end with {id}.qcow2
        assert!(
            disk.disk_info
                .base_path
                .ends_with(&format!("{}.qcow2", disk.id))
        );

        // Record should be in DB
        let found = mgr.store().find_by_id(&disk.id).unwrap().unwrap();
        assert_eq!(found.kind(), BaseDiskKind::Snapshot);
        assert_eq!(found.name(), Some("snap-1"));
    }

    #[test]
    fn test_create_base_disk_adds_ref() {
        let (dir, mgr) = setup();

        let box_disks = dir.path().join("boxes").join("box-1").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        write_qcow2_with_backing(&box_disks.join(disk_filenames::CONTAINER_DISK), None);

        let disk = mgr
            .create_base_disk(&box_disks, BaseDiskKind::CloneBase, None, "box-1")
            .unwrap();

        // create_base_disk should have added a ref for the source box
        assert!(mgr.store().has_dependents(&disk.id).unwrap());
        let deps = mgr.store().dependent_boxes(&disk.id).unwrap();
        assert_eq!(deps, vec!["box-1"]);
    }

    #[test]
    fn test_create_base_disk_uses_base_disk_id() {
        let (dir, mgr) = setup();

        let box_disks = dir.path().join("boxes").join("box-1").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        write_qcow2_with_backing(&box_disks.join(disk_filenames::CONTAINER_DISK), None);

        let disk = mgr
            .create_base_disk(&box_disks, BaseDiskKind::Snapshot, Some("snap-1"), "box-1")
            .unwrap();

        // ID should be 8 characters (BaseDiskID length)
        assert_eq!(disk.id.as_str().len(), BaseDiskID::FULL_LENGTH);

        // base_path should end with {id}.qcow2
        assert!(
            disk.disk_info
                .base_path
                .ends_with(&format!("{}.qcow2", disk.id))
        );
    }

    #[test]
    fn test_create_base_disk_tracks_ancestry() {
        let (dir, mgr) = setup();

        let box_disks = dir.path().join("boxes").join("box-1").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        write_qcow2_with_backing(&box_disks.join(disk_filenames::CONTAINER_DISK), None);

        let bd1 = mgr
            .create_base_disk(&box_disks, BaseDiskKind::CloneBase, None, "box-1")
            .unwrap();

        let bd2 = mgr
            .create_base_disk(&box_disks, BaseDiskKind::CloneBase, None, "box-1")
            .unwrap();

        // Verify ancestry via filesystem: bd2's backing chain includes bd1
        let bd2_file = bd2.disk_info.to_path_buf();
        let parent = mgr.find_parent_base(&bd2_file);
        assert_eq!(
            parent.as_ref().map(|p| p.to_string_lossy().to_string()),
            Some(bd1.disk_info.base_path.clone()),
            "bd2 should have bd1 as parent in its backing chain"
        );

        // Both records should exist in DB
        assert!(mgr.store().find_by_id(&bd1.id).unwrap().is_some());
        assert!(mgr.store().find_by_id(&bd2.id).unwrap().is_some());
    }

    #[test]
    fn test_find_parent_base() {
        let (dir, mgr) = setup();

        let base_file = mgr.bases_dir.join("layer-1.qcow2");
        write_qcow2_with_backing(&base_file, None);

        let test_qcow2 = dir.path().join("test.qcow2");
        write_qcow2_with_backing(&test_qcow2, Some(&base_file.to_string_lossy()));

        let parent = mgr.find_parent_base(&test_qcow2);
        assert_eq!(parent, Some(base_file));

        let standalone = dir.path().join("standalone.qcow2");
        write_qcow2_with_backing(&standalone, None);
        assert!(mgr.find_parent_base(&standalone).is_none());
    }

    #[test]
    fn test_identify_layer() {
        let (dir, mgr) = setup();

        let base_file = mgr.bases_dir.join("layer-42.qcow2");
        write_qcow2_with_backing(&base_file, None);

        let box_disks = dir.path().join("boxes").join("box-1").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        write_qcow2_with_backing(
            &box_disks.join(disk_filenames::CONTAINER_DISK),
            Some(&base_file.to_string_lossy()),
        );

        let identified = mgr.identify_layer(&box_disks);
        assert_eq!(
            identified.as_deref(),
            Some(base_file.to_string_lossy().as_ref())
        );

        let box_disks2 = dir.path().join("boxes").join("box-2").join("disks");
        std::fs::create_dir_all(&box_disks2).unwrap();
        write_qcow2_with_backing(&box_disks2.join(disk_filenames::CONTAINER_DISK), None);
        assert!(mgr.identify_layer(&box_disks2).is_none());
    }

    #[test]
    fn test_try_gc_base_single_level() {
        let (_dir, mgr) = setup();

        let base_file = mgr.bases_dir.join("base0001.qcow2");
        write_qcow2_with_backing(&base_file, None);

        let disk = BaseDisk {
            id: base_id("base0001"),
            source_box_id: "src".to_string(),
            name: None,
            kind: BaseDiskKind::CloneBase,
            disk_info: DiskInfo {
                base_path: base_file.to_string_lossy().to_string(),
                container_disk_bytes: 0,
                size_bytes: 0,
            },
            created_at: 0,
        };
        mgr.store().insert(&disk).unwrap();

        // Add a ref, then remove it (simulating box deletion)
        mgr.store()
            .add_ref(&base_id("base0001"), "clone-1")
            .unwrap();
        mgr.store().remove_all_refs_for_box("clone-1").unwrap();

        // GC should delete the base (no dependents)
        mgr.try_gc_base(&base_id("base0001")).unwrap();

        assert!(
            mgr.store()
                .find_by_id(&base_id("base0001"))
                .unwrap()
                .is_none()
        );
        assert!(!base_file.exists());
    }

    #[test]
    fn test_try_gc_base_cascade_nested() {
        let (_dir, mgr) = setup();

        // Create base-1 (no parent)
        let base1_file = mgr.bases_dir.join("base0001.qcow2");
        write_qcow2_with_backing(&base1_file, None);
        let bd1 = BaseDisk {
            id: base_id("base0001"),
            source_box_id: "src".to_string(),
            name: None,
            kind: BaseDiskKind::CloneBase,
            disk_info: DiskInfo {
                base_path: base1_file.to_string_lossy().to_string(),
                container_disk_bytes: 0,
                size_bytes: 0,
            },
            created_at: 0,
        };
        mgr.store().insert(&bd1).unwrap();

        // Create base-2 with backing pointing to base-1
        let base2_file = mgr.bases_dir.join("base0002.qcow2");
        write_qcow2_with_backing(&base2_file, Some(&base1_file.to_string_lossy()));
        let bd2 = BaseDisk {
            id: base_id("base0002"),
            source_box_id: "clone-of-src".to_string(),
            name: None,
            kind: BaseDiskKind::CloneBase,
            disk_info: DiskInfo {
                base_path: base2_file.to_string_lossy().to_string(),
                container_disk_bytes: 0,
                size_bytes: 0,
            },
            created_at: 0,
        };
        mgr.store().insert(&bd2).unwrap();

        // No refs → GC base-2 → cascades to base-1
        mgr.try_gc_base(&base_id("base0002")).unwrap();

        assert!(
            mgr.store()
                .find_by_id(&base_id("base0002"))
                .unwrap()
                .is_none(),
            "base-2 should be deleted"
        );
        assert!(!base2_file.exists(), "base-2 file should be removed");

        assert!(
            mgr.store()
                .find_by_id(&base_id("base0001"))
                .unwrap()
                .is_none(),
            "base-1 should cascade-delete"
        );
        assert!(!base1_file.exists(), "base-1 file should be removed");
    }

    #[test]
    fn test_try_gc_base_skips_snapshots() {
        let (_dir, mgr) = setup();

        let base_file = mgr.bases_dir.join("snap0001.qcow2");
        write_qcow2_with_backing(&base_file, None);

        let disk = BaseDisk {
            id: base_id("snap0001"),
            source_box_id: "box-1".to_string(),
            name: Some("my-snapshot".to_string()),
            kind: BaseDiskKind::Snapshot,
            disk_info: DiskInfo {
                base_path: base_file.to_string_lossy().to_string(),
                container_disk_bytes: 0,
                size_bytes: 0,
            },
            created_at: 0,
        };
        mgr.store().insert(&disk).unwrap();

        // GC should NOT delete the snapshot (kind=Snapshot is excluded from GC)
        mgr.try_gc_base(&base_id("snap0001")).unwrap();

        assert!(
            mgr.store()
                .find_by_id(&base_id("snap0001"))
                .unwrap()
                .is_some(),
            "Snapshot should NOT be auto-deleted"
        );
        assert!(base_file.exists(), "Snapshot file should still exist");
    }

    #[test]
    fn test_try_gc_base_preserves_with_dependents() {
        let (_dir, mgr) = setup();

        let base_file = mgr.bases_dir.join("shared01.qcow2");
        write_qcow2_with_backing(&base_file, None);

        let disk = BaseDisk {
            id: base_id("shared01"),
            source_box_id: "src".to_string(),
            name: None,
            kind: BaseDiskKind::CloneBase,
            disk_info: DiskInfo {
                base_path: base_file.to_string_lossy().to_string(),
                container_disk_bytes: 0,
                size_bytes: 0,
            },
            created_at: 0,
        };
        mgr.store().insert(&disk).unwrap();

        // Two boxes referencing the same base
        mgr.store()
            .add_ref(&base_id("shared01"), "clone-1")
            .unwrap();
        mgr.store()
            .add_ref(&base_id("shared01"), "clone-2")
            .unwrap();

        // Remove clone-1's ref: base should survive (clone-2 still depends)
        mgr.store().remove_all_refs_for_box("clone-1").unwrap();
        mgr.try_gc_base(&base_id("shared01")).unwrap();

        assert!(
            mgr.store()
                .find_by_id(&base_id("shared01"))
                .unwrap()
                .is_some(),
            "Base should survive (clone-2 still depends on it)"
        );
        assert!(base_file.exists());

        // Remove clone-2's ref: now base should be GC'd
        mgr.store().remove_all_refs_for_box("clone-2").unwrap();
        mgr.try_gc_base(&base_id("shared01")).unwrap();

        assert!(
            mgr.store()
                .find_by_id(&base_id("shared01"))
                .unwrap()
                .is_none(),
            "Base should be deleted (no more dependents)"
        );
        assert!(!base_file.exists());
    }

    /// Backdate past `ORPHAN_GRACE` so the sweep will consider the file.
    fn age(path: &Path) {
        let old = filetime::FileTime::from_system_time(
            SystemTime::now() - BaseDiskManager::ORPHAN_GRACE * 2,
        );
        filetime::set_file_mtime(path, old).unwrap();
    }

    fn insert_row(mgr: &BaseDiskManager, id: &str, kind: BaseDiskKind, path: &Path) {
        mgr.store()
            .insert(&BaseDisk {
                id: base_id(id),
                source_box_id: "__global__".to_string(),
                name: Some(id.to_string()),
                kind,
                disk_info: DiskInfo {
                    base_path: path.to_string_lossy().to_string(),
                    container_disk_bytes: 0,
                    size_bytes: 0,
                },
                created_at: 0,
            })
            .unwrap();
    }

    /// Only a file that *nothing* claims may be deleted.
    ///
    /// The per-kind collectors iterate DB records, so a file whose row is gone is
    /// invisible to them and accumulates forever. This sweep starts from the
    /// filesystem — which means it must not mistake a snapshot, a clone base, or
    /// an overlay's backing file for garbage.
    #[test]
    fn gc_orphans_removes_only_unclaimed_files() {
        let (dir, mgr) = setup();
        let boxes_dir = dir.path().join("boxes");

        // 1. Unclaimed — no DB row, no overlay. The only legitimate target.
        let orphan = mgr.bases_dir.join("orphan01.ext4");
        std::fs::write(&orphan, b"unclaimed").unwrap();
        age(&orphan);

        // 2. Claimed by a DB row, and a Snapshot at that — user data.
        let snapshot = mgr.bases_dir.join("snapshot.qcow2");
        std::fs::write(&snapshot, b"user snapshot").unwrap();
        age(&snapshot);
        insert_row(&mgr, "snapshot", BaseDiskKind::Snapshot, &snapshot);

        // 3. No DB row, but a live box's guest-rootfs overlay backs onto it.
        let backed = mgr.bases_dir.join("backed001.ext4");
        std::fs::write(&backed, b"still in use").unwrap();
        age(&backed);
        let box_disks = boxes_dir.join("box-1").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        write_qcow2_with_backing(
            &box_disks.join(disk_filenames::GUEST_ROOTFS_DISK),
            Some(&backed.to_string_lossy()),
        );

        // 4. No DB row, but a container overlay backs onto it. Scanning only
        //    guest-rootfs.qcow2 would delete this one.
        let clone_base = mgr.bases_dir.join("clonebas.qcow2");
        std::fs::write(&clone_base, b"clone base").unwrap();
        age(&clone_base);
        let box2_disks = boxes_dir.join("box-2").join("disks");
        std::fs::create_dir_all(&box2_disks).unwrap();
        write_qcow2_with_backing(
            &box2_disks.join(disk_filenames::CONTAINER_DISK),
            Some(&clone_base.to_string_lossy()),
        );

        let removed = mgr.gc_orphans(&boxes_dir).unwrap();

        assert_eq!(removed, 1, "exactly one file was unclaimed");
        assert!(!orphan.exists(), "unclaimed file should be reclaimed");
        assert!(snapshot.exists(), "a snapshot must never be auto-deleted");
        assert!(
            backed.exists(),
            "guest-rootfs overlay still backs onto this"
        );
        assert!(
            clone_base.exists(),
            "container overlay still backs onto this"
        );
    }

    /// Clone bases nest, and a mid-chain base with no DB row is precisely what
    /// this sweep exists to handle — so it must not be reachable by deleting it.
    #[test]
    fn gc_orphans_follows_the_whole_backing_chain() {
        let (dir, mgr) = setup();
        let boxes_dir = dir.path().join("boxes");

        // bd1 <- bd2 <- overlay. Neither base has a DB row.
        let bd1 = mgr.bases_dir.join("chain001.qcow2");
        write_qcow2_with_backing(&bd1, None);
        age(&bd1);
        let bd2 = mgr.bases_dir.join("chain002.qcow2");
        write_qcow2_with_backing(&bd2, Some(&bd1.to_string_lossy()));
        age(&bd2);

        let box_disks = boxes_dir.join("box-1").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        write_qcow2_with_backing(
            &box_disks.join(disk_filenames::CONTAINER_DISK),
            Some(&bd2.to_string_lossy()),
        );

        let removed = mgr.gc_orphans(&boxes_dir).unwrap();

        assert_eq!(removed, 0, "every link in a live chain is in use");
        assert!(bd2.exists(), "immediate backing file");
        assert!(
            bd1.exists(),
            "grandparent — reachable only by walking the chain"
        );
    }

    /// A base's parent may be reachable only through the child, never through a
    /// box overlay — `create_base_disk` chains bases directly.
    ///
    /// If the parent's row is the one that went missing, scanning only box
    /// overlays would delete it out from under a child that is still tracked.
    #[test]
    fn gc_orphans_follows_ancestry_between_bases() {
        let (dir, mgr) = setup();

        // bd1 <- bd2, no box overlay anywhere. Only bd2 keeps a DB row.
        let bd1 = mgr.bases_dir.join("parent01.qcow2");
        write_qcow2_with_backing(&bd1, None);
        age(&bd1);
        let bd2 = mgr.bases_dir.join("child001.qcow2");
        write_qcow2_with_backing(&bd2, Some(&bd1.to_string_lossy()));
        age(&bd2);
        insert_row(&mgr, "child001", BaseDiskKind::CloneBase, &bd2);

        let removed = mgr.gc_orphans(&dir.path().join("boxes")).unwrap();

        assert_eq!(removed, 0, "a tracked child still needs its parent");
        assert!(bd2.exists(), "claimed by its DB row");
        assert!(bd1.exists(), "claimed only by its child's backing chain");
    }

    /// A database error must never read as "unclaimed".
    ///
    /// `try_gc_base` already fails closed (`has_dependents(..).unwrap_or(true)`).
    /// This sweep deletes, so failing open here would let one transient error
    /// during `recover_boxes` take out every settled file, snapshots included.
    #[test]
    fn gc_orphans_keeps_files_when_the_db_cannot_be_read() {
        let dir = TempDir::new().unwrap();
        let db = Database::open(&dir.path().join("db").join("test.db")).unwrap();
        let bases_dir = dir.path().join("bases");
        std::fs::create_dir_all(&bases_dir).unwrap();
        let mgr = BaseDiskManager::new(bases_dir, BaseDiskStore::new(db.clone()));

        let base = mgr.bases_dir.join("atrisk01.ext4");
        std::fs::write(&base, b"unclaimed as far as a broken DB can tell").unwrap();
        age(&base);

        // Make every `find_by_base_path` return Err rather than Ok(None).
        // Dropping the table is what a query error looks like from the caller's
        // side, without depending on page-cache behaviour.
        db.conn().execute("DROP TABLE base_disk", []).unwrap();

        let removed = mgr.gc_orphans(&dir.path().join("boxes")).unwrap();

        assert_eq!(removed, 0, "an unreadable DB must not authorise deletion");
        assert!(base.exists(), "files must survive a DB error");
    }

    /// A file installed moments ago has not had its DB row written yet.
    #[test]
    fn gc_orphans_spares_freshly_written_files() {
        let (dir, mgr) = setup();

        let fresh = mgr.bases_dir.join("fresh001.ext4");
        std::fs::write(&fresh, b"just renamed into place").unwrap();

        let removed = mgr.gc_orphans(&dir.path().join("boxes")).unwrap();

        assert_eq!(removed, 0);
        assert!(
            fresh.exists(),
            "a file inside the grace window must survive"
        );
    }

    /// The sweep owns two filename shapes; anything else in the directory is
    /// not its to delete.
    #[test]
    fn gc_orphans_ignores_unrecognized_files() {
        let (dir, mgr) = setup();

        let stray = mgr.bases_dir.join("notes.txt");
        std::fs::write(&stray, b"not ours").unwrap();
        age(&stray);

        let removed = mgr.gc_orphans(&dir.path().join("boxes")).unwrap();

        assert_eq!(removed, 0);
        assert!(stray.exists());
    }

    fn clone_base_with_disk_row(dir: &std::path::Path, mgr: &BaseDiskManager) -> BaseDisk {
        mgr.store()
            .database()
            .conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('ext4key1', '/tmp/ext4', 'ready', '{}')",
                [],
            )
            .unwrap();
        mgr.store()
            .database()
            .conn()
            .execute(
                "INSERT INTO disk (id, root, parent) VALUES ('boxsrc01', 'ext4key1', 'ext4key1')",
                [],
            )
            .unwrap();
        let box_disks = dir.join("boxes").join("boxsrc01").join("disks");
        std::fs::create_dir_all(&box_disks).unwrap();
        write_qcow2_with_backing(&box_disks.join(disk_filenames::CONTAINER_DISK), None);
        mgr.create_base_disk(&box_disks, BaseDiskKind::CloneBase, None, "boxsrc01")
            .unwrap()
    }

    #[test]
    fn try_gc_base_drops_disk_row_when_the_qcow2_is_gone() {
        let (dir, mgr) = setup();
        let disk = clone_base_with_disk_row(dir.path(), &mgr);
        let base_file = disk.disk_info.to_path_buf();
        mgr.store()
            .database()
            .conn()
            .execute("DELETE FROM disk WHERE id = 'boxsrc01'", [])
            .unwrap();
        mgr.store().remove_all_refs_for_box("boxsrc01").unwrap();

        mgr.try_gc_base(&disk.id).unwrap();

        assert!(
            !base_file.exists(),
            "the unreferenced qcow2 must be removed"
        );
        let row =
            crate::db::shared_disk::disk_row(mgr.store().database(), disk.id.as_str()).unwrap();
        assert!(
            row.is_none(),
            "gc left a disk.root pointing at a deleted qcow2: {row:?}"
        );
    }

    #[test]
    fn try_gc_base_keeps_the_file_when_a_disk_parent_remains() {
        let (dir, mgr) = setup();
        let disk = clone_base_with_disk_row(dir.path(), &mgr);
        let base_file = disk.disk_info.to_path_buf();
        let before = std::fs::read(&base_file).unwrap();
        mgr.store()
            .database()
            .conn()
            .execute("DELETE FROM disk WHERE id = 'boxsrc01'", [])
            .unwrap();
        mgr.store()
            .database()
            .conn()
            .execute(
                "INSERT INTO disk (id, root, parent) VALUES ('clone001', 'ext4key1', ?1)",
                [disk.id.as_str()],
            )
            .unwrap();
        mgr.store().remove_all_refs_for_box("boxsrc01").unwrap();

        mgr.try_gc_base(&disk.id).unwrap();

        assert_eq!(
            std::fs::read(&base_file).ok().as_deref(),
            Some(before.as_slice()),
            "qcow2 was unlinked while a disk.parent still points at it"
        );
        assert!(
            crate::db::shared_disk::disk_row(mgr.store().database(), disk.id.as_str())
                .unwrap()
                .is_some(),
            "the disk row must stay while a child points at it"
        );
    }

    /// Unlink fails after the clone base is otherwise free. The base-disk record
    /// and the disk row must still be there, because the qcow2 is still there.
    #[test]
    fn try_gc_base_keeps_the_base_record_when_unlink_fails() {
        use std::os::unix::fs::PermissionsExt;

        struct RestoreMode(PathBuf);
        impl Drop for RestoreMode {
            fn drop(&mut self) {
                if let Ok(meta) = std::fs::metadata(&self.0) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(&self.0, perms);
                }
            }
        }

        let (dir, mgr) = setup();
        let disk = clone_base_with_disk_row(dir.path(), &mgr);
        let base_file = disk.disk_info.to_path_buf();
        mgr.store()
            .database()
            .conn()
            .execute("DELETE FROM disk WHERE id = 'boxsrc01'", [])
            .unwrap();
        mgr.store().remove_all_refs_for_box("boxsrc01").unwrap();

        let _restore = RestoreMode(mgr.bases_dir.clone());
        let mut perms = std::fs::metadata(&mgr.bases_dir).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&mgr.bases_dir, perms).unwrap();

        let gc = mgr.try_gc_base(&disk.id);

        assert!(
            base_file.exists(),
            "unlink failed, so the qcow2 must still be on disk"
        );
        assert!(
            mgr.store().find_by_id(&disk.id).unwrap().is_some(),
            "base-disk record was deleted before the qcow2 unlink succeeded"
        );
        assert!(
            crate::db::shared_disk::disk_row(mgr.store().database(), disk.id.as_str())
                .unwrap()
                .is_some(),
            "disk row was deleted while the qcow2 is still present"
        );
        let err = gc.expect_err("unlink failure must surface");
        assert!(err.to_string().contains("failed to remove"), "{err}");
    }

    /// A settled bases/ qcow2 with no base-disk record still has a disk row.
    /// Removing the file must remove that row. A parent pointer keeps the file.
    #[test]
    fn gc_orphans_does_not_leave_disk_root_after_removing_the_file() {
        let (dir, mgr) = setup();
        let db = mgr.store().database();
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('ext4key1', '/tmp/ext4', 'ready', '{}')",
                [],
            )
            .unwrap();

        let gone = mgr.bases_dir.join("freed001.qcow2");
        std::fs::write(&gone, b"unclaimed qcow2").unwrap();
        age(&gone);
        db.conn()
            .execute(
                "INSERT INTO disk (id, root, parent) VALUES ('freed001', 'ext4key1', 'ext4key1')",
                [],
            )
            .unwrap();

        let kept = mgr.bases_dir.join("kept0001.qcow2");
        std::fs::write(&kept, b"still parented").unwrap();
        age(&kept);
        db.conn()
            .execute(
                "INSERT INTO disk (id, root, parent) VALUES ('kept0001', 'ext4key1', 'ext4key1'), ('child001', 'ext4key1', 'kept0001')",
                [],
            )
            .unwrap();

        let _removed = mgr.gc_orphans(&dir.path().join("boxes")).unwrap();

        assert!(!gone.exists(), "the unclaimed qcow2 should be removed");
        let left = crate::db::shared_disk::disk_row(db, "freed001").unwrap();
        assert!(
            left.is_none(),
            "gc left disk.root after deleting the qcow2: {left:?}"
        );
        assert!(
            kept.exists(),
            "unlinked a qcow2 whose disk.parent still points at it"
        );
        assert!(
            crate::db::shared_disk::disk_row(db, "kept0001")
                .unwrap()
                .is_some(),
            "the parented disk row must stay with its file"
        );
    }
}
