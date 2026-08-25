//! Named-volume store and metadata type.
//!
//! [`VolumeInfo`] is the storage-agnostic view of a volume returned by the
//! [`VolumeBackend`](crate::runtime::volumes::VolumeBackend) trait and rendered
//! by the CLI. Volumes are addressed by a server-assigned id (like boxes).
//! [`NamedVolumeStore`] is the concrete local backend wired into
//! `impl VolumeBackend for LocalRuntime`: each volume is a directory named by
//! its id, either directly under `{home}/volumes/` or, for the CLI's anonymous
//! mounts, under `{home}/volumes/anonymous/`. The id is the same either way —
//! only [`NamedVolumeStore::locate`] knows the two places apart.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::runtime::id::{VolumeID, VolumeIDMint};
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
        let id = VolumeIDMint::mint().to_string();
        let dir = self.volumes_dir.join(&id);
        fs::create_dir_all(&dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to create volume dir {}: {}",
                dir.display(),
                e
            ))
        })?;
        self.volume_info(id, &dir)
    }

    /// List every volume, named and anonymous alike.
    ///
    /// Anonymous volumes sit one level down, under `anonymous/` (the CLI puts
    /// them there — `cli.rs`), but each one is an ordinary volume with its own
    /// directory and its own id. Only `anonymous/` itself is not a volume: it
    /// is the container holding them.
    pub fn list(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        let mut infos = Vec::new();
        for root in [
            self.volumes_dir.clone(),
            self.volumes_dir.join(ANONYMOUS_VOLUMES_DIR),
        ] {
            let entries = match fs::read_dir(&root) {
                Ok(entries) => entries,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => {
                    return Err(BoxliteError::Storage(format!(
                        "failed to read volume dir {}: {}",
                        root.display(),
                        e
                    )));
                }
            };

            for entry in entries {
                let entry = entry.map_err(|e| {
                    BoxliteError::Storage(format!(
                        "failed to read an entry of volume dir {}: {}",
                        root.display(),
                        e
                    ))
                })?;
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ANONYMOUS_VOLUMES_DIR {
                    continue;
                }
                infos.push(self.volume_info(name, &path)?);
            }
        }
        Ok(infos)
    }

    /// Get metadata for a single volume by id.
    ///
    /// Returns `BoxliteError::NotFound` when no such volume exists.
    pub fn get(&self, id: &str) -> BoxliteResult<VolumeInfo> {
        match self.locate(id)? {
            Some(dir) => self.volume_info(id.to_string(), &dir),
            None => Err(BoxliteError::NotFound(format!("volume not found: {id}"))),
        }
    }

    /// Remove a volume by id. With `force`, a missing volume is a no-op.
    pub fn remove(&self, id: &str, force: bool) -> BoxliteResult<()> {
        let Some(dir) = self.locate(id)? else {
            if force {
                return Ok(());
            }
            return Err(BoxliteError::NotFound(format!("volume not found: {id}")));
        };
        fs::remove_dir_all(&dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to remove directory {}: {}",
                dir.display(),
                e,
            ))
        })
    }

    /// Find the directory holding `id`, wherever it lives.
    ///
    /// One flat id space, two locations: [`Self::create`] puts named volumes
    /// directly under `volumes/`, while the CLI's `-v {guest_path}` mounts land
    /// in `volumes/anonymous/`. The id never carries that difference — a volume
    /// is addressed by its directory name — so callers of `get`/`remove` do not
    /// have to know which kind they hold. Collapsing the two directories
    /// (docker's model) would delete this probe; until then it is the only
    /// place that knows about the split.
    fn locate(&self, id: &str) -> BoxliteResult<Option<PathBuf>> {
        let named = self.volume_dir(id)?;
        if named.is_dir() {
            return Ok(Some(named));
        }
        let anonymous = self.volumes_dir.join(ANONYMOUS_VOLUMES_DIR).join(id);
        Ok(anonymous.is_dir().then_some(anonymous))
    }

    /// Resolve the named location `{volumes_dir}/{id}`, with the id checked.
    ///
    /// [`VolumeID`]'s character set admits no `/`, `\` or `.`, so a valid id
    /// can only name a direct child — the traversal guard is the id format
    /// itself. `anonymous` is rejected separately: it parses as an id but names
    /// the subtree holding the CLI's anonymous volumes, and resolving it would
    /// let a caller address every one of them at once.
    fn volume_dir(&self, id: &str) -> BoxliteResult<PathBuf> {
        if !VolumeID::is_valid(id) || id == ANONYMOUS_VOLUMES_DIR {
            return Err(BoxliteError::InvalidArgument(format!(
                "invalid volume id: {id:?}"
            )));
        }
        Ok(self.volumes_dir.join(id))
    }

    /// Read a volume's metadata off its directory.
    ///
    /// `created_at` is the directory's birth time. The mtime cannot stand in for
    /// it: the mtime moves every time a box writes into the volume, so a
    /// volume's "creation" time would march forward with its contents.
    /// Filesystems that cannot report a birth time (`ErrorKind::Unsupported`)
    /// leave the mtime as the only available answer; any other IO error is a
    /// real failure and is reported, never papered over with the current time.
    fn volume_info(&self, id: String, dir: &Path) -> BoxliteResult<VolumeInfo> {
        let metadata = fs::metadata(dir).map_err(|e| {
            BoxliteError::Storage(format!("failed to stat volume {}: {}", dir.display(), e))
        })?;
        let created_at = match metadata.created() {
            Ok(created_at) => created_at,
            Err(e) if e.kind() == io::ErrorKind::Unsupported => {
                metadata.modified().map_err(|e| {
                    BoxliteError::Storage(format!(
                        "failed to read modification time of volume {}: {}",
                        dir.display(),
                        e
                    ))
                })?
            }
            Err(e) => {
                return Err(BoxliteError::Storage(format!(
                    "failed to read creation time of volume {}: {}",
                    dir.display(),
                    e
                )));
            }
        };
        Ok(VolumeInfo {
            id,
            host_path: dir.to_path_buf(),
            created_at: DateTime::<Utc>::from(created_at),
            size_bytes: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ULID, the shape the CLI mints for anonymous volumes.
    const ANONYMOUS_ULID: &str = "01JQZ8XK9V3TBN7WPM2R5CYH4E";

    use filetime::FileTime;

    /// The mtime of a volume directory moves whenever a box writes into it, so
    /// `created_at` must not be read from it — and `create()` must report the
    /// same instant that a later `get()` does.
    #[test]
    fn created_at_does_not_follow_the_directory_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        if fs::metadata(tmp.path()).unwrap().created().is_err() {
            eprintln!("skipped: this filesystem reports no birth time");
            return;
        }
        let store = NamedVolumeStore::new(tmp.path());
        let created = store.create().unwrap();

        // Stand in for a box writing into the volume: drive the directory mtime
        // forward to a fixed point rather than waiting for the clock to tick.
        // It has to move *forward* — macOS drags a file's birth time back to an
        // mtime set before it, which would hide the very drift under test.
        let later = FileTime::from_unix_time(2_000_000_000, 0); // 2033-05-18
        filetime::set_file_mtime(&created.host_path, later).unwrap();

        let got = store.get(&created.id).unwrap();
        assert_ne!(
            2_000_000_000,
            got.created_at.timestamp(),
            "created_at followed the mtime instead of the birth time"
        );
        assert_eq!(
            created.created_at, got.created_at,
            "create() and get() must report one created_at for the same volume"
        );
    }

    /// A volume whose directory cannot be stat'd has no creation time to
    /// report; the failure must reach the caller instead of being replaced by
    /// "just created".
    #[test]
    fn volume_info_reports_a_stat_failure_instead_of_inventing_created_at() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        let missing = store.volume_dir("gone").unwrap();

        let err = store.volume_info("gone".to_string(), &missing).unwrap_err();
        assert!(
            matches!(err, BoxliteError::Storage(_)),
            "unreadable volume dir must fail, got {err:?}"
        );
    }

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

    /// Every anonymous volume has its own directory, so each one is a volume in
    /// its own right; `anonymous/` is the container holding them, and is not.
    #[test]
    fn list_includes_anonymous_volumes_but_not_their_container() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        let volume1 = store.create().unwrap();
        let volume2 = store.create().unwrap();

        let anon = tmp
            .path()
            .join("volumes")
            .join("anonymous")
            .join(ANONYMOUS_ULID);
        fs::create_dir_all(&anon).unwrap();

        let ids: Vec<String> = store.list().unwrap().into_iter().map(|v| v.id).collect();

        assert!(ids.contains(&volume1.id), "{ids:?}");
        assert!(ids.contains(&volume2.id), "{ids:?}");
        assert!(
            ids.contains(&ANONYMOUS_ULID.to_string()),
            "the anonymous volume must be listed: {ids:?}"
        );
        assert!(
            !ids.contains(&"anonymous".to_string()),
            "the container directory is not a volume: {ids:?}"
        );
        assert_eq!(3, ids.len(), "{ids:?}");
    }

    /// An anonymous volume is addressed by the same flat id space as a named
    /// one — the caller never spells out where it is stored.
    #[test]
    fn anonymous_volumes_are_addressable_by_id() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        let anonymous_dir = tmp.path().join("volumes").join("anonymous");
        let mine = anonymous_dir.join(ANONYMOUS_ULID);
        let someone_elses = anonymous_dir.join("01JQZ8XK9V3TBN7WPM2R5CYH4F");
        fs::create_dir_all(&mine).unwrap();
        fs::create_dir_all(&someone_elses).unwrap();

        let got = store.get(ANONYMOUS_ULID).unwrap();
        assert_eq!(mine, got.host_path);

        store.remove(ANONYMOUS_ULID, false).unwrap();
        assert!(!mine.exists());
        assert!(
            someone_elses.is_dir(),
            "removing one anonymous volume must not touch its siblings"
        );
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

    /// The blacklist only knew five bad shapes, so everything else — spaces,
    /// leading dots, non-ASCII, control characters, ids of any length —
    /// became a real directory name. Asking [`VolumeID`] what a valid id is
    /// rejects them at the boundary instead, which is a different error than
    /// "no such volume".
    #[test]
    fn ids_outside_the_volume_id_character_set_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let store = NamedVolumeStore::new(tmp.path());
        let too_long = "a".repeat(VolumeID::MAX_LENGTH + 1);

        for bad in [
            "a b",
            ".hidden",
            "\u{65e5}\u{672c}",
            "a\u{0}b",
            too_long.as_str(),
        ] {
            assert!(
                matches!(
                    store.get(bad).unwrap_err(),
                    BoxliteError::InvalidArgument(_)
                ),
                "id {bad:?} must be rejected by get, not looked up"
            );
            assert!(
                matches!(
                    store.remove(bad, true).unwrap_err(),
                    BoxliteError::InvalidArgument(_)
                ),
                "id {bad:?} must be rejected by remove, not treated as missing"
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
