//! Streaming OCI tar layer applier (containerd-style).

use super::compression::TarballReader;
use super::metadata::EntryMetadata;
use super::override_stat::{OverrideFileType, OverrideStat};
use super::safe_root::{SafeRoot, special_from_entry};
use super::time::{bound_time, latest_time};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use filetime::{FileTime, set_file_times, set_symlink_file_times};
use std::collections::HashSet;
use std::ffi::CString;
use std::fs::{self, Permissions};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
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
pub struct LayerExtractor<'a> {
    dest: &'a Path,
}

impl<'a> LayerExtractor<'a> {
    /// Construct an extractor targeting `dest`. The directory is opened lazily
    /// per extraction call so the same extractor can apply multiple layers.
    pub fn new(dest: &'a Path) -> Self {
        Self { dest }
    }

    /// Apply a compressed or uncompressed layer tarball on disk.
    pub fn extract_tarball(&self, tarball_path: &Path) -> BoxliteResult<u64> {
        let reader = TarballReader::open(tarball_path)?;
        self.extract_reader(reader)
    }

    /// Apply an already-decompressed tar stream.
    pub fn extract_reader<R: Read>(&self, reader: R) -> BoxliteResult<u64> {
        apply_oci_layer(reader, self.dest)
    }
}

struct DirMeta {
    path: PathBuf,
    meta: EntryMetadata,
}

/// Deferred hardlink: source doesn't exist yet, will retry later. Paths are
/// relative to the extraction root — the eventual creation goes back through
/// [`SafeRoot::create_hardlink`] for containment.
struct DeferredHardlink {
    link_rel: PathBuf,
    target_rel: PathBuf,
    meta: EntryMetadata,
}

fn apply_oci_layer<R: Read>(reader: R, dest: &Path) -> BoxliteResult<u64> {
    let root = SafeRoot::open(dest)?;
    let is_root = unsafe { libc::geteuid() } == 0;
    let mut archive = Archive::new(reader);
    let mut unpacked_paths: HashSet<PathBuf> = HashSet::new();
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

        let full_path = root.full_path(&normalized)?;
        if handle_whiteout(&root, &normalized, &mut unpacked_paths, entry_type)? {
            continue;
        }

        // Reject the entire entry up-front if it is an unsafe symlink — ensures
        // no parent directories are created or replaced for an attacker-
        // controlled entry that we'd refuse to finalize anyway.
        if entry_type == EntryType::Symlink
            && let Some(target) = link_name.as_ref()
            && !root.is_symlink_target_safe(&normalized, target)
        {
            warn!(
                "Rejecting unsafe symlink {} -> {} (target escapes extraction root)",
                full_path.display(),
                target.display()
            );
            continue;
        }

        root.ensure_parent(&normalized)?;
        root.remove_nofollow(&normalized, entry_type == EntryType::Directory)?;

        let xattrs = read_xattrs(&mut entry)?;
        let mut deferred_hardlink = false;

        match entry_type {
            EntryType::Directory => root.create_dir(&normalized)?,
            EntryType::Regular | EntryType::GNUSparse => {
                let mut file = root.create_file(&normalized, mode)?;
                io::copy(&mut entry, &mut file).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to copy file data to {}: {}",
                        full_path.display(),
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
                let target_rel = normalize_entry_path(&target).ok_or_else(|| {
                    BoxliteError::Storage(format!(
                        "Hardlink target escapes root: {}",
                        target.display()
                    ))
                })?;
                if root.exists_nofollow(&target_rel) {
                    root.create_hardlink(&normalized, &target_rel)?;
                } else {
                    trace!(
                        "Deferring hardlink {} -> {} (target not found yet)",
                        full_path.display(),
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
                    deferred_hardlink = true;
                }
            }
            EntryType::Symlink => {
                let target = link_name.ok_or_else(|| {
                    BoxliteError::Storage(format!("Symlink without target: {}", raw_path.display()))
                })?;
                root.create_symlink(&normalized, &target)?;
            }
            EntryType::Block | EntryType::Char | EntryType::Fifo => {
                if let Some(kind) = special_from_entry(entry_type, device_major, device_minor) {
                    root.create_special(&normalized, mode, kind, is_root)?;
                }
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

    // Retry deferred hardlinks — their targets may have been created later in
    // the same layer or removed by a whiteout.
    for deferred in deferred_hardlinks {
        if !root.exists_nofollow(&deferred.target_rel) {
            trace!(
                "Skipping deferred hardlink {} -> {} (target does not exist)",
                deferred.link_rel.display(),
                deferred.target_rel.display()
            );
            continue;
        }
        trace!(
            "Creating deferred hardlink {} -> {}",
            deferred.link_rel.display(),
            deferred.target_rel.display()
        );
        root.create_hardlink(&deferred.link_rel, &deferred.target_rel)
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create deferred hardlink {} -> {}: {}",
                    deferred.link_rel.display(),
                    deferred.target_rel.display(),
                    e
                ))
            })?;
        let link_full = root.full_path(&deferred.link_rel)?;
        apply_ownership(&link_full, &deferred.meta, is_root)?;
        apply_permissions_and_times(&link_full, EntryType::Link, &deferred.meta)?;
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

fn handle_whiteout(
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
        apply_opaque_whiteout(root, parent_rel, unpacked)?;
        return Ok(true);
    }

    if let Some(target_name) = base.strip_prefix(".wh.") {
        let parent_rel = rel.parent().unwrap_or(Path::new(""));
        let target_rel = parent_rel.join(target_name);
        // `ensure_parent` scrubs escape symlinks in the ancestry chain so that
        // `remove_nofollow` can't be redirected out of root by an intermediate
        // symlink planted before extraction began.
        root.ensure_parent(&target_rel)?;
        root.remove_nofollow(&target_rel, false)?;
        debug!("Whiteout removed {}", target_rel.display());
        return Ok(true);
    }

    Ok(false)
}

fn apply_opaque_whiteout(
    root: &SafeRoot,
    dir_rel: &Path,
    unpacked: &HashSet<PathBuf>,
) -> BoxliteResult<()> {
    // Scrub any escape symlink in the ancestry of `dir_rel` before we walk it.
    // `ensure_parent` operates on the parent of the path passed in, so we pass
    // a synthetic child whose parent is `dir_rel` itself.
    let sentinel = dir_rel.join(".wh..wh..opq");
    root.ensure_parent(&sentinel)?;

    let dir_abs = root.full_path(dir_rel)?;
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
        let abs = entry.path();
        if unpacked.contains(abs) {
            continue;
        }
        let Ok(rel_suffix) = abs.strip_prefix(root.root()) else {
            continue;
        };
        let _ = root.remove_nofollow(rel_suffix, false);
        debug!("Opaque whiteout removed {}", rel_suffix.display());
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
        LayerExtractor::new(dest).extract_tarball(tar_path)
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
    fn test_multiple_deferred_hardlinks_same_target() {
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

    // SafeRoot::ensure_parent behaviors, exercised through the new API.
    // Lower-level path-safety tests live in safe_root.rs.

    use super::super::safe_root::SafeRoot;

    #[test]
    fn ensure_parent_replaces_file_with_directory() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a"), b"I'm a file").unwrap();

        let root = SafeRoot::open(tmp.path()).unwrap();
        root.ensure_parent(Path::new("a/b/c.txt")).unwrap();

        assert!(tmp.path().join("a/b").is_dir());
    }

    #[test]
    fn ensure_parent_handles_existing_directory() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("a")).unwrap();

        let root = SafeRoot::open(tmp.path()).unwrap();
        root.ensure_parent(Path::new("a/b/c.txt")).unwrap();

        assert!(tmp.path().join("a/b").is_dir());
    }

    #[test]
    fn ensure_parent_deep_nesting_replaces_file_obstacle() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a"), b"blocker").unwrap();

        let root = SafeRoot::open(tmp.path()).unwrap();
        root.ensure_parent(Path::new("a/b/c/d/e/file.txt")).unwrap();

        assert!(tmp.path().join("a/b/c/d/e").is_dir());
    }

    #[test]
    fn ensure_parent_preserves_pnpm_style_symlink_to_dir() {
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
        root.ensure_parent(Path::new(
            ".pnpm/foo@1.0.0/node_modules/bar/subdir/file.txt",
        ))
        .unwrap();

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

    /// Regression: an escape symlink planted by an earlier layer must not be
    /// preserved. Exercising `SafeRoot::ensure_parent` must replace it with
    /// a real directory so a subsequent write lands inside `dest`.
    #[test]
    fn ensure_parent_removes_preexisting_escape_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("dest");
        let host_side = tmp.path().join("host_side");
        fs::create_dir_all(&dest).unwrap();
        fs::create_dir_all(&host_side).unwrap();

        let escape_link = dest.join("escape");
        std::os::unix::fs::symlink(&host_side, &escape_link).unwrap();
        assert!(escape_link.is_symlink());

        let root = SafeRoot::open(&dest).unwrap();
        root.ensure_parent(Path::new("escape/pwned.txt")).unwrap();

        assert!(
            escape_link.is_dir() && !escape_link.is_symlink(),
            "escape symlink should have been replaced with a real directory"
        );
        std::fs::write(dest.join("escape/pwned.txt"), b"contained").unwrap();
        assert!(!host_side.join("pwned.txt").exists());
        assert!(dest.join("escape/pwned.txt").exists());
    }

    // ================================================================
    // Bug-reproduction tests (audit findings). Each test is expected
    // to FAIL against the current implementation; once the underlying
    // issue is fixed, they become regression tests.
    // ================================================================

    /// Bug #1: a tar entry with an extreme `mtime` makes `unix_time()`
    /// panic inside `UNIX_EPOCH + Duration::from_secs(..)`. The clamp
    /// in `bound_time` runs too late to help. A crafted layer should
    /// either succeed or return a `BoxliteError`, never unwind.
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
        let outcome =
            std::panic::catch_unwind(|| LayerExtractor::new(&dest).extract_tarball(&tar_path));

        assert!(
            outcome.is_ok(),
            "extractor panicked on crafted mtime — should saturate/error instead"
        );
    }

    /// Bug #2: `handle_whiteout` operates on raw paths with plain
    /// `fs::remove_file`, whose intermediate-component resolution
    /// follows symlinks. If an escape symlink already exists in the
    /// extraction root (e.g. residue from a pre-hardening boxlite run),
    /// a whiteout entry underneath it deletes files on the host side.
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

        let _ = LayerExtractor::new(&dest).extract_tarball(&tar_path);

        assert!(
            host_victim.exists(),
            "whiteout followed escape symlink and deleted host file: {}",
            host_victim.display()
        );
    }

    /// Bug #8: `apply_permissions_and_times` runs `set_permissions` for
    /// `EntryType::Link` (it only skips `Symlink`). Hardlinks share the
    /// target inode, so chmod via the hardlink path overwrites the
    /// target's declared mode whenever the tar hardlink header carries
    /// a different mode.
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
        LayerExtractor::new(&dest)
            .extract_tarball(&tar_path)
            .unwrap();

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
}
