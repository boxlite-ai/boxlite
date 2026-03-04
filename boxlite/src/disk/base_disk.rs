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

use std::path::{Path, PathBuf};

use boxlite_shared::errors::BoxliteResult;
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

        // Fork: move container → bases/{id}.qcow2, create COW child at original path
        let base_file = self.bases_dir.join(format!("{}.qcow2", base_disk_id));
        let forked = super::fork_qcow2(&container, &base_file)?;
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
    /// Queries the `base_disk_ref` table for dependents. If none exist,
    /// deletes the base (DB record + file) and cascades to the parent base.
    pub(crate) fn try_gc_base(&self, base_disk_id: &BaseDiskID) {
        let record = match self.store.find_by_id(base_disk_id) {
            Ok(Some(r)) => r,
            _ => return,
        };

        // Only auto-cleanup clone bases (snapshots/rootfs require explicit removal)
        if record.kind() != BaseDiskKind::CloneBase {
            return;
        }

        // DB query for dependents — if any exist, keep the base
        if self.store.has_dependents(base_disk_id).unwrap_or(true) {
            return;
        }

        // Read parent BEFORE deleting file (we need the qcow2 header)
        let base_file = record.disk_info().to_path_buf();
        let parent = self.find_parent_base(&base_file);

        // Delete DB record and file
        let _ = self.store.delete(record.id());
        let _ = std::fs::remove_file(record.disk_info().as_path());

        tracing::info!(
            base_disk_id = %record.id(),
            "Garbage-collected clone base (no dependents)"
        );

        // Cascade to parent base disk
        if let Some(parent_path) = parent
            && let Ok(Some(parent_record)) =
                self.store.find_by_base_path(&parent_path.to_string_lossy())
        {
            self.try_gc_base(parent_record.id());
        }
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
        mgr.try_gc_base(&base_id("base0001"));

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
        mgr.try_gc_base(&base_id("base0002"));

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
        mgr.try_gc_base(&base_id("snap0001"));

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
        mgr.try_gc_base(&base_id("shared01"));

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
        mgr.try_gc_base(&base_id("shared01"));

        assert!(
            mgr.store()
                .find_by_id(&base_id("shared01"))
                .unwrap()
                .is_none(),
            "Base should be deleted (no more dependents)"
        );
        assert!(!base_file.exists());
    }
}
