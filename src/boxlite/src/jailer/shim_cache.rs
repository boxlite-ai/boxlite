//! Content-addressed shim and firmware shared by jailed boxes in one runtime home.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use filetime::FileTime;
use parking_lot::{Mutex, RwLock};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::{self, Metadata};
use std::io::{self, Read, Seek, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, SystemTime};

/// Hidden completion marker written after all generation files are copied.
const STAMP: &str = ".complete";
/// Lock files and stable digest memos, keyed by logical source path.
const SOURCES_DIR: &str = ".sources";
const STAMP_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// Hidden namespace for temporary directories outside the published digest names.
const STAGING_PREFIX: &str = ".staging.";
/// Give in-progress staging an hour before treating its directory as abandoned.
const STAGING_ORPHAN_TTL: Duration = Duration::from_secs(60 * 60);
/// Retire idle debug generations after an hour to limit buildup from rebuilds.
const STALE_TTL_DEBUG: Duration = Duration::from_secs(60 * 60);
/// Keep idle release generations for a week so intermittent runs can reuse them.
const STALE_TTL_RELEASE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Skip memoization within two seconds of a source change to account for coarse timestamps.
const RACY_STAT_WINDOW: Duration = Duration::from_secs(2);
/// Record whether debug assertions are enabled so cleanup can pick the retention period.
const BUILD_PROFILE: &str = if cfg!(debug_assertions) {
    "debug"
} else {
    "release"
};
/// Use a 64-bit SHA-256 prefix to keep generation directory names short.
const DIGEST_BYTES: usize = 8;
/// A generation name has two hexadecimal digits per digest byte.
const DIGEST_HEX_LEN: usize = DIGEST_BYTES * 2;
/// Hash file contents in 64 KiB chunks to amortize reads.
const HASH_BUFFER_BYTES: usize = 64 * 1024;
/// Let everyone traverse staged directories and execute shims, with writes limited to the owner.
#[cfg(unix)]
const EXECUTABLE_MODE: u32 = 0o755;
/// Let everyone read firmware, with writes limited to the owner and no execute bits.
#[cfg(unix)]
const FIRMWARE_MODE: u32 = 0o644;
/// Synthetic read-only directory inside Bubblewrap for symlinked runtime layouts.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const BWRAP_SANDBOX_SHIM_DIR: &str = "/run/boxlite-shim";

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static MEMO: LazyLock<RwLock<HashMap<PathBuf, Arc<MemoEntry>>>> = LazyLock::new(RwLock::default);
static LIFECYCLE_LOCK: RwLock<()> = RwLock::new(());
type StageFlight = Mutex<Option<Arc<MemoEntry>>>;
type StageFlights = HashMap<(PathBuf, PathBuf), Weak<StageFlight>>;
static STAGE_FLIGHTS: LazyLock<Mutex<StageFlights>> = LazyLock::new(Mutex::default);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedRuntimeFile {
    pub(crate) canonical_source: PathBuf,
    pub(crate) logical_name: OsString,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ResolvedRuntimeFiles {
    pub(crate) files: Vec<ResolvedRuntimeFile>,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) has_symlink: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct BwrapShimMountPlan {
    pub(crate) ro_binds: Vec<(PathBuf, PathBuf)>,
    pub(crate) executable: PathBuf,
    pub(crate) ld_library_path: String,
}

fn shim_parent_dir(shim: &Path) -> &Path {
    shim.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

fn is_firmware_filename(filename: &OsStr, binary_name: &OsStr) -> bool {
    filename != binary_name && filename.as_encoded_bytes().starts_with(b"libkrunfw.")
}

/// Resolve `binary` and adjacent `libkrunfw.*` files in its directory.
///
/// Tracks each entry's canonical file path alongside its logical filename in
/// `binary`'s directory, plus whether `binary` or any `libkrunfw.*` entry is a
/// symlink. Non-existent or non-file binaries return an empty result.
pub(crate) fn resolve_runtime_files(binary: &Path) -> ResolvedRuntimeFiles {
    let Some(binary_name) = binary.file_name().filter(|name| !name.is_empty()) else {
        return ResolvedRuntimeFiles::default();
    };
    let dir = shim_parent_dir(binary);

    let Ok(link_meta) = fs::symlink_metadata(binary) else {
        return ResolvedRuntimeFiles::default();
    };
    let Ok(meta) = fs::metadata(binary) else {
        return ResolvedRuntimeFiles::default();
    };
    if !meta.is_file() {
        return ResolvedRuntimeFiles::default();
    }

    let mut has_symlink = link_meta.file_type().is_symlink();
    let canonical_binary = binary
        .canonicalize()
        .unwrap_or_else(|_| binary.to_path_buf());
    let mut files = vec![ResolvedRuntimeFile {
        canonical_source: canonical_binary,
        logical_name: binary_name.to_os_string(),
    }];

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let filename = entry.file_name();
            if !is_firmware_filename(&filename, binary_name) {
                continue;
            }
            let entry_path = entry.path();
            if fs::metadata(&entry_path).is_ok_and(|m| m.is_file()) {
                if fs::symlink_metadata(&entry_path).is_ok_and(|lm| lm.file_type().is_symlink()) {
                    has_symlink = true;
                }
                let canonical = entry_path.canonicalize().unwrap_or(entry_path);
                files.push(ResolvedRuntimeFile {
                    canonical_source: canonical,
                    logical_name: filename,
                });
            }
        }
    }

    files.sort_unstable_by(|a, b| a.logical_name.cmp(&b.logical_name));
    ResolvedRuntimeFiles { files, has_symlink }
}

/// Plan Bubblewrap read-only mounts, executable path, and `LD_LIBRARY_PATH` for `binary`.
///
/// When `binary` or any adjacent `libkrunfw.*` entry is a symlink (e.g., an
/// unstaged `target/<profile>/runtime/` fallback), resolved targets are mapped
/// into [`BWRAP_SANDBOX_SHIM_DIR`] so relative symlinks do not dangle or
/// collide with directory mounts inside the mount namespace. Normal staged
/// directories keep their direct paths with no extra mounts.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn plan_bwrap_shim_mounts(binary: &Path) -> BwrapShimMountPlan {
    let shim_dir = binary
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    let resolved = resolve_runtime_files(binary);
    if resolved.has_symlink
        && let Some(binary_name) = binary.file_name().filter(|name| !name.is_empty())
    {
        let sandbox_dir = Path::new(BWRAP_SANDBOX_SHIM_DIR);
        let ro_binds = resolved
            .files
            .into_iter()
            .map(|file| (file.canonical_source, sandbox_dir.join(file.logical_name)))
            .collect();
        let ld_library_path = if shim_dir.is_empty() {
            BWRAP_SANDBOX_SHIM_DIR.to_string()
        } else {
            format!("{BWRAP_SANDBOX_SHIM_DIR}:{shim_dir}")
        };
        return BwrapShimMountPlan {
            ro_binds,
            executable: sandbox_dir.join(binary_name),
            ld_library_path,
        };
    }

    BwrapShimMountPlan {
        ro_binds: Vec::new(),
        executable: binary.to_path_buf(),
        ld_library_path: shim_dir,
    }
}

#[derive(Clone, PartialEq, Eq)]
struct FileFingerprint {
    name: OsString,
    len: u64,
    mtime: FileTime,
    #[cfg(unix)]
    inode: (u64, u64),
    #[cfg(unix)]
    ctime: FileTime,
}

impl FileFingerprint {
    fn new(name: OsString, metadata: &Metadata) -> Self {
        Self {
            name,
            len: metadata.len(),
            mtime: FileTime::from_last_modification_time(metadata),
            #[cfg(unix)]
            inode: (metadata.dev(), metadata.ino()),
            #[cfg(unix)]
            ctime: FileTime::from_unix_time(metadata.ctime(), metadata.ctime_nsec() as u32),
        }
    }

    fn older_than(&self, cutoff: FileTime) -> bool {
        #[cfg(unix)]
        if self.ctime >= cutoff {
            return false;
        }
        self.mtime < cutoff
    }

    fn check_metadata(&self, path: &Path, metadata: &Metadata) -> io::Result<()> {
        if *self == Self::new(self.name.clone(), metadata) {
            return Ok(());
        }
        Err(io::Error::other(format!(
            "source changed: {}",
            path.display()
        )))
    }
}

struct MemoEntry {
    fingerprints: Vec<FileFingerprint>,
    digest: String,
}

fn collect_sources(shim: &Path, dir: &Path, name: &OsStr) -> io::Result<Vec<FileFingerprint>> {
    let metadata = fs::metadata(shim)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "shim must be a file",
        ));
    }
    let mut files = vec![FileFingerprint::new(name.to_os_string(), &metadata)];
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let filename = entry.file_name();
        if !is_firmware_filename(&filename, name) {
            continue;
        }
        match fs::metadata(entry.path()) {
            Ok(metadata) if metadata.is_file() => {
                files.push(FileFingerprint::new(filename, &metadata));
            }
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    files.sort_unstable_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn memoized_digest(key: &Path, files: &[FileFingerprint]) -> Option<Arc<MemoEntry>> {
    MEMO.read()
        .get(key)
        .filter(|entry| entry.fingerprints == files)
        .cloned()
}

fn remember_digest(key: &Path, entry: &Arc<MemoEntry>) {
    MEMO.write().insert(key.to_path_buf(), Arc::clone(entry));
}

fn stable_sources(files: &[FileFingerprint], now: SystemTime) -> bool {
    // Coarse file timestamps can alias writes made close to the hash read.
    let cutoff = FileTime::from_system_time(now - RACY_STAT_WINDOW);
    files.iter().all(|f| f.older_than(cutoff))
}

fn digest_at(
    key: &Path,
    dir: &Path,
    files: &[FileFingerprint],
    now: SystemTime,
) -> io::Result<Arc<MemoEntry>> {
    if let Some(entry) = memoized_digest(key, files) {
        return Ok(entry);
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; HASH_BUFFER_BYTES];
    for source in files {
        let name = source.name.as_encoded_bytes();
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name);
        hash.update(source.len.to_le_bytes());
        let path = dir.join(&source.name);
        let mut file = fs::File::open(&path)?;
        loop {
            let len = file.read(&mut buffer)?;
            if len == 0 {
                break;
            }
            hash.update(&buffer[..len]);
        }
        source.check_metadata(&path, &file.metadata()?)?;
    }
    let entry = Arc::new(MemoEntry {
        fingerprints: files.to_vec(),
        digest: hex::encode(&hash.finalize()[..DIGEST_BYTES]),
    });
    if stable_sources(files, now) {
        remember_digest(key, &entry);
    }
    Ok(entry)
}

fn digest_name(bytes: &[u8]) -> bool {
    bytes.len() == DIGEST_HEX_LEN
        && bytes
            .iter()
            .all(|&b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn lock_source(cache_dir: &Path, source_key: &Path) -> io::Result<fs::File> {
    let locks = cache_dir.join(SOURCES_DIR);
    fs::create_dir_all(&locks)?;
    let name = hex::encode(Sha256::digest(source_key.as_os_str().as_encoded_bytes()));
    // Never unlink lock files: waiters may still have the original inode open.
    let file = fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(locks.join(name))?;
    loop {
        // SAFETY: the descriptor is open for the lifetime of `file`. Closing
        // it releases the lock, including on errors and process exit.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(file);
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

fn fingerprint_key(files: &[FileFingerprint]) -> [u8; 32] {
    let mut hash = Sha256::new();
    for f in files {
        let name = f.name.as_encoded_bytes();
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name);
        hash.update(f.len.to_le_bytes());
        for t in [f.mtime, f.ctime] {
            hash.update(t.unix_seconds().to_le_bytes());
            hash.update(t.nanoseconds().to_le_bytes());
        }
        hash.update(f.inode.0.to_le_bytes());
        hash.update(f.inode.1.to_le_bytes());
    }
    hash.finalize().into()
}

fn read_digest(mut lock: &fs::File, key: &[u8; 32]) -> Option<String> {
    let mut record = [0; 32 + DIGEST_HEX_LEN];
    lock.read_exact(&mut record).ok()?;
    let (stored_key, digest) = record.split_at(32);
    (stored_key == key && digest_name(digest)).then(|| String::from_utf8_lossy(digest).into_owned())
}

fn write_digest(mut lock: &fs::File, key: &[u8; 32], digest: &str) -> io::Result<()> {
    lock.rewind()?;
    lock.set_len(0)?;
    lock.write_all(key)?;
    lock.write_all(digest.as_bytes())
}

fn complete_stamp(target: &Path, files: &[FileFingerprint]) -> Option<Metadata> {
    let stamp = fs::metadata(target.join(STAMP)).ok()?;
    (stamp.is_file()
        && files.iter().all(|file| {
            fs::metadata(target.join(&file.name))
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() == file.len)
        }))
    .then_some(stamp)
}

fn refresh_stamp(path: &Path, stamp: &Metadata, now: SystemTime) {
    if refresh_due(stamp, now) {
        let _ = filetime::set_file_mtime(path.join(STAMP), FileTime::from_system_time(now));
    }
}

fn refresh_due(stamp: &Metadata, now: SystemTime) -> bool {
    stamp.modified().is_ok_and(|time| {
        now.duration_since(time)
            .is_ok_and(|age| age >= STAMP_REFRESH_INTERVAL)
    })
}

fn cache_hit(target: &Path, files: &[FileFingerprint]) -> bool {
    {
        let _lock = LIFECYCLE_LOCK.read();
        let Some(stamp) = complete_stamp(target, files) else {
            return false;
        };
        if !refresh_due(&stamp, SystemTime::now()) {
            return true;
        }
    }
    // Recheck in case another hit refreshed the stamp or GC retired it.
    let _lock = LIFECYCLE_LOCK.write();
    let Some(stamp) = complete_stamp(target, files) else {
        return false;
    };
    refresh_stamp(target, &stamp, SystemTime::now());
    true
}

struct StagingGuard {
    path: PathBuf,
    published: bool,
}

impl StagingGuard {
    fn publish(mut self, target: &Path, files: &[FileFingerprint]) -> io::Result<bool> {
        let _lock = LIFECYCLE_LOCK.write();
        match fs::rename(&self.path, target) {
            Ok(()) => self.published = true,
            Err(err) => {
                let stamp = complete_stamp(target, files).ok_or(err)?;
                refresh_stamp(target, &stamp, SystemTime::now());
            }
        }
        Ok(self.published)
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub(crate) fn stage_shim(shim_path: &Path, cache_dir: &Path) -> BoxliteResult<PathBuf> {
    stage(shim_path, cache_dir).map_err(|err| {
        BoxliteError::Storage(format!(
            "failed to stage shim {} in {}: {err}",
            shim_path.display(),
            cache_dir.display(),
        ))
    })
}

fn stage(shim_path: &Path, cache_dir: &Path) -> io::Result<PathBuf> {
    stage_with(shim_path, cache_dir, SystemTime::now(), digest_at)
}

fn stage_with(
    shim_path: &Path,
    cache_dir: &Path,
    now: SystemTime,
    digest: impl FnOnce(&Path, &Path, &[FileFingerprint], SystemTime) -> io::Result<Arc<MemoEntry>>,
) -> io::Result<PathBuf> {
    let name = shim_path
        .file_name()
        .filter(|name| !name.is_empty() && *name != STAMP)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid shim filename"))?;
    let dir = shim_parent_dir(shim_path);
    // Keep the logical filename and parent (which selects adjacent firmware),
    // rather than keying by the destination of a shim symlink.
    let source_key = dir.canonicalize()?.join(name);
    let files = collect_sources(shim_path, dir, name)?;
    if let Some(entry) = memoized_digest(&source_key, &files)
        && let Some(path) = cached_path(cache_dir, name, &entry)
    {
        return Ok(path);
    }

    fs::create_dir_all(cache_dir)?;
    let cache_dir = cache_dir.canonicalize()?;
    let flight = {
        let mut flights = STAGE_FLIGHTS.lock();
        flights.retain(|_, flight| flight.strong_count() != 0);
        let entry = flights
            .entry((cache_dir.clone(), source_key.clone()))
            .or_default();
        entry.upgrade().unwrap_or_else(|| {
            let flight = Arc::new(Mutex::new(None));
            *entry = Arc::downgrade(&flight);
            flight
        })
    };
    let mut recent = flight.lock();
    if let Some(entry) = recent.as_ref()
        && entry.fingerprints == collect_sources(shim_path, dir, name)?
        && let Some(path) = cached_path(&cache_dir, name, entry)
    {
        return Ok(path);
    }

    let lock = lock_source(&cache_dir, &source_key)?;
    // The source may have changed while another process held the lock.
    let files = collect_sources(shim_path, dir, name)?;
    let key = stable_sources(&files, now).then(|| fingerprint_key(&files));
    if let Some(key) = &key
        && let Some(digest) = read_digest(&lock, key)
    {
        let entry = Arc::new(MemoEntry {
            fingerprints: files.clone(),
            digest,
        });
        if let Some(path) = cached_path(&cache_dir, name, &entry) {
            remember_digest(&source_key, &entry);
            *recent = Some(entry);
            return Ok(path);
        }
    }
    let entry = digest(&source_key, dir, &files, now)?;
    let target = cache_dir.join(&entry.digest);
    if !cache_hit(&target, &files) {
        publish_generation(&cache_dir, &target, name, dir, &entry)?;
    }
    if let Some(key) = &key {
        let _ = write_digest(&lock, key, &entry.digest);
    }
    *recent = Some(entry);
    Ok(target.canonicalize().unwrap_or(target).join(name))
}

fn cached_path(cache_dir: &Path, name: &OsStr, entry: &MemoEntry) -> Option<PathBuf> {
    let target = cache_dir.join(&entry.digest);
    cache_hit(&target, &entry.fingerprints)
        .then(|| target.canonicalize().unwrap_or(target).join(name))
}

fn publish_generation(
    cache_dir: &Path,
    target: &Path,
    name: &OsStr,
    dir: &Path,
    entry: &MemoEntry,
) -> io::Result<()> {
    let digest = &entry.digest;
    let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = cache_dir.join(format!(
        "{STAGING_PREFIX}{digest}.{}.{seq}",
        std::process::id()
    ));
    fs::create_dir(&path)?;
    let staging = StagingGuard {
        path,
        published: false,
    };
    #[cfg(unix)]
    fs::set_permissions(&staging.path, fs::Permissions::from_mode(EXECUTABLE_MODE))?;

    for source in &entry.fingerprints {
        let path = dir.join(&source.name);
        let destination = staging.path.join(&source.name);
        fs::copy(&path, &destination)?;
        let metadata = fs::metadata(&path)?;
        source.check_metadata(&path, &metadata)?;
        #[cfg(unix)]
        {
            let mode = if source.name == name {
                EXECUTABLE_MODE
            } else {
                FIRMWARE_MODE
            };
            fs::set_permissions(&destination, fs::Permissions::from_mode(mode))?;
        }
    }
    fs::write(
        staging.path.join(STAMP),
        format!("{}\n{BUILD_PROFILE}\n", crate::VERSION),
    )?;
    if staging.publish(target, &entry.fingerprints)? {
        tracing::info!(path = %target.display(), "Published shared shim");
        cleanup_stale(cache_dir, Some(target));
    }
    Ok(())
}

fn published_metadata(path: &Path) -> io::Result<Metadata> {
    fs::metadata(path.join(STAMP)).or_else(|_| fs::metadata(path))
}

fn is_expired(metadata: io::Result<Metadata>, now: SystemTime, ttl: Duration) -> bool {
    metadata
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|time| now.duration_since(time).is_ok_and(|age| age > ttl))
}

fn retire_if_stale(
    path: &Path,
    reap_dir: &Path,
    now: SystemTime,
    ttl: Duration,
) -> io::Result<bool> {
    let _lock = LIFECYCLE_LOCK.write();
    if !is_expired(published_metadata(path), now, ttl) {
        return Ok(false);
    }
    fs::rename(path, reap_dir)?;
    Ok(true)
}

pub(crate) fn cleanup_stale(cache_dir: &Path, active_dir: Option<&Path>) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let active_canonical = active_dir.and_then(|path| path.canonicalize().ok());
    let now = SystemTime::now();
    for entry in entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|ty| ty.is_dir()))
    {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.as_encoded_bytes();
        if name.starts_with(STAGING_PREFIX.as_bytes()) {
            if is_expired(entry.metadata(), now, STAGING_ORPHAN_TTL) {
                let _ = fs::remove_dir_all(&path);
            }
            continue;
        }
        if !digest_name(name) {
            continue;
        }
        if active_dir == Some(path.as_path())
            || active_canonical
                .as_ref()
                .is_some_and(|active| path.canonicalize().is_ok_and(|p| p == *active))
        {
            continue;
        }
        let profile = fs::read_to_string(path.join(STAMP)).unwrap_or_default();
        // A hit may skip a stamp write for up to one refresh interval.
        let ttl = match profile.lines().nth(1) {
            Some("debug") => STALE_TTL_DEBUG,
            _ => STALE_TTL_RELEASE,
        } + STAMP_REFRESH_INTERVAL;
        if !is_expired(published_metadata(&path), now, ttl) {
            continue;
        }

        // Move the digest out of the cache namespace before deleting its contents.
        let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let reap_dir = cache_dir.join(format!("{STAGING_PREFIX}reap.{}.{seq}", std::process::id()));
        match retire_if_stale(&path, &reap_dir, now, ttl) {
            Ok(true) => {
                let _ = fs::remove_dir_all(&reap_dir);
            }
            Ok(false) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "Failed to retire shared shim directory")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use filetime::set_file_mtime;
    use tempfile::{TempDir, tempdir};

    fn fixture() -> (TempDir, PathBuf, PathBuf) {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let shim = source.join("boxlite-shim");
        fs::write(&shim, b"shim").unwrap();
        let cache = root.path().join("shims");
        (root, shim, cache)
    }

    #[test]
    #[cfg(unix)]
    fn stage_shim_copies_shim_and_libkrunfw_with_permissions() {
        let (_root, shim, cache) = fixture();
        let firmware = shim.with_file_name("libkrunfw.so.5");
        fs::write(&firmware, b"firmware").unwrap();
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&firmware, fs::Permissions::from_mode(0o600)).unwrap();
        fs::create_dir(shim.with_file_name("libkrunfw.directory")).unwrap();
        fs::write(shim.with_file_name("libkrun.so"), b"other").unwrap();

        let staged = stage_shim(&shim, &cache).unwrap();
        let dir = staged.parent().unwrap();
        assert_eq!(dir.file_name().unwrap(), "25003b18fa290e6b");
        let library = dir.join(firmware.file_name().unwrap());
        assert_eq!(fs::read(&staged).unwrap(), b"shim");
        assert_eq!(fs::read(&library).unwrap(), b"firmware");
        assert_eq!(fs::metadata(dir).unwrap().mode() & 0o777, 0o755);
        assert_eq!(fs::metadata(&staged).unwrap().mode() & 0o777, 0o755);
        assert_eq!(fs::metadata(library).unwrap().mode() & 0o777, 0o644);
        assert_eq!(fs::read_dir(dir).unwrap().count(), 3);
        let stamp = fs::read_to_string(dir.join(STAMP)).unwrap();
        assert_eq!(stamp, format!("{}\n{BUILD_PROFILE}\n", crate::VERSION));
    }

    #[test]
    #[cfg(unix)]
    fn stage_shim_normalizes_writable_source_permissions() {
        let (_root, shim, cache) = fixture();
        let firmware = shim.with_file_name("libkrunfw.so.5");
        fs::write(&firmware, b"firmware").unwrap();
        for path in [&shim, &firmware] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o777)).unwrap();
        }
        let staged = stage_shim(&shim, &cache).unwrap();
        assert_eq!(fs::metadata(&staged).unwrap().mode() & 0o777, 0o755);
        let library = staged.with_file_name(firmware.file_name().unwrap());
        assert_eq!(fs::metadata(library).unwrap().mode() & 0o777, 0o644);
    }

    #[test]
    #[cfg(unix)]
    fn stage_shim_reuses_same_inode_without_recopy() {
        let (_root, shim, cache) = fixture();
        let staged = stage_shim(&shim, &cache).unwrap();
        let inode = fs::metadata(&staged).unwrap().ino();
        let stamp = staged.with_file_name(STAMP);
        let old = FileTime::from_unix_time(1, 0);
        set_file_mtime(&stamp, old).unwrap();

        assert_eq!(stage_shim(&shim, &cache).unwrap(), staged);
        assert_eq!(fs::metadata(staged).unwrap().ino(), inode);
        assert!(FileTime::from_last_modification_time(&fs::metadata(stamp).unwrap()) > old);
    }

    #[test]
    fn stage_shim_throttles_stamp_refresh() {
        let (_root, shim, cache) = fixture();
        let staged = stage_shim(&shim, &cache).unwrap();
        let stamp = staged.with_file_name(STAMP);
        let mtime = || FileTime::from_last_modification_time(&fs::metadata(&stamp).unwrap());
        set_file_mtime(
            &stamp,
            FileTime::from_system_time(SystemTime::now() - STAMP_REFRESH_INTERVAL / 2),
        )
        .unwrap();
        let recent = mtime();
        assert_eq!(stage_shim(&shim, &cache).unwrap(), staged);
        assert_eq!(mtime(), recent);
        set_file_mtime(
            &stamp,
            FileTime::from_system_time(SystemTime::now() - 2 * STAMP_REFRESH_INTERVAL),
        )
        .unwrap();
        assert_eq!(stage_shim(&shim, &cache).unwrap(), staged);
        assert!(mtime() > recent);
    }

    #[test]
    #[cfg(unix)]
    fn stage_shim_follows_symlinked_sources() {
        use std::os::unix::fs::symlink;

        let (root, shim, cache) = fixture();
        let real_shim = root.path().join("installed-shim");
        fs::rename(&shim, &real_shim).unwrap();
        symlink(real_shim, &shim).unwrap();
        let firmware = root.path().join("installed-firmware");
        fs::write(&firmware, b"firmware").unwrap();
        symlink(firmware, shim.with_file_name("libkrunfw.dylib")).unwrap();
        symlink("missing", shim.with_file_name("libkrunfw.broken")).unwrap();

        let staged = stage_shim(&shim, &cache).unwrap();
        let library = staged.with_file_name("libkrunfw.dylib");
        for (path, contents) in [(&staged, &b"shim"[..]), (&library, &b"firmware"[..])] {
            assert!(fs::symlink_metadata(path).unwrap().is_file());
            assert_eq!(fs::read(path).unwrap(), contents);
        }
        assert!(!staged.with_file_name("libkrunfw.broken").exists());
    }

    #[test]
    #[cfg(unix)]
    fn stage_shim_rejects_firmware_symlink_loop() {
        let (_root, shim, cache) = fixture();
        let firmware = shim.with_file_name("libkrunfw.loop");
        std::os::unix::fs::symlink("libkrunfw.loop", &firmware).unwrap();
        let expected = io::Error::from_raw_os_error(libc::ELOOP).to_string();

        let err = stage_shim(&shim, &cache).expect_err("firmware metadata error must fail staging");
        assert!(err.to_string().contains(&expected), "{err}");
    }

    #[test]
    fn stage_shim_content_change_creates_new_digest_dir() {
        let (_root, shim, cache) = fixture();
        let firmware = shim.with_file_name("libkrunfw.so.5");
        fs::write(&firmware, b"firmware v1").unwrap();
        let first = stage_shim(&shim, &cache).unwrap();
        let mtime = FileTime::from_last_modification_time(&fs::metadata(&firmware).unwrap());
        fs::write(&firmware, b"firmware v2").unwrap();
        set_file_mtime(&firmware, mtime).unwrap();
        let second = stage_shim(&shim, &cache).unwrap();
        fs::write(&shim, b"shim v2").unwrap();
        let third = stage_shim(&shim, &cache).unwrap();

        assert_ne!(first.parent(), second.parent());
        assert_ne!(second.parent(), third.parent());
        assert_eq!(
            fs::read(first.with_file_name("libkrunfw.so.5")).unwrap(),
            b"firmware v1"
        );
        assert_eq!(
            fs::read(second.with_file_name("libkrunfw.so.5")).unwrap(),
            b"firmware v2"
        );
        assert_eq!(fs::read(third).unwrap(), b"shim v2");
    }

    #[test]
    #[cfg(unix)]
    fn digest_memo_reuses_entry_until_source_changes() {
        let (_root, shim, _cache) = fixture();
        let dir = shim.parent().unwrap();
        let name = shim.file_name().unwrap();
        let key = shim.canonicalize().unwrap();
        let files = collect_sources(&shim, dir, name).unwrap();
        let now = SystemTime::now() + 2 * RACY_STAT_WINDOW;
        let first = digest_at(&key, dir, &files, now).unwrap();
        let entry = || MEMO.read().get(&key).cloned().unwrap();
        assert!(Arc::ptr_eq(&first, &entry()));
        assert!(Arc::ptr_eq(
            &first,
            &digest_at(&key, dir, &files, now).unwrap()
        ));

        let mtime = files[0].mtime;
        let prev_inode = files[0].inode;
        // Replace atomically via rename so the inode changes deterministically even
        // when coarse ctime ticks would otherwise leave the metadata fingerprint equal.
        let replacement = dir.join("boxlite-shim.new");
        fs::write(&replacement, b"edit").unwrap();
        set_file_mtime(&replacement, mtime).unwrap();
        fs::rename(&replacement, &shim).unwrap();
        let files = collect_sources(&shim, dir, name).unwrap();
        assert_eq!(files[0].mtime, mtime);
        assert_ne!(files[0].inode, prev_inode);
        let now = SystemTime::now() + 2 * RACY_STAT_WINDOW;
        let updated = digest_at(&key, dir, &files, now).unwrap();
        assert_ne!(updated.digest, first.digest);
        assert!(Arc::ptr_eq(&updated, &entry()));
    }

    #[test]
    fn digest_memo_skips_sources_inside_racy_window() {
        let (_root, shim, _cache) = fixture();
        let dir = shim.parent().unwrap();
        let name = shim.file_name().unwrap();
        let key = shim.canonicalize().unwrap();
        let now = SystemTime::now();
        set_file_mtime(&shim, FileTime::from_system_time(now)).unwrap();
        let files = collect_sources(&shim, dir, name).unwrap();
        digest_at(&key, dir, &files, now + RACY_STAT_WINDOW / 2).unwrap();
        assert!(!MEMO.read().contains_key(&key));
    }

    fn assert_single_generation(cache: &Path) {
        let entries: Vec<_> = fs::read_dir(cache)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|name| name != SOURCES_DIR)
            .collect();
        assert_eq!(entries.len(), 1, "unexpected cache entries: {entries:?}");
        assert!(digest_name(entries[0].as_encoded_bytes()));
    }

    #[test]
    fn stage_shim_concurrent_threads_hash_once_even_for_recent_sources() {
        const CALLERS: usize = 20;
        let (_root, shim, cache) = fixture();
        let source_key = shim.canonicalize().unwrap();
        let lock = lock_source(&cache, &source_key).unwrap();
        let flight_key = (cache.canonicalize().unwrap(), source_key);
        let now = SystemTime::now();
        let hashes = AtomicU64::new(0);
        std::thread::scope(|scope| {
            let threads: Vec<_> = (0..CALLERS)
                .map(|_| {
                    scope.spawn(|| {
                        let staged = stage_with(&shim, &cache, now, |key, dir, files, now| {
                            hashes.fetch_add(1, Ordering::Relaxed);
                            digest_at(key, dir, files, now)
                        })
                        .unwrap();
                        assert_eq!(fs::read(&staged).unwrap(), b"shim");
                        assert!(staged.with_file_name(STAMP).is_file());
                        staged
                    })
                })
                .collect();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            // Hold the flock until every caller has joined the in-process flight.
            let joined = loop {
                if STAGE_FLIGHTS
                    .lock()
                    .get(&flight_key)
                    .is_some_and(|f| f.strong_count() == CALLERS)
                {
                    break true;
                }
                if std::time::Instant::now() > deadline {
                    break false;
                }
                std::thread::sleep(Duration::from_millis(1));
            };
            drop(lock);
            assert!(joined, "callers did not join the same flight");
            let paths: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
            assert!(paths.iter().all(|path| path == &paths[0]));
        });
        assert_eq!(hashes.load(Ordering::Relaxed), 1);
        assert!(!MEMO.read().contains_key(&flight_key.1));
        assert_single_generation(&cache);
    }

    #[test]
    fn stage_shim_subprocess_worker() {
        let Some(root) = std::env::var_os("BOXLITE_TEST_SHIM_FLIGHT_ROOT").map(PathBuf::from)
        else {
            return;
        };
        let now = SystemTime::now() + 2 * RACY_STAT_WINDOW;
        let staged = stage_with(
            &root.join("source/boxlite-shim"),
            &root.join("shims"),
            now,
            |key, dir, files, now| {
                let mut counter = fs::File::options()
                    .create(true)
                    .append(true)
                    .open(root.join("hashes"))?;
                counter.write_all(b"1")?;
                digest_at(key, dir, files, now)
            },
        )
        .unwrap();
        assert_eq!(fs::read(staged).unwrap(), b"shim");
    }

    #[test]
    fn stage_shim_concurrent_processes_hash_stable_source_once() {
        let (root, shim, cache) = fixture();
        let key = shim.canonicalize().unwrap();
        let lock = lock_source(&cache, &key).unwrap();
        let children: Vec<_> = (0..4)
            .map(|_| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "jailer::shim_cache::tests::stage_shim_subprocess_worker",
                        "--quiet",
                    ])
                    .env("BOXLITE_TEST_SHIM_FLIGHT_ROOT", root.path())
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        drop(lock);
        for mut child in children {
            assert!(child.wait().unwrap().success());
        }
        assert_eq!(fs::read(root.path().join("hashes")).unwrap(), b"1");
        assert_single_generation(&cache);
    }

    #[test]
    fn stage_shim_race_loser_cleans_up_staging_dir() {
        let (_root, shim, cache) = fixture();
        let winner = stage_shim(&shim, &cache).unwrap();
        let staging = cache.join(".staging.loser");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("unused"), b"race loser").unwrap();

        let guard = StagingGuard {
            path: staging.clone(),
            published: false,
        };
        let files =
            collect_sources(&shim, shim.parent().unwrap(), shim.file_name().unwrap()).unwrap();
        assert!(!guard.publish(winner.parent().unwrap(), &files).unwrap());
        assert!(!staging.exists());
        assert_eq!(fs::read(winner).unwrap(), b"shim");
    }

    #[test]
    fn cleanup_stale_respects_ttl_and_protects_active_dir() {
        let (root, shim, cache) = fixture();
        let active = stage_shim(&shim, &cache).unwrap();
        let active_dir = active.parent().unwrap();
        let now = SystemTime::now();
        let ago = |duration| FileTime::from_system_time(now - duration);
        let past_debug = STALE_TTL_DEBUG + Duration::from_secs(60);
        let past_release = STALE_TTL_RELEASE + Duration::from_secs(60);
        set_file_mtime(active.with_file_name(STAMP), ago(past_release)).unwrap();
        for (name, profile, age) in [
            ("0000000000000001", Some("debug"), past_debug),
            ("0000000000000002", Some("debug"), Duration::ZERO),
            ("0000000000000003", Some("release"), past_release),
            ("0000000000000004", Some("release"), past_debug),
            ("0000000000000005", None, past_release),
            ("0000000000000006", None, past_debug),
            ("local", None, past_release),
            (
                ".staging.expired",
                None,
                STAGING_ORPHAN_TTL + Duration::from_secs(60),
            ),
            (".staging.fresh", None, Duration::ZERO),
        ] {
            let path = cache.join(name);
            fs::create_dir(&path).unwrap();
            let clock_path = if let Some(profile) = profile {
                let stamp = path.join(STAMP);
                fs::write(&stamp, format!("version\n{profile}\n")).unwrap();
                stamp
            } else {
                path
            };
            set_file_mtime(clock_path, ago(age)).unwrap();
        }

        let cache_alias = root.path().join("source/../shims");
        cleanup_stale(&cache_alias, Some(active_dir));
        assert!(active.is_file());
        for (name, kept) in [
            ("0000000000000001", false),
            ("0000000000000002", true),
            ("0000000000000003", false),
            ("0000000000000004", true),
            ("0000000000000005", false),
            ("0000000000000006", true),
            ("local", true),
            (".staging.expired", false),
            (".staging.fresh", true),
        ] {
            assert_eq!(cache.join(name).exists(), kept, "{name}");
        }
        cleanup_stale(&cache, None);
        assert!(!active_dir.exists());
    }

    #[test]
    fn cleanup_stale_keeps_shim_renewed_after_expiry_check() {
        let (_root, shim, cache) = fixture();
        let staged = stage_shim(&shim, &cache).unwrap();
        let generation = staged.parent().unwrap();
        set_file_mtime(staged.with_file_name(STAMP), FileTime::from_unix_time(1, 0)).unwrap();
        let now = SystemTime::now();
        assert!(is_expired(
            published_metadata(generation),
            now,
            STALE_TTL_RELEASE
        ));

        let hit = stage_shim(&shim, &cache).unwrap();
        assert_eq!(hit, staged);
        let reap_dir = cache.join(".staging.reap");
        assert!(!retire_if_stale(generation, &reap_dir, now, STALE_TTL_RELEASE).unwrap());
        assert_eq!(fs::read(hit).unwrap(), b"shim");
    }

    #[test]
    fn stage_shim_missing_source_returns_storage_error() {
        let (_root, shim, cache) = fixture();
        assert!(matches!(
            stage_shim(&shim.with_file_name("missing"), &cache),
            Err(BoxliteError::Storage(_))
        ));
        assert!(!cache.exists());
    }

    #[test]
    fn stage_shim_directory_source_returns_storage_error() {
        let (_root, shim, cache) = fixture();
        assert!(matches!(
            stage_shim(shim.parent().unwrap(), &cache),
            Err(BoxliteError::Storage(_))
        ));
        assert!(!cache.exists());
    }

    #[test]
    fn stage_shim_incomplete_target_returns_error_without_refreshing_stamp() {
        let (_root, shim, cache) = fixture();
        let staged = stage_shim(&shim, &cache).unwrap();
        fs::remove_file(&staged).unwrap();
        let stamp = staged.with_file_name(STAMP);
        let old = FileTime::from_unix_time(1, 0);
        set_file_mtime(&stamp, old).unwrap();

        let result = stage_shim(&shim, &cache);

        assert!(
            matches!(result, Err(BoxliteError::Storage(_))),
            "{result:?}"
        );
        assert_eq!(
            FileTime::from_last_modification_time(&fs::metadata(stamp).unwrap()),
            old
        );
        assert!(!staged.exists());
        assert_single_generation(&cache);
    }

    #[test]
    fn stage_shim_rejects_missing_or_truncated_firmware_without_refreshing_stamp() {
        for truncated in [true, false] {
            let (_root, shim, cache) = fixture();
            let library = "libkrunfw.so.5";
            fs::write(shim.with_file_name(library), b"firmware").unwrap();
            let staged = stage_shim(&shim, &cache).unwrap();
            let cached_library = staged.with_file_name(library);
            if truncated {
                fs::write(&cached_library, b"short").unwrap();
            } else {
                fs::remove_file(&cached_library).unwrap();
            }
            let stamp = staged.with_file_name(STAMP);
            let old = FileTime::from_unix_time(1, 0);
            set_file_mtime(&stamp, old).unwrap();

            let result = stage_shim(&shim, &cache);

            assert!(
                matches!(result, Err(BoxliteError::Storage(_))),
                "{result:?}"
            );
            assert_eq!(
                FileTime::from_last_modification_time(&fs::metadata(stamp).unwrap()),
                old
            );
            assert!(staged.is_file());
            assert_single_generation(&cache);
        }
    }

    #[test]
    #[cfg(unix)]
    fn plan_bwrap_shim_mounts_remaps_symlinked_runtime_layout() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let target_dir = root.path().join("target/debug");
        let runtime_dir = target_dir.join("runtime");
        let real_out = target_dir.join("real-out");
        let out_link = target_dir.join("build/boxlite-hash/out");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        std::fs::create_dir_all(&real_out).unwrap();
        std::fs::create_dir_all(out_link.parent().unwrap()).unwrap();
        symlink(&real_out, &out_link).unwrap();

        let real_shim = target_dir.join("boxlite-shim");
        let real_fw = real_out.join("libkrunfw.so.5.4.0");
        fs::write(&real_shim, b"shim").unwrap();
        fs::write(&real_fw, b"fw").unwrap();

        let runtime_shim = runtime_dir.join("boxlite-shim");
        let fw_hop1 = runtime_dir.join(".libkrunfw-hop");
        let runtime_fw = runtime_dir.join("libkrunfw.so.5");
        symlink("../boxlite-shim", &runtime_shim).unwrap();
        symlink("../build/boxlite-hash/out/libkrunfw.so.5.4.0", &fw_hop1).unwrap();
        symlink(".libkrunfw-hop", &runtime_fw).unwrap();

        let plan = plan_bwrap_shim_mounts(&runtime_shim);
        assert_eq!(
            plan.executable,
            Path::new(BWRAP_SANDBOX_SHIM_DIR).join("boxlite-shim")
        );
        assert_eq!(
            plan.ld_library_path,
            format!("{BWRAP_SANDBOX_SHIM_DIR}:{}", runtime_dir.display())
        );
        assert_eq!(
            plan.ro_binds,
            vec![
                (
                    real_shim.canonicalize().unwrap(),
                    Path::new(BWRAP_SANDBOX_SHIM_DIR).join("boxlite-shim")
                ),
                (
                    real_fw.canonicalize().unwrap(),
                    Path::new(BWRAP_SANDBOX_SHIM_DIR).join("libkrunfw.so.5")
                ),
            ]
        );
    }

    #[test]
    fn plan_bwrap_shim_mounts_keeps_staged_non_symlink_paths_direct() {
        let (_root, shim, cache) = fixture();
        fs::write(shim.with_file_name("libkrunfw.so.5"), b"fw").unwrap();
        let staged = stage_shim(&shim, &cache).unwrap();

        let plan = plan_bwrap_shim_mounts(&staged);
        assert!(plan.ro_binds.is_empty());
        assert_eq!(plan.executable, staged);
        assert_eq!(
            plan.ld_library_path,
            staged.parent().unwrap().to_string_lossy()
        );
    }
}
