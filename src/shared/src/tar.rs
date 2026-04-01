//! Tar archive pack/unpack for host↔guest file transfer.
//!
//! Both host (boxlite) and guest agent share this module to avoid
//! duplicating tar building/extraction logic.

use crate::{BoxliteError, BoxliteResult};
use std::path::{Path, PathBuf};

// ── Pack ──────────────────────────────────────────────────────────

/// Controls how a source path is packed into a tar archive.
pub struct PackContext {
    /// Follow symlinks (copy target content) vs preserve them as links.
    pub follow_symlinks: bool,
    /// When packing a directory, include the directory itself as a top-level
    /// entry (true) or flatten its contents into the archive root (false).
    pub include_parent: bool,
}

/// Pack `src` (file or directory) into a tar archive at `tar_path`.
///
/// Runs blocking I/O on a dedicated thread via `spawn_blocking`.
pub async fn pack(src: PathBuf, tar_path: PathBuf, opts: PackContext) -> BoxliteResult<()> {
    tokio::task::spawn_blocking(move || pack_blocking(&src, &tar_path, &opts))
        .await
        .map_err(|e| BoxliteError::Storage(format!("pack task join error: {}", e)))?
}

fn pack_blocking(src: &Path, tar_path: &Path, opts: &PackContext) -> BoxliteResult<()> {
    let tar_file = std::fs::File::create(tar_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "failed to create tar {}: {}",
            tar_path.display(),
            e
        ))
    })?;
    let mut builder = tar::Builder::new(tar_file);
    builder.follow_symlinks(opts.follow_symlinks);

    if src.is_dir() {
        if opts.include_parent {
            let base = src
                .file_name()
                .map(|s| s.to_owned())
                .unwrap_or_else(|| std::ffi::OsStr::new("root").to_owned());
            builder
                .append_dir_all(base, src)
                .map_err(|e| BoxliteError::Storage(format!("failed to archive dir: {}", e)))?;
        } else {
            // Add each top-level entry individually so we don't create a
            // "." entry that produces an empty tar path on extraction.
            for entry in std::fs::read_dir(src).map_err(|e| {
                BoxliteError::Storage(format!("failed to read dir {}: {}", src.display(), e))
            })? {
                let entry = entry.map_err(|e| {
                    BoxliteError::Storage(format!("failed to read dir entry: {}", e))
                })?;
                let name = entry.file_name();
                let path = entry.path();
                if path.is_dir() {
                    builder.append_dir_all(&name, &path).map_err(|e| {
                        BoxliteError::Storage(format!("failed to archive dir: {}", e))
                    })?;
                } else {
                    builder.append_path_with_name(&path, &name).map_err(|e| {
                        BoxliteError::Storage(format!("failed to archive file: {}", e))
                    })?;
                }
            }
        }
    } else {
        let name = src
            .file_name()
            .ok_or_else(|| BoxliteError::Config("source file has no name".into()))?;
        builder
            .append_path_with_name(src, name)
            .map_err(|e| BoxliteError::Storage(format!("failed to archive file: {}", e)))?;
    }

    builder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("failed to finish tar: {}", e)))
}

// ── Unpack ────────────────────────────────────────────────────────

/// Controls how a tar archive is unpacked to a destination.
pub struct UnpackContext {
    /// Allow overwriting existing files/directories.
    pub overwrite: bool,
    /// Create parent directories if they don't exist.
    pub mkdir_parents: bool,
    /// Force directory extraction mode (skip single-file detection).
    /// Set `true` when the caller knows the destination is a directory
    /// (e.g. original path had trailing `/`).
    pub force_directory: bool,
}

/// Unpack a tar archive to `dest`.
///
/// Automatically detects whether to extract as a single file (FileToFile)
/// or into a directory (IntoDirectory) based on tar contents and dest path,
/// unless `force_directory` is set.
///
/// Runs blocking I/O on a dedicated thread via `spawn_blocking`.
pub async fn unpack(tar_path: PathBuf, dest: PathBuf, opts: UnpackContext) -> BoxliteResult<()> {
    tokio::task::spawn_blocking(move || unpack_blocking(&tar_path, &dest, &opts))
        .await
        .map_err(|e| BoxliteError::Storage(format!("unpack task join error: {}", e)))?
}

fn unpack_blocking(tar_path: &Path, dest: &Path, opts: &UnpackContext) -> BoxliteResult<()> {
    let mode = if opts.force_directory {
        ExtractionMode::IntoDirectory
    } else {
        detect_extraction_mode(dest, tar_path)?
    };

    match mode {
        ExtractionMode::FileToFile => {
            if let Some(parent) = dest.parent() {
                if opts.mkdir_parents && !parent.exists() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        BoxliteError::Storage(format!(
                            "failed to create parent dir {}: {}",
                            parent.display(),
                            e
                        ))
                    })?;
                } else if !parent.exists() {
                    return Err(BoxliteError::Storage(format!(
                        "parent directory of {} does not exist",
                        dest.display()
                    )));
                }
            }
            if !opts.overwrite && dest.exists() {
                return Err(BoxliteError::Storage(format!(
                    "destination {} exists and overwrite=false",
                    dest.display()
                )));
            }
            let tar_file = std::fs::File::open(tar_path).map_err(|e| {
                BoxliteError::Storage(format!("failed to open tar {}: {}", tar_path.display(), e))
            })?;
            let mut archive = tar::Archive::new(tar_file);
            let mut entries = archive
                .entries()
                .map_err(|e| BoxliteError::Storage(format!("failed to read tar entries: {}", e)))?;
            if let Some(entry) = entries.next() {
                let mut entry = entry.map_err(|e| {
                    BoxliteError::Storage(format!("failed to read tar entry: {}", e))
                })?;
                entry.unpack(dest).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "failed to unpack file to {}: {}",
                        dest.display(),
                        e
                    ))
                })?;
            }
            Ok(())
        }
        ExtractionMode::IntoDirectory => {
            if !dest.exists() {
                if opts.mkdir_parents {
                    std::fs::create_dir_all(dest).map_err(|e| {
                        BoxliteError::Storage(format!(
                            "failed to create destination {}: {}",
                            dest.display(),
                            e
                        ))
                    })?;
                } else {
                    return Err(BoxliteError::Storage(format!(
                        "destination {} does not exist",
                        dest.display()
                    )));
                }
            }
            if dest.exists() && !opts.overwrite {
                return Err(BoxliteError::Storage(format!(
                    "destination {} exists and overwrite=false",
                    dest.display()
                )));
            }
            let tar_file = std::fs::File::open(tar_path).map_err(|e| {
                BoxliteError::Storage(format!("failed to open tar {}: {}", tar_path.display(), e))
            })?;
            let mut archive = tar::Archive::new(tar_file);
            archive
                .unpack(dest)
                .map_err(|e| BoxliteError::Storage(format!("failed to extract archive: {}", e)))
        }
    }
}

// ── Private ───────────────────────────────────────────────────────

enum ExtractionMode {
    FileToFile,
    IntoDirectory,
}

/// Inspect the destination path and tar contents to decide extraction mode.
///
/// Rules (evaluated in order):
/// 1. Dest path has trailing `/` → directory mode
/// 2. Dest exists as a directory → directory mode
/// 3. Tar contains exactly one regular file → file-to-file mode
/// 4. Fallback → directory mode
fn detect_extraction_mode(dest: &Path, tar_path: &Path) -> BoxliteResult<ExtractionMode> {
    if dest.as_os_str().to_string_lossy().ends_with('/') {
        return Ok(ExtractionMode::IntoDirectory);
    }
    if dest.is_dir() {
        return Ok(ExtractionMode::IntoDirectory);
    }
    let tar_file = std::fs::File::open(tar_path).map_err(|e| {
        BoxliteError::Storage(format!("failed to open tar {}: {}", tar_path.display(), e))
    })?;
    let mut archive = tar::Archive::new(tar_file);
    if let Ok(entries) = archive.entries() {
        let mut count = 0u32;
        let mut is_regular = false;
        for entry in entries {
            count += 1;
            if count > 1 {
                break;
            }
            if let Ok(e) = entry {
                is_regular = e.header().entry_type() == tar::EntryType::Regular;
            }
        }
        if count == 1 && is_regular {
            return Ok(ExtractionMode::FileToFile);
        }
    }
    Ok(ExtractionMode::IntoDirectory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ── Helpers ───────────────────────────────────────────────────

    fn uc(overwrite: bool, mkdir_parents: bool, force_directory: bool) -> UnpackContext {
        UnpackContext {
            overwrite,
            mkdir_parents,
            force_directory,
        }
    }

    fn default_unpack(overwrite: bool) -> UnpackContext {
        uc(overwrite, true, false)
    }

    fn default_pack() -> PackContext {
        PackContext {
            follow_symlinks: true,
            include_parent: true,
        }
    }

    /// Create a tar containing a single file with the given entry name and content.
    fn create_single_file_tar(tar_path: &Path, entry_name: &str, content: &[u8]) {
        let tar_file = std::fs::File::create(tar_path).unwrap();
        let mut builder = tar::Builder::new(tar_file);
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, entry_name, content)
            .unwrap();
        builder.finish().unwrap();
    }

    /// Create a tar containing a directory with files inside.
    fn create_dir_tar(tar_path: &Path) {
        let tar_file = std::fs::File::create(tar_path).unwrap();
        let mut builder = tar::Builder::new(tar_file);

        let mut dir_header = tar::Header::new_gnu();
        dir_header.set_entry_type(tar::EntryType::Directory);
        dir_header.set_size(0);
        dir_header.set_mode(0o755);
        dir_header.set_cksum();
        builder
            .append_data(&mut dir_header, "mydir/", &[] as &[u8])
            .unwrap();

        let content = b"inside dir";
        let mut file_header = tar::Header::new_gnu();
        file_header.set_size(content.len() as u64);
        file_header.set_mode(0o644);
        file_header.set_cksum();
        builder
            .append_data(&mut file_header, "mydir/file.txt", &content[..])
            .unwrap();

        builder.finish().unwrap();
    }

    // ── pack: single file ────────────────────────────────────────

    #[tokio::test]
    async fn pack_single_file() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("hello.txt");
        std::fs::write(&src, b"hello").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        // Verify tar contains exactly one entry with the filename
        let tar_file = std::fs::File::open(&tar_path).unwrap();
        let mut archive = tar::Archive::new(tar_file);
        let entries: Vec<_> = archive.entries().unwrap().collect();
        assert_eq!(entries.len(), 1);
    }

    #[tokio::test]
    async fn pack_empty_file() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("empty.txt");
        std::fs::write(&src, b"").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let dest = tmp.path().join("dest.txt");
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap().len(), 0);
    }

    #[tokio::test]
    async fn pack_binary_content_fidelity() {
        let tmp = TempDir::new().unwrap();
        let data: Vec<u8> = (0..=255).collect();
        let src = tmp.path().join("binary.bin");
        std::fs::write(&src, &data).unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let dest = tmp.path().join("dest.bin");
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    // ── pack: directory with include_parent ───────────────────────

    #[tokio::test]
    async fn pack_dir_include_parent_true() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("mydir");
        std::fs::create_dir(&src_dir).unwrap();
        std::fs::write(src_dir.join("a.txt"), "aaa").unwrap();
        std::fs::write(src_dir.join("b.txt"), "bbb").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(src_dir, tar_path.clone(), default_pack())
            .await
            .unwrap();

        let dest = tmp.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();

        // Files nested under mydir/
        assert_eq!(
            std::fs::read_to_string(dest.join("mydir").join("a.txt")).unwrap(),
            "aaa"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("mydir").join("b.txt")).unwrap(),
            "bbb"
        );
    }

    #[tokio::test]
    async fn pack_dir_include_parent_false_flattens() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("flatdir");
        std::fs::create_dir(&src_dir).unwrap();
        std::fs::write(src_dir.join("f.txt"), "flat").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src_dir,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let dest = tmp.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        unpack(tar_path, dest.clone(), uc(true, false, true))
            .await
            .unwrap();

        // File directly in dest, not under flatdir/
        assert_eq!(std::fs::read_to_string(dest.join("f.txt")).unwrap(), "flat");
    }

    #[tokio::test]
    async fn pack_empty_directory() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("emptydir");
        std::fs::create_dir(&src_dir).unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(src_dir, tar_path.clone(), default_pack())
            .await
            .unwrap();

        let dest = tmp.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert!(dest.join("emptydir").is_dir());
    }

    #[tokio::test]
    async fn pack_nested_directory() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("deep");
        std::fs::create_dir_all(src_dir.join("a").join("b").join("c")).unwrap();
        std::fs::write(
            src_dir.join("a").join("b").join("c").join("file.txt"),
            "deep",
        )
        .unwrap();
        std::fs::write(src_dir.join("top.txt"), "top").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(src_dir, tar_path.clone(), default_pack())
            .await
            .unwrap();

        let dest = tmp.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(
                dest.join("deep")
                    .join("a")
                    .join("b")
                    .join("c")
                    .join("file.txt")
            )
            .unwrap(),
            "deep"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("deep").join("top.txt")).unwrap(),
            "top"
        );
    }

    // ── pack: symlinks ───────────────────────────────────────────

    #[tokio::test]
    async fn pack_follow_symlinks_false_preserves_link() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("linkdir");
        std::fs::create_dir(&src_dir).unwrap();
        std::fs::write(src_dir.join("target.txt"), "target content").unwrap();
        std::os::unix::fs::symlink("target.txt", src_dir.join("link.txt")).unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src_dir,
            tar_path.clone(),
            PackContext {
                follow_symlinks: false,
                include_parent: true,
            },
        )
        .await
        .unwrap();

        let dest = tmp.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();

        let link_path = dest.join("linkdir").join("link.txt");
        assert!(link_path
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_link(&link_path).unwrap().to_str().unwrap(),
            "target.txt"
        );
    }

    #[tokio::test]
    async fn pack_follow_symlinks_true_dereferences() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("derefdir");
        std::fs::create_dir(&src_dir).unwrap();
        std::fs::write(src_dir.join("target.txt"), "deref content").unwrap();
        std::os::unix::fs::symlink("target.txt", src_dir.join("link.txt")).unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src_dir,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: true,
            },
        )
        .await
        .unwrap();

        let dest = tmp.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();

        let link_path = dest.join("derefdir").join("link.txt");
        // Should be a regular file, not a symlink
        assert!(link_path.is_file());
        assert!(!link_path
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(&link_path).unwrap(),
            "deref content"
        );
    }

    // ── pack: error cases ────────────────────────────────────────

    #[tokio::test]
    async fn pack_nonexistent_source_errors() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("out.tar");
        let result = pack(tmp.path().join("does-not-exist"), tar_path, default_pack()).await;
        assert!(result.is_err());
    }

    // ── unpack: detection modes ──────────────────────────────────

    #[tokio::test]
    async fn unpack_single_file_to_nonexistent_path_uses_file_mode() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("single.tar");
        create_single_file_tar(&tar_path, "hello.txt", b"hello");

        let dest = tmp.path().join("output.txt");
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert!(dest.is_file());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "hello");
    }

    #[tokio::test]
    async fn unpack_single_file_to_existing_dir_uses_dir_mode() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("single.tar");
        create_single_file_tar(&tar_path, "hello.txt", b"hello");

        let dest = tmp.path().to_path_buf(); // existing directory
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert!(dest.join("hello.txt").is_file());
    }

    #[tokio::test]
    async fn unpack_trailing_slash_forces_dir_mode() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("single.tar");
        create_single_file_tar(&tar_path, "hello.txt", b"hello");

        let dest = tmp.path().join("dirout");
        std::fs::create_dir(&dest).unwrap();
        let dest_with_slash = PathBuf::from(format!("{}/", dest.display()));
        unpack(tar_path, dest_with_slash, default_unpack(true))
            .await
            .unwrap();
        assert!(dest.join("hello.txt").is_file());
    }

    #[tokio::test]
    async fn unpack_multi_entry_tar_uses_dir_mode() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("multi.tar");
        create_dir_tar(&tar_path);

        let dest = tmp.path().join("output");
        std::fs::create_dir(&dest).unwrap();
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();

        assert!(dest.join("mydir").join("file.txt").is_file());
        assert_eq!(
            std::fs::read_to_string(dest.join("mydir").join("file.txt")).unwrap(),
            "inside dir"
        );
    }

    #[tokio::test]
    async fn unpack_single_dir_entry_uses_dir_mode() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("dir_only.tar");

        let tar_file = std::fs::File::create(&tar_path).unwrap();
        let mut builder = tar::Builder::new(tar_file);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "somedir/", &[] as &[u8])
            .unwrap();
        builder.finish().unwrap();

        let dest = tmp.path().join("output");
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert!(dest.join("somedir").is_dir());
    }

    #[tokio::test]
    async fn unpack_empty_tar_uses_dir_mode() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("empty.tar");

        let tar_file = std::fs::File::create(&tar_path).unwrap();
        let builder = tar::Builder::new(tar_file);
        builder.into_inner().unwrap();

        let dest = tmp.path().join("output");
        // Empty tar + dir mode + mkdir_parents → creates empty directory
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert!(dest.is_dir());
    }

    // ── unpack: force_directory ──────────────────────────────────

    #[tokio::test]
    async fn force_directory_overrides_single_file_detection() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("file.txt");
        std::fs::write(&src, b"data").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let dest = tmp.path().join("dir_dest");
        std::fs::create_dir(&dest).unwrap();
        unpack(tar_path, dest.clone(), uc(true, false, true))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("file.txt")).unwrap(),
            "data"
        );
    }

    // ── unpack: overwrite ────────────────────────────────────────

    #[tokio::test]
    async fn unpack_overwrite_true_replaces_file() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("file.tar");
        create_single_file_tar(&tar_path, "data.txt", b"new content");

        let dest = tmp.path().join("data.txt");
        std::fs::write(&dest, b"old content").unwrap();

        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new content");
    }

    #[tokio::test]
    async fn unpack_overwrite_false_rejects_existing_file() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("file.tar");
        create_single_file_tar(&tar_path, "data.txt", b"new content");

        let dest = tmp.path().join("data.txt");
        std::fs::write(&dest, b"old content").unwrap();

        let result = unpack(tar_path, dest.clone(), default_unpack(false)).await;
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old content");
    }

    #[tokio::test]
    async fn unpack_overwrite_false_rejects_existing_dir() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("dir.tar");
        create_dir_tar(&tar_path);

        let dest = tmp.path().join("output");
        std::fs::create_dir(&dest).unwrap();

        let result = unpack(tar_path, dest, uc(false, false, false)).await;
        assert!(result.is_err());
    }

    // ── unpack: mkdir_parents ────────────────────────────────────

    #[tokio::test]
    async fn unpack_mkdir_parents_creates_parent_dirs_for_file() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("file.tar");
        create_single_file_tar(&tar_path, "data.txt", b"content");

        let dest = tmp.path().join("a").join("b").join("c").join("data.txt");
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();

        assert!(dest.is_file());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "content");
    }

    #[tokio::test]
    async fn unpack_mkdir_parents_creates_dest_dir() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("dir.tar");
        create_dir_tar(&tar_path);

        let dest = tmp.path().join("x").join("y").join("z");
        unpack(tar_path, dest.clone(), uc(true, true, true))
            .await
            .unwrap();
        assert!(dest.join("mydir").join("file.txt").is_file());
    }

    #[tokio::test]
    async fn unpack_no_mkdir_parents_errors_on_missing_parent() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("file.tar");
        create_single_file_tar(&tar_path, "data.txt", b"content");

        let dest = tmp.path().join("nonexistent").join("data.txt");
        let result = unpack(tar_path, dest, uc(true, false, false)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn unpack_no_mkdir_parents_errors_on_missing_dest_dir() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("dir.tar");
        create_dir_tar(&tar_path);

        let dest = tmp.path().join("nonexistent");
        let result = unpack(tar_path, dest, uc(true, false, true)).await;
        assert!(result.is_err());
    }

    // ── roundtrip: pack + unpack ─────────────────────────────────

    #[tokio::test]
    async fn roundtrip_single_file() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("hello.txt");
        std::fs::write(&src, b"hello").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let dest = tmp.path().join("dest.txt");
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "hello");
    }

    #[tokio::test]
    async fn roundtrip_dir_with_parent() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir(&src_dir).unwrap();
        std::fs::write(src_dir.join("hello.txt"), b"hello").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(src_dir, tar_path.clone(), default_pack())
            .await
            .unwrap();

        let dest_dir = tmp.path().join("dest");
        std::fs::create_dir(&dest_dir).unwrap();
        unpack(tar_path, dest_dir.clone(), default_unpack(true))
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(dest_dir.join("src").join("hello.txt")).unwrap(),
            "hello"
        );
    }

    /// Regression test for #238: copy_in creates directory when destination is a file path.
    #[tokio::test]
    async fn issue_238_file_to_file_path_not_directory() {
        let tmp = TempDir::new().unwrap();
        let src_file = tmp.path().join("script.py");
        std::fs::write(&src_file, b"print('hello')\n").unwrap();

        let tar_path = tmp.path().join("issue238.tar");
        pack(
            src_file,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let workspace = tmp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let dest_file = workspace.join("script.py");
        unpack(tar_path, dest_file.clone(), default_unpack(true))
            .await
            .unwrap();

        assert!(
            dest_file.is_file(),
            "script.py should be a file (issue #238)"
        );
        assert!(
            !dest_file.is_dir(),
            "script.py must NOT be a directory (issue #238)"
        );
        assert_eq!(
            std::fs::read_to_string(&dest_file).unwrap(),
            "print('hello')\n"
        );
    }

    #[tokio::test]
    async fn roundtrip_file_to_existing_dir_extracts_inside() {
        let tmp = TempDir::new().unwrap();
        let src_file = tmp.path().join("source.py");
        std::fs::write(&src_file, b"print('hello')").unwrap();
        let tar_path = tmp.path().join("file.tar");
        pack(
            src_file,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let dest_dir = tmp.path().join("workspace");
        std::fs::create_dir(&dest_dir).unwrap();
        unpack(tar_path, dest_dir.clone(), default_unpack(true))
            .await
            .unwrap();

        let extracted = dest_dir.join("source.py");
        assert!(extracted.is_file());
        assert_eq!(
            std::fs::read_to_string(&extracted).unwrap(),
            "print('hello')"
        );
    }

    #[tokio::test]
    async fn roundtrip_filename_with_spaces() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("my file.txt");
        std::fs::write(&src, "spaces\n").unwrap();

        let tar_path = tmp.path().join("out.tar");
        pack(
            src,
            tar_path.clone(),
            PackContext {
                follow_symlinks: true,
                include_parent: false,
            },
        )
        .await
        .unwrap();

        let dest = tmp.path().join("my file out.txt");
        unpack(tar_path, dest.clone(), default_unpack(true))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "spaces\n");
    }
}
