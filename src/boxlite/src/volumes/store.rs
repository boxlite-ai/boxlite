//! Named-volume store and metadata type.
//!
//! [`VolumeInfo`] is the storage-agnostic view of a volume returned by the
//! [`VolumeBackend`](crate::runtime::volumes::VolumeBackend) trait and rendered
//! by the CLI. Volumes are addressed by a server-assigned id (like boxes).
//! [`NamedVolumeStore`] is the concrete local backend wired into
//! `impl VolumeBackend for LocalRuntime`: each volume lives in a directory
//! under `{home}/volumes/{id}`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

const ANONYMOUS_VOLUMES_DIR: &str = "anonymous";

/// Public metadata about a volume.
///
/// Mirrors the shape of [`crate::runtime::types::ImageInfo`]: a storage-agnostic
/// view suitable for CLI/table rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeInfo {
    /// Server-assigned volume id — the addressing key for get/remove.
    pub id: String,

    pub host_path: PathBuf,

    /// When the volume was created.
    pub created_at: DateTime<Utc>,

    /// Size of the payload in bytes, if it could be computed.
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct NamedVolumeStore {
    volumes_dir: PathBuf,
}

impl NamedVolumeStore {
    /// Create a store rooted at '{home_dir}/volumes'.
    pub fn new(home_dir: &Path) -> Self {
        Self {
            volumes_dir: home_dir.join("volumes"),
        }
    }

    /// Create a new volume and return its metadata (including the assigned id).
    pub fn create(&self) -> BoxliteResult<VolumeInfo> {
        let id = crate::runtime::id::BoxIDMint::mint().to_string();
        let dir = self.volumes_dir.join(&id);
        fs::create_dir_all(&dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to create volume dir {}: {}",
                dir.display(),
                e
            ))
        })?;
        Ok(VolumeInfo {
            id,
            host_path: dir,
            created_at: Utc::now(),
            size_bytes: None,
        })
    }

    /// List all named volume.
    pub fn list(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        let entries = match fs::read_dir(&self.volumes_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(BoxliteError::Storage(format!(
                    "failed to read volume dir {}: {}",
                    self.volumes_dir.display(),
                    e
                )));
            }
        };

        let mut infos = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ANONYMOUS_VOLUMES_DIR {
                continue;
            }
            infos.push(self.volume_info(name, &path));
        }
        Ok(infos)
    }

    /// Get metadata for a single volume by id.
    ///
    /// Returns `BoxliteError::NotFound` when no such volume exists.
    pub fn get(&self, id: &str) -> BoxliteResult<VolumeInfo> {
        let dir = self.volume_dir(id)?;
        if !dir.is_dir() {
            return Err(BoxliteError::NotFound(format!("volume not found: {id}")));
        }
        Ok(self.volume_info(id.to_string(), &dir))
    }

    /// Remove a volume by id. With `force`, a missing volume is a no-op.
    pub fn remove(&self, id: &str, force: bool) -> BoxliteResult<()> {
        let dir = self.volume_dir(id)?;
        if !dir.exists() {
            if force {
                return Ok(());
            }
            return Err(BoxliteError::NotFound(format!("volume not found: {id}")));
        }
        if !dir.is_dir() {
            return Err(BoxliteError::InvalidArgument(format!(
                "volume path is not a directory: {}",
                dir.display(),
            )));
        }
        fs::remove_dir_all(&dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to remove directory {}: {}",
                dir.display(),
                e,
            ))
        })
    }

    /// Resolve `{volumes_dir}/{id}` with a path-traversal guard:
    /// the id must be a single directory name, never a path.
    ///
    /// The reserved `anonymous/` subtree (the CLI's anonymous volumes) is also rejected — this store must never touch it, neither to list nor to delete.
    pub fn volume_dir(&self, id: &str) -> BoxliteResult<PathBuf> {
        if id.is_empty()
            || id == "."
            || id == ".."
            || id.contains('/')
            || id.contains('\\')
            || id == ANONYMOUS_VOLUMES_DIR
        {
            return Err(BoxliteError::InvalidArgument(format!(
                "invalid volume id: {id:?}"
            )));
        }
        Ok(self.volumes_dir.join(id))
    }

    pub fn volume_info(&self, id: String, dir: &Path) -> VolumeInfo {
        let created_at = fs::metadata(dir)
            .and_then(|m| m.modified())
            .ok()
            .map(DateTime::<Utc>::from)
            .unwrap_or_else(Utc::now);
        VolumeInfo {
            id,
            host_path: dir.to_path_buf(),
            created_at,
            size_bytes: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_then_get_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        let created = store.create().unwrap();

        assert!(created.host_path.is_dir());
        assert_eq!(
            created.host_path,
            tmp.path().join("volumes").join(&created.id)
        );

        let got = store.get(&created.id).unwrap();
        assert_eq!(got.id, created.id);
        assert_eq!(got.host_path, created.host_path);
    }

    #[test]
    fn list_lists_only_named_volumes() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        let volume1 = store.create().unwrap();
        let volume2 = store.create().unwrap();

        let anon = tmp.path().join("volumes").join("anonymous").join("ulid-x");
        fs::create_dir_all(&anon).unwrap();

        let ids: Vec<String> = store.list().unwrap().into_iter().map(|v| v.id).collect();

        assert!(ids.contains(&volume1.id));
        assert!(ids.contains(&volume2.id));
        assert_eq!(2, ids.len(), "anonymous volume must be excluded: {ids:?}");
    }

    #[test]
    fn remove_deletes_and_force_tolerates_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        let created = store.create().unwrap();

        store.remove(&created.id, false).unwrap();
        assert!(!created.host_path.exists());
        assert!(!tmp.path().join("volumes").join(&created.id).exists());

        let err = store.remove(&created.id, false).unwrap_err();
        assert!(matches!(err, BoxliteError::NotFound(_)));

        store.remove(&created.id, true).unwrap();
    }

    #[test]
    fn get_missing_volume_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        let err = store.get("foo").unwrap_err();

        assert!(matches!(err, BoxliteError::NotFound(_)));
    }

    #[test]
    fn traversal_ids_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        for bad in ["..", ".", "a/b", "a\\b", "../escape"] {
            assert!(
                store.get(bad).is_err(),
                "id {bad:?} must be rejected by get"
            );
            assert!(
                store.remove(bad, true).is_err(),
                "id {bad:?} must be rejected by remove"
            );
        }
    }

    #[test]
    fn reserved_anonymous_id_is_protected() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        // A real CLI anonymous volume living under volumes/anonymous/.
        let anon = tmp.path().join("volumes").join("anonymous").join("ulid-x");
        fs::create_dir_all(&anon).unwrap();

        assert!(
            store.get("anonymous").is_err(),
            "get must reject the reserved anonymous id"
        );
        assert!(
            store.remove("anonymous", true).is_err(),
            "remove must reject the reserved anonymous id"
        );
        assert!(
            anon.is_dir(),
            "anonymous volumes must survive a remove attempt"
        );
    }
}
