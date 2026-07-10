//! Named local-volume store (Docker `local` driver style).
//!
//! A named volume is a managed directory on the host, addressed by a short
//! name rather than an absolute path:
//!
//! ```text
//! <home>/volumes/<name>/
//! ├── _data/        # payload; what a future `-v name:path` bind-mounts
//! └── meta.json     # { "name", "created_at" (rfc3339), "size_gb"? }
//! ```
//!
//! This module owns the four management operations (`create`, `list`, `get`,
//! `remove`) plus name validation. Higher layers reach it via
//! [`VolumeStore`], which is the only public entry point — callers never
//! stitch together path math or metadata parsing themselves.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Payload subdirectory inside each volume dir. A future `-v name:path`
/// resolution binds *this* directory into the guest, not the metadata sibling.
const DATA_DIR: &str = "_data";

/// Per-volume metadata filename.
const META_FILE: &str = "meta.json";

/// Public metadata about a named local volume.
///
/// Mirrors the shape of [`crate::runtime::types::ImageInfo`]: a storage-agnostic
/// view suitable for CLI/table rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeInfo {
    /// User-facing volume name (a single path segment).
    pub name: String,

    /// Absolute path to the volume's `_data` payload directory. This is the
    /// mountpoint a future `-v name:path` would bind into the guest.
    pub mountpoint: PathBuf,

    /// When the volume was created.
    pub created_at: DateTime<Utc>,

    /// On-disk size of `_data` in bytes, if it could be computed.
    /// `None` when the payload could not be walked (e.g. transient I/O error).
    pub size_bytes: Option<u64>,
}

/// On-disk metadata persisted as `meta.json`.
///
/// Kept separate from [`VolumeInfo`] because it stores only what can't be
/// re-derived from the filesystem: the name, creation time, and the advisory
/// size request. `mountpoint`/`size_bytes` are computed on read.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VolumeMeta {
    name: String,
    created_at: DateTime<Utc>,
    /// Advisory size hint from `--size <GB>`. Stored only; not enforced for
    /// local directories (a plain dir has no quota).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    size_gb: Option<u64>,
}

/// Facade over `<home>/volumes` for managing named local volumes.
///
/// Holds only the root directory; every operation derives its paths from it.
#[derive(Clone, Debug)]
pub struct VolumeStore {
    volumes_dir: PathBuf,
}

impl VolumeStore {
    /// Create a store rooted at `volumes_dir` (typically
    /// `FilesystemLayout::volumes_dir()`). The directory is created lazily on
    /// the first `create`.
    pub fn new(volumes_dir: PathBuf) -> Self {
        Self { volumes_dir }
    }

    /// Create a new named volume.
    ///
    /// Validates `name`, then creates `<name>/_data` and writes `meta.json`.
    /// `size_gb` is stored as an advisory hint only (no quota is enforced for
    /// a local directory).
    ///
    /// # Errors
    /// - [`BoxliteError::InvalidArgument`] if `name` is not a valid segment.
    /// - [`BoxliteError::AlreadyExists`] if a volume of that name exists.
    /// - [`BoxliteError::Storage`] on filesystem failure.
    pub fn create(&self, name: &str, size_gb: Option<u64>) -> BoxliteResult<VolumeInfo> {
        validate_volume_name(name)?;

        let volume_dir = self.volume_dir(name);
        if volume_dir.exists() {
            return Err(BoxliteError::AlreadyExists(format!(
                "volume \"{name}\" already exists"
            )));
        }

        let data_dir = volume_dir.join(DATA_DIR);
        std::fs::create_dir_all(&data_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to create volume data dir for \"{name}\": {e}"
            ))
        })?;

        let meta = VolumeMeta {
            name: name.to_string(),
            created_at: Utc::now(),
            size_gb,
        };
        self.write_meta(name, &meta)?;

        Ok(self.info_from_meta(meta))
    }

    /// List all volumes, sorted by name.
    ///
    /// Skips directory entries that are missing or have an unreadable
    /// `meta.json` (they are not valid volumes managed by this store).
    pub fn list(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        let entries = match std::fs::read_dir(&self.volumes_dir) {
            Ok(entries) => entries,
            // No volumes dir yet → no volumes. Not an error.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(BoxliteError::Storage(format!(
                    "failed to read volumes dir {}: {e}",
                    self.volumes_dir.display()
                )));
            }
        };

        let mut infos = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| {
                BoxliteError::Storage(format!("failed to read volumes dir entry: {e}"))
            })?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // A directory without a readable meta.json isn't a managed volume.
            if let Ok(meta) = self.read_meta(&name) {
                infos.push(self.info_from_meta(meta));
            }
        }

        infos.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(infos)
    }

    /// Get metadata for a single volume by name.
    ///
    /// # Errors
    /// - [`BoxliteError::InvalidArgument`] if `name` is not a valid segment.
    /// - [`BoxliteError::NotFound`] if no such volume exists.
    pub fn get(&self, name: &str) -> BoxliteResult<VolumeInfo> {
        validate_volume_name(name)?;
        if !self.volume_dir(name).exists() {
            return Err(BoxliteError::NotFound(format!(
                "volume \"{name}\" not found"
            )));
        }
        let meta = self.read_meta(name)?;
        Ok(self.info_from_meta(meta))
    }

    /// Remove a volume by name.
    ///
    /// With `force=false`, a missing volume is an error. With `force=true`,
    /// removing a non-existent volume is a no-op (idempotent, matching
    /// `docker volume rm -f`).
    ///
    /// # Errors
    /// - [`BoxliteError::InvalidArgument`] if `name` is not a valid segment.
    /// - [`BoxliteError::NotFound`] if the volume is absent and `!force`.
    /// - [`BoxliteError::Storage`] on filesystem failure.
    // TODO(#942): reject removal of a volume that is currently bind-mounted
    // into a running box once `-v name:path` resolution is wired up.
    pub fn remove(&self, name: &str, force: bool) -> BoxliteResult<()> {
        validate_volume_name(name)?;
        let volume_dir = self.volume_dir(name);
        if !volume_dir.exists() {
            if force {
                return Ok(());
            }
            return Err(BoxliteError::NotFound(format!(
                "volume \"{name}\" not found"
            )));
        }
        std::fs::remove_dir_all(&volume_dir).map_err(|e| {
            BoxliteError::Storage(format!("failed to remove volume \"{name}\": {e}"))
        })?;
        Ok(())
    }

    // ── internals ──────────────────────────────────────────────────────────

    /// Directory for a single volume: `<volumes>/<name>`.
    ///
    /// Safe against traversal because every public entry validates `name`
    /// first (single segment, no `/`, `\`, `..`, or leading dot).
    fn volume_dir(&self, name: &str) -> PathBuf {
        self.volumes_dir.join(name)
    }

    fn meta_path(&self, name: &str) -> PathBuf {
        self.volume_dir(name).join(META_FILE)
    }

    fn write_meta(&self, name: &str, meta: &VolumeMeta) -> BoxliteResult<()> {
        let json = serde_json::to_string_pretty(meta).map_err(|e| {
            BoxliteError::Storage(format!("failed to serialize meta for \"{name}\": {e}"))
        })?;
        std::fs::write(self.meta_path(name), json)
            .map_err(|e| BoxliteError::Storage(format!("failed to write meta for \"{name}\": {e}")))
    }

    fn read_meta(&self, name: &str) -> BoxliteResult<VolumeMeta> {
        let path = self.meta_path(name);
        let bytes = std::fs::read(&path).map_err(|e| {
            BoxliteError::Storage(format!("failed to read {}: {e}", path.display()))
        })?;
        serde_json::from_slice(&bytes).map_err(|e| {
            BoxliteError::MetadataError(format!("invalid volume metadata {}: {e}", path.display()))
        })
    }

    /// Build the public view from persisted metadata, computing the live
    /// mountpoint and on-disk size.
    fn info_from_meta(&self, meta: VolumeMeta) -> VolumeInfo {
        let mountpoint = self.volume_dir(&meta.name).join(DATA_DIR);
        let size_bytes = dir_size_bytes(&mountpoint);
        VolumeInfo {
            name: meta.name,
            mountpoint,
            created_at: meta.created_at,
            size_bytes,
        }
    }
}

/// Validate a volume name: a single, safe path segment.
///
/// Rules (Docker-local-driver aligned, path-traversal safe):
/// - non-empty, at most 255 chars
/// - must match `[A-Za-z0-9][A-Za-z0-9_.-]*` (first char alphanumeric)
/// - rejects `/`, `\`, `..`, whitespace, and a leading dot
pub fn validate_volume_name(name: &str) -> BoxliteResult<()> {
    if name.is_empty() {
        return Err(BoxliteError::InvalidArgument(
            "volume name cannot be empty".into(),
        ));
    }
    if name.len() > 255 {
        return Err(BoxliteError::InvalidArgument(format!(
            "volume name too long ({} chars, max 255)",
            name.len()
        )));
    }

    let mut chars = name.chars();
    let first = chars.next().expect("non-empty checked above");
    if !first.is_ascii_alphanumeric() {
        return Err(BoxliteError::InvalidArgument(format!(
            "volume name \"{name}\" must start with an alphanumeric character"
        )));
    }
    for ch in name.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-';
        if !ok {
            return Err(BoxliteError::InvalidArgument(format!(
                "volume name \"{name}\" contains an invalid character {ch:?}; \
                 allowed: [A-Za-z0-9_.-], no whitespace or path separators"
            )));
        }
    }
    Ok(())
}

/// Sum the byte sizes of all regular files under `dir`.
///
/// Returns `None` if `dir` cannot be walked at all (e.g. it was removed
/// concurrently). Individual unreadable entries are skipped rather than
/// failing the whole computation, so a partial size is preferred over none.
fn dir_size_bytes(dir: &Path) -> Option<u64> {
    if !dir.exists() {
        return None;
    }
    let mut total: u64 = 0;
    for entry in walkdir::WalkDir::new(dir).into_iter().flatten() {
        if let Ok(meta) = entry.metadata()
            && meta.is_file()
        {
            total += meta.len();
        }
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a store over a fresh tempdir standing in for `<home>/volumes`.
    /// Returns the guard too so the dir outlives the store.
    fn temp_store() -> (tempfile::TempDir, VolumeStore) {
        let home = tempfile::TempDir::new().expect("tempdir");
        let store = VolumeStore::new(home.path().join("volumes"));
        (home, store)
    }

    #[test]
    fn create_lays_out_data_dir_and_meta() {
        let (_home, store) = temp_store();
        let info = store.create("data", None).expect("create");

        assert_eq!(info.name, "data");
        assert!(info.mountpoint.ends_with("volumes/data/_data"));
        assert!(info.mountpoint.is_dir(), "payload _data must exist");
        assert!(
            info.mountpoint
                .parent()
                .unwrap()
                .join("meta.json")
                .is_file(),
            "meta.json must be written next to _data"
        );
        // Fresh empty payload → zero bytes, not None.
        assert_eq!(info.size_bytes, Some(0));
    }

    #[test]
    fn create_rejects_duplicate() {
        let (_home, store) = temp_store();
        store.create("dup", None).expect("first create");
        let err = store.create("dup", None).expect_err("second must fail");
        assert!(
            matches!(err, BoxliteError::AlreadyExists(_)),
            "expected AlreadyExists, got {err:?}"
        );
        assert!(err.to_string().contains("already exists"));
    }

    #[test]
    fn list_returns_created_volumes_sorted() {
        let (_home, store) = temp_store();
        store.create("beta", None).unwrap();
        store.create("alpha", None).unwrap();

        let names: Vec<String> = store.list().unwrap().into_iter().map(|v| v.name).collect();
        assert_eq!(names, vec!["alpha", "beta"], "list is sorted by name");
    }

    #[test]
    fn list_is_empty_when_no_volumes_dir() {
        let (_home, store) = temp_store();
        // Never created anything, so <home>/volumes doesn't exist yet.
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn get_returns_metadata() {
        let (_home, store) = temp_store();
        let created = store.create("cfg", Some(5)).unwrap();

        let fetched = store.get("cfg").expect("get");
        assert_eq!(fetched.name, "cfg");
        assert_eq!(fetched.mountpoint, created.mountpoint);
        // created_at round-trips through rfc3339 serialization.
        assert_eq!(
            fetched.created_at.timestamp(),
            created.created_at.timestamp()
        );
    }

    #[test]
    fn get_missing_is_not_found() {
        let (_home, store) = temp_store();
        let err = store.get("ghost").expect_err("missing must fail");
        assert!(
            matches!(err, BoxliteError::NotFound(_)),
            "expected NotFound, got {err:?}"
        );
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn size_reflects_payload_bytes() {
        let (_home, store) = temp_store();
        let info = store.create("sized", None).unwrap();
        std::fs::write(info.mountpoint.join("blob"), b"0123456789").unwrap();

        let refreshed = store.get("sized").unwrap();
        assert_eq!(refreshed.size_bytes, Some(10));
    }

    #[test]
    fn remove_deletes_volume() {
        let (_home, store) = temp_store();
        let info = store.create("tmp", None).unwrap();
        let volume_dir = info.mountpoint.parent().unwrap().to_path_buf();
        assert!(volume_dir.exists());

        store.remove("tmp", false).expect("remove");
        assert!(!volume_dir.exists(), "volume dir must be gone");
        assert!(store.get("tmp").is_err(), "gone from get");
    }

    #[test]
    fn remove_missing_without_force_is_not_found() {
        let (_home, store) = temp_store();
        let err = store.remove("nope", false).expect_err("missing must fail");
        assert!(matches!(err, BoxliteError::NotFound(_)), "got {err:?}");
    }

    #[test]
    fn remove_missing_with_force_is_ok() {
        let (_home, store) = temp_store();
        store
            .remove("nope", true)
            .expect("force remove is idempotent");
    }

    // ── name validation ─────────────────────────────────────────────────────

    #[test]
    fn valid_names_accepted() {
        for name in ["a", "data", "my-vol", "vol_1", "v.2", "Cache99"] {
            assert!(
                validate_volume_name(name).is_ok(),
                "expected {name:?} to be valid"
            );
        }
    }

    #[test]
    fn traversal_and_separators_rejected() {
        for name in ["..", "../x", "a/b", "a\\b", "./x"] {
            let err = validate_volume_name(name).expect_err(&format!("{name:?} must be rejected"));
            assert!(
                matches!(err, BoxliteError::InvalidArgument(_)),
                "got {err:?}"
            );
        }
    }

    #[test]
    fn empty_whitespace_and_leading_dot_rejected() {
        for name in ["", " ", "a b", "\tvol", ".hidden", ".", "-lead"] {
            assert!(
                validate_volume_name(name).is_err(),
                "expected {name:?} to be rejected"
            );
        }
    }

    /// The store's mutating entry points reject a traversal name *before*
    /// touching the filesystem — a defense-in-depth check beyond the pure
    /// `validate_volume_name` unit tests.
    #[test]
    fn store_create_rejects_traversal_name() {
        let (_home, store) = temp_store();
        let err = store.create("../escape", None).expect_err("must reject");
        assert!(
            matches!(err, BoxliteError::InvalidArgument(_)),
            "got {err:?}"
        );
    }
}
