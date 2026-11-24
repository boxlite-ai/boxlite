//! Content-addressed shim and firmware shared by jailed boxes in one runtime home.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use filetime::FileTime;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::{self, Metadata};
use std::io::{self, Read};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

const STAMP: &str = ".complete";
const STAGING_PREFIX: &str = ".staging.";
const STAGING_ORPHAN_TTL: Duration = Duration::from_secs(60 * 60);
const STALE_TTL_DEBUG: Duration = Duration::from_secs(60 * 60);
const STALE_TTL_RELEASE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RACY_STAT_WINDOW: Duration = Duration::from_secs(2);
const BUILD_PROFILE: &str = if cfg!(debug_assertions) {
    "debug"
} else {
    "release"
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static MEMO: OnceLock<Mutex<HashMap<PathBuf, Arc<MemoEntry>>>> = OnceLock::new();
static LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

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
        if filename == name || !filename.as_encoded_bytes().starts_with(b"libkrunfw.") {
            continue;
        }
        if let Ok(metadata) = fs::metadata(entry.path())
            && metadata.is_file()
        {
            files.push(FileFingerprint::new(filename, &metadata));
        }
    }
    files.sort_unstable_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn digest_at(
    shim: &Path,
    dir: &Path,
    files: &[FileFingerprint],
    now: SystemTime,
) -> io::Result<String> {
    let key = shim.canonicalize().unwrap_or_else(|_| shim.to_path_buf());
    let memo = MEMO.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = memo.lock().get(&key).cloned();
    if let Some(entry) = cached
        && entry.fingerprints == files
    {
        return Ok(entry.digest.clone());
    }

    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
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
    let digest = hex::encode(&hash.finalize()[..8]);
    // Coarse file timestamps can alias writes made close to the hash read.
    let cutoff = FileTime::from_system_time(now - RACY_STAT_WINDOW);
    if files.iter().all(|f| f.older_than(cutoff)) {
        let entry = Arc::new(MemoEntry {
            fingerprints: files.to_vec(),
            digest: digest.clone(),
        });
        let _previous = memo.lock().insert(key, entry);
    }
    Ok(digest)
}

fn is_complete(target: &Path, files: &[FileFingerprint]) -> bool {
    target.join(STAMP).is_file()
        && files.iter().all(|file| {
            fs::metadata(target.join(&file.name))
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() == file.len)
        })
}

struct StagingGuard {
    path: PathBuf,
    published: bool,
}

impl StagingGuard {
    fn publish(mut self, target: &Path, files: &[FileFingerprint]) -> io::Result<bool> {
        let result = fs::rename(&self.path, target);
        let _lock = LIFECYCLE_LOCK.lock();
        match result {
            Ok(()) => self.published = true,
            Err(_) if is_complete(target, files) => {}
            Err(err) => return Err(err),
        }
        let _ = filetime::set_file_mtime(target.join(STAMP), FileTime::now());
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
    let name = shim_path
        .file_name()
        .filter(|name| !name.is_empty() && *name != STAMP)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid shim filename"))?;
    let dir = shim_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let files = collect_sources(shim_path, dir, name)?;
    let digest = digest_at(shim_path, dir, &files, SystemTime::now())?;
    let target = cache_dir.join(&digest);

    let hit = {
        let _lock = LIFECYCLE_LOCK.lock();
        let complete = is_complete(&target, &files);
        if complete {
            let _ = filetime::set_file_mtime(target.join(STAMP), FileTime::now());
        }
        complete
    };
    if !hit {
        fs::create_dir_all(cache_dir)?;
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
        fs::set_permissions(&staging.path, fs::Permissions::from_mode(0o755))?;

        for source in &files {
            let path = dir.join(&source.name);
            let destination = staging.path.join(&source.name);
            fs::copy(&path, &destination)?;
            let metadata = fs::metadata(&path)?;
            source.check_metadata(&path, &metadata)?;
            #[cfg(unix)]
            {
                let mode = if source.name == name { 0o755 } else { 0o644 };
                fs::set_permissions(&destination, fs::Permissions::from_mode(mode))?;
            }
        }
        fs::write(
            staging.path.join(STAMP),
            format!("{}\n{BUILD_PROFILE}\n", crate::VERSION),
        )?;
        if staging.publish(&target, &files)? {
            tracing::info!(path = %target.display(), "Published shared shim");
            cleanup_stale(cache_dir, Some(&target));
        }
    }
    Ok(target.canonicalize().unwrap_or(target).join(name))
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
    let _lock = LIFECYCLE_LOCK.lock();
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
        if name.len() != 16 || !name.iter().all(|&b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
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
        let ttl = match profile.lines().nth(1) {
            Some("debug") => STALE_TTL_DEBUG,
            _ => STALE_TTL_RELEASE,
        };
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
        let first = digest_at(&shim, dir, &files, now).unwrap();
        let memo = MEMO.get().unwrap();
        let entry = || memo.lock().get(&key).cloned().unwrap();
        let first_entry = entry();
        assert_eq!(first_entry.digest, first);

        assert_eq!(digest_at(&shim, dir, &files, now).unwrap(), first);
        assert!(Arc::ptr_eq(&first_entry, &entry()));

        let mtime = files[0].mtime;
        fs::write(&shim, b"edit").unwrap();
        set_file_mtime(&shim, mtime).unwrap();
        let files = collect_sources(&shim, dir, name).unwrap();
        assert_eq!(files[0].mtime, mtime);
        let now = SystemTime::now() + 2 * RACY_STAT_WINDOW;
        let updated = digest_at(&shim, dir, &files, now).unwrap();
        assert_ne!(updated, first);
        assert_eq!(entry().digest, updated);
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
        digest_at(&shim, dir, &files, now + RACY_STAT_WINDOW / 2).unwrap();
        assert!(!MEMO.get().unwrap().lock().contains_key(&key));
    }

    #[test]
    fn stage_shim_concurrent_threads_atomic_publish() {
        let (_root, shim, cache) = fixture();
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            let threads: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        let staged = stage_shim(&shim, &cache).unwrap();
                        assert_eq!(fs::read(&staged).unwrap(), b"shim");
                        assert!(staged.with_file_name(STAMP).is_file());
                        staged
                    })
                })
                .collect();
            let paths: Vec<_> = threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect();
            assert!(paths.iter().all(|path| path == &paths[0]));
        });
        assert_eq!(fs::read_dir(cache).unwrap().count(), 1);
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
        assert_eq!(fs::read_dir(cache).unwrap().count(), 1);
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
            assert_eq!(fs::read_dir(cache).unwrap().count(), 1);
        }
    }
}
