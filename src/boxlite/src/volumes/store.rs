//! Named-volume store and metadata type.
//!
//! [`VolumeInfo`] is the storage-agnostic view of a volume returned by the
//! [`VolumeBackend`](crate::runtime::volumes::VolumeBackend) trait and rendered
//! by the CLI. [`LocalVolumeStore`] is the concrete local backend wired into
//! `impl VolumeBackend for LocalRuntime`.
//!
//! On-disk shape under `{home}/volumes/`:
//!
//! ```text
//! {id}/                 one volume
//! {id}/.metadata.json   its name and creation time — host-only
//! {id}/_data/           its payload — the only part a box ever sees
//! ```
//!
//! A volume is one directory: creating it is a `mkdir` and one file, removing
//! it is one `remove_dir_all`, and no sidecar can outlive its payload or be
//! left behind by a crash between two deletes. The payload sits one level
//! down, as in docker's local driver (`volume/local/local.go:31,85`), because
//! the directory handed to a box is shared wholesale: a sidecar inside it
//! could be rewritten by the box to claim another volume's name. A volume
//! whose sidecar is missing anyway answers to its id alone (see `volume_info`).

use std::fs;
use std::io;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

use crate::runtime::id::{VolumeID, VolumeIDMint};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Sidecar file inside a volume's directory — beside the payload, never in it.
const METADATA_FILE: &str = ".metadata.json";

/// Payload directory inside a volume's directory; this, not the volume
/// directory, is what a box mounts.
const PAYLOAD_DIR: &str = "_data";

/// Public metadata about a volume.
///
/// Mirrors the shape of [`crate::runtime::types::ImageInfo`]: a storage-agnostic
/// view suitable for CLI/table rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeInfo {
    /// Server-assigned volume id — the addressing key for get/remove.
    pub id: String,

    /// Volume name, unique within the owning scope. Mountable in place of the
    /// id, so a box can name the volume it wants without knowing the id. The
    /// server defaults it to the id when the caller supplies none.
    pub name: String,

    /// When the volume was created.
    pub created_at: DateTime<Utc>,

    /// Size of the payload in bytes, if it could be computed.
    pub size_bytes: Option<u64>,
}

/// What the store persists about a volume, inside its directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VolumeMetadata {
    name: String,
    created_at: DateTime<Utc>,
}

/// Proof that the caller holds the volumes-directory lock.
///
/// Only [`LocalVolumeStore::lock`] hands one out and dropping it releases
/// the lock, so a critical section is exactly the scope this value lives
/// in. The two mutations that must not interleave with anything are here as
/// their already-locked bodies; the lock-free reads are forwarded too, so
/// one handle answers a whole section.
///
/// Being a type rather than a convention is the point: `flock` counts per
/// open file description and [`LocalVolumeStore::lock`] opens a new one on
/// every call, so a thread that took the lock twice would wait on itself
/// forever. Nothing reachable from here locks again, so that call cannot be
/// written.
#[derive(Debug)]
pub struct LockedVolumeStore<'a> {
    store: &'a LocalVolumeStore,
    _lock: fs::File,
}

impl LockedVolumeStore<'_> {
    /// [`LocalVolumeStore::create`], without taking the lock again.
    pub fn create(&self, name: Option<&str>) -> BoxliteResult<VolumeInfo> {
        self.store.create_locked(name)
    }

    /// Remove a volume by id or name. With `force`, a missing volume is a
    /// no-op.
    ///
    /// Only reachable through this handle, so a removal and a `create` of
    /// the same name cannot interleave into a torn scan. The lock the handle
    /// carries is held across `remove_dir_all`, so deleting a large payload
    /// stalls whoever wants the lock next. That is the price of keeping one
    /// kind of directory under `volumes/`; moving the payload to a trash
    /// directory first would buy concurrency at the cost of a second shape
    /// `list` has to know about.
    pub fn remove(&self, reference: &str, force: bool) -> BoxliteResult<()> {
        self.store.remove_locked(reference, force)
    }

    /// [`LocalVolumeStore::get`], which needs no lock; forwarded so a
    /// section holding this handle does not have to reach around it.
    pub fn get(&self, reference: &str) -> BoxliteResult<VolumeInfo> {
        self.store.get(reference)
    }

    /// [`LocalVolumeStore::payload_dir`], which needs no lock; see
    /// [`Self::get`].
    pub(crate) fn payload_dir(&self, reference: &str) -> BoxliteResult<PathBuf> {
        self.store.payload_dir(reference)
    }
}

#[derive(Debug, Clone)]
pub struct LocalVolumeStore {
    volumes_dir: PathBuf,
}

impl LocalVolumeStore {
    /// Create a store rooted at `{home_dir}/volumes`.
    pub fn new(home_dir: &Path) -> Self {
        Self {
            volumes_dir: home_dir.join("volumes"),
        }
    }

    /// The directory this store owns, and the file its lock is taken on.
    ///
    /// For the tests that have to park a runtime operation on that lock:
    /// deriving the path a second time would leave them locking somewhere
    /// else the day the layout moves. Test-only, because production code
    /// reaches the directory through the store rather than by path.
    #[cfg(test)]
    pub(crate) fn volumes_dir(&self) -> &Path {
        &self.volumes_dir
    }

    /// Take the volumes-directory lock, held until the returned handle
    /// drops.
    ///
    /// For a section that has to be one step against a concurrent removal --
    /// resolving a mount and then persisting the box that holds it, or
    /// scanning holders and then deleting -- rather than a single store
    /// call, which locks on its own. Blocking, so it belongs on the blocking
    /// pool and never on an async worker;
    /// `run_blocking_with_volume_store` in `runtime/rt_impl.rs` is where the
    /// runtime's sections take it.
    pub fn lock(&self) -> BoxliteResult<LockedVolumeStore<'_>> {
        Ok(LockedVolumeStore {
            store: self,
            _lock: self.lock_volumes_dir()?,
        })
    }

    /// Create a volume, naming it after its id when the caller supplies none.
    ///
    /// The name is what makes `-v my-data:/data` work without knowing the id,
    /// so it has to be unique: a duplicate would make that reference ambiguous
    /// and silently pick one of two volumes.
    pub fn create(&self, name: Option<&str>) -> BoxliteResult<VolumeInfo> {
        self.lock()?.create(name)
    }

    /// The body of [`Self::create`]; the caller holds the volumes-directory
    /// lock, so the uniqueness scan and the `mkdir` below are one step.
    fn create_locked(&self, name: Option<&str>) -> BoxliteResult<VolumeInfo> {
        let id = VolumeIDMint::mint().to_string();
        let name = match name {
            Some(name) => {
                validate_volume_name(name)?;
                // `locate`, not `find_by_name`: a name equal to another
                // volume's id would pass a name-only scan yet never resolve
                // to this volume, because `locate` tries the id first.
                if self.locate(name)?.is_some() {
                    return Err(BoxliteError::AlreadyExists(format!(
                        "a volume named {name:?} already exists"
                    )));
                }
                name.to_string()
            }
            None => id.clone(),
        };

        let payload = self.volumes_dir.join(&id).join(PAYLOAD_DIR);
        fs::create_dir_all(&payload).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to create volume dir {}: {}",
                payload.display(),
                e
            ))
        })?;

        let metadata = VolumeMetadata {
            name,
            created_at: Utc::now(),
        };

        if let Err(write_error) = self.write_metadata(&id, &metadata) {
            // A directory without a sidecar would list as an id-named volume,
            // so take it back out. The write error is the one worth reporting;
            // a cleanup failure only adds to it.
            let dir = self.volumes_dir.join(&id);
            if let Err(cleanup_error) = fs::remove_dir_all(&dir) {
                tracing::warn!(
                    volume = %id,
                    error = %cleanup_error,
                    "failed to remove the directory of a volume whose sidecar could not be written"
                );
            }
            return Err(write_error);
        }

        Ok(VolumeInfo {
            id,
            name: metadata.name,
            created_at: metadata.created_at,
            size_bytes: None,
        })
    }

    /// List every volume.
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
        for entry in entries {
            let entry = entry.map_err(|e| {
                BoxliteError::Storage(format!(
                    "failed to read an entry of volume dir {}: {}",
                    self.volumes_dir.display(),
                    e
                ))
            })?;
            let path = entry.path();
            if !is_valid_volume_dir(&path) {
                tracing::warn!(
                    path = %path.display(),
                    "not a valid volume directory"
                );
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if let Some(volume) = self.volume_info(id, &path)? {
                infos.push(volume);
            }
        }
        Ok(infos)
    }

    /// Get metadata for a single volume, by id or by name.
    ///
    /// Returns `BoxliteError::NotFound` when no such volume exists. Nothing in
    /// this store creates a volume as a side effect of looking one up.
    pub fn get(&self, reference: &str) -> BoxliteResult<VolumeInfo> {
        let Some((id, dir)) = self.locate(reference)? else {
            return Err(not_found(reference));
        };
        // The directory can vanish between `locate` and the stat below when a
        // removal races this call; to the caller that is simply "not found".
        self.volume_info(id, &dir)?
            .ok_or_else(|| not_found(reference))
    }

    /// The body of [`LockedVolumeStore::remove`]; the caller holds the
    /// volumes-directory lock, so the lookup and the `remove_dir_all` below
    /// are one step. There is deliberately no lock-taking wrapper beside
    /// `create`'s: every removal has a holder question to answer first, and
    /// the answer has to be found under the same lock that then deletes.
    fn remove_locked(&self, reference: &str, force: bool) -> BoxliteResult<()> {
        let Some((_, dir)) = self.locate(reference)? else {
            if force {
                return Ok(());
            }
            return Err(not_found(reference));
        };

        // The sidecar lives inside `dir`, so this frees the name too.
        fs::remove_dir_all(&dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to remove directory {}: {}",
                dir.display(),
                e,
            ))
        })
    }

    /// The directory a box mounts — the volume's `_data/`, never the volume
    /// directory itself, so the sidecar stays out of the guest's reach.
    ///
    /// Deliberately not a field of [`VolumeInfo`]: an end user names a volume
    /// by id or name, and a path on the server's disk is not something a REST
    /// client can act on — docker does return a `Mountpoint`, so this is a
    /// choice, not an impossibility. The answer is also local-only: a REST
    /// runtime has none to give, which is why this is a method on the local
    /// store rather than on the metadata or the `VolumeBackend` trait.
    ///
    /// A reference the store has never seen is `NotFound`, the same answer the
    /// hosted API gives: a mistyped `-v my-data:/data` must not quietly create
    /// an empty volume, least of all over REST where the caller cannot see the
    /// server's store. Anonymous mounts are the one way a mount creates a
    /// volume, and the runtime's resolution does that, not this method.
    /// Lock-free like [`Self::get`]: it only reads, and mounting an existing
    /// volume is the common path.
    pub(crate) fn payload_dir(&self, reference: &str) -> BoxliteResult<PathBuf> {
        let dir = match self.locate(reference)? {
            Some((_, dir)) => dir,
            None => return Err(not_found(reference)),
        };
        Ok(dir.join(PAYLOAD_DIR))
    }

    /// Find the directory holding `reference`, if any.
    ///
    /// An id names its directory directly, so it costs one `stat`; a name
    /// lives only in the sidecars, so it costs a scan.
    fn locate(&self, reference: &str) -> BoxliteResult<Option<(String, PathBuf)>> {
        validate_reference(reference)?;
        if VolumeID::is_valid(reference) {
            let dir = self.volumes_dir.join(reference);
            if is_valid_volume_dir(&dir) {
                return Ok(Some((reference.to_string(), dir)));
            }
        }
        self.find_by_name(reference)
    }

    /// Scan every volume for the one carrying `name`.
    fn find_by_name(&self, name: &str) -> BoxliteResult<Option<(String, PathBuf)>> {
        for volume in self.list()? {
            if volume.name == name {
                let dir = self.volumes_dir.join(&volume.id);
                return Ok(Some((volume.id, dir)));
            }
        }
        Ok(None)
    }

    /// Hold an exclusive `flock` on the volumes directory while it is mutated
    /// — `create` and `remove`.
    ///
    /// The lock guards the *name*, not the id: ids are minted unique, but two
    /// concurrent `create(Some("foo"))` would each scan the sidecars, find no
    /// `foo`, and both `mkdir`. Under the lock the scan and the `mkdir` are
    /// one step. Readers (`list`, `get`, `find_by_name`) stay lock-free and
    /// instead tolerate the two transient states a mutation can expose: a
    /// directory that vanishes mid-scan (`volume_info`) and a sidecar being
    /// replaced (`write_metadata`). The directory itself is the lock file, so
    /// nothing extra appears in `list`. Dropping the returned handle releases
    /// the lock.
    fn lock_volumes_dir(&self) -> BoxliteResult<fs::File> {
        fs::create_dir_all(&self.volumes_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to create volume dir {}: {}",
                self.volumes_dir.display(),
                e
            ))
        })?;
        let dir = fs::File::open(&self.volumes_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to open volume dir {} for locking: {}",
                self.volumes_dir.display(),
                e
            ))
        })?;
        // SAFETY: `dir` is an open descriptor for the whole call; flock(2) has
        // no other preconditions.
        if unsafe { libc::flock(dir.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(BoxliteError::Storage(format!(
                "failed to lock volume dir {}: {}",
                self.volumes_dir.display(),
                io::Error::last_os_error()
            )));
        }
        Ok(dir)
    }

    fn metadata_path(&self, id: &str) -> PathBuf {
        self.volumes_dir.join(id).join(METADATA_FILE)
    }

    /// Write the sidecar into the volume's directory, which [`Self::create`]
    /// has already made.
    fn write_metadata(&self, id: &str, metadata: &VolumeMetadata) -> BoxliteResult<()> {
        let path = self.metadata_path(id);
        // Written under a staging name and renamed into place: `rename` within
        // one directory is atomic, so a lock-free reader opens either no
        // sidecar or a whole one, never a truncated file. The staging name only
        // keeps the bytes in flight out of any reader's path.
        let staging = path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(metadata).map_err(|e| {
            BoxliteError::Storage(format!("failed to encode volume metadata for {id}: {e}"))
        })?;
        fs::write(&staging, body).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to write volume metadata {}: {}",
                staging.display(),
                e
            ))
        })?;
        fs::rename(&staging, &path).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to move volume metadata into place {}: {}",
                path.display(),
                e,
            ))
        })
    }

    /// Read a volume's sidecar. `None` when it has none, or when the file
    /// cannot be decoded.
    ///
    /// A missing sidecar is a volume created before sidecars existed. An
    /// undecodable one is treated the same way, with a warning, rather than
    /// failed on: this sits under `volume_info` → `list` → `find_by_name`,
    /// so one corrupt file would otherwise break name lookup for every
    /// volume — create, get, remove and mount alike. Demoting just that
    /// volume to answering by its id keeps the blast radius at one, at a
    /// price: while the sidecar stays broken its name is invisible to
    /// `create`'s uniqueness scan, so a new volume can take that name, and
    /// repairing the sidecar afterwards would leave two volumes answering
    /// to it. The warning is what points an operator at the file to fix.
    fn read_metadata(&self, id: &str) -> BoxliteResult<Option<VolumeMetadata>> {
        let path = self.metadata_path(id);
        let body = match fs::read(&path) {
            Ok(body) => body,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(BoxliteError::Storage(format!(
                    "failed to read volume metadata {}: {}",
                    path.display(),
                    e
                )));
            }
        };

        match serde_json::from_slice(&body) {
            Ok(metadata) => Ok(Some(metadata)),
            Err(e) => {
                tracing::warn!(
                    volume = %id,
                    path = %path.display(),
                    error = %e,
                    "ignoring undecodeable volume sidecar"
                );
                Ok(None)
            }
        }
    }

    /// Read a volume's metadata off its directory and sidecar.
    ///
    /// Without a sidecar the volume answers to its id alone and `created_at`
    /// is the directory's birth time. The mtime cannot stand in for it: it
    /// moves every time a box writes into the volume, so a volume's "creation"
    /// time would march forward with its contents. Filesystems that cannot
    /// report a birth time (`ErrorKind::Unsupported`) leave the mtime as the
    /// only available answer; any other IO error is a real failure and is
    /// reported, never papered over with the current time.
    ///
    /// `None` means the directory vanished between the caller's `read_dir`
    /// and the stat here: a volume being removed concurrently is not an error
    /// of the listing, it simply is no longer part of it.
    fn volume_info(&self, id: String, dir: &Path) -> BoxliteResult<Option<VolumeInfo>> {
        if let Some(meta) = self.read_metadata(&id)? {
            return Ok(Some(VolumeInfo {
                id,
                name: meta.name,
                created_at: meta.created_at,
                size_bytes: None,
            }));
        }

        let metadata = match fs::metadata(dir) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(BoxliteError::Storage(format!(
                    "failed to stat volume {}: {}",
                    dir.display(),
                    e
                )));
            }
        };
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
        Ok(Some(VolumeInfo {
            name: id.clone(),
            id,
            created_at: DateTime::<Utc>::from(created_at),
            size_bytes: None,
        }))
    }
}

fn not_found(reference: &str) -> BoxliteError {
    BoxliteError::NotFound(format!("volume not found: {reference}"))
}

/// A volume is a directory with a `_data/` payload, not any directory under
/// `volumes/`. Anyone upgrading has `volumes/anonymous/<ulid>/` there from the
/// CLI's old anonymous mounts; listed as a volume named `anonymous` it could
/// be mounted, and fail at boot for want of a payload, or removed with
/// `volume rm anonymous`, taking every old anonymous mount with it.
fn is_valid_volume_dir(path: &Path) -> bool {
    path.is_dir() && path.join(PAYLOAD_DIR).is_dir()
}

/// Reject a reference that is neither an id nor a name before it is used to
/// address anything.
///
/// Without this, `remove(reference, force = true)` would answer `Ok` for
/// `../escape`: the lookup finds nothing, and `force` reads "nothing to do".
/// A malformed reference is a caller error whether or not `force` is set, so
/// it has to fail before the not-found path can swallow it.
fn validate_reference(reference: &str) -> BoxliteResult<()> {
    if VolumeID::is_valid(reference) || validate_volume_name(reference).is_ok() {
        return Ok(());
    }
    Err(BoxliteError::InvalidArgument(format!(
        "invalid volume reference {reference:?}: expected a volume id or name"
    )))
}

/// Accept the names the CLI documents: 2-128 characters of
/// `[a-zA-Z0-9][a-zA-Z0-9_.-]`, the same rule docker's daemon applies
/// (`daemon/names/names.go:6-9`). A name is not a path component here — the
/// directory is always the id — but it is user-facing, so it stays printable
/// and shell-safe. The upper bound is `VolumeID::MAX_LENGTH` for the reason
/// ids have one: the name is written into the sidecar and echoed by every
/// listing, so it cannot be allowed to grow without limit.
fn validate_volume_name(name: &str) -> BoxliteResult<()> {
    let invalid = || {
        BoxliteError::InvalidArgument(format!(
            "invalid volume name {name:?}: at least two characters of \
             [a-zA-Z0-9][a-zA-Z0-9_.-]"
        ))
    };
    if name.len() < 2 || name.len() > VolumeID::MAX_LENGTH {
        return Err(invalid());
    }
    let mut bytes = name.bytes();
    let first = bytes.next().ok_or_else(invalid)?;
    if !first.is_ascii_alphanumeric() {
        return Err(invalid());
    }
    if !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-') {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_then_get_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let created = store.create(None).unwrap();

        let dir = store.payload_dir(&created.id).unwrap();
        assert!(dir.is_dir());
        let volume_dir = tmp.path().join("volumes").join(&created.id);
        assert_eq!(volume_dir.join("_data"), dir);
        assert!(
            volume_dir.join(".metadata.json").is_file(),
            "the sidecar lives in the volume's directory, beside the payload"
        );

        let got = store.get(&created.id).unwrap();
        assert_eq!(created.id, got.id);
        assert_eq!(created.created_at, got.created_at);
    }

    /// The server names a volume after its id when the caller supplies none —
    /// so a mount can always use the id, named or not.
    #[test]
    fn an_unnamed_volume_is_named_after_its_id() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let created = store.create(None).unwrap();

        assert_eq!(created.id, created.name);
        assert_eq!(created.id, store.get(&created.id).unwrap().name);
    }

    /// The name is the whole point of `-v my-data:/data`: it has to resolve to
    /// the same volume the id does, and it cannot be ambiguous.
    #[test]
    fn a_named_volume_answers_to_its_name() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let created = store.create(Some("my-data")).unwrap();

        let by_name = store.get("my-data").unwrap();
        assert_eq!(created.id, by_name.id);
        assert_eq!("my-data", by_name.name);
        assert_eq!(
            store.payload_dir(&created.id).unwrap(),
            store.payload_dir("my-data").unwrap()
        );

        let duplicate = store.create(Some("my-data")).unwrap_err();
        assert!(
            matches!(duplicate, BoxliteError::AlreadyExists(_)),
            "{duplicate:?}"
        );
    }

    /// `-v my-data:/data` on a name the store has never seen is refused, as
    /// the hosted API refuses it: the mount path is a lookup, never a create,
    /// so a typo cannot leave an empty volume behind.
    #[test]
    fn payload_dir_of_an_unknown_reference_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());

        let err = store.payload_dir("fresh-vol").unwrap_err();
        assert!(matches!(err, BoxliteError::NotFound(_)), "{err:?}");
        assert!(
            store.list().unwrap().is_empty(),
            "resolving a mount must not create a volume"
        );
    }

    /// `docker volume inspect typo` never creates anything; neither may `get`,
    /// or a typo in `boxlite volume get` would leave a stray volume behind.
    #[test]
    fn get_does_not_create_an_unknown_volume() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());

        let err = store.get("no-such-volume").unwrap_err();
        assert!(matches!(err, BoxliteError::NotFound(_)), "{err:?}");
        assert!(
            store.list().unwrap().is_empty(),
            "get must not create a volume"
        );
    }

    /// The directory handed to a box must not contain the sidecar: a box could
    /// otherwise rewrite its volume's name and hijack another volume's
    /// `-v name:/path`, or corrupt the file and break every name lookup.
    #[test]
    fn the_payload_directory_never_contains_the_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        store.create(Some("guarded")).unwrap();

        let payload = store.payload_dir("guarded").unwrap();
        assert!(
            !payload.join(".metadata.json").exists(),
            "the sidecar is reachable from the mount: {payload:?}"
        );
        assert!(
            payload.parent().unwrap().join(".metadata.json").is_file(),
            "the sidecar sits beside the payload, in the volume's directory"
        );
    }

    /// A volume removed while a listing is in flight is not an error of the
    /// listing: `volume_info` reports it as gone, `list` moves on, `get` says
    /// not found.
    #[test]
    fn a_directory_that_vanished_mid_scan_is_skipped_not_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let created = store.create(Some("vanishing")).unwrap();
        let dir = tmp.path().join("volumes").join(&created.id);
        std::fs::remove_dir_all(&dir).unwrap();

        assert!(
            store
                .volume_info(created.id.clone(), &dir)
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            store.get(&created.id),
            Err(BoxliteError::NotFound(_))
        ));
        assert!(store.list().unwrap().is_empty());
    }

    /// The sidecar is renamed into place, so no reader can see a partial file
    /// and no staging file is left behind.
    #[test]
    fn the_sidecar_is_written_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let created = store.create(Some("atomic")).unwrap();
        let dir = tmp.path().join("volumes").join(&created.id);

        assert!(dir.join(".metadata.json").is_file());
        assert!(!dir.join(".metadata.json.tmp").exists());
        let mut entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        entries.sort();
        assert_eq!(vec![".metadata.json", "_data"], entries);
    }

    /// A name that is another volume's id would pass a name-only scan yet
    /// never resolve to the new volume, because lookups try the id first.
    #[test]
    fn a_name_equal_to_another_volumes_id_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let first = store.create(Some("first")).unwrap();

        let err = store.create(Some(&first.id)).unwrap_err();
        assert!(matches!(err, BoxliteError::AlreadyExists(_)), "{err:?}");
        assert_eq!(1, store.list().unwrap().len());
    }

    /// `remove` mutates the volumes directory like `create`, so it takes the
    /// same lock; a removal racing a mount and a listing of the same name must
    /// never make any of the three fail with anything but "gone".
    #[test]
    fn concurrent_remove_mount_and_list_never_break_each_other() {
        use std::sync::{Arc, Barrier};

        type Op = Box<dyn Fn(&LocalVolumeStore) -> BoxliteResult<()> + Send>;
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(LocalVolumeStore::new(tmp.path()));
        for _ in 0..20 {
            store.create(Some("contended")).unwrap();
            let ops: Vec<Op> = vec![
                // The lock this takes is what the other two must survive.
                Box::new(|s| s.lock()?.remove("contended", true)),
                // A mount racing the removal may find the volume already gone;
                // that is "not found", never a torn read or a stray create.
                Box::new(|s| match s.payload_dir("contended") {
                    Ok(_) | Err(BoxliteError::NotFound(_)) => Ok(()),
                    Err(e) => Err(e),
                }),
                Box::new(|s| s.list().map(|_| ())),
            ];
            let barrier = Arc::new(Barrier::new(ops.len()));
            let handles: Vec<_> = ops
                .into_iter()
                .map(|op| {
                    let store = Arc::clone(&store);
                    let barrier = Arc::clone(&barrier);
                    std::thread::spawn(move || {
                        barrier.wait();
                        op(&store)
                    })
                })
                .collect();
            for handle in handles {
                handle
                    .join()
                    .unwrap()
                    .expect("no operation may fail because another one raced it");
            }
            store.lock().unwrap().remove("contended", true).unwrap();
        }
    }

    /// Two creates of one name at the same time must yield one volume: the
    /// uniqueness scan and the mkdir behind `create` are two steps, and only
    /// the lock on the volumes directory makes them one. The lock guards the
    /// name, not the id; ids are unique by construction.
    #[test]
    fn concurrent_creates_of_one_name_yield_one_volume() {
        use std::sync::{Arc, Barrier};

        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(LocalVolumeStore::new(tmp.path()));
        let threads = 8;
        let barrier = Arc::new(Barrier::new(threads));
        let results: Vec<BoxliteResult<VolumeInfo>> = (0..threads)
            .map(|_| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    store.create(Some("shared"))
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();

        assert_eq!(
            1,
            results.iter().filter(|r| r.is_ok()).count(),
            "{results:?}"
        );
        assert!(
            results
                .iter()
                .filter_map(|r| r.as_ref().err())
                .all(|e| matches!(e, BoxliteError::AlreadyExists(_))),
            "{results:?}"
        );
        assert_eq!(1, store.list().unwrap().len(), "one volume named shared");
    }

    #[test]
    fn names_outside_the_documented_set_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());

        for bad in [
            "a",
            "",
            "-leading",
            ".hidden",
            "has space",
            "sl/ash",
            "quo\"te",
        ] {
            assert!(
                matches!(
                    store.create(Some(bad)).unwrap_err(),
                    BoxliteError::InvalidArgument(_)
                ),
                "name {bad:?} must be rejected"
            );
        }
        assert!(store.create(Some("ok-name_1.2")).is_ok());
    }

    /// `remove` takes a name or an id, and both mean the same volume: the
    /// directory goes with its sidecar and so with its name, another volume
    /// is left alone, and the freed name can be taken again. With `force`, a
    /// volume that is already gone is a no-op under either reference.
    #[test]
    fn remove_by_name_or_by_id_deletes_payload_and_sidecar_and_frees_the_name() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        // How the test addresses the volume under test: by its name or by its id.
        type ReferenceOf = fn(&VolumeInfo) -> String;
        let by: [(&str, ReferenceOf); 2] = [("name", |v| v.name.clone()), ("id", |v| v.id.clone())];

        for (kind, reference_of) in by {
            let target = store.create(Some("gone-soon")).unwrap();
            let bystander = store.create(Some(&format!("stays-{kind}"))).unwrap();

            store
                .lock()
                .unwrap()
                .remove(&reference_of(&target), false)
                .unwrap_or_else(|e| panic!("remove by {kind} must succeed: {e:?}"));
            assert!(
                !tmp.path().join("volumes").join(&target.id).exists(),
                "removed by {kind}: the directory is gone"
            );
            assert!(
                matches!(store.get("gone-soon"), Err(BoxliteError::NotFound(_))),
                "removed by {kind}: the name no longer resolves"
            );
            assert_eq!(
                bystander.id,
                store.get(&bystander.name).unwrap().id,
                "removed by {kind}: another volume is untouched"
            );

            let err = store
                .lock()
                .unwrap()
                .remove(&reference_of(&target), false)
                .unwrap_err();
            assert!(matches!(err, BoxliteError::NotFound(_)), "{err:?}");
            store
                .lock()
                .unwrap()
                .remove(&reference_of(&target), true)
                .unwrap_or_else(|e| panic!("force by {kind} tolerates a missing volume: {e:?}"));
        }
        assert!(
            store.create(Some("gone-soon")).is_ok(),
            "a removed volume must not keep its name reserved"
        );
    }

    #[test]
    fn traversal_ids_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        for bad in ["..", ".", "a/b", "a\\b", "../escape", ""] {
            assert!(
                store.get(bad).is_err(),
                "id {bad:?} must be rejected by get"
            );
            assert!(
                store.lock().unwrap().remove(bad, true).is_err(),
                "id {bad:?} must be rejected by remove"
            );
        }
    }

    /// The metadata every surface renders from — CLI table, REST body, SDK
    /// object — must not carry the backing directory. See
    /// [`LocalVolumeStore::payload_dir`] for why the runtime asks separately.
    #[test]
    fn volume_info_does_not_carry_the_backing_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let created = store.create(None).unwrap();

        let rendered = serde_json::to_value(&created).unwrap();
        assert!(
            !rendered.as_object().unwrap().contains_key("host_path"),
            "volume metadata must not expose the backing directory: {rendered}"
        );

        // Destructuring fails to compile if a field is added, so a path that
        // comes back as a Rust field cannot slip in behind `#[serde(skip)]`.
        let VolumeInfo {
            id: _,
            name: _,
            created_at: _,
            size_bytes: _,
        } = created;
    }

    /// Only a directory with a `_data/` payload is a volume. The old CLI left
    /// `volumes/anonymous/<ulid>/` behind, and a bare id-shaped directory can
    /// be made by hand; neither may list, resolve, mount, or be removable, or
    /// `volume rm anonymous` would wipe every old anonymous mount at once.
    #[test]
    fn directories_without_a_payload_are_not_volumes() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let real = store.create(Some("real")).unwrap();
        let volumes = tmp.path().join("volumes");
        let legacy = volumes.join("anonymous").join("01ARZ3NDEKTSV4RRFFQ69G5FAV");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("old-data.txt"), b"keep me").unwrap();
        std::fs::create_dir(volumes.join("AbCdEfGhIjKl")).unwrap();

        let listed: Vec<String> = store.list().unwrap().into_iter().map(|v| v.id).collect();
        assert_eq!(vec![real.id.clone()], listed, "only the real volume lists");

        for stray in ["anonymous", "AbCdEfGhIjKl"] {
            assert!(
                matches!(store.get(stray), Err(BoxliteError::NotFound(_))),
                "{stray} must not resolve"
            );
            assert!(
                matches!(store.payload_dir(stray), Err(BoxliteError::NotFound(_))),
                "{stray} must not be mountable"
            );
            assert!(
                matches!(
                    store.lock().unwrap().remove(stray, false),
                    Err(BoxliteError::NotFound(_))
                ),
                "{stray} must not be removable"
            );
        }
        assert!(
            legacy.join("old-data.txt").is_file(),
            "a stray directory is left alone, never deleted"
        );
    }

    /// One unreadable sidecar demotes that volume to id-only; it must not
    /// take the listing, and with it every name lookup, down with it.
    #[test]
    fn a_corrupt_sidecar_demotes_only_its_own_volume() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let good = store.create(Some("good")).unwrap();
        let bad = store.create(Some("bad")).unwrap();
        std::fs::write(
            tmp.path()
                .join("volumes")
                .join(&bad.id)
                .join(".metadata.json"),
            b"{not json",
        )
        .unwrap();

        let listed = store.list().unwrap();
        assert_eq!(2, listed.len(), "{listed:?}");
        let demoted = listed.iter().find(|v| v.id == bad.id).unwrap();
        assert_eq!(
            bad.id, demoted.name,
            "a volume without usable metadata answers to its id"
        );

        assert_eq!(good.id, store.get("good").unwrap().id);
        assert_eq!(bad.id, store.get(&bad.id).unwrap().id);
        assert!(
            matches!(store.get("bad"), Err(BoxliteError::NotFound(_))),
            "the name lived only in the sidecar"
        );
        store.lock().unwrap().remove(&bad.id, false).unwrap();
        assert_eq!(1, store.list().unwrap().len());
    }

    /// Names share the id's length cap: unbounded, a multi-megabyte `--name`
    /// would be accepted and written into the sidecar.
    #[test]
    fn names_longer_than_an_id_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());

        let longest = "a".repeat(VolumeID::MAX_LENGTH);
        store.create(Some(&longest)).unwrap();

        let too_long = format!("{longest}a");
        let err = store.create(Some(&too_long)).unwrap_err();
        assert!(matches!(err, BoxliteError::InvalidArgument(_)), "{err:?}");
        assert!(
            matches!(store.get(&too_long), Err(BoxliteError::InvalidArgument(_))),
            "an over-long reference is rejected before any lookup"
        );
    }

    /// Mounting a volume that already exists is the common path and must not
    /// queue behind every create and remove on the machine: with the volumes
    /// directory locked by someone else, `payload_dir` of a known volume still
    /// answers, by id and by name.
    #[test]
    fn payload_dir_of_an_existing_volume_does_not_wait_for_the_lock() {
        use std::sync::mpsc;
        use std::time::Duration;

        let tmp = tempfile::tempdir().unwrap();
        let store = LocalVolumeStore::new(tmp.path());
        let created = store.create(Some("hot")).unwrap();

        let held = std::fs::File::open(tmp.path().join("volumes")).unwrap();
        assert_eq!(0, unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX) });

        let (tx, rx) = mpsc::channel();
        let by_id = created.id.clone();
        std::thread::spawn(move || {
            let store = LocalVolumeStore::new(tmp.path());
            let _ = tx.send((store.payload_dir(&by_id), store.payload_dir("hot")));
            drop(tmp);
        });
        let (by_id, by_name) = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("mounting an existing volume blocked on the volumes-directory lock");
        assert!(by_id.unwrap().ends_with("_data"));
        assert!(by_name.unwrap().ends_with("_data"));
        drop(held);
    }
}
