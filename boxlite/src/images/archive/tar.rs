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

struct DirMeta {
    path: PathBuf,
    mode: u32,
    atime: u64,
    mtime: u64,
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

    for entry_result in archive
        .entries()
        .map_err(|e| BoxliteError::Storage(format!("Tar read entries error: {}", e)))?
    {
        let mut entry = entry_result
            .map_err(|e| BoxliteError::Storage(format!("Tar read entry error: {}", e)))?;
        let raw_path = entry
            .header()
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
                create_hardlink(&full_path, &target_path)?;
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

        // Ownership: root mode uses chown, rootless stores in override_stat xattr
        if is_root {
            if let Err(e) = lchown(&full_path, uid as libc::uid_t, gid as libc::gid_t) {
                return Err(BoxliteError::Storage(format!(
                    "Failed to chown {} to {}:{}: {}",
                    full_path.display(),
                    uid,
                    gid,
                    e
                )));
            }
        } else {
            // Rootless: store intended ownership in xattr for fuse-overlayfs
            let file_type = OverrideFileType::from_tar_entry(
                entry_type,
                device_major as u32,
                device_minor as u32,
            );
            let override_stat = OverrideStat::new(uid as u32, gid as u32, mode, file_type);
            if let Err(e) = override_stat.write_xattr(&full_path) {
                // Non-fatal: some filesystems don't support xattrs
                trace!(
                    "Failed to write override_stat xattr on {}: {}",
                    full_path.display(),
                    e
                );
            }
        }

        apply_xattrs(&full_path, &xattrs, entry_type, is_root)?;

        if entry_type == EntryType::Directory {
            deferred_dirs.push(DirMeta {
                path: full_path.clone(),
                mode,
                atime,
                mtime,
            });
        } else {
            if entry_type != EntryType::Symlink {
                fs::set_permissions(&full_path, Permissions::from_mode(mode)).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to set permissions {:o} on {}: {}",
                        mode,
                        full_path.display(),
                        e
                    ))
                })?;
            }
            apply_times(&full_path, entry_type, atime, mtime)?;
        }

        unpacked_paths.insert(full_path);
    }

    // Finalize directory metadata deepest-first. Reverse path order ensures
    // /a/b/c gets chmod'd before /a/b — a restrictive parent won't block
    // chmod on children.
    deferred_dirs.sort_unstable_by(|a, b| b.path.cmp(&a.path));
    for dir in &deferred_dirs {
        fs::set_permissions(&dir.path, Permissions::from_mode(dir.mode)).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to set deferred dir permissions {:o} on {}: {}",
                dir.mode,
                dir.path.display(),
                e
            ))
        })?;
        apply_times(&dir.path, EntryType::Directory, dir.atime, dir.mtime)?;
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
    if let Some(parent) = path.parent() {
        if parent == root {
            return Ok(());
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
