//! Image disk manager.
//!
//! Builds and caches pure ext4 disk images from OCI images.
//! These disks contain only image content (no guest binary).

#[cfg(any(unix, windows, test))]
use std::fs;
use std::path::PathBuf;

#[cfg(any(unix, windows, test))]
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

#[cfg(any(unix, windows))]
use crate::disk::create_ext4_from_dir;
#[cfg(any(unix, windows, test))]
use crate::disk::{Disk, DiskFormat};
#[cfg(unix)]
use crate::rootfs::RootfsBuilder;

#[cfg(any(unix, windows))]
use super::ImageObject;

/// Builds and caches ext4 disk images from OCI images.
///
/// Image disks are pure: only OCI image content, no guest binary injected.
/// Cache key is the image digest (SHA256 of layer digests).
///
/// Follows the staged install pattern: build in temp → atomic rename to cache.
/// No half-written files ever appear in the cache directory.
///
/// # Concurrency
///
/// Thread-safety is provided by the caller:
/// - Multi-process: `RuntimeLock` ensures single-process access per BOXLITE_HOME
/// - In-process: `OnceCell<GuestRootfs>` serializes all calls to `get_or_create()`
///
/// No internal locking is needed.
///
/// Cache location: `~/.boxlite/images/disk-images/`
pub struct ImageDiskManager {
    #[allow(dead_code)] // Read from cfg-gated methods only
    cache_dir: PathBuf,
    #[allow(dead_code)] // Read from cfg-gated methods only
    temp_dir: PathBuf,
}

impl ImageDiskManager {
    pub fn new(cache_dir: PathBuf, temp_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            temp_dir,
        }
    }

    /// Get or create an ext4 disk image for the given OCI image.
    ///
    /// Returns a persistent `Disk` (won't be cleaned up on drop).
    /// If a cached disk exists for this image digest, returns it immediately.
    /// Otherwise: extracts layers → creates ext4 → atomically installs to cache.
    ///
    /// On Unix, uses `RootfsBuilder` for layer extraction (xattr support).
    /// On Windows, uses `extract_layer_tarball` (simpler, no xattr).
    /// Both platforms use native `mke2fs` for ext4 creation.
    #[cfg(any(unix, windows))]
    pub async fn get_or_create(&self, image: &ImageObject) -> BoxliteResult<Disk> {
        let digest = image.compute_image_digest();

        if let Some(disk) = self.find(&digest) {
            tracing::debug!("Found cached image disk for {}", digest);
            return Ok(disk);
        }

        tracing::info!("Building image disk for {} (first time)", digest);
        self.build_and_install(image, &digest).await
    }

    /// Look up a cached disk by image digest.
    #[cfg(any(unix, windows, test))]
    fn find(&self, digest: &str) -> Option<Disk> {
        let path = self.disk_path(digest);
        path.exists()
            .then(|| Disk::new(path, DiskFormat::Ext4, true))
    }

    /// Build ext4 from image layers and atomically install to cache.
    #[cfg(unix)]
    async fn build_and_install(&self, image: &ImageObject, digest: &str) -> BoxliteResult<Disk> {
        // All work happens in a temp directory (staged)
        let temp = tempfile::tempdir_in(&self.temp_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp directory in {}: {}",
                self.temp_dir.display(),
                e
            ))
        })?;

        // Extract image layers to merged directory
        let merged_path = temp.path().join("merged");
        let prepared = RootfsBuilder::new().prepare(merged_path, image).await?;

        // Create ext4 from merged directory (blocking I/O)
        let temp_disk_path = temp.path().join("image.ext4");
        let prepared_path = prepared.path.clone();
        let disk_clone = temp_disk_path.clone();
        let temp_disk =
            tokio::task::spawn_blocking(move || create_ext4_from_dir(&prepared_path, &disk_clone))
                .await
                .map_err(|e| {
                    BoxliteError::Internal(format!("Disk creation task failed: {}", e))
                })??;

        // Atomically install staged disk to cache
        self.install(digest, temp_disk)
    }

    /// Build ext4 from image layers and atomically install to cache (non-Unix).
    ///
    /// Uses cross-platform tar extraction (no xattr) followed by native `mke2fs`
    /// (cross-compiled e2fsprogs binary bundled in the distribution).
    ///
    /// Symlinks are deferred: extracted as metadata, then created inside the ext4
    /// image via `debugfs` after `mke2fs -d` populates regular files.
    #[cfg(windows)]
    async fn build_and_install(&self, image: &ImageObject, digest: &str) -> BoxliteResult<Disk> {
        // All work happens in a temp directory (staged)
        let temp = tempfile::tempdir_in(&self.temp_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp directory in {}: {}",
                self.temp_dir.display(),
                e
            ))
        })?;

        // Extract image layers to merged directory.
        // Symlinks are collected instead of created on the Windows filesystem.
        let merged_path = temp.path().join("merged");
        let layer_tarballs = image.layer_tarballs();

        std::fs::create_dir_all(&merged_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create merged directory {}: {}",
                merged_path.display(),
                e
            ))
        })?;

        let mut all_symlinks = Vec::new();
        for tarball in &layer_tarballs {
            let symlinks = extract_layer_tarball(tarball, &merged_path)?;
            all_symlinks.extend(symlinks);
        }

        // Create ext4 from merged directory via native mke2fs (blocking I/O)
        let temp_disk_path = temp.path().join("image.ext4");
        let merged_clone = merged_path.clone();
        let disk_clone = temp_disk_path.clone();
        let symlinks_clone = all_symlinks;
        let temp_disk = tokio::task::spawn_blocking(move || {
            let disk = create_ext4_from_dir(&merged_clone, &disk_clone)?;

            // Create symlinks inside the ext4 image via debugfs
            if !symlinks_clone.is_empty() {
                create_symlinks_in_ext4(&disk_clone, &symlinks_clone)?;
            }

            Ok::<_, BoxliteError>(disk)
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("Disk creation task failed: {}", e)))??;

        // Atomically install staged disk to cache
        self.install(digest, temp_disk)
    }

    /// Atomically install a staged disk to the cache directory.
    ///
    /// Takes ownership of the temp `Disk`, renames it to the final cache path,
    /// and returns a new persistent `Disk` pointing to the installed location.
    #[cfg(any(unix, windows, test))]
    fn install(&self, digest: &str, staged_disk: Disk) -> BoxliteResult<Disk> {
        let target = self.disk_path(digest);

        // Defensive: target may already exist from a previous run
        if target.exists() {
            tracing::debug!("Image disk already exists: {}", target.display());
            return Ok(Disk::new(target, DiskFormat::Ext4, true));
        }

        fs::create_dir_all(&self.cache_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create disk image directory {}: {}",
                self.cache_dir.display(),
                e
            ))
        })?;

        let source = staged_disk.path().to_path_buf();

        // Atomic rename (same filesystem guaranteed by startup validation)
        fs::rename(&source, &target).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to install disk image from {} to {}: {}",
                source.display(),
                target.display(),
                e
            ))
        })?;

        // Prevent staged_disk from cleaning up the now-moved file
        let _ = staged_disk.leak();

        tracing::info!("Installed image disk to cache: {}", target.display());
        Ok(Disk::new(target, DiskFormat::Ext4, true))
    }

    /// Compute the cache path for a given image digest.
    ///
    /// Format matches `storage.rs:disk_image_path()`: `{digest}.ext4`
    #[cfg(any(unix, windows, test))]
    fn disk_path(&self, digest: &str) -> PathBuf {
        let filename = digest.replace(':', "-");
        self.cache_dir.join(format!("{}.ext4", filename))
    }
}

/// A deferred symlink to be created inside the ext4 image via debugfs.
#[cfg(any(windows, test))]
#[allow(dead_code)] // Fields read on non-unix; on unix only used in tests
struct DeferredSymlink {
    /// Path inside the filesystem (e.g., "bin/arch")
    path: String,
    /// Symlink target (e.g., "/bin/busybox")
    target: String,
}

/// Extract a layer tarball into a destination directory (Windows).
///
/// Detects compression format by magic bytes:
/// - `1f 8b` → gzip (most common OCI layer format)
/// - `28 b5 2f fd` → zstd
/// - Otherwise → uncompressed tar
///
/// Symlinks are NOT created on the Windows filesystem (they require
/// special privileges and can't point to Unix absolute paths). Instead,
/// they are collected and returned for deferred creation inside the ext4
/// image via debugfs.
///
/// Hardlinks are extracted as regular file copies.
#[cfg(windows)]
fn extract_layer_tarball(
    tarball: &std::path::Path,
    dest: &std::path::Path,
) -> BoxliteResult<Vec<DeferredSymlink>> {
    use std::io::{BufReader, Read, Seek, SeekFrom};

    let file = std::fs::File::open(tarball).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open layer tarball {}: {}",
            tarball.display(),
            e
        ))
    })?;
    let mut reader = BufReader::new(file);

    // Detect compression by magic bytes
    let mut magic = [0u8; 4];
    if reader.read_exact(&mut magic).is_err() {
        return Err(BoxliteError::Storage(format!(
            "Layer tarball too small to read header: {}",
            tarball.display()
        )));
    }
    reader.seek(SeekFrom::Start(0)).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to seek layer tarball {}: {}",
            tarball.display(),
            e
        ))
    })?;

    if magic[0] == 0x1f && magic[1] == 0x8b {
        let decoder = flate2::read::GzDecoder::new(reader);
        extract_tar_entries(tar::Archive::new(decoder), dest, tarball)
    } else if magic == [0x28, 0xb5, 0x2f, 0xfd] {
        let decoder = zstd::Decoder::new(reader).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create zstd decoder for {}: {}",
                tarball.display(),
                e
            ))
        })?;
        extract_tar_entries(tar::Archive::new(decoder), dest, tarball)
    } else {
        extract_tar_entries(tar::Archive::new(reader), dest, tarball)
    }
}

/// Check if a tar entry name is an OCI whiteout marker.
///
/// OCI whiteout files have the prefix `.wh.` and indicate that the
/// corresponding file from a lower layer should be deleted.
#[cfg(any(windows, test))]
fn is_whiteout(name: &str) -> bool {
    // Get the filename component only
    name.rsplit('/')
        .next()
        .map(|f| f.starts_with(".wh."))
        .unwrap_or(false)
}

/// Check if a tar entry name is an OCI opaque whiteout marker.
///
/// The special `.wh..wh..opq` file indicates that ALL contents of the
/// parent directory from lower layers should be deleted.
#[cfg(any(windows, test))]
fn is_opaque_whiteout(name: &str) -> bool {
    name.rsplit('/')
        .next()
        .map(|f| f == ".wh..wh..opq")
        .unwrap_or(false)
}

/// Extract tar entries one by one, skipping symlinks on Windows.
///
/// Handles OCI whiteout markers:
/// - `.wh.<name>`: deletes the target file from the destination
/// - `.wh..wh..opq`: deletes all existing contents of the parent directory
///
/// Returns deferred symlinks to be created in the ext4 image later.
/// Symlinks are deduplicated with last-wins semantics per OCI spec.
#[cfg(any(windows, test))]
fn extract_tar_entries<R: std::io::Read>(
    mut archive: tar::Archive<R>,
    dest: &std::path::Path,
    tarball: &std::path::Path,
) -> BoxliteResult<Vec<DeferredSymlink>> {
    use std::collections::HashMap;

    // Use HashMap for last-wins dedup (OCI spec: upper layer overrides lower)
    let mut symlink_map: HashMap<String, DeferredSymlink> = HashMap::new();

    let entries = archive.entries().map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read tar entries from {}: {}",
            tarball.display(),
            e
        ))
    })?;

    for entry_result in entries {
        let mut entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("Skipping bad tar entry in {}: {}", tarball.display(), e);
                continue;
            }
        };

        let entry_type = entry.header().entry_type();
        let path = match entry.path() {
            Ok(p) => p.to_path_buf(),
            Err(e) => {
                tracing::warn!("Skipping entry with invalid path: {}", e);
                continue;
            }
        };

        let path_str = path.to_string_lossy().to_string();
        let clean_path = path_str.strip_prefix("./").unwrap_or(&path_str);

        // Handle OCI opaque whiteout: delete all existing contents in the parent directory
        if is_opaque_whiteout(clean_path) {
            if let Some(parent) = std::path::Path::new(clean_path).parent() {
                let parent_dest = dest.join(parent);
                if parent_dest.exists() {
                    tracing::debug!(
                        "Opaque whiteout: clearing contents of {}",
                        parent_dest.display()
                    );
                    if let Ok(entries) = std::fs::read_dir(&parent_dest) {
                        for child in entries.flatten() {
                            let _ = if child.path().is_dir() {
                                std::fs::remove_dir_all(child.path())
                            } else {
                                std::fs::remove_file(child.path())
                            };
                        }
                    }
                }
            }
            continue;
        }

        // Handle OCI single-file whiteout: delete the target file
        if is_whiteout(clean_path) {
            // ".wh.<name>" means delete "<name>" in the same directory
            let whiteout_path = std::path::Path::new(clean_path);
            if let Some(filename) = whiteout_path.file_name().and_then(|f| f.to_str())
                && let Some(target_name) = filename.strip_prefix(".wh.")
            {
                let target_path = if let Some(parent) = whiteout_path.parent() {
                    dest.join(parent).join(target_name)
                } else {
                    dest.join(target_name)
                };
                if target_path.exists() {
                    tracing::debug!("Whiteout: removing {}", target_path.display());
                    let _ = if target_path.is_dir() {
                        std::fs::remove_dir_all(&target_path)
                    } else {
                        std::fs::remove_file(&target_path)
                    };
                }
            }
            continue;
        }

        // Collect symlinks for deferred creation via debugfs (last-wins dedup)
        if entry_type == tar::EntryType::Symlink {
            if let Ok(Some(target)) = entry.header().link_name() {
                let target_str = target.to_string_lossy().to_string();
                if !clean_path.is_empty() {
                    symlink_map.insert(
                        clean_path.to_string(),
                        DeferredSymlink {
                            path: clean_path.to_string(),
                            target: target_str,
                        },
                    );
                }
            }
            continue;
        }

        // Extract regular files, directories, and hardlinks normally
        entry.set_preserve_permissions(false);
        if let Err(e) = entry.unpack_in(dest) {
            let err_msg = e.to_string();
            // Only skip entries that fail due to unsupported entry types (device nodes, etc.)
            if err_msg.contains("not supported")
                || err_msg.contains("operation not permitted")
                || entry_type == tar::EntryType::Block
                || entry_type == tar::EntryType::Char
                || entry_type == tar::EntryType::Fifo
            {
                tracing::debug!(
                    "Skipping unsupported entry {} (type {:?}) in {}: {}",
                    path.display(),
                    entry_type,
                    tarball.display(),
                    e
                );
            } else {
                return Err(BoxliteError::Storage(format!(
                    "Failed to extract {} (type {:?}) from {}: {}",
                    path.display(),
                    entry_type,
                    tarball.display(),
                    e
                )));
            }
        }
    }

    let symlinks: Vec<DeferredSymlink> = symlink_map.into_values().collect();

    tracing::debug!(
        "Extracted layer {} ({} deferred symlinks)",
        tarball.display(),
        symlinks.len()
    );

    Ok(symlinks)
}

/// Create symlinks inside an ext4 image using debugfs.
///
/// Writes commands to a temp file and uses `debugfs -w -f <file>` to
/// batch-create symlinks that were deferred during tar extraction on Windows.
/// Uses a temp file instead of stdin pipe to avoid pipe buffer deadlocks
/// when there are many symlinks (500+).
#[cfg(windows)]
fn create_symlinks_in_ext4(
    image_path: &std::path::Path,
    symlinks: &[DeferredSymlink],
) -> BoxliteResult<()> {
    use std::io::Write;

    let start = std::time::Instant::now();

    // Build debugfs commands: symlink <path> <target>
    let mut commands = String::new();
    for sym in symlinks {
        // Ensure parent directories exist (debugfs mkdir is idempotent for existing dirs)
        let sym_path = std::path::Path::new(&sym.path);
        let mut current = PathBuf::new();
        if let Some(parent) = sym_path.parent() {
            for component in parent.components() {
                current.push(component);
                commands.push_str(&format!(
                    "mkdir /{}\n",
                    crate::disk::ext4::to_unix_path_str(&current)
                ));
            }
        }
        // Use forward slashes for symlink path and target (debugfs requires Unix paths)
        let unix_path = crate::disk::ext4::to_unix_path_str(std::path::Path::new(&sym.path));
        let unix_target = sym.target.replace('\\', "/");
        // Create the symlink
        commands.push_str(&format!("symlink /{} {}\n", unix_path, unix_target));
        // Set ownership to root
        commands.push_str(&format!("sif /{} uid 0\n", unix_path));
        commands.push_str(&format!("sif /{} gid 0\n", unix_path));
    }

    // Write commands to a temp file to avoid pipe buffer deadlocks
    let cmd_file = std::env::temp_dir().join(format!(
        "boxlite-debugfs-symlinks-{}.txt",
        std::process::id()
    ));
    std::fs::write(&cmd_file, commands.as_bytes()).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to write debugfs command file {}: {}",
            cmd_file.display(),
            e
        ))
    })?;

    let debugfs = crate::disk::ext4::get_debugfs_path()?;

    let output = std::process::Command::new(&debugfs)
        .arg("-w")
        .arg("-f")
        .arg(&cmd_file)
        .arg(image_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| {
            BoxliteError::Storage(format!("Failed to run debugfs for symlinks: {}", e))
        })?;

    // Clean up temp file
    let _ = std::fs::remove_file(&cmd_file);

    let duration = start.elapsed();

    if !output.status.success() {
        return Err(BoxliteError::Storage(format!(
            "debugfs symlink creation failed (exit code: {:?}, took {:?})",
            output.status.code(),
            duration
        )));
    }

    tracing::info!(
        "Created {} symlinks in ext4 image in {:?}",
        symlinks.len(),
        duration
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_disk_path_replaces_colon() {
        let mgr = ImageDiskManager::new(PathBuf::from("/cache/disk-images"), PathBuf::from("/tmp"));
        let path = mgr.disk_path("sha256:abc123def456");
        assert_eq!(
            path,
            PathBuf::from("/cache/disk-images/sha256-abc123def456.ext4")
        );
    }

    #[test]
    fn test_disk_path_no_colon() {
        let mgr = ImageDiskManager::new(PathBuf::from("/cache"), PathBuf::from("/tmp"));
        let path = mgr.disk_path("plaindigest");
        assert_eq!(path, PathBuf::from("/cache/plaindigest.ext4"));
    }

    #[test]
    fn test_find_returns_none_when_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = ImageDiskManager::new(dir.path().to_path_buf(), dir.path().to_path_buf());

        assert!(mgr.find("sha256:nonexistent").is_none());
    }

    #[test]
    fn test_find_returns_disk_when_cached() {
        let dir = tempfile::TempDir::new().unwrap();
        let mgr = ImageDiskManager::new(dir.path().to_path_buf(), dir.path().to_path_buf());

        // Create a fake cached disk
        let cached = dir.path().join("sha256-abc123.ext4");
        std::fs::write(&cached, "fake disk").unwrap();

        let disk = mgr.find("sha256:abc123");
        assert!(disk.is_some());
        let disk = disk.unwrap();
        assert_eq!(disk.path(), cached);
        assert_eq!(disk.format(), DiskFormat::Ext4);
        let _ = disk.leak();
    }

    #[test]
    fn test_install_creates_dir_and_moves_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("disk-images");
        let mgr = ImageDiskManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Create staged file
        let staged_path = dir.path().join("staged.ext4");
        std::fs::write(&staged_path, "staged content").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("sha256:test", staged_disk).unwrap();
        let expected = cache_dir.join("sha256-test.ext4");

        assert!(expected.exists());
        assert_eq!(result.path(), expected);
        let _ = result.leak();
    }

    #[test]
    fn test_install_race_safe() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache_dir = dir.path().join("disk-images");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let mgr = ImageDiskManager::new(cache_dir.clone(), dir.path().to_path_buf());

        // Pre-create target (another process won the race)
        let target = cache_dir.join("sha256-raced.ext4");
        std::fs::write(&target, "first").unwrap();

        // Try to install over it
        let staged_path = dir.path().join("staged.ext4");
        std::fs::write(&staged_path, "second").unwrap();
        let staged_disk = Disk::new(staged_path, DiskFormat::Ext4, false);

        let result = mgr.install("sha256:raced", staged_disk).unwrap();
        assert_eq!(result.path(), target);
        assert_eq!(std::fs::read_to_string(result.path()).unwrap(), "first");
        let _ = result.leak();
    }

    #[test]
    fn test_is_whiteout() {
        assert!(is_whiteout(".wh.somefile"));
        assert!(is_whiteout("usr/lib/.wh.libold.so"));
        assert!(is_whiteout(".wh..wh..opq"));
        assert!(!is_whiteout("regular_file"));
        assert!(!is_whiteout("usr/lib/libfoo.so"));
        assert!(!is_whiteout("path/to/.hidden"));
    }

    #[test]
    fn test_is_opaque_whiteout() {
        assert!(is_opaque_whiteout(".wh..wh..opq"));
        assert!(is_opaque_whiteout("etc/.wh..wh..opq"));
        assert!(!is_opaque_whiteout(".wh.somefile"));
        assert!(!is_opaque_whiteout("regular_file"));
    }

    #[test]
    fn test_symlink_dedup_last_wins() {
        use std::collections::HashMap;

        let mut map: HashMap<String, DeferredSymlink> = HashMap::new();

        // First layer: bin/sh -> /bin/dash
        map.insert(
            "bin/sh".to_string(),
            DeferredSymlink {
                path: "bin/sh".to_string(),
                target: "/bin/dash".to_string(),
            },
        );

        // Second layer overrides: bin/sh -> /bin/bash
        map.insert(
            "bin/sh".to_string(),
            DeferredSymlink {
                path: "bin/sh".to_string(),
                target: "/bin/bash".to_string(),
            },
        );

        let result: Vec<DeferredSymlink> = map.into_values().collect();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].target, "/bin/bash");
    }

    #[test]
    fn test_extract_tar_entries_whiteout() {
        let dir = tempfile::TempDir::new().unwrap();
        let dest = dir.path().join("extract");
        std::fs::create_dir_all(&dest).unwrap();

        // Pre-create files that whiteouts should delete
        let etc_dir = dest.join("etc");
        std::fs::create_dir_all(&etc_dir).unwrap();
        std::fs::write(etc_dir.join("old_config"), "old").unwrap();
        std::fs::write(etc_dir.join("keep_this"), "keep").unwrap();

        // Build a tar with:
        // 1. A single-file whiteout: etc/.wh.old_config
        // 2. A regular file: etc/new_config
        let tar_path = dir.path().join("layer.tar");
        {
            let file = std::fs::File::create(&tar_path).unwrap();
            let mut builder = tar::Builder::new(file);

            // Add whiteout marker for old_config
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "etc/.wh.old_config", std::io::empty())
                .unwrap();

            // Add a new regular file
            let data = b"new content";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "etc/new_config", &data[..])
                .unwrap();

            builder.finish().unwrap();
        }

        let file = std::fs::File::open(&tar_path).unwrap();
        let archive = tar::Archive::new(file);
        let symlinks = extract_tar_entries(archive, &dest, &tar_path).unwrap();

        // old_config should be deleted by the whiteout
        assert!(!etc_dir.join("old_config").exists());
        // keep_this should still exist (not affected)
        assert!(etc_dir.join("keep_this").exists());
        // new_config should be extracted
        assert!(etc_dir.join("new_config").exists());
        assert_eq!(
            std::fs::read_to_string(etc_dir.join("new_config")).unwrap(),
            "new content"
        );
        assert!(symlinks.is_empty());
    }

    #[test]
    fn test_extract_tar_entries_opaque_whiteout() {
        let dir = tempfile::TempDir::new().unwrap();
        let dest = dir.path().join("extract");
        std::fs::create_dir_all(&dest).unwrap();

        // Pre-create files in etc/ that opaque whiteout should clear
        let etc_dir = dest.join("etc");
        std::fs::create_dir_all(&etc_dir).unwrap();
        std::fs::write(etc_dir.join("file_a"), "a").unwrap();
        std::fs::write(etc_dir.join("file_b"), "b").unwrap();

        // Build a tar with an opaque whiteout for etc/
        let tar_path = dir.path().join("layer.tar");
        {
            let file = std::fs::File::create(&tar_path).unwrap();
            let mut builder = tar::Builder::new(file);

            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "etc/.wh..wh..opq", std::io::empty())
                .unwrap();

            // Add a new file in the same layer (should survive)
            let data = b"new";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "etc/new_file", &data[..])
                .unwrap();

            builder.finish().unwrap();
        }

        let file = std::fs::File::open(&tar_path).unwrap();
        let archive = tar::Archive::new(file);
        let _symlinks = extract_tar_entries(archive, &dest, &tar_path).unwrap();

        // Old files should be cleared by opaque whiteout
        assert!(!etc_dir.join("file_a").exists());
        assert!(!etc_dir.join("file_b").exists());
        // New file from the same layer should exist
        assert!(etc_dir.join("new_file").exists());
    }
}
