//! Streaming OCI tar layer applier (containerd-style).

use super::compression::TarballReader;
use super::metadata::EntryMetadata;
use super::override_stat::{OverrideFileType, OverrideStat};
use super::safe_root::SafeRoot;
use super::time::{bound_time, latest_time};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use filetime::{FileTime, set_file_times, set_symlink_file_times};
use std::collections::{BTreeMap, HashSet};
use std::ffi::CString;
use std::fs::{self, Permissions};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tar::{Archive, Entry, EntryType};
use tracing::{debug, trace, warn};
use walkdir::WalkDir;

/// Extracts an OCI layer tar stream into a destination directory, enforcing
/// containment through [`SafeRoot`].
///
/// Every destructive filesystem operation goes through the root handle, so on
/// Linux the kernel (`openat2(RESOLVE_IN_ROOT)`) and on other platforms a
/// lexical fallback guarantee that no entry can escape `dest` — even if the
/// tar contains crafted symlinks aiming at the host filesystem.
/// Lifecycle: `new(dest)` → one or more `extract_*` calls → `finalize()`.
///
/// Directory mode metadata is deferred across all `extract_*` calls and
/// applied once on `finalize`, deepest-first. This lets a multi-layer
/// flat-merge avoid chmod-narrowing a parent directory between layers
/// (the failure that motivated `cross_layer_overwrite_through_readonly_parent_dir`).
///
/// **Forgetting to call `finalize` leaves directory permissions at their
/// kernel-default `0o755` — silent semantic bug.** A `Drop` implementation
/// logs an error if non-empty deferred state is dropped without finalize.
pub struct LayerExtractor<'a> {
    dest: &'a Path,
    deferred_dirs: DeferredDirs,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum WhiteoutMode {
    Apply,
    Preserve,
}

impl<'a> LayerExtractor<'a> {
    /// Construct an extractor targeting `dest`. The directory is opened lazily
    /// per extraction call so the same extractor can apply multiple layers.
    pub fn new(dest: &'a Path) -> Self {
        Self {
            dest,
            deferred_dirs: DeferredDirs::new(),
        }
    }

    /// Apply a compressed or uncompressed layer tarball on disk.
    ///
    /// The caller MUST call [`Self::finalize`] after all layers have been
    /// extracted, or directory permissions will not be applied.
    pub fn extract_tarball(&mut self, tarball_path: &Path) -> BoxliteResult<u64> {
        let reader = TarballReader::open(tarball_path)?;
        self.extract_reader(reader)
    }

    /// Unpack a layer into a standalone cached layer directory.
    ///
    /// Whiteout marker files are preserved so a later copy-overlay merge can
    /// apply them against lower layers. The caller MUST call [`Self::finalize`].
    pub(crate) fn extract_tarball_preserving_whiteouts(
        &mut self,
        tarball_path: &Path,
    ) -> BoxliteResult<u64> {
        let reader = TarballReader::open(tarball_path)?;
        self.extract_reader_with_whiteout_mode(reader, WhiteoutMode::Preserve)
    }

    /// Apply an already-decompressed tar stream.
    ///
    /// The caller MUST call [`Self::finalize`] after all layers have been
    /// extracted, or directory permissions will not be applied.
    pub fn extract_reader<R: Read>(&mut self, reader: R) -> BoxliteResult<u64> {
        self.extract_reader_with_whiteout_mode(reader, WhiteoutMode::Apply)
    }

    /// Apply all deferred directory metadata (deepest-first) and consume
    /// the extractor. Must be called after all `extract_*` calls.
    ///
    /// Forgetting to call this leaves directory permissions at their kernel-
    /// default `0o755` instead of the tar-declared mode — a silent semantic
    /// bug. Every caller must call this exactly once.
    pub fn finalize(self) -> BoxliteResult<()> {
        self.deferred_dirs.apply()
    }

    fn extract_reader_with_whiteout_mode<R: Read>(
        &mut self,
        reader: R,
        whiteout_mode: WhiteoutMode,
    ) -> BoxliteResult<u64> {
        let root = SafeRoot::open(self.dest)?;
        let is_root = unsafe { libc::geteuid() } == 0;
        let mut archive = Archive::new(reader);
        let mut unpacked_paths: HashSet<PathBuf> = HashSet::new();
        let mut total_size = 0u64;
        let mut deferred_hardlinks: Vec<DeferredHardlink> = Vec::new();

        for entry_result in archive
            .entries()
            .map_err(|e| BoxliteError::Storage(format!("Tar read entries error: {}", e)))?
        {
            let mut entry = entry_result
                .map_err(|e| BoxliteError::Storage(format!("Tar read entry error: {}", e)))?;
            let raw_path = entry
                .path()
                .map_err(|e| BoxliteError::Storage(format!("Tar parse header path error: {}", e)))?
                .into_owned();
            let normalized = match SafeRoot::normalize(&raw_path) {
                Some(p) => p,
                None => {
                    debug!("Skipping path outside root: {}", raw_path.display());
                    continue;
                }
            };

            if normalized.as_os_str().is_empty() {
                debug!("Skipping root entry");
                continue;
            }

            let entry_type = entry.header().entry_type();
            let mode = entry.header().mode().unwrap_or(0o755);
            let uid = entry.header().uid().unwrap_or(0);
            let gid = entry.header().gid().unwrap_or(0);
            let mtime = entry.header().mtime().unwrap_or(0);
            let atime = mtime;
            total_size = total_size.saturating_add(entry.header().size().unwrap_or(0));

            let link_name = if matches!(entry_type, EntryType::Link | EntryType::Symlink) {
                entry
                    .link_name()
                    .map_err(|e| BoxliteError::Storage(format!("Tar read link name error: {}", e)))?
                    .map(|p| p.into_owned())
            } else {
                None
            };

            let device_major =
                entry.header().device_major().unwrap_or(None).unwrap_or(0) as libc::dev_t;
            let device_minor =
                entry.header().device_minor().unwrap_or(None).unwrap_or(0) as libc::dev_t;

            trace!(
                "Processing entry: path={}, type={:?}, mode={:o}, uid={}, gid={}, size={}, mtime={}, device={}:{}, link={:?}",
                normalized.display(),
                entry_type,
                mode,
                uid,
                gid,
                entry.header().size().unwrap_or(0),
                mtime,
                device_major,
                device_minor,
                link_name.as_ref().map(|p| p.display().to_string())
            );

            if whiteout_mode == WhiteoutMode::Apply
                && Self::apply_whiteout(&root, &normalized, &mut unpacked_paths, entry_type)?
            {
                continue;
            }

            // containerd pattern: resolve parent, join leaf.
            // Parent is resolved (symlinks re-anchored). Leaf doesn't need
            // to exist yet — it's the entry being created.
            let (parent_rel, leaf) = Self::split_parent_leaf(&normalized);
            let safe_parent = root.resolve_or_root(&parent_rel)?;
            if fs::create_dir_all(&safe_parent).is_err() {
                // Obstacle: a file exists where a directory is needed.
                // Walk up from safe_parent, find the non-dir obstacle, remove it, retry.
                let root_path = root.root_path();
                let mut cursor = safe_parent.as_path();
                while cursor != root_path {
                    if let Ok(m) = fs::symlink_metadata(cursor) {
                        if !m.is_dir() {
                            let _ = fs::remove_file(cursor);
                        }
                        break;
                    }
                    match cursor.parent() {
                        Some(p) => cursor = p,
                        None => break,
                    }
                }
                fs::create_dir_all(&safe_parent).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to create parent {}: {}",
                        parent_rel.display(),
                        e
                    ))
                })?;
            }
            let safe_path = safe_parent.join(&leaf);
            Self::remove_nofollow(&safe_path, entry_type == EntryType::Directory)?;

            let xattrs = read_xattrs(&mut entry)?;
            let mut is_deferred = false;

            match entry_type {
                EntryType::Directory => {
                    if !safe_path.exists() {
                        fs::create_dir(&safe_path).map_err(|e| {
                            BoxliteError::Storage(format!(
                                "Failed to create dir {}: {}",
                                normalized.display(),
                                e
                            ))
                        })?;
                    }
                }
                EntryType::Regular | EntryType::GNUSparse => {
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(mode)
                        .open(&safe_path)
                        .map_err(|e| {
                            BoxliteError::Storage(format!(
                                "Failed to create file {}: {}",
                                normalized.display(),
                                e
                            ))
                        })?;
                    io::copy(&mut entry, &mut file).map_err(|e| {
                        BoxliteError::Storage(format!(
                            "Failed to copy file data to {}: {}",
                            normalized.display(),
                            e
                        ))
                    })?;
                }
                EntryType::Link => {
                    let target = link_name.clone().ok_or_else(|| {
                        BoxliteError::Storage(format!(
                            "Hardlink without target: {}",
                            raw_path.display()
                        ))
                    })?;
                    let target_rel = SafeRoot::normalize(&target).ok_or_else(|| {
                        BoxliteError::Storage(format!(
                            "Hardlink target escapes root: {}",
                            target.display()
                        ))
                    })?;
                    let (tp, tl) = Self::split_parent_leaf(&target_rel);
                    let target_safe = root.resolve_or_root(&tp)?.join(&tl);
                    if fs::symlink_metadata(&target_safe).is_ok() {
                        fs::hard_link(&target_safe, &safe_path).map_err(|e| {
                            BoxliteError::Storage(format!(
                                "Failed to create hardlink {}: {}",
                                normalized.display(),
                                e
                            ))
                        })?;
                    } else {
                        trace!(
                            "Deferring hardlink {} -> {} (target not found yet)",
                            normalized.display(),
                            target_rel.display()
                        );
                        deferred_hardlinks.push(DeferredHardlink {
                            link_rel: normalized.clone(),
                            target_rel,
                            meta: EntryMetadata::builder(mode, atime, mtime)
                                .uid(uid)
                                .gid(gid)
                                .entry_type(entry_type)
                                .device(device_major, device_minor)
                                .xattrs(vec![])
                                .build(),
                        });
                        is_deferred = true;
                    }
                }
                EntryType::Symlink => {
                    let target = link_name.ok_or_else(|| {
                        BoxliteError::Storage(format!(
                            "Symlink without target: {}",
                            raw_path.display()
                        ))
                    })?;
                    std::os::unix::fs::symlink(&target, &safe_path).map_err(|e| {
                        BoxliteError::Storage(format!(
                            "Failed to create symlink {} -> {}: {}",
                            normalized.display(),
                            target.display(),
                            e
                        ))
                    })?;
                }
                EntryType::Block | EntryType::Char | EntryType::Fifo => {
                    Self::create_special_inode(
                        &safe_path,
                        entry_type,
                        mode,
                        device_major,
                        device_minor,
                        is_root,
                    )?;
                }
                EntryType::XGlobalHeader => {
                    trace!("Ignoring PAX global header {}", raw_path.display());
                    continue;
                }
                other => {
                    return Err(BoxliteError::Storage(format!(
                        "Unhandled tar entry type {:?} for {}",
                        other,
                        raw_path.display()
                    )));
                }
            }

            if is_deferred {
                Self::remember_unpacked_path(&mut unpacked_paths, root.root_path(), &safe_path);
                continue;
            }

            apply_ownership(
                &safe_path,
                &EntryMetadata::builder(mode, atime, mtime)
                    .uid(uid)
                    .gid(gid)
                    .entry_type(entry_type)
                    .device(device_major, device_minor)
                    .xattrs(xattrs.clone())
                    .build(),
                is_root,
            )?;

            if entry_type == EntryType::Directory {
                self.deferred_dirs.record(DirMeta {
                    path: safe_path.clone(),
                    meta: EntryMetadata::with_timestamps(mode, atime, mtime),
                })?;
            } else {
                apply_permissions_and_times(
                    &safe_path,
                    entry_type,
                    &EntryMetadata::with_timestamps(mode, atime, mtime),
                )?;
            }

            Self::remember_unpacked_path(&mut unpacked_paths, root.root_path(), &safe_path);
        }

        // Retry deferred hardlinks — their targets may have been created later in
        // the same layer or removed by a whiteout.
        for deferred in deferred_hardlinks {
            let (tp, tl) = Self::split_parent_leaf(&deferred.target_rel);
            let target_safe = root.resolve_or_root(&tp)?.join(&tl);
            if fs::symlink_metadata(&target_safe).is_err() {
                trace!(
                    "Skipping deferred hardlink {} -> {} (target does not exist)",
                    deferred.link_rel.display(),
                    deferred.target_rel.display()
                );
                continue;
            }
            let (lp, ll) = Self::split_parent_leaf(&deferred.link_rel);
            let link_safe = root.resolve_or_root(&lp)?.join(&ll);
            trace!(
                "Creating deferred hardlink {} -> {}",
                deferred.link_rel.display(),
                deferred.target_rel.display()
            );
            fs::hard_link(&target_safe, &link_safe).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create deferred hardlink {}: {}",
                    deferred.link_rel.display(),
                    e
                ))
            })?;
            apply_ownership(&link_safe, &deferred.meta, is_root)?;
            apply_permissions_and_times(&link_safe, EntryType::Link, &deferred.meta)?;
        }

        // Directory metadata is finalized by the caller via DeferredDirs::apply,
        // not per layer. Hoisting that sweep across layers is what fixes the
        // cross-layer EACCES (cross_layer_overwrite_through_readonly_parent_dir).

        Ok(total_size)
    }

    fn split_parent_leaf(rel: &Path) -> (PathBuf, PathBuf) {
        let parent = rel.parent().unwrap_or(Path::new(""));
        let leaf = rel
            .file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(""));
        (parent.to_path_buf(), leaf)
    }

    fn remove_nofollow(path: &Path, keep_if_dir: bool) -> BoxliteResult<()> {
        match fs::symlink_metadata(path) {
            Ok(meta) => {
                let is_real_dir = meta.is_dir() && !meta.file_type().is_symlink();
                if keep_if_dir && is_real_dir {
                    return Ok(());
                }
                let first = if is_real_dir {
                    fs::remove_dir_all(path)
                } else {
                    fs::remove_file(path)
                };
                // OCI layers can mark a dir read-only (e.g. /usr/bin at 0555);
                // a whiteout or higher-layer overwrite still has to delete
                // inside it, but std `remove_*` can't unlink within a read-only
                // parent. On EACCES/EPERM, make the target subtree and its
                // parent user-writable, then retry once.
                match first {
                    Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                        Self::make_removable(path, is_real_dir);
                        if is_real_dir {
                            fs::remove_dir_all(path)
                        } else {
                            fs::remove_file(path)
                        }
                    }
                    other => other,
                }
                .map_err(|e| {
                    BoxliteError::Storage(format!("Failed to remove {}: {}", path.display(), e))
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(BoxliteError::Storage(format!(
                "Failed to stat {}: {}",
                path.display(),
                e
            ))),
        }
    }

    /// Make `path` (and, for a directory, its whole subtree) plus its parent
    /// user-writable, so a read-only OCI dir (e.g. `/usr/bin` at 0555) can't
    /// block a whiteout/overwrite unlink. Best-effort: chmod errors are
    /// ignored — the caller's retry surfaces any genuine failure.
    fn make_removable(path: &Path, is_dir: bool) {
        if let Some(parent) = path.parent() {
            Self::make_user_writable(parent);
        }
        if is_dir {
            for entry in WalkDir::new(path).into_iter().flatten() {
                Self::make_user_writable(entry.path());
            }
        } else {
            Self::make_user_writable(path);
        }
    }

    /// Add the owner-write bit to `path` when missing. Skips symlinks (chmod
    /// would follow to the target); no-op when already writable.
    fn make_user_writable(path: &Path) {
        if let Ok(meta) = fs::symlink_metadata(path) {
            if meta.file_type().is_symlink() {
                return;
            }
            let mode = meta.permissions().mode();
            if mode & 0o200 == 0 {
                let _ = fs::set_permissions(path, Permissions::from_mode(mode | 0o200));
            }
        }
    }

    fn remember_unpacked_path(unpacked: &mut HashSet<PathBuf>, root: &Path, path: &Path) {
        let mut current = path;
        while current != root {
            unpacked.insert(current.to_path_buf());
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent;
        }
    }

    /// Create a special inode (FIFO, char/block device).
    fn create_special_inode(
        path: &Path,
        entry_type: EntryType,
        mode: u32,
        major: libc::dev_t,
        minor: libc::dev_t,
        is_root: bool,
    ) -> BoxliteResult<()> {
        match entry_type {
            EntryType::Fifo => {
                let c_path = CString::new(path.as_os_str().as_bytes())
                    .map_err(|_| BoxliteError::Storage("Path contains NUL".into()))?;
                let res = unsafe { libc::mkfifo(c_path.as_ptr(), mode as libc::mode_t) };
                if res != 0 {
                    return Err(BoxliteError::Storage(format!(
                        "Failed to mkfifo {}: {}",
                        path.display(),
                        std::io::Error::last_os_error()
                    )));
                }
            }
            EntryType::Char | EntryType::Block => {
                if !is_root {
                    trace!("Skipping device node {} (requires root)", path.display());
                    return Ok(());
                }
                let c_path = CString::new(path.as_os_str().as_bytes())
                    .map_err(|_| BoxliteError::Storage("Path contains NUL".into()))?;
                let kind_bits = if entry_type == EntryType::Char {
                    libc::S_IFCHR
                } else {
                    libc::S_IFBLK
                };
                let dev = libc::makedev(major as _, minor as _);
                let full_mode = kind_bits | (mode as libc::mode_t & 0o7777);
                let res = unsafe { libc::mknod(c_path.as_ptr(), full_mode, dev) };
                if res != 0 {
                    return Err(BoxliteError::Storage(format!(
                        "Failed to mknod {}: {}",
                        path.display(),
                        std::io::Error::last_os_error()
                    )));
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn apply_whiteout(
        root: &SafeRoot,
        rel: &Path,
        unpacked: &mut HashSet<PathBuf>,
        entry_type: EntryType,
    ) -> BoxliteResult<bool> {
        if entry_type != EntryType::Regular {
            return Ok(false);
        }

        let base = match rel.file_name().and_then(|n| n.to_str()) {
            Some(b) => b,
            None => return Ok(false),
        };

        if base == ".wh..wh..opq" {
            let parent_rel = rel.parent().unwrap_or(Path::new(""));
            Self::apply_opaque_whiteout(root, parent_rel, unpacked)?;
            return Ok(true);
        }

        if let Some(target_name) = base.strip_prefix(".wh.") {
            Self::validate_whiteout_target(base, target_name)?;
            let parent_rel = rel.parent().unwrap_or(Path::new(""));
            // containerd: originalPath = filepath.Join(dir, originalBase)
            // where dir = filepath.Dir(path) and path is already resolved.
            let target_safe = root.resolve_or_root(parent_rel)?.join(target_name);
            Self::remove_nofollow(&target_safe, false)?;
            debug!("Whiteout removed {}", target_name);
            return Ok(true);
        }

        Ok(false)
    }

    fn validate_whiteout_target(base: &str, target_name: &str) -> BoxliteResult<()> {
        if target_name.is_empty() || target_name == "." || target_name == ".." {
            return Err(BoxliteError::Storage(format!(
                "Invalid whiteout name: {}",
                base
            )));
        }
        Ok(())
    }

    fn apply_opaque_whiteout(
        root: &SafeRoot,
        dir_rel: &Path,
        unpacked: &HashSet<PathBuf>,
    ) -> BoxliteResult<()> {
        // containerd pattern: dir is already resolved (from filepath.Dir(path)
        // where path = RootPath(root, ppath) + base). We resolve dir_rel to
        // get the real directory, following any symlinks within root.
        let dir_abs = root.resolve_or_root(dir_rel)?;
        if !dir_abs.exists() {
            return Ok(());
        }

        for entry in WalkDir::new(&dir_abs).min_depth(1).into_iter() {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    trace!("Skipping walk entry in {}: {}", dir_abs.display(), e);
                    continue;
                }
            };
            let abs = entry.path().to_path_buf();
            if unpacked.contains(&abs) {
                continue;
            }
            if entry.file_type().is_dir() {
                let _ = fs::remove_dir_all(&abs);
            } else {
                let _ = fs::remove_file(&abs);
            }
            debug!(
                "Opaque whiteout removed {}",
                abs.strip_prefix(&dir_abs).unwrap_or(&abs).display()
            );
        }
        Ok(())
    }
}

struct DirMeta {
    path: PathBuf,
    meta: EntryMetadata,
}

/// Default cap on the cross-layer deferred-dirs accumulator.
///
/// Measured per-entry cost on a typical layout: PathBuf (24 B inline +
/// ~70 B heap for a 30-60 char path) + EntryMetadata (~88 B inline,
/// Option<OwnershipMeta> reserves the inline payload even when None) +
/// BTreeMap node overhead (~35 B amortized) ≈ 210-280 B per entry.
///
/// 500K entries → ~110-140 MB peak typical (up to ~225 MB for crafted
/// near-PATH_MAX paths). Realistic legitimate images sit in the 1K-50K
/// range; the cap is an anti-DOS bound against crafted images, not an
/// anti-OOM bound for normal use. Override via `BOXLITE_MAX_DEFERRED_DIRS`.
const DEFAULT_MAX_DEFERRED_DIRS: usize = 500_000;

fn max_deferred_dirs() -> usize {
    static MAX: OnceLock<usize> = OnceLock::new();
    *MAX.get_or_init(|| {
        std::env::var("BOXLITE_MAX_DEFERRED_DIRS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_MAX_DEFERRED_DIRS)
    })
}

/// Cross-layer accumulator for deferred directory metadata.
///
/// OCI image layers may declare a parent directory with a restrictive
/// mode (e.g. RHEL UBI ships `/usr/bin` as 0o555) before a subsequent
/// layer needs to unlink files inside it. Applying directory modes
/// per-layer would chmod the parent narrow between layers, causing
/// EACCES on the next layer's unlink. Instead, the caller threads one
/// `DeferredDirs` across all `extract_tarball_into` calls and invokes
/// `apply()` exactly once after the final layer.
pub(crate) struct DeferredDirs {
    // Last-write-wins per path. BTreeMap iterates in path order; we reverse
    // on apply to get deepest-first, which the existing within-archive
    // pattern at tar-rs `archive.rs:254` uses for the same reason.
    by_path: BTreeMap<PathBuf, DirMeta>,
    cap: usize,
}

impl DeferredDirs {
    /// Production constructor — capacity from `BOXLITE_MAX_DEFERRED_DIRS`
    /// or [`DEFAULT_MAX_DEFERRED_DIRS`].
    pub(crate) fn new() -> Self {
        Self {
            by_path: BTreeMap::new(),
            cap: max_deferred_dirs(),
        }
    }

    /// Test-only constructor with an explicit cap so individual tests don't
    /// race the process-global env-var cache.
    #[cfg(test)]
    pub(crate) fn with_cap(cap: usize) -> Self {
        Self {
            by_path: BTreeMap::new(),
            cap,
        }
    }

    fn record(&mut self, dir: DirMeta) -> BoxliteResult<()> {
        // Replacing an existing key doesn't grow memory — only fail when a
        // new key would push us past the cap.
        let is_new = !self.by_path.contains_key(&dir.path);
        if is_new && self.by_path.len() >= self.cap {
            return Err(BoxliteError::Storage(format!(
                "OCI image declares more than {} unique directories across layers; \
                 refusing to accumulate further to bound memory. If this image is \
                 legitimate, raise BOXLITE_MAX_DEFERRED_DIRS.",
                self.cap
            )));
        }
        // Last-write-wins — a later layer redeclaring /foo replaces the
        // earlier mode/timestamps; if no later layer mentions /foo, the
        // earlier entry stays. Matches OCI layer ordering.
        self.by_path.insert(dir.path.clone(), dir);
        Ok(())
    }

    /// Apply all recorded directory metadata deepest-first. Idempotent over
    /// already-applied state (re-stats and skips removed/replaced paths).
    pub(crate) fn apply(self) -> BoxliteResult<()> {
        let mut sorted: Vec<DirMeta> = self.by_path.into_values().collect();
        sorted.sort_unstable_by(|a, b| b.path.cmp(&a.path));
        for dir in &sorted {
            match fs::symlink_metadata(&dir.path) {
                Ok(m) if m.is_dir() => {}
                _ => {
                    trace!(
                        "Skipping permissions for removed/replaced directory: {}",
                        dir.path.display()
                    );
                    continue;
                }
            }
            apply_permissions_and_times(&dir.path, EntryType::Directory, &dir.meta)?;
        }
        Ok(())
    }
}

struct DeferredHardlink {
    link_rel: PathBuf,
    target_rel: PathBuf,
    meta: EntryMetadata,
}

fn read_xattrs<R: Read>(entry: &mut Entry<R>) -> BoxliteResult<Vec<(String, Vec<u8>)>> {
    let mut xattrs = Vec::new();
    let extensions = match entry.pax_extensions() {
        Ok(Some(exts)) => exts,
        Ok(None) => return Ok(xattrs),
        Err(e) => return Err(BoxliteError::Storage(format!("PAX parse error: {}", e))),
    };

    for ext in extensions {
        let ext = ext.map_err(|e| BoxliteError::Storage(format!("PAX entry error: {}", e)))?;
        let key = match ext.key() {
            Ok(k) => k,
            Err(e) => {
                trace!("Skipping PAX key decode error: {}", e);
                continue;
            }
        };
        if let Some(name) = key.strip_prefix("SCHILY.xattr.") {
            xattrs.push((name.to_string(), ext.value_bytes().to_vec()));
        }
    }
    Ok(xattrs)
}

/// Apply ownership metadata (chown or override_stat xattr) and extended attributes.
fn apply_ownership(path: &Path, meta: &EntryMetadata, is_root: bool) -> BoxliteResult<()> {
    let ownership = meta.ownership.as_ref().ok_or_else(|| {
        BoxliteError::Storage(format!("Missing ownership metadata for {}", path.display()))
    })?;

    // Hardlinks share the target's inode. Running chown/override_stat through
    // a hardlink path would mutate the shared inode; the target's own entry
    // already applied the authoritative ownership.
    if ownership.entry_type == EntryType::Link {
        return Ok(());
    }

    if is_root {
        lchown(
            path,
            ownership.uid as libc::uid_t,
            ownership.gid as libc::gid_t,
        )
        .map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to chown {} to {}:{}: {}",
                path.display(),
                ownership.uid,
                ownership.gid,
                e
            ))
        })?;
    } else {
        // Rootless: store intended ownership in xattr for fuse-overlayfs
        let file_type = OverrideFileType::from_tar_entry(
            ownership.entry_type,
            ownership.device_major as u32,
            ownership.device_minor as u32,
        );
        let override_stat = OverrideStat::new(
            ownership.uid as u32,
            ownership.gid as u32,
            meta.mode,
            file_type,
        );
        if let Err(e) = override_stat.write_xattr(path) {
            trace!(
                "Failed to write override_stat xattr on {}: {}",
                path.display(),
                e
            );
        }
    }

    apply_xattrs(path, &ownership.xattrs, ownership.entry_type, is_root)?;
    Ok(())
}

fn apply_permissions_and_times(
    path: &Path,
    entry_type: EntryType,
    meta: &EntryMetadata,
) -> BoxliteResult<()> {
    // Skip for symlinks (no permission bits) and hardlinks (share the target
    // inode — chmod via the hardlink path would overwrite the target's mode).
    if !matches!(entry_type, EntryType::Symlink | EntryType::Link) {
        fs::set_permissions(path, Permissions::from_mode(meta.mode)).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to set permissions {:o} on {}: {}",
                meta.mode,
                path.display(),
                e
            ))
        })?;
    }

    apply_times(
        path,
        entry_type,
        meta.timestamps.atime,
        meta.timestamps.mtime,
    )?;
    Ok(())
}

fn apply_xattrs(
    path: &Path,
    xattrs: &[(String, Vec<u8>)],
    entry_type: EntryType,
    is_root: bool,
) -> BoxliteResult<()> {
    for (key, value) in xattrs {
        if key.starts_with("trusted.") || (!is_root && key.starts_with("security.")) {
            trace!(
                "Skipping privileged xattr {} on {} (requires root)",
                key,
                path.display()
            );
            continue;
        }

        if let Err(e) = setxattr_nofollow(path, key, value) {
            if e.raw_os_error() == Some(libc::ENOTSUP) {
                warn!("Ignoring unsupported xattr {} on {}", key, path.display());
            } else if e.raw_os_error() == Some(libc::EPERM)
                && key.starts_with("user.")
                && entry_type != EntryType::Regular
                && entry_type != EntryType::Directory
            {
                warn!(
                    "Ignoring xattr {} on {} (EPERM for {:?})",
                    key,
                    path.display(),
                    entry_type
                );
            } else {
                return Err(BoxliteError::Storage(format!(
                    "Failed to set xattr {} on {}: {}",
                    key,
                    path.display(),
                    e
                )));
            }
        }
    }
    Ok(())
}

fn apply_times(path: &Path, entry_type: EntryType, atime: u64, mtime: u64) -> BoxliteResult<()> {
    let atime = bound_time(unix_time(atime));
    let mtime = bound_time(unix_time(mtime));
    let atime_ft = FileTime::from_system_time(atime);
    let mtime_ft = FileTime::from_system_time(latest_time(atime, mtime));
    if entry_type == EntryType::Symlink {
        set_symlink_file_times(path, atime_ft, mtime_ft).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to set times on symlink {}: {}",
                path.display(),
                e
            ))
        })?;
    } else if entry_type != EntryType::Link {
        set_file_times(path, atime_ft, mtime_ft).map_err(|e| {
            BoxliteError::Storage(format!("Failed to set times on {}: {}", path.display(), e))
        })?;
    }
    Ok(())
}

fn unix_time(secs: u64) -> SystemTime {
    // Saturate at the largest seconds value the platform's timespec can hold
    // (`i64::MAX`). Without this, a crafted tar header with `mtime` near
    // `u64::MAX` makes `UNIX_EPOCH + Duration::from_secs(..)` overflow and
    // panic. The `bound_time` clamp runs too late to help.
    const MAX_SECS: u64 = i64::MAX as u64;
    UNIX_EPOCH + Duration::from_secs(secs.min(MAX_SECS))
}

fn lchown(path: &Path, uid: libc::uid_t, gid: libc::gid_t) -> io::Result<()> {
    let c_path = to_cstring(path)?;
    let res = unsafe { libc::lchown(c_path.as_ptr(), uid, gid) };
    if res == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn setxattr_nofollow(path: &Path, key: &str, value: &[u8]) -> io::Result<()> {
    xattr::set(path, key, value)
}

fn to_cstring(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Path contains interior NUL: {}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;

    fn create_test_tar(entries: Vec<TestEntry>) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());

        for entry in entries {
            match entry.entry_type {
                TestEntryType::Directory => {
                    let mut header = tar::Header::new_gnu();
                    header.set_path(&entry.path).unwrap();
                    header.set_mode(0o755);
                    header.set_entry_type(tar::EntryType::Directory);
                    header.set_size(0);
                    header.set_cksum();
                    builder.append(&header, &[][..]).unwrap();
                }
                TestEntryType::File { content } => {
                    let mut header = tar::Header::new_gnu();
                    header.set_path(&entry.path).unwrap();
                    header.set_size(content.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    builder.append(&header, &*content).unwrap();
                }
                TestEntryType::Hardlink { target } => {
                    let mut header = tar::Header::new_gnu();
                    header.set_path(&entry.path).unwrap();
                    header.set_link_name(&target).unwrap();
                    header.set_mode(0o644);
                    header.set_entry_type(tar::EntryType::Link);
                    header.set_size(0);
                    header.set_cksum();
                    builder.append(&header, &[][..]).unwrap();
                }
                TestEntryType::Symlink { target } => {
                    let mut header = tar::Header::new_gnu();
                    header.set_path(&entry.path).unwrap();
                    header.set_link_name(&target).unwrap();
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_size(0);
                    header.set_cksum();
                    builder.append(&header, &[][..]).unwrap();
                }
            }
        }

        builder.into_inner().unwrap()
    }

    fn create_gzipped_tar(data: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    struct RawTarEntry<'a> {
        path: &'a str,
        kind: RawTarEntryKind<'a>,
        mode: u32,
    }

    enum RawTarEntryKind<'a> {
        Directory,
        File(&'a [u8]),
        Hardlink(&'a str),
        Symlink(&'a str),
    }

    fn raw_dir(path: &str) -> RawTarEntry<'_> {
        RawTarEntry {
            path,
            kind: RawTarEntryKind::Directory,
            mode: 0o755,
        }
    }

    fn raw_file<'a>(path: &'a str, content: &'a [u8]) -> RawTarEntry<'a> {
        RawTarEntry {
            path,
            kind: RawTarEntryKind::File(content),
            mode: 0o644,
        }
    }

    fn raw_hardlink<'a>(path: &'a str, target: &'a str) -> RawTarEntry<'a> {
        RawTarEntry {
            path,
            kind: RawTarEntryKind::Hardlink(target),
            mode: 0o644,
        }
    }

    fn raw_symlink<'a>(path: &'a str, target: &'a str) -> RawTarEntry<'a> {
        RawTarEntry {
            path,
            kind: RawTarEntryKind::Symlink(target),
            mode: 0o777,
        }
    }

    fn create_raw_tar(entries: &[RawTarEntry<'_>]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());

        for entry in entries {
            let mut header = tar::Header::new_gnu();
            set_header_path(&mut header, entry.path);
            header.set_mode(entry.mode);
            match entry.kind {
                RawTarEntryKind::Directory => {
                    header.set_entry_type(tar::EntryType::Directory);
                    header.set_size(0);
                    header.set_cksum();
                    builder.append(&header, &[][..]).unwrap();
                }
                RawTarEntryKind::File(content) => {
                    header.set_entry_type(tar::EntryType::Regular);
                    header.set_size(content.len() as u64);
                    header.set_cksum();
                    builder.append(&header, content).unwrap();
                }
                RawTarEntryKind::Hardlink(target) => {
                    header.set_link_name_literal(target.as_bytes()).unwrap();
                    header.set_entry_type(tar::EntryType::Link);
                    header.set_size(0);
                    header.set_cksum();
                    builder.append(&header, &[][..]).unwrap();
                }
                RawTarEntryKind::Symlink(target) => {
                    header.set_link_name_literal(target.as_bytes()).unwrap();
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_size(0);
                    header.set_cksum();
                    builder.append(&header, &[][..]).unwrap();
                }
            }
        }

        builder.into_inner().unwrap()
    }

    fn set_header_path(header: &mut tar::Header, path: &str) {
        if header.set_path(path).is_ok() {
            return;
        }

        let bytes = path.as_bytes();
        assert!(
            bytes.len() <= 100,
            "raw test path too long for old tar header: {}",
            path
        );
        let old = header.as_old_mut();
        old.name = [0; 100];
        old.name[..bytes.len()].copy_from_slice(bytes);
    }

    fn extract_raw(entries: &[RawTarEntry<'_>], dest: &Path) -> BoxliteResult<u64> {
        let mut e = LayerExtractor::new(dest);
        let n = e.extract_reader(std::io::Cursor::new(create_raw_tar(entries)))?;
        e.finalize()?;
        Ok(n)
    }

    fn assert_same_inode(left: &Path, right: &Path) {
        let left_meta = fs::symlink_metadata(left).unwrap();
        let right_meta = fs::symlink_metadata(right).unwrap();
        assert_eq!(left_meta.dev(), right_meta.dev());
        assert_eq!(left_meta.ino(), right_meta.ino());
    }

    struct TestEntry {
        path: String,
        entry_type: TestEntryType,
    }

    enum TestEntryType {
        Directory,
        File { content: Vec<u8> },
        Hardlink { target: String },
        Symlink { target: String },
    }

    fn extract(tar_path: &Path, dest: &Path) -> BoxliteResult<u64> {
        let mut e = LayerExtractor::new(dest);
        let n = e.extract_tarball(tar_path)?;
        e.finalize()?;
        Ok(n)
    }

    #[test]
    fn test_deferred_hardlink_target_appears_later() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![
            TestEntry {
                path: "link-to-target".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target.txt".to_string(),
                },
            },
            TestEntry {
                path: "target.txt".to_string(),
                entry_type: TestEntryType::File {
                    content: b"target content".to_vec(),
                },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        let size = extract(&tar_path, &dest_dir).unwrap();

        let link_path = dest_dir.join("link-to-target");
        let target_path = dest_dir.join("target.txt");

        assert!(link_path.exists());
        assert!(target_path.exists());

        let link_content = std::fs::read_to_string(&link_path).unwrap();
        let target_content = std::fs::read_to_string(&target_path).unwrap();
        assert_eq!(link_content, "target content");
        assert_eq!(target_content, "target content");

        assert_eq!(size, 14);
    }

    #[test]
    fn test_deferred_hardlink_with_directories() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![
            TestEntry {
                path: "dir".to_string(),
                entry_type: TestEntryType::Directory,
            },
            TestEntry {
                path: "dir/link".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target.txt".to_string(),
                },
            },
            TestEntry {
                path: "target.txt".to_string(),
                entry_type: TestEntryType::File {
                    content: b"shared content".to_vec(),
                },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        extract(&tar_path, &dest_dir).unwrap();

        let link_path = dest_dir.join("dir/link");
        let target_path = dest_dir.join("target.txt");

        assert!(link_path.exists());
        assert!(target_path.exists());

        let link_content = std::fs::read_to_string(&link_path).unwrap();
        assert_eq!(link_content, "shared content");
    }

    #[test]
    fn test_multiple_deferred_hardlinks() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![
            TestEntry {
                path: "link1".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target".to_string(),
                },
            },
            TestEntry {
                path: "link2".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target".to_string(),
                },
            },
            TestEntry {
                path: "link3".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target".to_string(),
                },
            },
            TestEntry {
                path: "target".to_string(),
                entry_type: TestEntryType::File {
                    content: b"data".to_vec(),
                },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        extract(&tar_path, &dest_dir).unwrap();

        for i in 1..=3 {
            let link_path = dest_dir.join(format!("link{}", i));
            assert!(link_path.exists(), "link{} should exist", i);
            let content = std::fs::read_to_string(&link_path).unwrap();
            assert_eq!(content, "data");
        }

        let target_path = dest_dir.join("target");
        assert!(target_path.exists());
    }

    #[test]
    fn test_deferred_hardlink_target_removed_by_whiteout() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![
            TestEntry {
                path: "target.txt".to_string(),
                entry_type: TestEntryType::File {
                    content: b"will be removed".to_vec(),
                },
            },
            TestEntry {
                path: "link".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target.txt".to_string(),
                },
            },
            TestEntry {
                path: ".wh.target.txt".to_string(),
                entry_type: TestEntryType::File { content: vec![] },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        let result = extract(&tar_path, &dest_dir);
        assert!(result.is_ok(), "Should handle missing target gracefully");

        let target_path = dest_dir.join("target.txt");
        assert!(!target_path.exists());
    }

    #[test]
    fn test_hardlink_target_exists_immediately() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![
            TestEntry {
                path: "target.txt".to_string(),
                entry_type: TestEntryType::File {
                    content: b"content".to_vec(),
                },
            },
            TestEntry {
                path: "link".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target.txt".to_string(),
                },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        extract(&tar_path, &dest_dir).unwrap();

        let link_path = dest_dir.join("link");
        let target_path = dest_dir.join("target.txt");

        assert!(link_path.exists());
        assert!(target_path.exists());

        let content = std::fs::read_to_string(&link_path).unwrap();
        assert_eq!(content, "content");
    }

    #[test]
    fn containerd_absolute_symlink_paths_are_reanchored() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");

        extract_raw(
            &[
                raw_symlink("localetc", "/etc"),
                raw_file("/localetc/unbroken", b"one"),
                raw_symlink("dummy", "."),
                raw_symlink("normallocaletc", "/dummy/../etc"),
                raw_file("/normallocaletc/passwd", b"two"),
                raw_symlink("chain-a", "chain-b"),
                raw_symlink("chain-b", "/etc"),
                raw_file("chain-a/chain", b"three"),
            ],
            &dest,
        )
        .unwrap();

        assert_eq!(std::fs::read(dest.join("etc/unbroken")).unwrap(), b"one");
        assert_eq!(std::fs::read(dest.join("etc/passwd")).unwrap(), b"two");
        assert_eq!(std::fs::read(dest.join("etc/chain")).unwrap(), b"three");
        assert_eq!(
            std::fs::read_link(dest.join("localetc")).unwrap(),
            Path::new("/etc")
        );
    }

    #[test]
    fn containerd_hardlink_to_symlink_preserves_symlink_inode() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");

        extract_raw(
            &[
                raw_dir("etc"),
                raw_file("etc/passwd", b"root"),
                raw_symlink("passwdlink", "/etc/passwd"),
                raw_hardlink("hardlink", "passwdlink"),
            ],
            &dest,
        )
        .unwrap();

        assert_eq!(
            std::fs::read_link(dest.join("hardlink")).unwrap(),
            Path::new("/etc/passwd")
        );
        assert_same_inode(&dest.join("passwdlink"), &dest.join("hardlink"));
        assert_eq!(std::fs::read(dest.join("etc/passwd")).unwrap(), b"root");
    }

    #[test]
    fn containerd_hardlink_through_symlink_parent_stays_in_root() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");

        extract_raw(
            &[
                raw_symlink("localetc", "/etc"),
                raw_dir("etc"),
                raw_file("etc/passwd", b"root"),
                raw_hardlink("localetc/passwd.link", "etc/passwd"),
            ],
            &dest,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(dest.join("etc/passwd.link")).unwrap(),
            b"root"
        );
        assert_same_inode(&dest.join("etc/passwd"), &dest.join("etc/passwd.link"));
    }

    #[test]
    fn containerd_whiteout_final_symlink_removes_link_not_target() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");

        extract_raw(
            &[
                raw_dir("target"),
                raw_file("target/file", b"kept"),
                raw_symlink("remove-me", "/target"),
                raw_file(".wh.remove-me", b""),
            ],
            &dest,
        )
        .unwrap();

        assert!(std::fs::symlink_metadata(dest.join("remove-me")).is_err());
        assert_eq!(std::fs::read(dest.join("target/file")).unwrap(), b"kept");
    }

    #[test]
    fn containerd_whiteout_through_symlink_parent_is_reanchored() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");

        extract_raw(
            &[
                raw_symlink("localetc", "/etc"),
                raw_dir("etc"),
                raw_file("etc/victim", b"delete"),
                raw_file("localetc/.wh.victim", b""),
            ],
            &dest,
        )
        .unwrap();

        assert!(!dest.join("etc/victim").exists());
        assert_eq!(
            std::fs::read_link(dest.join("localetc")).unwrap(),
            Path::new("/etc")
        );
    }

    #[test]
    fn umoci_invalid_whiteout_names_are_rejected() {
        for path in [
            ".wh.",
            ".wh..",
            ".wh...",
            "etc/.wh.",
            "etc/.wh..",
            "etc/.wh...",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let dest = tmp.path().join("extract");
            let result = extract_raw(&[raw_file(path, b"")], &dest);
            assert!(result.is_err(), "invalid whiteout should fail: {}", path);
        }
    }

    #[test]
    fn umoci_wh_prefix_directory_is_not_a_whiteout() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");

        extract_raw(
            &[
                raw_dir(".wh.etc"),
                raw_file(".wh.etc/somefile", b"marker-looking path"),
                raw_dir("etc"),
                raw_file("etc/passwd", b"root"),
            ],
            &dest,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(dest.join(".wh.etc/somefile")).unwrap(),
            b"marker-looking path"
        );
        assert_eq!(std::fs::read(dest.join("etc/passwd")).unwrap(), b"root");
    }

    #[test]
    fn umoci_opaque_whiteout_preserves_same_layer_children() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");
        fs::create_dir_all(dest.join("dir/old-subdir")).unwrap();
        fs::write(dest.join("dir/old-subdir/lower"), b"lower").unwrap();
        fs::write(dest.join("dir/lower-file"), b"lower").unwrap();

        extract_raw(
            &[
                raw_file("dir/new-subdir/new-file", b"upper"),
                raw_file("dir/.wh..wh..opq", b""),
            ],
            &dest,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(dest.join("dir/new-subdir/new-file")).unwrap(),
            b"upper"
        );
        assert!(!dest.join("dir/old-subdir").exists());
        assert!(!dest.join("dir/lower-file").exists());
    }

    #[test]
    fn cached_layer_unpack_preserves_whiteout_markers() {
        let tmp = tempfile::tempdir().unwrap();
        let tar_path = tmp.path().join("layer.tar");
        let dest = tmp.path().join("extract");

        std::fs::write(
            &tar_path,
            create_raw_tar(&[
                raw_dir("bin"),
                raw_file("bin/.wh.sh", b""),
                raw_file("bin/new-tool", b"upper"),
            ]),
        )
        .unwrap();

        let mut extractor = LayerExtractor::new(&dest);
        extractor
            .extract_tarball_preserving_whiteouts(&tar_path)
            .unwrap();
        extractor.finalize().unwrap();

        assert!(dest.join("bin/.wh.sh").exists());
        assert_eq!(std::fs::read(dest.join("bin/new-tool")).unwrap(), b"upper");
    }

    #[test]
    fn umoci_parent_underflow_entries_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");
        let host_file = tmp.path().join("outside");
        fs::write(&host_file, b"host").unwrap();

        extract_raw(&[raw_file("../outside", b"layer")], &dest).unwrap();

        assert_eq!(std::fs::read(&host_file).unwrap(), b"host");
        assert!(!dest.join("outside").exists());
    }

    // Parent creation and obstacle handling through rooted resolution.
    // Lower-level path-safety tests live in safe_root.rs.

    use super::super::safe_root::SafeRoot;

    #[test]
    fn extractor_replaces_file_obstacle_with_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");

        // Layer 1: "a" as a regular file
        let tar1 = tmp.path().join("layer1.tar");
        let entries1 = vec![TestEntry {
            path: "a".to_string(),
            entry_type: TestEntryType::File {
                content: b"I'm a file".to_vec(),
            },
        }];
        std::fs::write(&tar1, create_test_tar(entries1)).unwrap();
        extract(&tar1, &dest).unwrap();

        // Layer 2: "a/b/c.txt" — extraction should replace the file
        // obstacle at "a" with a directory
        let tar2 = tmp.path().join("layer2.tar");
        let entries2 = vec![TestEntry {
            path: "a/b/c.txt".to_string(),
            entry_type: TestEntryType::File {
                content: b"nested".to_vec(),
            },
        }];
        std::fs::write(&tar2, create_test_tar(entries2)).unwrap();
        extract(&tar2, &dest).unwrap();

        assert!(dest.join("a/b").is_dir());
    }

    #[test]
    fn rooted_parent_creation_handles_existing_directory() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("a")).unwrap();

        let root = SafeRoot::open(tmp.path()).unwrap();
        let resolved = root.resolve(Path::new("a/b")).unwrap();
        std::fs::create_dir_all(&resolved).unwrap();

        assert!(tmp.path().join("a/b").is_dir());
    }

    #[test]
    fn extractor_replaces_deep_file_obstacle_with_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("extract");

        // Layer 1: "a" as a file
        let tar1 = tmp.path().join("layer1.tar");
        let entries1 = vec![TestEntry {
            path: "a".to_string(),
            entry_type: TestEntryType::File {
                content: b"blocker".to_vec(),
            },
        }];
        std::fs::write(&tar1, create_test_tar(entries1)).unwrap();
        extract(&tar1, &dest).unwrap();

        // Layer 2: deeply nested under "a"
        let tar2 = tmp.path().join("layer2.tar");
        let entries2 = vec![TestEntry {
            path: "a/b/c/d/e/file.txt".to_string(),
            entry_type: TestEntryType::File {
                content: b"deep".to_vec(),
            },
        }];
        std::fs::write(&tar2, create_test_tar(entries2)).unwrap();
        extract(&tar2, &dest).unwrap();

        assert!(dest.join("a/b/c/d/e").is_dir());
    }

    #[test]
    fn rooted_parent_creation_preserves_pnpm_style_symlink_to_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let bar_dir = tmp.path().join(".pnpm/bar@1.0.0/node_modules/bar");
        fs::create_dir_all(&bar_dir).unwrap();
        std::fs::write(bar_dir.join("index.js"), b"bar").unwrap();

        let foo_nm = tmp.path().join(".pnpm/foo@1.0.0/node_modules");
        fs::create_dir_all(&foo_nm).unwrap();
        let bar_symlink = foo_nm.join("bar");
        std::os::unix::fs::symlink("../../bar@1.0.0/node_modules/bar", &bar_symlink).unwrap();
        assert!(bar_symlink.is_symlink());

        let root = SafeRoot::open(tmp.path()).unwrap();
        {
            let p = Path::new(".pnpm/foo@1.0.0/node_modules/bar/subdir/file.txt");
            if let Some(parent) = p.parent() {
                let resolved = root.resolve(parent).unwrap();
                std::fs::create_dir_all(&resolved).unwrap();
            }
        }

        assert!(
            bar_symlink.is_symlink(),
            "in-root symlink must be preserved"
        );
        assert_eq!(
            fs::read_link(&bar_symlink).unwrap(),
            Path::new("../../bar@1.0.0/node_modules/bar"),
        );
    }

    #[test]
    fn test_gzip_compression_detection() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar.gz");

        let entries = vec![TestEntry {
            path: "file.txt".to_string(),
            entry_type: TestEntryType::File {
                content: b"test content".to_vec(),
            },
        }];

        let tar_data = create_test_tar(entries);
        let gzipped_data = create_gzipped_tar(&tar_data);
        std::fs::write(&tar_path, &gzipped_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        extract(&tar_path, &dest_dir).unwrap();

        let file_path = dest_dir.join("file.txt");
        assert!(file_path.exists());
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "test content");
    }

    #[test]
    fn test_uncompressed_tar_detection() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![TestEntry {
            path: "file.txt".to_string(),
            entry_type: TestEntryType::File {
                content: b"uncompressed".to_vec(),
            },
        }];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        extract(&tar_path, &dest_dir).unwrap();

        let file_path = dest_dir.join("file.txt");
        assert!(file_path.exists());
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "uncompressed");
    }

    #[test]
    fn test_apply_oci_layer_with_symlinks() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![
            TestEntry {
                path: "target.txt".to_string(),
                entry_type: TestEntryType::File {
                    content: b"target".to_vec(),
                },
            },
            TestEntry {
                path: "link".to_string(),
                entry_type: TestEntryType::Symlink {
                    target: "target.txt".to_string(),
                },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        extract(&tar_path, &dest_dir).unwrap();

        let link_path = dest_dir.join("link");
        assert!(link_path.is_symlink());

        let target = std::fs::read_link(&link_path).unwrap();
        assert_eq!(target, PathBuf::from("target.txt"));
    }

    // Regression: GHSA-f396-4rp4-7v2j — crafted OCI layer must not write
    // outside the extraction root even with a symlink pointing on-host.
    #[test]
    fn test_cve_symlink_escape_blocked() {
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("malicious.tar");
        let dest_dir = temp_dir.path().join("extract");
        let host_side_dir = temp_dir.path().join("host_escape_target");
        fs::create_dir_all(&host_side_dir).unwrap();

        let escape_target = host_side_dir.join("pwned.txt");
        assert!(!escape_target.exists());

        let entries = vec![
            TestEntry {
                path: "escape".to_string(),
                entry_type: TestEntryType::Symlink {
                    target: host_side_dir.to_string_lossy().into_owned(),
                },
            },
            TestEntry {
                path: "escape/pwned.txt".to_string(),
                entry_type: TestEntryType::File {
                    content: b"EXPLOIT_PAYLOAD".to_vec(),
                },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let _ = extract(&tar_path, &dest_dir);

        assert!(
            !escape_target.exists(),
            "CVE regression: host file was written via escape symlink at {}",
            escape_target.display()
        );
    }

    /// Regression: an escape symlink planted by an earlier layer must not let a
    /// subsequent write land outside `dest`.
    #[test]
    fn resolve_preexisting_escape_symlink_stays_inside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("dest");
        let host_side = tmp.path().join("host_side");
        fs::create_dir_all(&dest).unwrap();
        fs::create_dir_all(&host_side).unwrap();

        let escape_link = dest.join("escape");
        std::os::unix::fs::symlink(&host_side, &escape_link).unwrap();
        assert!(escape_link.is_symlink());

        let root = SafeRoot::open(&dest).unwrap();
        {
            let (p, _) = LayerExtractor::split_parent_leaf(Path::new("escape/pwned.txt"));
            if !p.as_os_str().is_empty() {
                let sp = root.resolve(&p).unwrap();
                std::fs::create_dir_all(&sp).unwrap();
            }
        }

        let safe = root.resolve(Path::new("escape/pwned.txt")).unwrap();
        // ensure parent of the resolved path exists
        if let Some(p) = safe.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(&safe, b"contained").unwrap();
        assert!(
            !host_side.join("pwned.txt").exists(),
            "write escaped to host through symlink"
        );
    }

    // ================================================================
    // Audit regressions.
    // ================================================================

    /// A tar entry with an extreme `mtime` should either succeed or return a
    /// `BoxliteError`, never unwind.
    #[test]
    fn crafted_mtime_does_not_panic() {
        let temp = tempfile::tempdir().unwrap();
        let tar_path = temp.path().join("mtime_bomb.tar");

        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_path("hello.txt").unwrap();
        header.set_size(5);
        header.set_mode(0o644);
        // SystemTime on Unix is backed by an `i64`-seconded timespec;
        // u64::MAX seconds overflows on Add.
        header.set_mtime(u64::MAX);
        header.set_cksum();
        builder.append(&header, &b"hello"[..]).unwrap();
        let data = builder.into_inner().unwrap();
        std::fs::write(&tar_path, &data).unwrap();

        let dest = temp.path().join("extract");
        let outcome = std::panic::catch_unwind(|| {
            let mut e = LayerExtractor::new(&dest);
            let r = e.extract_tarball(&tar_path);
            let _ = e.finalize();
            r
        });

        assert!(
            outcome.is_ok(),
            "extractor panicked on crafted mtime — should saturate/error instead"
        );
    }

    /// Whiteout removal must be rooted even if an escape symlink already exists
    /// in the extraction root.
    #[test]
    fn whiteout_does_not_follow_preexisting_escape_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("extract");
        let host_side = temp.path().join("host");
        fs::create_dir_all(&dest).unwrap();
        fs::create_dir_all(&host_side).unwrap();

        // Pre-plant the escape symlink *before* `LayerExtractor` runs.
        // Simulates state left by an older boxlite that didn't have
        // `SafeRoot` containment.
        let host_victim = host_side.join("victim.txt");
        std::fs::write(&host_victim, b"host content").unwrap();
        std::os::unix::fs::symlink(&host_side, dest.join("etc")).unwrap();

        // Layer: just a whiteout targeting a file reachable through the
        // escape symlink.
        let tar_path = temp.path().join("wh.tar");
        let entries = vec![TestEntry {
            path: "etc/.wh.victim.txt".to_string(),
            entry_type: TestEntryType::File { content: vec![] },
        }];
        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let _ = extract(&tar_path, &dest);

        assert!(
            host_victim.exists(),
            "whiteout followed escape symlink and deleted host file: {}",
            host_victim.display()
        );
    }

    /// Hardlink headers must not chmod the shared target inode when the tar
    /// hardlink header carries a different mode.
    #[test]
    fn hardlink_entry_does_not_overwrite_target_permissions() {
        let temp = tempfile::tempdir().unwrap();
        let tar_path = temp.path().join("hl.tar");

        let mut builder = tar::Builder::new(Vec::new());

        let mut target_h = tar::Header::new_gnu();
        target_h.set_path("target").unwrap();
        target_h.set_size(5);
        target_h.set_mode(0o600);
        target_h.set_cksum();
        builder.append(&target_h, &b"hello"[..]).unwrap();

        let mut link_h = tar::Header::new_gnu();
        link_h.set_path("link").unwrap();
        link_h.set_link_name("target").unwrap();
        link_h.set_mode(0o755);
        link_h.set_entry_type(tar::EntryType::Link);
        link_h.set_size(0);
        link_h.set_cksum();
        builder.append(&link_h, &[][..]).unwrap();

        std::fs::write(&tar_path, builder.into_inner().unwrap()).unwrap();

        let dest = temp.path().join("extract");
        extract(&tar_path, &dest).unwrap();

        let target_mode = std::fs::metadata(dest.join("target"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            target_mode, 0o600,
            "hardlink entry's 0o755 mode overwrote target's declared 0o600 \
             (got {:o}) — perms should not be chmod'd through a hardlink",
            target_mode
        );
    }

    /// Cross-layer regression: an OCI base layer that declares a system
    /// directory as 0o555 must not block subsequent layers from overwriting
    /// files inside it. RHEL UBI ships `/usr/bin` as 0o555, and images
    /// derived from UBI (e.g. `minio/mc`) install binaries into `/usr/bin`,
    /// needing to replace base-layer files like `usr/bin/[`.
    ///
    /// Pre-fix bug: applying the deferred-dirs sweep at end of each layer
    /// chmod'd `/usr/bin` to 0o555 before the next layer's unlink, EACCES.
    /// Post-fix: a single `LayerExtractor` accumulates directory metadata
    /// across all layers and applies it only on `finalize`.
    #[test]
    fn cross_layer_overwrite_through_readonly_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("merged");

        let mut extractor = LayerExtractor::new(&dest);

        let layer1 = [
            raw_dir("usr"),
            RawTarEntry {
                path: "usr/bin",
                kind: RawTarEntryKind::Directory,
                mode: 0o555,
            },
            raw_file("usr/bin/[", b"original"),
        ];
        extractor
            .extract_reader(std::io::Cursor::new(create_raw_tar(&layer1)))
            .unwrap();

        let layer2 = [raw_file("usr/bin/[", b"upper")];
        extractor
            .extract_reader(std::io::Cursor::new(create_raw_tar(&layer2)))
            .expect("upper layer must overwrite file inside 0o555 base dir");

        extractor.finalize().unwrap();

        assert_eq!(
            std::fs::read(dest.join("usr/bin/[")).unwrap(),
            b"upper",
            "upper layer must replace base layer's file content",
        );

        let bin_mode = fs::symlink_metadata(dest.join("usr/bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            bin_mode, 0o555,
            "after fix, /usr/bin must retain declared 0o555 (got {:o}) — \
             a fix that relaxes perms to bypass EACCES would corrupt the \
             override_stat xattr written by fix_rootfs_permissions",
            bin_mode,
        );

        // Restore u+w so TempDir's Drop can recurse-remove.
        let _ = fs::set_permissions(dest.join("usr/bin"), Permissions::from_mode(0o755));
    }

    /// Whiteout regression: a `.wh.` marker deleting a file inside an
    /// already-finalized read-only parent dir must succeed. OCI base layers
    /// ship system dirs like `/usr/bin` at 0o555; a higher layer whiteouting a
    /// file there (e.g. removing coreutils `[`) hits a parent the previous
    /// layer's `finalize` already chmod'd to 0o555 on disk, so std `remove_*`
    /// can't unlink within it — pre-fix this surfaced as a cold `make up`
    /// failure on macOS: "Failed to remove …/usr/bin/[: Permission denied".
    /// `remove_nofollow` must make the target writable and proceed.
    #[test]
    fn whiteout_removes_file_inside_finalized_readonly_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("merged");

        // Layer 1: lay down /usr/bin at 0o555 with a file, then finalize so the
        // read-only mode is applied on disk (a later layer sees 0o555).
        let mut ex1 = LayerExtractor::new(&dest);
        ex1.extract_reader(std::io::Cursor::new(create_raw_tar(&[
            raw_dir("usr"),
            RawTarEntry {
                path: "usr/bin",
                kind: RawTarEntryKind::Directory,
                mode: 0o555,
            },
            raw_file("usr/bin/[", b"coreutils"),
        ])))
        .unwrap();
        ex1.finalize().unwrap();

        let bin_mode = fs::symlink_metadata(dest.join("usr/bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            bin_mode, 0o555,
            "precondition: /usr/bin must be read-only on disk before the whiteout layer",
        );

        // Layer 2: whiteout /usr/bin/[ — its parent is 0o555 on disk now, so the
        // unlink only succeeds if remove_nofollow makes the target writable.
        let mut ex2 = LayerExtractor::new(&dest);
        ex2.extract_reader(std::io::Cursor::new(create_raw_tar(&[raw_file(
            "usr/bin/.wh.[",
            b"",
        )])))
        .expect("whiteout must delete a file inside a read-only parent dir");
        ex2.finalize().unwrap();

        assert!(
            !dest.join("usr/bin/[").exists(),
            "whiteout should have removed /usr/bin/[",
        );

        // Restore u+w so TempDir's Drop can recurse-remove.
        let _ = fs::set_permissions(dest.join("usr/bin"), Permissions::from_mode(0o755));
    }

    /// Last-write-wins: layer 2 redeclaring a dir with a different mode
    /// overrides layer 1's mode.
    #[test]
    fn cross_layer_redeclared_dir_uses_later_layer_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("merged");

        let mut extractor = LayerExtractor::new(&dest);

        let layer1 = [
            raw_dir("usr"),
            RawTarEntry {
                path: "usr/bin",
                kind: RawTarEntryKind::Directory,
                mode: 0o555,
            },
        ];
        extractor
            .extract_reader(std::io::Cursor::new(create_raw_tar(&layer1)))
            .unwrap();

        let layer2 = [
            raw_dir("usr"),
            RawTarEntry {
                path: "usr/bin",
                kind: RawTarEntryKind::Directory,
                mode: 0o750,
            },
        ];
        extractor
            .extract_reader(std::io::Cursor::new(create_raw_tar(&layer2)))
            .unwrap();
        extractor.finalize().unwrap();

        let bin_mode = fs::symlink_metadata(dest.join("usr/bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            bin_mode, 0o750,
            "later layer's redeclaration of /usr/bin must win"
        );
    }

    /// Layer 2 writes a file into a dir declared by layer 1 without
    /// redeclaring the dir itself. The dir's final mode must come from
    /// layer 1 (the only layer that declared it).
    #[test]
    fn cross_layer_unmentioned_dir_keeps_earlier_layer_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("merged");

        let mut extractor = LayerExtractor::new(&dest);

        let layer1 = [
            raw_dir("usr"),
            RawTarEntry {
                path: "usr/bin",
                kind: RawTarEntryKind::Directory,
                mode: 0o555,
            },
        ];
        extractor
            .extract_reader(std::io::Cursor::new(create_raw_tar(&layer1)))
            .unwrap();

        // Layer 2 writes a file into /usr/bin but doesn't redeclare the dir.
        let layer2 = [raw_file("usr/bin/bar", b"hello")];
        extractor
            .extract_reader(std::io::Cursor::new(create_raw_tar(&layer2)))
            .unwrap();
        extractor.finalize().unwrap();

        let bin_mode = fs::symlink_metadata(dest.join("usr/bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            bin_mode, 0o555,
            "earlier layer's declared mode is preserved when no later layer redeclares"
        );
        assert_eq!(std::fs::read(dest.join("usr/bin/bar")).unwrap(), b"hello");

        let _ = fs::set_permissions(dest.join("usr/bin"), Permissions::from_mode(0o755));
    }

    /// A later layer whiteouts a dir that an earlier layer recorded.
    /// `finalize` must skip the now-removed path cleanly (no panic).
    #[test]
    fn cross_layer_whiteout_of_recorded_dir_does_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("merged");

        let mut extractor = LayerExtractor::new(&dest);

        let layer1 = [
            raw_dir("usr"),
            RawTarEntry {
                path: "usr/foo",
                kind: RawTarEntryKind::Directory,
                mode: 0o755,
            },
            raw_file("usr/foo/x", b"hi"),
        ];
        extractor
            .extract_reader(std::io::Cursor::new(create_raw_tar(&layer1)))
            .unwrap();

        // Layer 2: whiteout removes /usr/foo entirely.
        let layer2 = [raw_file("usr/.wh.foo", b"")];
        extractor
            .extract_reader(std::io::Cursor::new(create_raw_tar(&layer2)))
            .unwrap();

        // Must succeed: DeferredDirs::apply re-stats each path and skips
        // removed/replaced dirs.
        extractor.finalize().unwrap();

        assert!(!dest.join("usr/foo").exists());
    }

    /// The cap on DeferredDirs is anti-DOS: a crafted image with absurd
    /// numbers of unique dir entries should fail fast with a clear error
    /// pointing at the override env var, not OOM the host.
    #[test]
    fn deferred_dirs_cap_rejects_oversized_image() {
        let mut dirs = DeferredDirs::with_cap(2);
        let mk = |p: &str| DirMeta {
            path: PathBuf::from(p),
            meta: EntryMetadata::with_timestamps(0o755, 0, 0),
        };

        dirs.record(mk("/a")).unwrap();
        dirs.record(mk("/b")).unwrap();

        // 3rd distinct dir trips the cap.
        let err = dirs.record(mk("/c")).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("BOXLITE_MAX_DEFERRED_DIRS"),
            "cap error should mention the env-var override: {}",
            msg,
        );

        // Replacing an existing key is not growth; should still succeed.
        dirs.record(mk("/a")).unwrap();
    }
}
