//! Symlink-safe overlay merge of one extracted OCI layer onto a rootfs tree.
//!
//! Lower layers are attacker-controlled: a layer may plant `config -> /etc/shadow`
//! in the merge destination. Two rules keep that contained:
//!
//! 1. Destination paths are built as `SafeRoot::resolve(parent).join(leaf)` —
//!    parent components are followed with absolute targets re-anchored into the
//!    root, the leaf is never followed, so it can be `lstat`ed and unlinked.
//! 2. Anything already at the leaf is unlinked before the new entry is created,
//!    and regular files are opened `O_EXCL`. Writes never pass *through* an
//!    inherited symlink.
//!
//! Symlink targets themselves are stored verbatim: the guest resolves them
//! inside its own root, where an absolute `/bin/busybox` is correct.
//!
//! (`RootPath`).

#[cfg(target_os = "linux")]
use super::copy_mount::create_fifo;
use super::copy_mount::{CopyMode, CopyMountOptions, copy_metadata, set_symlink_times};
use crate::images::SafeRoot;
use crate::images::whiteout::{self, Whiteout};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, symlink};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[cfg(target_os = "linux")]
use std::os::unix::fs::FileTypeExt;

/// Device + inode key, used to re-create hardlinks that exist inside one layer.
#[derive(Hash, Eq, PartialEq, Clone, Copy)]
struct FileId {
    dev: u64,
    ino: u64,
}

/// Applies one extracted layer directory on top of an existing rootfs tree,
/// with OCI whiteout semantics.
pub(super) struct OverlayMerge<'a> {
    src: &'a Path,
    root: SafeRoot,
    options: CopyMountOptions,
}

impl<'a> OverlayMerge<'a> {
    pub(super) fn new(src: &'a Path, dst: &Path) -> BoxliteResult<Self> {
        Ok(Self {
            src,
            root: SafeRoot::open(dst)?,
            options: CopyMountOptions {
                copy_xattrs: true,
                copy_mode: CopyMode::Content,
                ignore_chown_errors: false,
            },
        })
    }

    /// Apply whiteouts, then place every entry of the layer.
    pub(super) fn apply(&self) -> BoxliteResult<()> {
        self.apply_whiteouts()?;
        self.place_entries()
    }

    // ---- containment ----------------------------------------------------

    /// Destination path for `rel`: parent components resolved inside the root
    /// (absolute symlink targets re-anchored), leaf left unfollowed.
    fn safe_path(&self, rel: &Path) -> BoxliteResult<PathBuf> {
        let parent = rel.parent().unwrap_or(Path::new(""));
        let leaf = rel.file_name().ok_or_else(|| {
            BoxliteError::Storage(format!("Layer entry has no file name: {}", rel.display()))
        })?;
        Ok(self.root.resolve_or_root(parent)?.join(leaf))
    }

    fn rel_path(&self, path: &Path) -> BoxliteResult<PathBuf> {
        path.strip_prefix(self.src)
            .map(Path::to_path_buf)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to rebase {}: {}", path.display(), e))
            })
    }

    // ---- phase 1: whiteouts ---------------------------------------------

    fn apply_whiteouts(&self) -> BoxliteResult<()> {
        for entry in WalkDir::new(self.src).follow_links(false) {
            let entry = entry.map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to walk layer {}: {}",
                    self.src.display(),
                    e
                ))
            })?;

            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(marker) = marker_of(&entry, &name)? else {
                continue;
            };

            let rel = self.rel_path(entry.path())?;
            let rel_parent = rel.parent().unwrap_or(Path::new("")).to_path_buf();

            // Opaque marker hides the whole directory it sits in; a plain
            // `.wh.foo` marker hides the sibling named `foo`.
            let victim_rel = match marker {
                Whiteout::Opaque => rel_parent,
                Whiteout::Remove(target_name) => rel_parent.join(target_name),
            };

            // Only an opaque marker at the layer root leaves this empty: a
            // `.wh.<name>` victim is never empty (`whiteout::classify`).
            if victim_rel.as_os_str().is_empty() {
                self.clear_root()?;
                continue;
            }

            let victim = self.safe_path(&victim_rel)?;
            remove_nofollow(&victim)?;
            tracing::debug!("Whiteout: removed {}", victim.display());
        }
        Ok(())
    }

    /// Empty the destination root without removing the root itself.
    fn clear_root(&self) -> BoxliteResult<()> {
        let root = self.root.root_path();
        let dir = fs::read_dir(root).map_err(|e| {
            BoxliteError::Storage(format!("Failed to read {}: {}", root.display(), e))
        })?;
        for entry in dir {
            let entry = entry.map_err(|e| {
                BoxliteError::Storage(format!("Failed to read {}: {}", root.display(), e))
            })?;
            remove_nofollow(&entry.path())?;
        }
        Ok(())
    }

    // ---- phase 2: entries -----------------------------------------------

    fn place_entries(&self) -> BoxliteResult<()> {
        // Inode -> first destination, so hardlinks inside a layer stay hardlinks.
        let mut placed: HashMap<FileId, PathBuf> = HashMap::new();
        // Directory metadata is applied last: populating a directory bumps its
        // mtime, and a 0o555 mode must not be set before its children exist.
        let mut deferred_dirs: Vec<(PathBuf, PathBuf)> = Vec::new();

        for entry in WalkDir::new(self.src).follow_links(false) {
            let entry = entry.map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to walk layer {}: {}",
                    self.src.display(),
                    e
                ))
            })?;

            // Markers are metadata, already consumed in phase 1. A `.wh.`-named
            // directory or symlink is not a marker, so it is placed like any
            // other entry.
            let name = entry.file_name().to_string_lossy().into_owned();
            if marker_of(&entry, &name)?.is_some() {
                continue;
            }

            let src_path = entry.path();
            let rel = self.rel_path(src_path)?;
            if rel.as_os_str().is_empty() {
                continue; // the layer root itself
            }

            let meta = fs::symlink_metadata(src_path).map_err(|e| {
                BoxliteError::Storage(format!("Failed to stat {}: {}", src_path.display(), e))
            })?;
            // WalkDir yields a directory before its children, and `place_dir`
            // guarantees a real directory at that path — so the resolved parent
            // of every non-directory entry already exists.
            let dst_path = self.safe_path(&rel)?;
            let file_type = meta.file_type();

            if file_type.is_dir() {
                place_dir(&dst_path)?;
                deferred_dirs.push((src_path.to_path_buf(), dst_path));
                continue;
            }

            if file_type.is_file() {
                let id = FileId {
                    dev: meta.dev(),
                    ino: meta.ino(),
                };
                if let Some(first) = placed.get(&id) {
                    remove_nofollow(&dst_path)?;
                    fs::hard_link(first, &dst_path).map_err(|e| {
                        BoxliteError::Storage(format!(
                            "Failed to hardlink {} -> {}: {}",
                            first.display(),
                            dst_path.display(),
                            e
                        ))
                    })?;
                    continue; // hardlinks share the inode's metadata
                }
                place_regular(src_path, &dst_path, &meta)?;
                placed.insert(id, dst_path.clone());
            } else if file_type.is_symlink() {
                let target = fs::read_link(src_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to read symlink {}: {}",
                        src_path.display(),
                        e
                    ))
                })?;
                remove_nofollow(&dst_path)?;
                symlink(&target, &dst_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to create symlink {} -> {}: {}",
                        dst_path.display(),
                        target.display(),
                        e
                    ))
                })?;
            } else if !place_special(src_path, &dst_path, &meta)? {
                continue; // sockets and device nodes are skipped
            }

            copy_metadata(src_path, &dst_path, &meta, &self.options)?;
        }

        for (src_dir, dst_dir) in deferred_dirs.iter().rev() {
            let meta = fs::symlink_metadata(src_dir).map_err(|e| {
                BoxliteError::Storage(format!("Failed to stat {}: {}", src_dir.display(), e))
            })?;
            copy_metadata(src_dir, dst_dir, &meta, &self.options)?;
            if let (Ok(atime), Ok(mtime)) = (meta.accessed(), meta.modified()) {
                set_symlink_times(dst_dir, atime, mtime)?;
            }
        }

        Ok(())
    }
}

/// Whiteout classification of one layer entry, or `None` for ordinary content.
///
/// Only a regular file can be a marker: the walk uses `follow_links(false)`, so
/// `file_type` is the entry's own type and a directory or symlink named
/// `.wh.foo` stays content.
fn marker_of<'a>(entry: &walkdir::DirEntry, name: &'a str) -> BoxliteResult<Option<Whiteout<'a>>> {
    if !entry.file_type().is_file() {
        return Ok(None);
    }
    whiteout::classify(name)
}

/// Unlink whatever sits at `path` without following a symlink there.
/// A real directory is removed with its contents; a symlink *to* a directory is
/// unlinked, never traversed.
fn remove_nofollow(path: &Path) -> BoxliteResult<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(BoxliteError::Storage(format!(
                "Failed to stat {}: {}",
                path.display(),
                e
            )));
        }
    };

    let removed = if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    removed
        .map_err(|e| BoxliteError::Storage(format!("Failed to remove {}: {}", path.display(), e)))
}

/// Ensure a real directory at `dst`, replacing a file or symlink in the way.
fn place_dir(dst: &Path) -> BoxliteResult<()> {
    match fs::symlink_metadata(dst) {
        Ok(m) if m.is_dir() => return Ok(()), // merge into the lower layer's dir
        Ok(_) => remove_nofollow(dst)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(BoxliteError::Storage(format!(
                "Failed to stat {}: {}",
                dst.display(),
                e
            )));
        }
    }
    fs::create_dir(dst).map_err(|e| {
        BoxliteError::Storage(format!("Failed to create dir {}: {}", dst.display(), e))
    })
}

/// Replace `dst` with a fresh copy of `src`. `create_new` sets `O_EXCL`, so the
/// open fails rather than following a symlink that reappeared after the unlink.
fn place_regular(src: &Path, dst: &Path, meta: &fs::Metadata) -> BoxliteResult<()> {
    remove_nofollow(dst)?;

    let mut reader = fs::File::open(src)
        .map_err(|e| BoxliteError::Storage(format!("Failed to open {}: {}", src.display(), e)))?;
    let mut writer = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(meta.mode() & 0o7777)
        .open(dst)
        .map_err(|e| BoxliteError::Storage(format!("Failed to create {}: {}", dst.display(), e)))?;

    io::copy(&mut reader, &mut writer).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to copy {} -> {}: {}",
            src.display(),
            dst.display(),
            e
        ))
    })?;
    Ok(())
}

/// Returns whether an inode was created. Sockets and device nodes are skipped,
/// matching `dir_copy`.
#[cfg(target_os = "linux")]
fn place_special(src: &Path, dst: &Path, meta: &fs::Metadata) -> BoxliteResult<bool> {
    if meta.file_type().is_fifo() {
        remove_nofollow(dst)?;
        create_fifo(dst, meta.mode())?;
        return Ok(true);
    }
    tracing::debug!("Skipping special file: {}", src.display());
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
fn place_special(src: &Path, _dst: &Path, _meta: &fs::Metadata) -> BoxliteResult<bool> {
    tracing::debug!("Skipping special file: {}", src.display());
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn merge(src: &Path, dst: &Path) {
        OverlayMerge::new(src, dst).unwrap().apply().unwrap();
    }

    #[test]
    fn upper_layer_file_does_not_write_through_inherited_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        let src = tmp.path().join("layer");
        let dst = tmp.path().join("merged");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();

        // Host file the attacker wants to own.
        fs::write(outside.join("authorized_keys"), b"LEGIT_KEY").unwrap();
        // Lower layer planted an absolute escape link in the merge tree.
        symlink(outside.join("authorized_keys"), dst.join("config")).unwrap();
        // Upper layer ships a regular file at the same path.
        fs::write(src.join("config"), b"ATTACKER_PUBKEY").unwrap();

        merge(&src, &dst);

        assert_eq!(
            fs::read(outside.join("authorized_keys")).unwrap(),
            b"LEGIT_KEY",
            "host file outside the rootfs must not be touched"
        );
        assert_eq!(fs::read(dst.join("config")).unwrap(), b"ATTACKER_PUBKEY");
        assert!(
            !fs::symlink_metadata(dst.join("config"))
                .unwrap()
                .file_type()
                .is_symlink(),
            "escape link must be replaced, not written through"
        );
    }

    #[test]
    fn whiteout_does_not_delete_through_inherited_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        let src = tmp.path().join("layer");
        let dst = tmp.path().join("merged");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(src.join("etc")).unwrap();
        fs::create_dir_all(&dst).unwrap();

        fs::write(outside.join("authorized_keys"), b"LEGIT_KEY").unwrap();
        symlink(&outside, dst.join("etc")).unwrap();
        fs::write(src.join("etc/.wh.authorized_keys"), b"").unwrap();

        merge(&src, &dst);

        assert!(
            outside.join("authorized_keys").exists(),
            "whiteout must not delete a host file through an escape link"
        );
        assert!(!dst.join("etc/.wh.authorized_keys").exists());
    }

    #[test]
    fn opaque_whiteout_does_not_clear_a_directory_outside_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        let src = tmp.path().join("layer");
        let dst = tmp.path().join("merged");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(src.join("etc")).unwrap();
        fs::create_dir_all(&dst).unwrap();

        fs::write(outside.join("keep"), b"KEEP").unwrap();
        symlink(&outside, dst.join("etc")).unwrap();
        fs::write(src.join("etc/.wh..wh..opq"), b"").unwrap();
        fs::write(src.join("etc/upper"), b"upper").unwrap();

        merge(&src, &dst);

        assert_eq!(fs::read(outside.join("keep")).unwrap(), b"KEEP");
        assert_eq!(fs::read(dst.join("etc/upper")).unwrap(), b"upper");
        assert!(!dst.join("etc/.wh..wh..opq").exists());
    }

    #[test]
    fn regular_whiteout_marker_removes_the_lower_file() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(src.join("bin")).unwrap();
        fs::create_dir_all(dst.join("bin")).unwrap();
        fs::write(src.join("bin/.wh.sh"), b"").unwrap();
        fs::write(src.join("bin/new-tool"), b"new").unwrap();
        fs::write(dst.join("bin/sh"), b"old").unwrap();
        fs::write(dst.join("bin/bash"), b"keep").unwrap();

        merge(&src, &dst);

        assert!(!dst.join("bin/sh").exists());
        assert!(!dst.join("bin/.wh.sh").exists());
        assert_eq!(fs::read(dst.join("bin/bash")).unwrap(), b"keep");
        assert_eq!(fs::read(dst.join("bin/new-tool")).unwrap(), b"new");
    }

    #[test]
    fn opaque_whiteout_marker_clears_the_lower_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(src.join("etc")).unwrap();
        fs::create_dir_all(dst.join("etc/subdir")).unwrap();
        fs::write(src.join("etc/.wh..wh..opq"), b"").unwrap();
        fs::write(src.join("etc/upper"), b"upper").unwrap();
        fs::write(dst.join("etc/lower"), b"lower").unwrap();
        fs::write(dst.join("etc/subdir/lower"), b"lower").unwrap();

        merge(&src, &dst);

        assert_eq!(fs::read(dst.join("etc/upper")).unwrap(), b"upper");
        assert!(!dst.join("etc/lower").exists());
        assert!(!dst.join("etc/subdir").exists());
        assert!(!dst.join("etc/.wh..wh..opq").exists());
    }

    #[test]
    fn self_referential_symlink_in_dest_is_replaced_by_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(src.join("thunar")).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("thunar/app"), b"app").unwrap();
        symlink("thunar", dst.join("thunar")).unwrap();

        merge(&src, &dst);

        assert_eq!(fs::read(dst.join("thunar/app")).unwrap(), b"app");
    }

    /// A cross-layer parent-directory symlink that points outside the root must
    /// not let a later layer's file land outside: the parent is resolved through
    /// `SafeRoot`, which re-anchors it back inside. Directly encodes the goal —
    /// cross-layer symlinks cannot write outside the extraction root.
    #[test]
    fn write_through_escaping_parent_symlink_stays_inside_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        let src = tmp.path().join("layer");
        let dst = tmp.path().join("merged");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(src.join("etc")).unwrap();
        fs::create_dir_all(&dst).unwrap();

        // Lower layer planted an escape link: dst/etc -> <outside>.
        symlink(&outside, dst.join("etc")).unwrap();
        // Upper layer writes a file under that directory.
        fs::write(src.join("etc/evil"), b"OWNED").unwrap();

        merge(&src, &dst);

        assert!(
            !outside.join("evil").exists(),
            "write escaped the root through a parent-dir symlink"
        );
    }

    /// A layer entry named exactly `.wh.` has an empty whiteout target. OCI
    /// forbids it (umoci rejects it, and so does `LayerExtractor`); treating it
    /// as "whiteout the containing directory" would let one layer erase every
    /// lower layer.
    #[test]
    fn degenerate_root_whiteout_marker_does_not_wipe_the_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("layer");
        let dst = tmp.path().join("merged");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(dst.join("etc")).unwrap();
        fs::write(src.join(".wh."), b"").unwrap();
        fs::write(dst.join("etc/passwd"), b"root").unwrap();

        let outcome = OverlayMerge::new(&src, &dst).unwrap().apply();

        assert_eq!(
            fs::read(dst.join("etc/passwd")).unwrap(),
            b"root",
            "lower layers must survive a malformed marker (outcome {:?})",
            outcome
        );
        assert!(
            outcome.is_err(),
            "an empty whiteout target must be rejected, not applied"
        );
    }

    /// Same rule one level down: `etc/.wh.` must not be read as "remove etc".
    #[test]
    fn degenerate_nested_whiteout_marker_does_not_remove_its_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("layer");
        let dst = tmp.path().join("merged");
        fs::create_dir_all(src.join("etc")).unwrap();
        fs::create_dir_all(dst.join("etc")).unwrap();
        fs::write(src.join("etc/.wh."), b"").unwrap();
        fs::write(dst.join("etc/passwd"), b"root").unwrap();

        let outcome = OverlayMerge::new(&src, &dst).unwrap().apply();

        assert!(outcome.is_err(), "empty whiteout target must be rejected");
        assert_eq!(fs::read(dst.join("etc/passwd")).unwrap(), b"root");
    }

    /// `.wh..` and `.wh...` name `.` and `..` as their victim — a directory
    /// traversal spelled as a whiteout. Both are rejected upstream
    /// (`extractor.rs` `validate_whiteout_target`).
    #[test]
    fn dot_and_dotdot_whiteout_targets_are_rejected() {
        for marker in [".wh..", ".wh...", "etc/.wh..", "etc/.wh..."] {
            let tmp = tempfile::tempdir().unwrap();
            let src = tmp.path().join("layer");
            let dst = tmp.path().join("merged");
            fs::create_dir_all(src.join("etc")).unwrap();
            fs::create_dir_all(dst.join("etc")).unwrap();
            fs::write(src.join(marker), b"").unwrap();
            fs::write(dst.join("etc/passwd"), b"root").unwrap();

            let outcome = OverlayMerge::new(&src, &dst).unwrap().apply();

            assert!(outcome.is_err(), "{} must be rejected", marker);
            assert_eq!(
                fs::read(dst.join("etc/passwd")).unwrap(),
                b"root",
                "{} must not delete anything",
                marker
            );
        }
    }

    /// Only a regular file is a whiteout marker. A directory whose name merely
    /// starts with `.wh.` is ordinary content and must be copied, not obeyed —
    /// same rule as `extractor.rs` (`entry_type != Regular` -> not a whiteout).
    #[test]
    fn wh_prefixed_directory_is_content_not_a_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("layer");
        let dst = tmp.path().join("merged");
        fs::create_dir_all(src.join(".wh.etc")).unwrap();
        fs::create_dir_all(dst.join("etc")).unwrap();
        fs::write(src.join(".wh.etc/somefile"), b"marker-looking path").unwrap();
        fs::write(dst.join("etc/passwd"), b"root").unwrap();

        merge(&src, &dst);

        assert_eq!(
            fs::read(dst.join(".wh.etc/somefile")).unwrap(),
            b"marker-looking path",
            "a .wh.-prefixed directory must be copied as content"
        );
        assert_eq!(
            fs::read(dst.join("etc/passwd")).unwrap(),
            b"root",
            "it must not whiteout the sibling it looks like it names"
        );
    }

    #[test]
    fn absolute_symlink_targets_are_preserved_for_the_guest() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(src.join("usr/bin")).unwrap();
        fs::create_dir_all(&dst).unwrap();
        symlink("/bin/busybox", src.join("usr/bin/sh")).unwrap();

        merge(&src, &dst);

        assert_eq!(
            fs::read_link(dst.join("usr/bin/sh")).unwrap(),
            Path::new("/bin/busybox"),
            "guest-visible symlink targets must stay verbatim"
        );
    }
}
