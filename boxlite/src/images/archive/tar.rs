//! Streaming OCI tar layer applier (containerd-style).

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use filetime::{FileTime, set_file_times, set_symlink_file_times};
use flate2::read::GzDecoder;
#[cfg(target_os = "linux")]
use libc::c_uint;
use std::collections::HashSet;
use std::ffi::CString;
use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, BufReader, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tar::{Archive, Entry, EntryType};
use tracing::{debug, trace, warn};
use walkdir::WalkDir;

use super::override_stat::{OverrideFileType, OverrideStat};
use super::time::{bound_time, latest_time};

/// Apply a gzip-compressed OCI layer tarball into `dest`, preserving metadata.
pub fn extract_layer_tarball_streaming(tarball_path: &Path, dest: &Path) -> BoxliteResult<u64> {
    let file = fs::File::open(tarball_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open layer tarball {}: {}",
            tarball_path.display(),
            e
        ))
    })?;

    // Detect compression format by reading first 2 bytes
    let mut header = [0u8; 2];
    {
        let file_ref = &file;
        use std::io::Read;
        file_ref
            .take(2)
            .read_exact(&mut header)
            .map_err(|e| BoxliteError::Storage(format!("Failed to read layer header: {}", e)))?;
    }

    // Gzip magic number: 0x1f 0x8b
    let reader: Box<dyn Read> = if header == [0x1f, 0x8b] {
        // Gzip-compressed
        debug!("Detected gzip compression for {}", tarball_path.display());
        let file = fs::File::open(tarball_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to reopen layer tarball {}: {}",
                tarball_path.display(),
                e
            ))
        })?;
        Box::new(GzDecoder::new(BufReader::new(file)))
    } else {
        // Uncompressed
        debug!(
            "Detected uncompressed tarball for {}",
            tarball_path.display()
        );
        let file = fs::File::open(tarball_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to reopen layer tarball {}: {}",
                tarball_path.display(),
                e
            ))
        })?;
        Box::new(BufReader::new(file))
    };

    apply_oci_layer(reader, dest)
}

/// Ownership metadata for chown/xattr operations.
pub struct OwnershipMeta {
    pub uid: u64,
    pub gid: u64,
    pub entry_type: EntryType,
    pub device_major: libc::dev_t,
    pub device_minor: libc::dev_t,
    pub xattrs: Vec<(String, Vec<u8>)>,
}

/// Timestamp metadata for time operations.
pub struct TimestampMeta {
    pub atime: u64,
    pub mtime: u64,
}

/// Entry metadata combining ownership, timestamps, and permissions.
pub struct EntryMetadata {
    pub mode: u32,
    pub timestamps: TimestampMeta,
    pub ownership: Option<OwnershipMeta>,
}

impl EntryMetadata {
    /// Create metadata with only timestamps (for directories).
    pub fn with_timestamps(mode: u32, atime: u64, mtime: u64) -> Self {
        Self {
            mode,
            timestamps: TimestampMeta { atime, mtime },
            ownership: None,
        }
    }

    /// Start building full metadata (for files, hardlinks, etc.).
    pub fn builder(mode: u32, atime: u64, mtime: u64) -> EntryMetadataBuilder {
        EntryMetadataBuilder {
            mode,
            atime,
            mtime,
            uid: 0,
            gid: 0,
            entry_type: EntryType::Regular,
            device_major: 0,
            device_minor: 0,
            xattrs: vec![],
        }
    }
}

/// Builder for creating EntryMetadata with ownership.
pub struct EntryMetadataBuilder {
    mode: u32,
    atime: u64,
    mtime: u64,
    uid: u64,
    gid: u64,
    entry_type: EntryType,
    device_major: libc::dev_t,
    device_minor: libc::dev_t,
    xattrs: Vec<(String, Vec<u8>)>,
}

impl EntryMetadataBuilder {
    pub fn uid(mut self, uid: u64) -> Self {
        self.uid = uid;
        self
    }

    pub fn gid(mut self, gid: u64) -> Self {
        self.gid = gid;
        self
    }

    pub fn entry_type(mut self, entry_type: EntryType) -> Self {
        self.entry_type = entry_type;
        self
    }

    pub fn device(mut self, major: libc::dev_t, minor: libc::dev_t) -> Self {
        self.device_major = major;
        self.device_minor = minor;
        self
    }

    pub fn xattrs(mut self, xattrs: Vec<(String, Vec<u8>)>) -> Self {
        self.xattrs = xattrs;
        self
    }

    pub fn build(self) -> EntryMetadata {
        EntryMetadata {
            mode: self.mode,
            timestamps: TimestampMeta {
                atime: self.atime,
                mtime: self.mtime,
            },
            ownership: Some(OwnershipMeta {
                uid: self.uid,
                gid: self.gid,
                entry_type: self.entry_type,
                device_major: self.device_major,
                device_minor: self.device_minor,
                xattrs: self.xattrs,
            }),
        }
    }
}

struct DirMeta {
    path: PathBuf,
    meta: EntryMetadata,
}

/// Deferred hardlink: source doesn't exist yet, will retry later.
struct DeferredHardlink {
    link_path: PathBuf,
    target_path: PathBuf,
    meta: EntryMetadata,
}

/// Apply an OCI layer tar stream into `dest`, handling whiteouts inline.
pub fn apply_oci_layer<R: Read>(reader: R, dest: &Path) -> BoxliteResult<u64> {
    fs::create_dir_all(dest).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create destination directory {}: {}",
            dest.display(),
            e
        ))
    })?;

    let is_root = unsafe { libc::geteuid() } == 0;
    let mut archive = Archive::new(reader);
    let mut unpacked_paths = HashSet::new();
    let mut total_size = 0u64;
    let mut deferred_dirs: Vec<DirMeta> = Vec::new();
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
        let normalized = match normalize_entry_path(&raw_path) {
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

        let full_path = dest.join(&normalized);
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

        // Whiteout handling (inline, no second pass)
        let whiteout_handled = handle_whiteout(&full_path, &mut unpacked_paths, entry_type)?;
        if whiteout_handled {
            continue;
        }

        ensure_parent_dirs(&full_path, dest)?;

        remove_existing_if_needed(&full_path, entry_type)?;

        let xattrs = read_xattrs(&mut entry)?;

        // Track if this entry is a deferred hardlink (target doesn't exist yet)
        let mut deferred_hardlink = false;

        match entry_type {
            EntryType::Directory => create_dir(&full_path)?,
            EntryType::Regular | EntryType::GNUSparse => {
                create_regular_file(&mut entry, &full_path, mode)?
            }
            EntryType::Link => {
                let target = link_name.clone().ok_or_else(|| {
                    BoxliteError::Storage(format!(
                        "Hardlink without target: {}",
                        raw_path.display()
                    ))
                })?;
                let target_path = resolve_hardlink_target(dest, &target)?;
                // Try to create hardlink, defer if target doesn't exist yet
                if target_path.exists() {
                    create_hardlink(&full_path, &target_path)?;
                } else {
                    trace!(
                        "Deferring hardlink {} -> {} (target not found yet)",
                        full_path.display(),
                        target_path.display()
                    );
                    deferred_hardlinks.push(DeferredHardlink {
                        link_path: full_path.clone(),
                        target_path,
                        meta: EntryMetadata::builder(mode, atime, mtime)
                            .uid(uid)
                            .gid(gid)
                            .entry_type(entry_type)
                            .device(device_major, device_minor)
                            .xattrs(vec![]) // Hardlinks don't have xattrs initially
                            .build(),
                    });
                    deferred_hardlink = true; // Mark as deferred
                }
            }
            EntryType::Symlink => {
                let target = link_name.ok_or_else(|| {
                    BoxliteError::Storage(format!("Symlink without target: {}", raw_path.display()))
                })?;
                create_symlink(&full_path, &target)?;
            }
            EntryType::Block | EntryType::Char => {
                create_special_device(
                    &full_path,
                    entry_type,
                    mode,
                    device_major,
                    device_minor,
                    is_root,
                )?;
            }
            EntryType::Fifo => create_fifo(&full_path, mode)?,
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

        // Skip post-creation processing for deferred hardlinks
        // (they'll be processed later after all entries are extracted)
        if deferred_hardlink {
            unpacked_paths.insert(full_path);
            continue;
        }

        apply_ownership(
            &full_path,
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
            deferred_dirs.push(DirMeta {
                path: full_path.clone(),
                meta: EntryMetadata::with_timestamps(mode, atime, mtime),
            });
        } else {
            apply_permissions_and_times(
                &full_path,
                entry_type,
                &EntryMetadata::with_timestamps(mode, atime, mtime),
            )?;
        }

        unpacked_paths.insert(full_path);
    }

    // Retry deferred hardlinks - targets may exist now after full extraction
    for deferred in deferred_hardlinks {
        if deferred.target_path.exists() {
            trace!(
                "Creating deferred hardlink {} -> {}",
                deferred.link_path.display(),
                deferred.target_path.display()
            );
            create_hardlink(&deferred.link_path, &deferred.target_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create deferred hardlink {} -> {}: {}",
                    deferred.link_path.display(),
                    deferred.target_path.display(),
                    e
                ))
            })?;

            // Apply ownership metadata (chown or override_stat xattr) and extended attributes
            apply_ownership(&deferred.link_path, &deferred.meta, is_root)?;

            // Apply permissions and timestamps
            apply_permissions_and_times(&deferred.link_path, EntryType::Link, &deferred.meta)?;
        } else {
            // Target file doesn't exist - this can happen when:
            // 1. Target was deleted by whiteout processing
            // 2. pnpm hardlink optimization where target was removed
            // This is not necessarily an error - skip the hardlink
            trace!(
                "Skipping deferred hardlink {} -> {} (target does not exist, possibly removed by whiteout)",
                deferred.link_path.display(),
                deferred.target_path.display()
            );
        }
    }

    // Finalize directory metadata deepest-first. Reverse path order ensures
    // /a/b/c gets chmod'd before /a/b — a restrictive parent won't block
    // chmod on children.
    deferred_dirs.sort_unstable_by(|a, b| b.path.cmp(&a.path));
    for dir in &deferred_dirs {
        if !dir.path.exists() {
            trace!(
                "Skipping permissions for deleted directory: {}",
                dir.path.display()
            );
            continue;
        }

        apply_permissions_and_times(&dir.path, EntryType::Directory, &dir.meta)?;
    }

    Ok(total_size)
}

fn normalize_entry_path(path: &Path) -> Option<PathBuf> {
    let mut components = Vec::new();
    for comp in path.components() {
        match comp {
            Component::RootDir | Component::Prefix(_) => continue,
            Component::CurDir => {}
            Component::ParentDir => {
                components.pop()?;
            }
            Component::Normal(c) => components.push(c.to_os_string()),
        }
    }
    Some(components.into_iter().collect())
}

fn ensure_parent_dirs(path: &Path, root: &Path) -> BoxliteResult<()> {
    if let Some(parent) = path.parent()
        && parent != root
    {
        // Fast path: try to create all parent directories
        match fs::create_dir_all(parent) {
            Ok(_) => return Ok(()),
            Err(e) => {
                // Handle different error types:
                // - ENOTDIR: need to remove non-directory obstacles
                // - EEXIST: might be a race condition or file exists, check if we can proceed
                // - Other: fail immediately
                match e.raw_os_error() {
                    Some(libc::ENOTDIR) => {
                        // Continue to slow path for ENOTDIR errors
                    }
                    Some(libc::EEXIST) => {
                        if parent.exists() && parent.is_dir() {
                            return Ok(());
                        }
                    }
                    _ => {
                        return Err(BoxliteError::Storage(format!(
                            "Failed to create parent directory {}: {}",
                            parent.display(),
                            e
                        )));
                    }
                }
            }
        }

        // Slow path: collect all non-directory obstacles, remove them, then create
        // Symlink handling: When extracting OCI layers, a later layer may replace
        // a file/symlink with a directory (e.g., "/a" was a symlink, now "/a/b/c"
        // needs to be created). However, we must preserve symlinks that point to
        // valid directories (e.g., pnpm's node_modules structure where symlinks
        // form the dependency graph).
        //
        // This behavior aligns with OCI image-spec discussion:
        // https://github.com/opencontainers/image-spec/issues/857
        // (File-to-directory replacement during layer extraction)
        let mut obstacles = Vec::new();
        let mut current_check = parent;

        while current_check != root {
            match fs::symlink_metadata(current_check) {
                Ok(m) if m.is_dir() => {
                    break;
                }
                Ok(m) if m.file_type().is_symlink() => {
                    // Check if symlink points to a directory
                    match fs::metadata(current_check) {
                        Ok(target_m) if target_m.is_dir() => {
                            trace!(
                                "Preserving symlink that points to directory: {} -> {:?}",
                                current_check.display(),
                                fs::read_link(current_check)
                            );
                            break;
                        }
                        Ok(_) => {
                            trace!(
                                "Symlink obstacle (does not point to directory): {}",
                                current_check.display()
                            );
                            obstacles.push(current_check.to_path_buf());
                        }
                        Err(e) => {
                            trace!(
                                "Broken symlink obstacle: {} (error: {})",
                                current_check.display(),
                                e
                            );
                            obstacles.push(current_check.to_path_buf());
                        }
                    }
                }
                Ok(_) => {
                    obstacles.push(current_check.to_path_buf());
                }
                Err(e)
                    if e.kind() == io::ErrorKind::NotFound
                        || e.raw_os_error() == Some(libc::ENOTDIR) =>
                {
                    // Doesn't exist or has non-directory in ancestry, continue checking parent
                }
                Err(e) => {
                    return Err(BoxliteError::Storage(format!(
                        "Failed to stat parent directory {}: {}",
                        current_check.display(),
                        e
                    )));
                }
            }

            match current_check.parent() {
                Some(p) => current_check = p,
                None => break,
            }
        }

        for obstacle in obstacles.iter().rev() {
            trace!("Removing non-directory obstacle: {}", obstacle.display());

            fs::remove_file(obstacle)
                .or_else(|_| fs::remove_dir_all(obstacle))
                .map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to remove obstacle {}: {}",
                        obstacle.display(),
                        e
                    ))
                })?;
        }

        fs::create_dir_all(parent).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create parent directory {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    Ok(())
}

fn handle_whiteout(
    path: &Path,
    unpacked: &mut HashSet<PathBuf>,
    entry_type: EntryType,
) -> BoxliteResult<bool> {
    // Only regular files can be whiteouts
    if entry_type != EntryType::Regular {
        return Ok(false);
    }

    let base = match path.file_name().and_then(|n| n.to_str()) {
        Some(b) => b,
        None => return Ok(false),
    };

    if base == ".wh..wh..opq" {
        let dir = path
            .parent()
            .ok_or_else(|| BoxliteError::Storage("Opaque marker without parent".into()))?;
        apply_opaque_whiteout(dir, unpacked)?;
        return Ok(true);
    }

    if let Some(target_name) = base.strip_prefix(".wh.") {
        let parent = path
            .parent()
            .ok_or_else(|| BoxliteError::Storage("Whiteout without parent directory".into()))?;
        let target = parent.join(target_name);
        if target.exists() {
            if target.is_dir() {
                fs::remove_dir_all(&target).ok();
            } else {
                fs::remove_file(&target).ok();
            }
            debug!("Whiteout removed {}", target.display());
        }
        return Ok(true);
    }

    Ok(false)
}

fn apply_opaque_whiteout(dir: &Path, unpacked: &HashSet<PathBuf>) -> BoxliteResult<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in WalkDir::new(dir).min_depth(1).into_iter() {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                trace!("Skipping walk entry in {}: {}", dir.display(), e);
                continue;
            }
        };
        let target = entry.path();
        if unpacked.contains(target) {
            continue;
        }
        if target.is_dir() {
            fs::remove_dir_all(target).ok();
        } else {
            fs::remove_file(target).ok();
        }
        debug!("Opaque whiteout removed {}", target.display());
    }
    Ok(())
}

fn remove_existing_if_needed(path: &Path, entry_type: EntryType) -> BoxliteResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.is_dir() && entry_type == EntryType::Directory {
                return Ok(());
            }
            fs::remove_file(path)
                .or_else(|_| fs::remove_dir_all(path))
                .map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to remove existing path {}: {}",
                        path.display(),
                        e
                    ))
                })?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(BoxliteError::Storage(format!(
                "Failed to stat {}: {}",
                path.display(),
                e
            )));
        }
    }
    Ok(())
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

fn create_dir(path: &Path) -> BoxliteResult<()> {
    if !path.exists() {
        fs::create_dir(path).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create dir {}: {}", path.display(), e))
        })?;
    }
    Ok(())
}

fn create_regular_file<R: Read>(entry: &mut Entry<R>, path: &Path, mode: u32) -> BoxliteResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .map_err(|e| {
            BoxliteError::Storage(format!("Failed to create file {}: {}", path.display(), e))
        })?;

    io::copy(entry, &mut file).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to copy file data to {}: {}",
            path.display(),
            e
        ))
    })?;
    Ok(())
}

fn create_hardlink(path: &Path, target: &Path) -> BoxliteResult<()> {
    fs::hard_link(target, path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create hardlink {} -> {}: {}",
            path.display(),
            target.display(),
            e
        ))
    })
}

fn create_symlink(path: &Path, target: &Path) -> BoxliteResult<()> {
    std::os::unix::fs::symlink(target, path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create symlink {} -> {}: {}",
            path.display(),
            target.display(),
            e
        ))
    })
}

fn create_special_device(
    path: &Path,
    entry_type: EntryType,
    mode: u32,
    major: libc::dev_t,
    minor: libc::dev_t,
    is_root: bool,
) -> BoxliteResult<()> {
    if !is_root {
        trace!("Skipping device node {} (requires root)", path.display());
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    let dev = libc::makedev(major as c_uint, minor as c_uint);
    #[cfg(target_os = "macos")]
    let dev = libc::makedev(major, minor);

    let kind = match entry_type {
        EntryType::Block => libc::S_IFBLK,
        EntryType::Char => libc::S_IFCHR,
        _ => unreachable!(),
    };
    let full_mode = kind | (mode as libc::mode_t & 0o7777);

    let c_path = to_cstring(path)?;
    let res = unsafe { libc::mknod(c_path.as_ptr(), full_mode, dev) };
    if res != 0 {
        let err = io::Error::last_os_error();
        return Err(BoxliteError::Storage(format!(
            "Failed to create device {}: {}",
            path.display(),
            err
        )));
    }
    Ok(())
}

fn create_fifo(path: &Path, mode: u32) -> BoxliteResult<()> {
    let c_path = to_cstring(path)?;
    let res = unsafe { libc::mkfifo(c_path.as_ptr(), mode as libc::mode_t) };
    if res != 0 {
        let err = io::Error::last_os_error();
        return Err(BoxliteError::Storage(format!(
            "Failed to create fifo {}: {}",
            path.display(),
            err
        )));
    }
    Ok(())
}

fn resolve_hardlink_target(root: &Path, linkname: &Path) -> BoxliteResult<PathBuf> {
    let cleaned = normalize_entry_path(linkname).ok_or_else(|| {
        BoxliteError::Storage(format!(
            "Hardlink target escapes root: {}",
            linkname.display()
        ))
    })?;

    let target = root.join(cleaned);
    if target.starts_with(root) {
        Ok(target)
    } else {
        Ok(root.to_path_buf())
    }
}

/// Apply ownership metadata (chown or override_stat xattr) and extended attributes.
fn apply_ownership(path: &Path, meta: &EntryMetadata, is_root: bool) -> BoxliteResult<()> {
    let ownership = meta.ownership.as_ref().ok_or_else(|| {
        BoxliteError::Storage(format!("Missing ownership metadata for {}", path.display()))
    })?;

    // Ownership: root mode uses chown, rootless stores in override_stat xattr
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
            // Non-fatal: some filesystems don't support xattrs
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

/// Apply permissions and timestamp metadata to a path.
/// Used for deferred hardlink processing.
fn apply_permissions_and_times(
    path: &Path,
    entry_type: EntryType,
    meta: &EntryMetadata,
) -> BoxliteResult<()> {
    // Set permissions (skip for symlinks)
    if entry_type != EntryType::Symlink {
        fs::set_permissions(path, Permissions::from_mode(meta.mode)).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to set permissions {:o} on {}: {}",
                meta.mode,
                path.display(),
                e
            ))
        })?;
    }

    // Set timestamps
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
        // trusted.* and security.* require root privileges
        if key.starts_with("trusted.") || (!is_root && key.starts_with("security.")) {
            trace!(
                "Skipping privileged xattr {} on {} (requires root)",
                key,
                path.display()
            );
            continue;
        }

        let res = setxattr_nofollow(path, key, value);
        match res {
            Ok(()) => {}
            Err(e) if e.raw_os_error() == Some(libc::ENOTSUP) => {
                warn!("Ignoring unsupported xattr {} on {}", key, path.display());
            }
            Err(e)
                if e.raw_os_error() == Some(libc::EPERM)
                    && key.starts_with("user.")
                    && entry_type != EntryType::Regular
                    && entry_type != EntryType::Directory =>
            {
                warn!(
                    "Ignoring xattr {} on {} (EPERM for {:?})",
                    key,
                    path.display(),
                    entry_type
                );
            }
            Err(e) => {
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
    UNIX_EPOCH + Duration::from_secs(secs)
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

    /// Helper to create a tar archive with custom entries
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

    /// Helper to create a gzipped tar archive
    fn create_gzipped_tar(data: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
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

    #[test]
    fn test_deferred_hardlink_target_appears_later() {
        // Create a tar where hardlink appears BEFORE its target
        // This simulates pnpm-style hardlink ordering
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![
            // Hardlink that references a file not yet seen
            TestEntry {
                path: "link-to-target".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target.txt".to_string(),
                },
            },
            // Target file appears after the hardlink
            TestEntry {
                path: "target.txt".to_string(),
                entry_type: TestEntryType::File {
                    content: b"target content".to_vec(),
                },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        // Extract and verify
        let dest_dir = temp_dir.path().join("extracted");
        let size = extract_layer_tarball_streaming(&tar_path, &dest_dir).unwrap();

        // Both files should exist
        let link_path = dest_dir.join("link-to-target");
        let target_path = dest_dir.join("target.txt");

        assert!(link_path.exists(), "Hardlink should exist");
        assert!(target_path.exists(), "Target should exist");

        // Verify it's actually a hardlink (same content)
        // Note: inode comparison is filesystem-dependent, so we check content instead
        let link_content = std::fs::read_to_string(&link_path).unwrap();
        let target_content = std::fs::read_to_string(&target_path).unwrap();
        assert_eq!(link_content, "target content");
        assert_eq!(target_content, "target content");

        assert_eq!(size, 14); // "target content" is 14 bytes
    }

    #[test]
    fn test_deferred_hardlink_with_directories() {
        // Test deferred hardlinks in nested directories
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
        extract_layer_tarball_streaming(&tar_path, &dest_dir).unwrap();

        let link_path = dest_dir.join("dir/link");
        let target_path = dest_dir.join("target.txt");

        assert!(link_path.exists());
        assert!(target_path.exists());

        let link_content = std::fs::read_to_string(&link_path).unwrap();
        assert_eq!(link_content, "shared content");
    }

    #[test]
    fn test_multiple_deferred_hardlinks_same_target() {
        // Test multiple hardlinks to the same deferred target
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
        extract_layer_tarball_streaming(&tar_path, &dest_dir).unwrap();

        // All links should exist and point to the same content
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
        // Test graceful handling when target is removed by whiteout
        let temp_dir = tempfile::tempdir().unwrap();
        let tar_path = temp_dir.path().join("test.tar");

        let entries = vec![
            // Create target first
            TestEntry {
                path: "target.txt".to_string(),
                entry_type: TestEntryType::File {
                    content: b"will be removed".to_vec(),
                },
            },
            // Hardlink to target
            TestEntry {
                path: "link".to_string(),
                entry_type: TestEntryType::Hardlink {
                    target: "target.txt".to_string(),
                },
            },
            // Whiteout that removes the target
            TestEntry {
                path: ".wh.target.txt".to_string(),
                entry_type: TestEntryType::File { content: vec![] },
            },
        ];

        let tar_data = create_test_tar(entries);
        std::fs::write(&tar_path, &tar_data).unwrap();

        let dest_dir = temp_dir.path().join("extracted");
        // This should not fail - the deferred hardlink should be skipped gracefully
        let result = extract_layer_tarball_streaming(&tar_path, &dest_dir);
        assert!(result.is_ok(), "Should handle missing target gracefully");

        // Target should be removed by whiteout
        let target_path = dest_dir.join("target.txt");
        assert!(
            !target_path.exists(),
            "Target should be removed by whiteout"
        );
    }

    #[test]
    fn test_hardlink_target_exists_immediately() {
        // Test normal case where target exists before hardlink
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
        extract_layer_tarball_streaming(&tar_path, &dest_dir).unwrap();

        let link_path = dest_dir.join("link");
        let target_path = dest_dir.join("target.txt");

        assert!(link_path.exists());
        assert!(target_path.exists());

        let content = std::fs::read_to_string(&link_path).unwrap();
        assert_eq!(content, "content");
    }

    #[test]
    fn test_ensure_parent_dirs_replaces_file_with_directory() {
        // Test that ensure_parent_dirs handles file -> directory replacements
        let temp_dir = tempfile::tempdir().unwrap();

        // Create a file where a directory should be
        let file_path = temp_dir.path().join("a");
        std::fs::write(&file_path, b"I'm a file").unwrap();

        // Now try to create a directory structure that requires replacing the file
        let nested_path = temp_dir.path().join("a/b/c.txt");
        let parent = nested_path.parent().unwrap();

        // This should remove the file and create the directory
        let result = ensure_parent_dirs(&nested_path, temp_dir.path());
        assert!(
            result.is_ok(),
            "Should handle file -> directory replacement"
        );

        // Verify the directory was created
        assert!(parent.exists(), "Parent directory should exist");
        assert!(parent.is_dir(), "Parent should be a directory");
    }

    #[test]
    fn test_ensure_parent_dirs_handles_existing_directory() {
        // Test that ensure_parent_dirs handles EEXIST gracefully
        let temp_dir = tempfile::tempdir().unwrap();

        // Create the parent directory first
        let parent_dir = temp_dir.path().join("a");
        fs::create_dir_all(&parent_dir).unwrap();

        // Now try to create a nested path
        let nested_path = temp_dir.path().join("a/b/c.txt");

        // This should succeed even though parent already exists
        let result = ensure_parent_dirs(&nested_path, temp_dir.path());
        assert!(
            result.is_ok(),
            "Should handle existing directory, got error: {:?}",
            result
        );

        // Verify the parent directory still exists
        assert!(parent_dir.exists());
        assert!(parent_dir.is_dir());
    }

    #[test]
    fn test_ensure_parent_dirs_deep_nesting_with_file_obstacle() {
        // Test deep nesting where a high-level file blocks the path
        let temp_dir = tempfile::tempdir().unwrap();

        // Create a file where a directory should be at a higher level
        let file_path = temp_dir.path().join("a");
        std::fs::write(&file_path, b"blocking file").unwrap();

        // Try to create a deeply nested path
        let deep_path = temp_dir.path().join("a/b/c/d/e/file.txt");

        // This should find and remove the blocking file
        let result = ensure_parent_dirs(&deep_path, temp_dir.path());
        assert!(
            result.is_ok(),
            "Should handle deep nesting with file obstacle, got error: {:?}",
            result
        );

        // Verify the directory was created
        let created_dir = temp_dir.path().join("a/b/c/d/e");
        assert!(created_dir.exists());
        assert!(created_dir.is_dir());
    }

    #[test]
    fn test_ensure_parent_dirs_symlink_obstacle() {
        // Test that symlinks are treated as non-directories and removed
        let temp_dir = tempfile::tempdir().unwrap();

        // Create a symlink where a directory should be
        let target_file = temp_dir.path().join("target.txt");
        std::fs::write(&target_file, b"target").unwrap();

        let symlink_path = temp_dir.path().join("a");
        std::os::unix::fs::symlink(&target_file, &symlink_path).unwrap();

        // Try to create a path through the symlink
        let nested_path = temp_dir.path().join("a/b/c.txt");

        // This should remove the symlink and create a directory
        let result = ensure_parent_dirs(&nested_path, temp_dir.path());
        assert!(
            result.is_ok(),
            "Should handle symlink obstacle, got error: {:?}",
            result
        );

        // Verify the symlink was replaced with a directory
        assert!(symlink_path.exists());
        assert!(
            symlink_path.is_dir(),
            "Should be a directory now, not a symlink"
        );
    }

    #[test]
    fn test_ensure_parent_dirs_preserves_symlink_to_directory() {
        // Test pnpm-style structure: symlinks pointing to directories should be preserved
        let temp_dir = tempfile::tempdir().unwrap();

        // Create target directory structure (simulating content-addressable store)
        let bar_dir = temp_dir.path().join(".pnpm/bar@1.0.0/node_modules/bar");
        fs::create_dir_all(&bar_dir).unwrap();
        std::fs::write(bar_dir.join("index.js"), b"bar content").unwrap();

        // Create a symlink pointing to that directory (like pnpm does)
        let foo_node_modules = temp_dir.path().join(".pnpm/foo@1.0.0/node_modules");
        fs::create_dir_all(&foo_node_modules).unwrap();
        let bar_symlink = foo_node_modules.join("bar");
        std::os::unix::fs::symlink("../../bar@1.0.0/node_modules/bar", &bar_symlink).unwrap();

        // Verify symlink was created
        assert!(bar_symlink.is_symlink());

        // Now try to create a file through the symlink (like extracting into the symlinked dir)
        let nested_path = bar_symlink.join("subdir/file.txt");

        // This should preserve the symlink and not replace it with a directory
        let result = ensure_parent_dirs(&nested_path, temp_dir.path());
        assert!(
            result.is_ok(),
            "Should preserve symlink to directory, got error: {:?}",
            result
        );

        // Verify the symlink still exists and points to the correct target
        assert!(bar_symlink.exists());
        assert!(
            bar_symlink.is_symlink(),
            "Symlink should still be a symlink"
        );
        let target = fs::read_link(&bar_symlink).unwrap();
        assert_eq!(target, Path::new("../../bar@1.0.0/node_modules/bar"));

        // Verify we can access files through the symlink
        assert!(bar_symlink.join("index.js").exists());
    }

    #[test]
    fn test_ensure_parent_dirs_replaces_symlink_to_file() {
        // Test that symlinks pointing to files are treated as obstacles
        let temp_dir = tempfile::tempdir().unwrap();

        // Create a target file
        let target_file = temp_dir.path().join("target.txt");
        std::fs::write(&target_file, b"target").unwrap();

        // Create a symlink pointing to that file
        let symlink_path = temp_dir.path().join("link");
        std::os::unix::fs::symlink(&target_file, &symlink_path).unwrap();

        // Verify symlink was created
        assert!(symlink_path.is_symlink());

        // Try to create a path through the symlink (expecting a directory)
        let nested_path = symlink_path.join("subdir/file.txt");

        // This should remove the symlink and create a directory
        let result = ensure_parent_dirs(&nested_path, temp_dir.path());
        assert!(
            result.is_ok(),
            "Should replace symlink to file with directory, got error: {:?}",
            result
        );

        // Verify the symlink was replaced with a directory
        assert!(symlink_path.exists());
        assert!(
            symlink_path.is_dir(),
            "Should be a directory now, not a symlink"
        );
        assert!(!symlink_path.is_symlink());
    }

    #[test]
    fn test_ensure_parent_dirs_pnpm_structure() {
        // Full integration test for pnpm-style node_modules structure
        let temp_dir = tempfile::tempdir().unwrap();

        // Step 1: Create the content-addressable store structure
        let store_bar = temp_dir.path().join(".pnpm/bar@1.0.0/node_modules/bar");
        fs::create_dir_all(&store_bar).unwrap();
        std::fs::write(store_bar.join("index.js"), b"console.log('bar')").unwrap();

        let store_foo = temp_dir.path().join(".pnpm/foo@1.0.0/node_modules/foo");
        fs::create_dir_all(&store_foo).unwrap();
        std::fs::write(store_foo.join("index.js"), b"console.log('foo')").unwrap();

        // Step 2: Create symlinks forming the dependency graph
        let foo_nm = temp_dir.path().join(".pnpm/foo@1.0.0/node_modules");
        let bar_symlink_in_foo = foo_nm.join("bar");
        std::os::unix::fs::symlink("../../bar@1.0.0/node_modules/bar", &bar_symlink_in_foo)
            .unwrap();

        // Step 3: Simulate extracting a file through the symlinked directory
        // (like pnpm would need to do when extracting packages)
        let file_in_symlinked_bar = bar_symlink_in_foo.join("package.json");
        let result = ensure_parent_dirs(&file_in_symlinked_bar, temp_dir.path());
        assert!(
            result.is_ok(),
            "Should handle pnpm symlink structure: {:?}",
            result
        );

        // Step 4: Verify symlinks are preserved
        assert!(
            bar_symlink_in_foo.is_symlink(),
            "bar symlink should be preserved"
        );
        let target = fs::read_link(&bar_symlink_in_foo).unwrap();
        assert_eq!(target, Path::new("../../bar@1.0.0/node_modules/bar"));

        // Step 5: Verify we can traverse through the symlink
        assert!(store_bar.join("index.js").exists());
        assert!(bar_symlink_in_foo.join("index.js").exists());
    }

    #[test]
    fn test_gzip_compression_detection() {
        // Test that gzip compression is auto-detected
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
        extract_layer_tarball_streaming(&tar_path, &dest_dir).unwrap();

        let file_path = dest_dir.join("file.txt");
        assert!(file_path.exists());
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "test content");
    }

    #[test]
    fn test_uncompressed_tar_detection() {
        // Test that uncompressed tar is handled
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
        extract_layer_tarball_streaming(&tar_path, &dest_dir).unwrap();

        let file_path = dest_dir.join("file.txt");
        assert!(file_path.exists());
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "uncompressed");
    }

    #[test]
    fn test_apply_oci_layer_with_symlinks() {
        // Test that symlinks are preserved correctly
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
        extract_layer_tarball_streaming(&tar_path, &dest_dir).unwrap();

        let link_path = dest_dir.join("link");
        assert!(link_path.is_symlink());

        // Read symlink target
        let target = std::fs::read_link(&link_path).unwrap();
        assert_eq!(target, PathBuf::from("target.txt"));
    }
}
