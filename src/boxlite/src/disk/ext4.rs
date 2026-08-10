use crate::images::OverrideStat;
use crate::util;
use boxlite_shared::{BoxliteError, BoxliteResult};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

use super::constants::ext4::{
    BLOCK_SIZE, DEFAULT_DIR_SIZE_BYTES, INODE_SIZE, JOURNAL_OVERHEAD_BYTES, MIN_DISK_SIZE_BYTES,
    SIZE_MULTIPLIER_DEN, SIZE_MULTIPLIER_NUM,
};
use super::{Disk, DiskFormat};

/// Get the path to the mke2fs binary.
fn get_mke2fs_path() -> PathBuf {
    util::find_binary("mke2fs").expect("mke2fs binary not found")
}

/// Get the path to the debugfs binary.
fn get_debugfs_path() -> PathBuf {
    util::find_binary("debugfs").expect("debugfs binary not found")
}

/// Calculate the total size needed for a directory tree on ext4.
///
/// This accounts for:
/// - File content sizes (rounded up to 4KB blocks)
/// - Inode overhead (256 bytes per file/dir/symlink)
/// - Directory entry overhead
fn calculate_dir_size(dir: &Path) -> BoxliteResult<u64> {
    let mut total_blocks = 0u64;
    let mut entry_count = 0u64;

    for entry in WalkDir::new(dir).follow_links(false) {
        let entry = entry.map_err(|e| {
            BoxliteError::Storage(format!("Failed to walk directory {}: {}", dir.display(), e))
        })?;

        entry_count += 1;

        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                // Each file needs at least one block, round up
                let file_blocks = metadata.len().div_ceil(BLOCK_SIZE);
                total_blocks += file_blocks.max(1);
            } else if metadata.is_dir() {
                // Directories need at least one block
                total_blocks += 1;
            }
        }
    }

    // Calculate total:
    // - Block storage
    // - Inode storage (entry_count * INODE_SIZE, rounded to blocks)
    let content_size = total_blocks * BLOCK_SIZE;
    let inode_size = entry_count * INODE_SIZE;

    Ok(content_size + inode_size)
}

/// Calculate appropriate disk size with ext4 overhead.
fn calculate_disk_size(source: &Path, reserve_bytes: u64) -> u64 {
    disk_size_with_overhead(
        calculate_dir_size(source).unwrap_or(DEFAULT_DIR_SIZE_BYTES),
        reserve_bytes,
    )
}

/// Apply ext4 overhead to a measured tree size and clamp to the minimum image.
///
/// Split from [`calculate_disk_size`] so the unprivileged path — which measures
/// the tree during its own single scan — shares one definition of the sizing
/// policy instead of restating the arithmetic.
///
/// `reserve_bytes` is extra room for content the *caller* adds to the image
/// after it is built (e.g. `GuestRootfsManager` injects the `boxlite-guest`
/// binary into a copy of this image once it exists — an unstripped debug
/// build runs ~231 MiB, well over the free space a floor-sized image
/// otherwise has). Added once, verbatim, after the tree-size overhead
/// multiplier: it's an exact byte count, not an estimate that needs the same
/// safety margin as the measured tree.
fn disk_size_with_overhead(dir_size: u64, reserve_bytes: u64) -> u64 {
    // ext4 overhead:
    // - Metadata (superblock, block groups, inode tables): ~1-5%
    // - Journal: 64MB
    // - We set reserved blocks to 0% via mke2fs
    // Use 1.1x multiplier (10% overhead) plus 64MB for journal
    // Testing showed ~0.5% overhead needed, 10% provides safety margin
    let size_with_overhead = dir_size * SIZE_MULTIPLIER_NUM / SIZE_MULTIPLIER_DEN
        + JOURNAL_OVERHEAD_BYTES
        + reserve_bytes;

    // Minimum 256MB for small images
    let final_size = size_with_overhead.max(MIN_DISK_SIZE_BYTES);

    tracing::debug!(
        "Calculated disk size: dir_size={}MB, reserve={}MB, with_overhead={}MB, final={}MB",
        dir_size / (1024 * 1024),
        reserve_bytes / (1024 * 1024),
        size_with_overhead / (1024 * 1024),
        final_size / (1024 * 1024)
    );

    final_size
}

/// A source entry whose owner-permission bits were temporarily widened so
/// `mke2fs -d` could read it, with everything needed to restore the original.
struct WidenedPerm {
    /// Absolute path inside the ext4 image, e.g. `/etc/gshadow`.
    ext4_path: String,
    /// Path on the host source tree (to restore the source mode afterward).
    source_path: PathBuf,
    /// Original full `st_mode` (incl. the `S_IFMT` type bits) for `sif … mode`.
    mode: u32,
}

/// The ownership one inode must carry inside the image.
struct InodeOwner {
    /// Absolute path inside the ext4 image, e.g. `/var/dex`.
    ext4_path: String,
    uid: u32,
    gid: u32,
}

/// Everything the unprivileged build needs from the source tree, gathered in a
/// single pass: the size estimate and the ownership to stamp into each inode.
struct SourceScan {
    /// Per-inode ownership for the debugfs pass. The source root is excluded —
    /// `mke2fs -E root_owner=0:0` already sets the image's root inode.
    owners: Vec<InodeOwner>,
    /// Entries with no readable `override_stat` record, which default to 0:0.
    unrecorded: usize,
    total_blocks: u64,
    entry_count: u64,
}

impl SourceScan {
    /// Bytes the tree occupies on ext4 before overhead: block storage plus one
    /// inode per entry. Feed to [`disk_size_with_overhead`].
    fn dir_size(&self) -> u64 {
        self.total_blocks * BLOCK_SIZE + self.entry_count * INODE_SIZE
    }

    fn account(&mut self, meta: &std::fs::Metadata) {
        self.entry_count += 1;
        if meta.is_file() {
            // Each file needs at least one block, round up
            self.total_blocks += meta.len().div_ceil(BLOCK_SIZE).max(1);
        } else if meta.is_dir() {
            // Directories need at least one block
            self.total_blocks += 1;
        }
    }

    /// Record the ownership `path` must end up with inside the image.
    ///
    /// Unprivileged extraction cannot `chown`, so `LayerExtractor` parks the tar
    /// header's uid/gid in the `override_stat` xattr and `mke2fs -d` records the
    /// *host* uid instead. Entries with no record — the guest rootfs, injected
    /// binaries — stay 0:0, which is what those paths require.
    ///
    /// A *present-but-malformed* record is different: it is the only copy of
    /// that file's real ownership, so it must abort the build rather than
    /// silently default to 0:0 like a genuinely absent one — see
    /// `OverrideStat::read_xattr`'s doc comment for why `Ok(None)` and `Err`
    /// are deliberately distinct.
    fn record_owner(&mut self, source_root: &Path, path: &Path) -> BoxliteResult<()> {
        let rel = path.strip_prefix(source_root).unwrap_or(path);
        if rel.as_os_str().is_empty() {
            return Ok(()); // the source root maps to the image root
        }

        let (uid, gid) = match OverrideStat::read_xattr(path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read ownership xattr on {}: {}",
                path.display(),
                e
            ))
        })? {
            Some(stat) => (stat.uid, stat.gid),
            None => {
                self.unrecorded += 1;
                (0, 0)
            }
        };

        self.owners.push(InodeOwner {
            // Absolute path in ext4 (starting with /)
            ext4_path: format!("/{}", rel.display()),
            uid,
            gid,
        });
        Ok(())
    }
}

/// Walk the source tree once, temporarily granting the owner read (and search,
/// for directories) on entries the unprivileged owner cannot otherwise read, and
/// gathering the size estimate and declared ownership along the way.
///
/// e2fsprogs opens every source file as the calling user; a `0000` file (e.g.
/// `/etc/gshadow` in RHEL UBI images) is denied because POSIX consults only the
/// owner-class bits, which have no read bit. `chmod` is authorized by *ownership*
/// (not the read bit), and unprivileged OCI extraction leaves every file owned by
/// the current user, so the widen always succeeds. Each widened entry's original
/// mode is appended to `widened` so the caller can restore it — both on the source
/// tree and, authoritatively, inside the image via debugfs: `mke2fs` records the
/// *widened* mode, so the image must be corrected afterward.
///
/// Sizing and the ownership read are fused into this walk rather than run as
/// their own traversals because the ordering is load-bearing: both need the same
/// owner-read bit `mke2fs` needs, so both must follow the widen *for that entry*
/// — which one pass guarantees by construction.
///
/// Entries are appended as they are mutated, so a partial failure still leaves the
/// caller's guard owning every already-widened entry. Walks top-down: a `0000`
/// directory cannot be listed until its own owner read+search bits are restored,
/// so each directory is widened before descent.
fn scan_source_tree(source: &Path, widened: &mut Vec<WidenedPerm>) -> BoxliteResult<SourceScan> {
    let mut scan = SourceScan {
        owners: Vec::new(),
        unrecorded: 0,
        total_blocks: 0,
        entry_count: 0,
    };
    scan_dir_recursive(source, source, &mut scan, widened)?;
    Ok(scan)
}

fn scan_dir_recursive(
    source_root: &Path,
    dir: &Path,
    scan: &mut SourceScan,
    widened: &mut Vec<WidenedPerm>,
) -> BoxliteResult<()> {
    use std::os::unix::fs::MetadataExt;

    // A directory needs owner read+search (0o500) before we can list it, read its
    // xattr, or descend.
    let dir_meta = std::fs::symlink_metadata(dir)
        .map_err(|e| BoxliteError::Storage(format!("Failed to stat {}: {}", dir.display(), e)))?;
    let dir_mode = dir_meta.mode();
    if dir_mode & 0o500 != 0o500 {
        record_and_widen(source_root, dir, dir_mode, dir_mode | 0o500, widened)?;
    }
    scan.account(&dir_meta);
    scan.record_owner(source_root, dir)?;

    let entries = std::fs::read_dir(dir).map_err(|e| {
        BoxliteError::Storage(format!("Failed to read dir {}: {}", dir.display(), e))
    })?;
    for entry in entries {
        let path = entry
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to read entry in {}: {}", dir.display(), e))
            })?
            .path();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| {
            BoxliteError::Storage(format!("Failed to stat {}: {}", path.display(), e))
        })?;
        let file_type = meta.file_type();
        if file_type.is_dir() {
            scan_dir_recursive(source_root, &path, scan, widened)?;
            continue;
        }
        // Symlink perms are irrelevant; readlink needs no read bit, so symlinks
        // are never widened — but they still occupy an inode and carry ownership.
        if file_type.is_file() && meta.mode() & 0o400 == 0 {
            record_and_widen(
                source_root,
                &path,
                meta.mode(),
                meta.mode() | 0o400,
                widened,
            )?;
        }
        scan.account(&meta);
        scan.record_owner(source_root, &path)?;
    }
    Ok(())
}

fn record_and_widen(
    source_root: &Path,
    path: &Path,
    orig_mode: u32,
    new_mode: u32,
    widened: &mut Vec<WidenedPerm>,
) -> BoxliteResult<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(new_mode & 0o7777)).map_err(
        |e| {
            BoxliteError::Storage(format!(
                "Failed to grant owner read on {} (mode {:04o}); is it owned by the current user? {}",
                path.display(),
                orig_mode & 0o7777,
                e
            ))
        },
    )?;
    let rel = path.strip_prefix(source_root).unwrap_or(path);
    widened.push(WidenedPerm {
        ext4_path: format!("/{}", rel.display()),
        source_path: path.to_path_buf(),
        mode: orig_mode,
    });
    Ok(())
}

/// Owns the source entries whose owner bits were temporarily widened for
/// `mke2fs` and restores them on drop — so the source tree is cleaned up on
/// every exit path, including the early returns when `mke2fs` or the debugfs
/// pass fails, not just the happy path.
///
/// Restores **bottom-up** (children before parents): entries are recorded
/// top-down, so restoring a `0000` directory before its children would make the
/// child `set_permissions` fail with EACCES and leave it widened. The image
/// already holds the authoritative modes via debugfs, so a failed source
/// restore is logged, not fatal.
struct SourceModeGuard {
    widened: Vec<WidenedPerm>,
}

impl Drop for SourceModeGuard {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;

        for w in self.widened.iter().rev() {
            if let Err(e) = std::fs::set_permissions(
                &w.source_path,
                std::fs::Permissions::from_mode(w.mode & 0o7777),
            ) {
                tracing::warn!(
                    "Failed to restore source mode on {}: {}",
                    w.source_path.display(),
                    e
                );
            }
        }
    }
}

/// Create an ext4 disk image from a directory using mke2fs.
///
/// This uses the `mke2fs -d` option to populate the filesystem directly
/// from a source directory, which is much simpler than using libext2fs.
///
/// Size is automatically calculated based on directory contents with
/// appropriate overhead for ext4 metadata, journal, and reserved blocks, plus
/// `reserve_bytes` of extra headroom for whatever the caller injects into the
/// image afterward (0 when nothing will be).
///
/// Returns a non-persistent Disk (will be cleaned up on drop).
pub fn create_ext4_from_dir(
    source: &Path,
    output_path: &Path,
    reserve_bytes: u64,
) -> BoxliteResult<Disk> {
    let output_str = output_path.to_str().ok_or_else(|| {
        BoxliteError::Storage(format!("Invalid output path: {}", output_path.display()))
    })?;

    let source_str = source.to_str().ok_or_else(|| {
        BoxliteError::Storage(format!("Invalid source path: {}", source.display()))
    })?;

    // `mke2fs -d` opens every source file as the current user. When unprivileged,
    // an unreadable file (mode 0000, e.g. /etc/gshadow in RHEL UBI images) is
    // denied, aborting the build. One scan widens owner-read on such entries and
    // collects the size and declared ownership as it goes; the guard restores the
    // source modes on every exit path (drop), and the original modes are written
    // back into the image via debugfs below. As root the read bit is bypassed and
    // `mke2fs -d` applies real ownership, so neither is needed.
    let mut source_modes = SourceModeGuard {
        widened: Vec::new(),
    };
    let scan = if unsafe { libc::geteuid() } != 0 {
        Some(scan_source_tree(source, &mut source_modes.widened)?)
    } else {
        None
    };

    // The scan measured each entry right after widening it. Sizing from a
    // separate walk would miss a `0000` directory, and `calculate_disk_size`
    // swallows that failure by falling back to a fixed default — discarding the
    // measurement for the whole tree, not just the unreadable subtree, and
    // under-sizing the image for `mke2fs`.
    let size_bytes = match &scan {
        Some(scan) => disk_size_with_overhead(scan.dir_size(), reserve_bytes),
        None => calculate_disk_size(source, reserve_bytes),
    };

    // With -b 4096, mke2fs expects size in 4KB blocks
    let size_blocks = size_bytes / 4096;

    let mke2fs = get_mke2fs_path();

    // Use mke2fs with -d to populate from directory
    // https://man7.org/linux/man-pages/man8/mke2fs.8.html
    // -t ext4: create ext4 filesystem
    // -d dir: populate from directory
    // -m 0: no reserved blocks (default 5% is wasted for containers)
    // -E root_owner=0:0: set root ownership (important for containers)
    let output = Command::new(&mke2fs)
        .args([
            "-t",
            "ext4",
            "-b",
            "4096", // 4KB block size (explicit)
            "-d",
            source_str,
            "-m",
            "0",
            "-E",
            "root_owner=0:0",
            "-F", // Force, don't ask questions
            "-q", // Quiet
            output_str,
            &size_blocks.to_string(),
        ])
        .output()
        .map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to run mke2fs ({}): {}",
                mke2fs.display(),
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(BoxliteError::Storage(format!(
            "mke2fs failed with exit code {:?}: {}",
            output.status.code(),
            stderr
        )));
    }

    // Apply the ownership and modes gathered by the scan. Rootless only: as root
    // `mke2fs -d` already wrote real ownership and nothing was widened.
    if let Some(scan) = &scan {
        normalize_inodes_with_debugfs(output_path, scan, &source_modes.widened)?;
    }

    let disk = Disk::new(output_path.to_path_buf(), DiskFormat::Ext4, false);
    // `source_modes` drops here, restoring the widened source entries bottom-up.
    Ok(disk)
}

/// Check a `debugfs -w -f -` batch-script invocation actually succeeded,
/// including per-command failures the process exit code alone can't see.
///
/// `debugfs -f -` logs a per-command failure (e.g. `sif` on a path it can't
/// resolve, or `write` on a source file that vanished — both via `com_err`) to
/// the same stderr stream as its one-line startup banner, then continues to
/// the next command rather than aborting. So a clean exit code isn't proof
/// every command landed; anything beyond that first banner line means a
/// command failed silently. `what` names the operation for the error message
/// (e.g. `"normalizing {path}"`, `"injecting {src} -> {dst}"`).
fn check_debugfs_output(what: &str, output: &std::process::Output) -> BoxliteResult<()> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(BoxliteError::Storage(format!(
            "debugfs failed (exit {:?}) while {}: {}",
            output.status.code(),
            what,
            stderr
        )));
    }

    let after_banner = match output.stderr.iter().position(|&b| b == b'\n') {
        Some(newline) => &output.stderr[newline + 1..],
        None => &output.stderr[..],
    };
    if !after_banner.is_empty() {
        return Err(BoxliteError::Storage(format!(
            "debugfs reported unexpected output while {}: {}",
            what,
            String::from_utf8_lossy(after_banner)
        )));
    }

    Ok(())
}

/// Normalize inode metadata in the ext4 image via debugfs: give every file the
/// ownership its layer declared (0:0 when none was recorded), and restore the
/// original mode on any entry whose owner-read bit was temporarily widened so
/// `mke2fs` could read it.
///
/// `mke2fs -d` records the *host* uid/gid and the *widened* (readable) mode — and
/// `-E root_owner=0:0` only fixes the root inode — so both are corrected here.
fn normalize_inodes_with_debugfs(
    image_path: &Path,
    scan: &SourceScan,
    widened: &[WidenedPerm],
) -> BoxliteResult<()> {
    // Skip if already running as root - mke2fs creates files with current uid/gid
    // and reads unreadable files directly, so nothing was widened.
    let current_uid = unsafe { libc::getuid() };
    let current_gid = unsafe { libc::getgid() };
    if current_uid == 0 && current_gid == 0 {
        tracing::debug!("Running as root, skipping debugfs inode normalization");
        return Ok(());
    }

    let start = std::time::Instant::now();
    let owners = &scan.owners;

    if owners.is_empty() && widened.is_empty() {
        tracing::debug!("No inodes to normalize");
        return Ok(());
    }

    // Build debugfs commands to set the owning uid/gid for each file
    // Using sif (set inode field) command: sif <path> <field> <value>
    let mut commands = String::new();
    for owner in owners {
        // sif sets inode field by path
        commands.push_str(&format!("sif {} uid {}\n", owner.ext4_path, owner.uid));
        commands.push_str(&format!("sif {} gid {}\n", owner.ext4_path, owner.gid));
    }
    // Restore the original mode on entries we widened for mke2fs. The value is
    // the full st_mode incl. type bits (e.g. a 0000 regular file -> 0100000),
    // matching the `sif … mode 0100555` form used by inject_file_into_ext4.
    for w in widened {
        commands.push_str(&format!("sif {} mode 0{:o}\n", w.ext4_path, w.mode));
    }

    let debugfs = get_debugfs_path();

    // Run debugfs with commands via stdin
    let mut child = Command::new(&debugfs)
        .args(["-w", "-f", "-"])
        .arg(image_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| BoxliteError::Storage(format!("Failed to spawn debugfs: {}", e)))?;

    // Write commands to stdin
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(commands.as_bytes()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to write to debugfs stdin: {}", e))
        })?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| BoxliteError::Storage(format!("Failed to wait for debugfs: {}", e)))?;

    let duration = start.elapsed();

    // This is the only pass that writes the original 0000 modes back into the
    // image, so a failure must abort the build rather than yield an image with
    // wrong inode metadata.
    check_debugfs_output(&format!("normalizing {}", image_path.display()), &output)?;

    tracing::info!(
        "Normalized {} inodes ({} without recorded ownership → 0:0, {} mode-restored) in {:?}",
        owners.len(),
        scan.unrecorded,
        widened.len(),
        duration
    );

    Ok(())
}

/// Inject a host file into an ext4 disk image using debugfs.
///
/// Creates parent directories as needed within the ext4 image,
/// writes the file, and sets ownership to root (0:0) with mode 0555.
///
/// # Arguments
/// * `image_path` - Path to the ext4 disk image file
/// * `host_file` - Path to the file on the host to inject
/// * `guest_path` - Destination path inside the ext4 image (e.g. "boxlite/bin/boxlite-guest")
pub fn inject_file_into_ext4(
    image_path: &Path,
    host_file: &Path,
    guest_path: &str,
) -> BoxliteResult<()> {
    let host_file_str = host_file.to_str().ok_or_else(|| {
        BoxliteError::Storage(format!("Invalid host file path: {}", host_file.display()))
    })?;

    let commands = build_inject_commands(host_file_str, guest_path);

    let debugfs = get_debugfs_path();

    let mut child = Command::new(&debugfs)
        .args(["-w", "-f", "-"])
        .arg(image_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            BoxliteError::Storage(format!("Failed to spawn debugfs for injection: {}", e))
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(commands.as_bytes()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to write to debugfs stdin: {}", e))
        })?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| BoxliteError::Storage(format!("Failed to wait for debugfs: {}", e)))?;

    check_debugfs_output(
        &format!("injecting {} -> {}", host_file.display(), guest_path),
        &output,
    )?;

    tracing::debug!(
        "Injected {} into ext4 image at /{}",
        host_file.display(),
        guest_path
    );

    Ok(())
}

/// Build debugfs commands for injecting a file into an ext4 image.
///
/// Creates parent directories, writes the file, and sets ownership/mode.
/// Separated from `inject_file_into_ext4` for testability.
fn build_inject_commands(host_file_str: &str, guest_path: &str) -> String {
    let mut commands = String::new();

    // Create parent directories
    let guest_path_obj = Path::new(guest_path);
    let mut current = PathBuf::new();
    if let Some(parent) = guest_path_obj.parent() {
        for component in parent.components() {
            current.push(component);
            commands.push_str(&format!("mkdir /{}\n", current.display()));
        }
    }

    // Write host file into ext4 image (quote source path for spaces, e.g. macOS "Application Support")
    let ext4_dest = format!("/{}", guest_path);
    commands.push_str(&format!("write \"{}\" {}\n", host_file_str, ext4_dest));

    // Set ownership (uid=0, gid=0) and mode (0555 = r-xr-xr-x)
    commands.push_str(&format!("sif {} uid 0\n", ext4_dest));
    commands.push_str(&format!("sif {} gid 0\n", ext4_dest));
    commands.push_str(&format!("sif {} mode 0100555\n", ext4_dest));

    // Set ownership on parent directories too
    let mut current = PathBuf::new();
    if let Some(parent) = guest_path_obj.parent() {
        for component in parent.components() {
            current.push(component);
            let dir_path = format!("/{}", current.display());
            commands.push_str(&format!("sif {} uid 0\n", dir_path));
            commands.push_str(&format!("sif {} gid 0\n", dir_path));
        }
    }

    commands
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `sif` command targeting a path debugfs cannot resolve makes the whole
    /// batch script exit 0 — e2fsprogs's `-f -` mode logs the failure via
    /// `com_err` to the same stderr stream as the one-line startup banner, and
    /// moves on to the next command rather than aborting. The doc comment on
    /// `normalize_inodes_with_debugfs` states "a failure must abort the build",
    /// but checking only `output.status.success()` cannot see this class of
    /// failure at all.
    ///
    /// Verified empirically before writing this test: 20 failing `sif` commands
    /// against a real image still produced `exit=0`, with each failure adding a
    /// `"<path>: File not found by ext2_lookup"` line to stderr, after the fixed
    /// one-line banner.
    #[test]
    fn normalize_inodes_with_debugfs_fails_on_unresolvable_path() {
        if util::find_binary("mke2fs").is_err() || util::find_binary("debugfs").is_err() {
            eprintln!("skipping: mke2fs/debugfs not found (run `make runtime:debug`)");
            return;
        }
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipping: root skips debugfs normalization entirely");
            return;
        }

        let src_root = tempfile::tempdir().expect("source tempdir");
        let src = src_root.path().join("rootfs");
        std::fs::create_dir_all(&src).expect("mkdir rootfs");
        std::fs::write(src.join("real"), b"x").expect("write real");

        let out_root = tempfile::tempdir().expect("output tempdir");
        let out = out_root.path().join("rootfs.ext4");
        let _disk = create_ext4_from_dir(&src, &out, 0).expect("ext4 build must succeed");

        // A path that does not exist in the image just built.
        let scan = SourceScan {
            owners: vec![InodeOwner {
                ext4_path: "/does-not-exist".to_string(),
                uid: 1001,
                gid: 1001,
            }],
            unrecorded: 0,
            total_blocks: 0,
            entry_count: 0,
        };

        let result = normalize_inodes_with_debugfs(&out, &scan, &[]);
        assert!(
            result.is_err(),
            "an unresolvable sif target must fail the build, not silently succeed \
             with the image left partially unnormalized"
        );
    }

    /// A tree larger than `MIN_DISK_SIZE_BYTES` must still build when it
    /// contains an unreadable (mode `0000`) directory.
    ///
    /// `calculate_disk_size` ran *before* `widen_unreadable_owner`, so `WalkDir`
    /// could not list the `0000` directory and `calculate_dir_size` failed.
    /// `calculate_disk_size` swallows that with `.unwrap_or(DEFAULT_DIR_SIZE_BYTES)`
    /// (`:65`), discarding the measurement for the *entire* tree — not just the
    /// unreadable subtree — and clamping to the 256 MiB floor. `mke2fs` is then
    /// handed a filesystem too small for the content it is told to copy in.
    ///
    /// Sparse source files keep setup cheap; `calculate_dir_size` measures
    /// `metadata.len()`, and `mke2fs -d` still has to place every byte.
    ///
    /// Skipped without e2fsprogs, or as root (root can list a `0000` directory,
    /// so the mis-sizing never occurs).
    #[test]
    fn create_ext4_sizes_tree_containing_unreadable_dir() {
        use std::os::unix::fs::PermissionsExt;

        if util::find_binary("mke2fs").is_err() || util::find_binary("debugfs").is_err() {
            eprintln!("skipping: mke2fs/debugfs not found (run `make runtime:debug`)");
            return;
        }
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipping: root can list a 0000 directory, so the bug cannot reproduce");
            return;
        }

        // Enough content that a correct size must exceed MIN_DISK_SIZE_BYTES.
        let root = tempfile::tempdir().expect("tempdir");
        let src = root.path().join("rootfs");
        let data = src.join("data");
        std::fs::create_dir_all(&data).expect("mkdir data");
        for i in 0..200 {
            let f = std::fs::File::create(data.join(format!("blob{i}"))).expect("create blob");
            f.set_len(1024 * 1024).expect("size blob"); // sparse 1 MiB
        }

        let secret = src.join("secret");
        std::fs::create_dir_all(&secret).expect("mkdir secret");
        std::fs::write(secret.join("locked"), b"x").expect("write locked");
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000))
            .expect("chmod 0000 secret");

        let out_root = tempfile::tempdir().expect("output tempdir");
        let out = out_root.path().join("rootfs.ext4");
        let built = create_ext4_from_dir(&src, &out, 0);

        // Restore before asserting so TempDir::drop can always recurse.
        let _ = std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o755));

        let _disk = built
            .expect("ext4 build must size the image from the real tree, not the fallback default");
        let image_len = std::fs::metadata(&out).expect("stat image").len();
        assert!(
            image_len > MIN_DISK_SIZE_BYTES,
            "image must be sized from the ~200 MiB tree, not clamped to the {} MiB floor (got {} MiB)",
            MIN_DISK_SIZE_BYTES / (1024 * 1024),
            image_len / (1024 * 1024)
        );
    }

    /// Regression: building an ext4 image from a tree containing an unreadable
    /// (mode `0000`) file — e.g. `/etc/gshadow` in RHEL UBI images — must
    /// succeed when running unprivileged, and the image must still record the
    /// original `0000` mode and full content.
    ///
    /// Pre-fix, `mke2fs -d` aborts because the unprivileged owner cannot
    /// `open(O_RDONLY)` a `0000` file it owns (POSIX consults only the
    /// owner-class bits): `while opening "gshadow" to copy`.
    ///
    /// Skipped (not failed) when the e2fsprogs binaries aren't assembled, so a
    /// bare checkout without `make runtime:debug` doesn't spuriously fail.
    #[test]
    fn create_ext4_preserves_unreadable_file_mode() {
        use std::os::unix::fs::PermissionsExt;

        if util::find_binary("mke2fs").is_err() || util::find_binary("debugfs").is_err() {
            eprintln!(
                "skipping create_ext4_preserves_unreadable_file_mode: mke2fs/debugfs not found (run `make runtime:debug`)"
            );
            return;
        }
        // As root the owner-read bit is bypassed, so the bug can't reproduce and
        // this test would pass vacuously — skip rather than assert nothing.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!(
                "skipping create_ext4_preserves_unreadable_file_mode: must run unprivileged to exercise the DAC read check"
            );
            return;
        }

        let src_root = tempfile::tempdir().expect("create source tempdir");
        let src = src_root.path().join("rootfs");
        std::fs::create_dir_all(src.join("etc")).expect("create etc/");
        let gshadow = src.join("etc/gshadow");
        let content = b"root:::\n";
        std::fs::write(&gshadow, content).expect("write gshadow");
        std::fs::set_permissions(&gshadow, std::fs::Permissions::from_mode(0o000))
            .expect("chmod 0000 gshadow");

        let out_root = tempfile::tempdir().expect("create output tempdir");
        let out = out_root.path().join("rootfs.ext4");

        // Pre-fix this returns Err (mke2fs aborts on the 0000 file). Bind the
        // returned Disk: it is non-persistent and deletes the image on drop.
        let _disk = create_ext4_from_dir(&src, &out, 0)
            .expect("ext4 build must tolerate a 0000-mode source file");

        // The image must carry the ORIGINAL 0000 mode (data crosses the
        // mke2fs+debugfs boundary — not asserted from the test body).
        let debugfs = get_debugfs_path();
        let stat = Command::new(&debugfs)
            .args(["-R", "stat /etc/gshadow"])
            .arg(&out)
            .output()
            .expect("run debugfs stat");
        assert!(
            stat.status.success(),
            "debugfs stat failed: {}",
            String::from_utf8_lossy(&stat.stderr)
        );
        let stat_out = String::from_utf8_lossy(&stat.stdout);
        let tokens: Vec<&str> = stat_out.split_whitespace().collect();
        let mode = tokens
            .iter()
            .position(|t| *t == "Mode:")
            .and_then(|i| tokens.get(i + 1))
            .copied()
            .unwrap_or_else(|| panic!("no Mode field in debugfs stat:\n{stat_out}"));
        assert_eq!(
            mode, "0000",
            "gshadow mode must stay 0000 in image:\n{stat_out}"
        );

        // Content must be intact (read back out of the image).
        let cat = Command::new(&debugfs)
            .args(["-R", "cat /etc/gshadow"])
            .arg(&out)
            .output()
            .expect("run debugfs cat");
        assert!(
            cat.status.success(),
            "debugfs cat failed: {}",
            String::from_utf8_lossy(&cat.stderr)
        );
        assert_eq!(
            cat.stdout, content,
            "gshadow content must be preserved in image"
        );
    }

    /// Regression: after a successful build, the source tree must be restored to
    /// its original modes — including a `0000` file nested under a `0000`
    /// directory. The restore must run bottom-up: restoring the parent dir to
    /// `0000` first makes the child `set_permissions` fail with EACCES, leaving
    /// the child widened (readable). This walks through the public API so the
    /// same test holds before and after the fix.
    ///
    /// Skipped when e2fsprogs is absent or running as root (no widen happens).
    #[test]
    fn create_ext4_restores_nested_unreadable_source_modes() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        if util::find_binary("mke2fs").is_err() || util::find_binary("debugfs").is_err() {
            eprintln!("skipping: mke2fs/debugfs not found (run `make runtime:debug`)");
            return;
        }
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipping: must run unprivileged (root skips the widen)");
            return;
        }

        let src_root = tempfile::tempdir().expect("source tempdir");
        let src = src_root.path().join("rootfs");
        let secret = src.join("etc/secret");
        std::fs::create_dir_all(&secret).expect("mkdir tree");
        let locked = secret.join("locked");
        std::fs::write(&locked, b"x").expect("write locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000))
            .expect("chmod 0000 file");
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000))
            .expect("chmod 0000 dir");

        let out_root = tempfile::tempdir().expect("output tempdir");
        let out = out_root.path().join("rootfs.ext4");
        let _disk = create_ext4_from_dir(&src, &out, 0).expect("ext4 build must succeed");

        // The dir restores fine even with the bug (it's restored first).
        assert_eq!(
            std::fs::symlink_metadata(&secret).unwrap().mode() & 0o7777,
            0o000,
            "source dir mode must be restored to 0000"
        );
        // Re-grant search on the parent (we own it) only to inspect the child;
        // this does not change the child's own mode.
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            std::fs::symlink_metadata(&locked).unwrap().mode() & 0o7777,
            0o000,
            "source file under a 0000 dir must be restored to 0000 (bottom-up restore)"
        );
    }

    /// Read `User:`/`Group:` for an in-image path out of `debugfs stat`.
    fn image_owner(image: &Path, ext4_path: &str) -> (String, String) {
        let debugfs = get_debugfs_path();
        let stat = Command::new(&debugfs)
            .args(["-R", &format!("stat {}", ext4_path)])
            .arg(image)
            .output()
            .expect("run debugfs stat");
        assert!(
            stat.status.success(),
            "debugfs stat {} failed: {}",
            ext4_path,
            String::from_utf8_lossy(&stat.stderr)
        );
        let out = String::from_utf8_lossy(&stat.stdout);
        let tokens: Vec<&str> = out.split_whitespace().collect();
        let field = |name: &str| {
            tokens
                .iter()
                .position(|t| *t == name)
                .and_then(|i| tokens.get(i + 1))
                .copied()
                .unwrap_or_else(|| panic!("no {name} field in debugfs stat {ext4_path}:\n{out}"))
                .to_string()
        };
        (field("User:"), field("Group:"))
    }

    /// The image must carry the ownership the *layer* declared, not a blanket
    /// `0:0`.
    ///
    /// Unprivileged extraction cannot `chown`, so `LayerExtractor` parks the tar
    /// header's uid/gid in `user.containers.override_stat`. `mke2fs -d` then
    /// stamps the *host* uid on every inode, and this module's debugfs pass
    /// rewrote every inode to `0:0` — so an image whose non-root `USER` depends
    /// on a layer-chowned directory (dexidp/dex's `/var/dex`, 1001:1001) got it
    /// `root:root` and could not create its database there.
    ///
    /// Entries with no recorded ownership must still land `0:0`, which is what
    /// keeps the guest-rootfs and injected-binary paths correct.
    ///
    /// Skipped when e2fsprogs is absent or running as root (as root the
    /// extractor `lchown`s for real, so the xattr path never runs).
    #[test]
    fn create_ext4_applies_override_stat_ownership() {
        use crate::images::{OverrideFileType, OverrideStat};

        if util::find_binary("mke2fs").is_err() || util::find_binary("debugfs").is_err() {
            eprintln!("skipping: mke2fs/debugfs not found (run `make runtime:debug`)");
            return;
        }
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipping: must run unprivileged (as root ownership is applied directly)");
            return;
        }

        let src_root = tempfile::tempdir().expect("source tempdir");
        let src = src_root.path().join("rootfs");
        let dex_dir = src.join("var/dex");
        std::fs::create_dir_all(&dex_dir).expect("mkdir var/dex");
        let dex_file = dex_dir.join("keep");
        std::fs::write(&dex_file, b"x").expect("write keep");
        std::fs::create_dir_all(src.join("etc")).expect("mkdir etc");
        std::fs::write(src.join("etc/passwd"), b"root:x:0:0\n").expect("write passwd");

        // Encode through the production writer, exactly as the extractor does.
        OverrideStat::new(1001, 1001, 0o755, OverrideFileType::Dir)
            .write_xattr(&dex_dir)
            .expect("write override_stat on var/dex");
        OverrideStat::new(1001, 1001, 0o644, OverrideFileType::File)
            .write_xattr(&dex_file)
            .expect("write override_stat on var/dex/keep");

        let out_root = tempfile::tempdir().expect("output tempdir");
        let out = out_root.path().join("rootfs.ext4");
        let _disk = create_ext4_from_dir(&src, &out, 0).expect("ext4 build must succeed");

        assert_eq!(
            image_owner(&out, "/var/dex"),
            ("1001".to_string(), "1001".to_string()),
            "a layer-chowned directory must keep its declared ownership in the image"
        );
        assert_eq!(
            image_owner(&out, "/var/dex/keep"),
            ("1001".to_string(), "1001".to_string()),
            "a layer-chowned file must keep its declared ownership in the image"
        );
        assert_eq!(
            image_owner(&out, "/etc/passwd"),
            ("0".to_string(), "0".to_string()),
            "an entry with no recorded ownership must still normalize to 0:0"
        );
    }

    /// A malformed `override_stat` xattr must abort the scan, not silently
    /// default to 0:0.
    ///
    /// `OverrideStat::read_xattr` distinguishes a genuinely absent xattr
    /// (`Ok(None)`, correctly defaults to 0:0) from a present-but-unparseable
    /// one (`Err`) — but `record_owner` treated both the same, logging a
    /// warning and defaulting to 0:0 either way. Unprivileged extraction
    /// can't `chown`, so a layer-declared xattr is the *only* copy of that
    /// file's real ownership; silently discarding a corrupt one is exactly
    /// the silent-failure class this file's `check_debugfs_output` already
    /// guards against one layer down — the scan itself must not repeat it.
    #[test]
    fn scan_source_tree_fails_on_malformed_override_stat() {
        // Matches OverrideStat::CONTAINERS_OVERRIDE_XATTR (private to
        // images::archive::override_stat) — the containers/storage xattr name,
        // not expected to ever change.
        const CONTAINERS_OVERRIDE_XATTR: &str = "user.containers.override_stat";

        let root = tempfile::tempdir().expect("tempdir");
        let src = root.path().join("rootfs");
        std::fs::create_dir_all(&src).expect("mkdir rootfs");
        let f = src.join("file");
        std::fs::write(&f, b"x").expect("write file");
        xattr::set(&f, CONTAINERS_OVERRIDE_XATTR, b"not-a-valid-record")
            .expect("seed malformed xattr");

        let mut widened = Vec::new();
        let result = scan_source_tree(&src, &mut widened);
        assert!(
            result.is_err(),
            "a malformed override_stat xattr is the only copy of a layer's \
             declared ownership; the scan must fail, not silently default to 0:0"
        );
    }

    /// The scan's size accounting must match the standalone `WalkDir` walk it
    /// replaced, entry for entry.
    ///
    /// `calculate_dir_size` still serves the root path, so the two must not
    /// drift: a silent divergence here resizes every image built unprivileged.
    /// Uses a fully readable tree so both can measure the same thing, and covers
    /// the entry kinds whose accounting differs (file blocks vs. directory block
    /// vs. symlink, which occupies an inode but no block).
    #[test]
    fn scan_source_tree_size_matches_standalone_walk() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("tempdir");
        let src = root.path().join("rootfs");
        std::fs::create_dir_all(src.join("etc/nested")).expect("mkdir tree");
        std::fs::write(src.join("etc/small"), b"x").expect("write small");
        std::fs::write(src.join("etc/nested/empty"), b"").expect("write empty");
        // Spans several blocks, so rounding differences would show up.
        std::fs::write(src.join("etc/nested/big"), vec![0u8; 9000]).expect("write big");
        symlink("small", src.join("etc/link")).expect("symlink");

        let mut widened = Vec::new();
        let scan = scan_source_tree(&src, &mut widened).expect("scan must succeed");
        assert!(widened.is_empty(), "nothing to widen in a readable tree");

        assert_eq!(
            scan.dir_size(),
            calculate_dir_size(&src).expect("standalone walk must succeed"),
            "merged scan must measure the tree exactly as the walk it replaced"
        );
    }

    /// The scan must handle a `0000` directory: it can't be listed until its own
    /// owner read+search bits are restored, so the walk has to widen it before
    /// descending. Records must carry the original full modes (incl. type bits)
    /// and the in-image paths.
    ///
    /// The same pass also has to *measure* and *record ownership for* entries it
    /// just widened — the whole reason sizing, ownership and widening share one
    /// traversal — so those outputs are asserted here too. No e2fsprogs binaries
    /// needed.
    #[test]
    fn scan_source_tree_widens_and_measures_zero_mode_dir_and_file() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let root = tempfile::tempdir().expect("tempdir");
        let src = root.path().join("rootfs");
        let secret_dir = src.join("etc/secret");
        std::fs::create_dir_all(&secret_dir).expect("mkdir tree");
        let locked = secret_dir.join("locked");
        std::fs::write(&locked, b"x").expect("write locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000))
            .expect("chmod 0000 file");
        // 0000 dir — un-listable until widened.
        std::fs::set_permissions(&secret_dir, std::fs::Permissions::from_mode(0o000))
            .expect("chmod 0000 dir");

        let mut widened = Vec::new();
        let scan = scan_source_tree(&src, &mut widened).expect("scan must succeed as owner");

        // Content under the 0000 directory is reached, so it is measured: root,
        // etc, etc/secret, etc/secret/locked.
        assert_eq!(
            scan.entry_count, 4,
            "every entry counted, including the root"
        );
        assert!(
            scan.dir_size() > 0,
            "a tree reached through a 0000 dir must measure non-zero"
        );

        // Ownership is recorded for the widened entries, and the source root is
        // excluded (mke2fs -E root_owner=0:0 owns the image root).
        let owned: Vec<&str> = scan.owners.iter().map(|o| o.ext4_path.as_str()).collect();
        assert!(
            owned.contains(&"/etc/secret"),
            "0000 dir recorded: {owned:?}"
        );
        assert!(
            owned.contains(&"/etc/secret/locked"),
            "0000 file recorded: {owned:?}"
        );
        assert!(!owned.contains(&"/"), "source root excluded: {owned:?}");

        // Dir and file are now owner read/searchable.
        assert_eq!(
            std::fs::symlink_metadata(&secret_dir).unwrap().mode() & 0o500,
            0o500
        );
        assert_eq!(
            std::fs::symlink_metadata(&locked).unwrap().mode() & 0o400,
            0o400
        );

        // Records carry original full modes (with type bits) and in-image paths.
        let dir_rec = widened
            .iter()
            .find(|w| w.ext4_path == "/etc/secret")
            .expect("dir recorded");
        assert_eq!(dir_rec.mode & 0o170000, 0o040000, "dir type bits preserved");
        assert_eq!(dir_rec.mode & 0o7777, 0o000);
        let file_rec = widened
            .iter()
            .find(|w| w.ext4_path == "/etc/secret/locked")
            .expect("file recorded");
        assert_eq!(
            file_rec.mode & 0o170000,
            0o100000,
            "regular type bits preserved"
        );
        assert_eq!(file_rec.mode & 0o7777, 0o000);

        // Make the tree removable so TempDir can clean up.
        std::fs::set_permissions(&secret_dir, std::fs::Permissions::from_mode(0o700)).ok();
    }

    /// `inject_file_into_ext4` runs the same `debugfs -w -f -` batch-script
    /// pattern as `normalize_inodes_with_debugfs`, and has the identical gap: a
    /// failing `write` (e.g. the host source file vanished) makes every
    /// subsequent `sif` on that never-created guest path fail too, but the
    /// whole script still exits 0.
    ///
    /// Verified empirically before writing this test: `write` on a nonexistent
    /// host path produces `"do_write_internal: No such file or directory..."` on
    /// stderr, followed by three `"File not found by ext2_lookup"` lines (one per
    /// cascading `sif`), with the process still exiting 0.
    #[test]
    fn inject_file_into_ext4_fails_on_missing_host_file() {
        if util::find_binary("mke2fs").is_err() || util::find_binary("debugfs").is_err() {
            eprintln!("skipping: mke2fs/debugfs not found (run `make runtime:debug`)");
            return;
        }

        let src_root = tempfile::tempdir().expect("source tempdir");
        let src = src_root.path().join("rootfs");
        std::fs::create_dir_all(&src).expect("mkdir rootfs");
        std::fs::write(src.join("real"), b"x").expect("write real");

        let out_root = tempfile::tempdir().expect("output tempdir");
        let out = out_root.path().join("rootfs.ext4");
        let _disk = create_ext4_from_dir(&src, &out, 0).expect("ext4 build must succeed");

        let missing_host_file = src_root.path().join("does-not-exist-on-host");
        let result = inject_file_into_ext4(&out, &missing_host_file, "injected");
        assert!(
            result.is_err(),
            "a missing host source file must fail the injection, not silently \
             succeed with the guest path never actually written"
        );
    }

    /// Write `len` non-zero, non-repeating bytes to `path`.
    ///
    /// `debugfs write` (verified empirically before writing this test, against
    /// a real image) treats a long run of *zero* bytes in the source file as
    /// sparse and allocates no real ext4 blocks for it at all — a same-length
    /// all-zero stand-in file would consume no free space and make the
    /// reproducer below tautologically green regardless of how little room
    /// the image actually has.
    fn write_random_file(path: &Path, len: u64) {
        use std::io::Read;

        let mut urandom = std::fs::File::open("/dev/urandom").expect("open /dev/urandom");
        let mut limited = (&mut urandom).take(len);
        let mut out = std::fs::File::create(path).expect("create random payload file");
        std::io::copy(&mut limited, &mut out).expect("write random payload");
    }

    /// A guest binary injected *after* the image is built must actually fit.
    ///
    /// `create_ext4_from_dir` sizes the image purely from the source tree it
    /// is given — a near-empty tree lands at the `MIN_DISK_SIZE_BYTES` floor,
    /// with no headroom budgeted for anything injected afterward. But
    /// `GuestRootfsManager::build_and_install` (rootfs/guest.rs) copies
    /// exactly that image and then injects the `boxlite-guest` binary into
    /// it — an unstripped debug build runs ~231 MiB, well over the ~223 MiB
    /// of free space a floor-sized image has once mke2fs/journal overhead is
    /// accounted for (measured empirically against a real image before
    /// writing this test).
    ///
    /// Pre-fix, this fails: `create_ext4_from_dir` has no way to reserve
    /// headroom, so a same-shape oversized payload cannot fit and
    /// `inject_file_into_ext4` correctly reports `Err` (`check_debugfs_output`
    /// above already catches the underlying `debugfs` silent-failure class) —
    /// proving this is a real, present-day capacity bug, not a hypothetical
    /// one.
    #[test]
    fn create_ext4_from_dir_reserves_headroom_for_post_build_injection() {
        if util::find_binary("mke2fs").is_err() || util::find_binary("debugfs").is_err() {
            eprintln!("skipping: mke2fs/debugfs not found (run `make runtime:debug`)");
            return;
        }

        let src_root = tempfile::tempdir().expect("source tempdir");
        let src = src_root.path().join("rootfs");
        std::fs::create_dir_all(&src).expect("mkdir rootfs");
        std::fs::write(src.join("real"), b"x").expect("write real");

        // Larger than the ~223 MiB of free space measured on a floor-sized
        // image with no reserve — comfortably over, well under a real debug
        // guest binary (~231 MiB).
        let payload_len = 235 * 1024 * 1024u64;
        let payload_root = tempfile::tempdir().expect("payload tempdir");
        let payload = payload_root.path().join("guest-binary-stand-in");
        write_random_file(&payload, payload_len);

        let out_root = tempfile::tempdir().expect("output tempdir");
        let out = out_root.path().join("rootfs.ext4");
        // Exercises the reserve_bytes mechanism itself, at this function's
        // own level — not the specific value runtime/rt_impl.rs picks (a
        // fixed constant; see IMAGE_DISK_GUEST_BINARY_HEADROOM_BYTES there).
        // Sized to the payload plus a small fixed margin, not a percentage of
        // it: the payload length is already exact, unlike the tree-size
        // estimate `disk_size_with_overhead`'s multiplier compensates for.
        let reserve_bytes = payload_len + 8 * 1024 * 1024;
        let _disk =
            create_ext4_from_dir(&src, &out, reserve_bytes).expect("ext4 build must succeed");

        let result = inject_file_into_ext4(&out, &payload, "boxlite/bin/boxlite-guest");
        assert!(
            result.is_ok(),
            "a guest binary must always fit in the image it is injected into, \
             but injection into an unpadded floor-sized image failed: {:?}",
            result.err()
        );
    }

    #[test]
    fn test_build_inject_commands_nested_path() {
        let cmds = build_inject_commands("/host/boxlite-guest", "boxlite/bin/boxlite-guest");

        // Should create parent dirs: boxlite, boxlite/bin
        assert!(cmds.contains("mkdir /boxlite\n"));
        assert!(cmds.contains("mkdir /boxlite/bin\n"));

        // Should write the file (source path quoted for spaces)
        assert!(cmds.contains("write \"/host/boxlite-guest\" /boxlite/bin/boxlite-guest\n"));

        // Should set file permissions
        assert!(cmds.contains("sif /boxlite/bin/boxlite-guest uid 0\n"));
        assert!(cmds.contains("sif /boxlite/bin/boxlite-guest gid 0\n"));
        assert!(cmds.contains("sif /boxlite/bin/boxlite-guest mode 0100555\n"));

        // Should set parent dir ownership
        assert!(cmds.contains("sif /boxlite uid 0\n"));
        assert!(cmds.contains("sif /boxlite gid 0\n"));
        assert!(cmds.contains("sif /boxlite/bin uid 0\n"));
        assert!(cmds.contains("sif /boxlite/bin gid 0\n"));
    }

    #[test]
    fn test_build_inject_commands_single_dir() {
        let cmds = build_inject_commands("/host/file", "dir/file");

        assert!(cmds.contains("mkdir /dir\n"));
        assert!(cmds.contains("write \"/host/file\" /dir/file\n"));
        assert!(cmds.contains("sif /dir uid 0\n"));
        assert!(cmds.contains("sif /dir gid 0\n"));
    }

    #[test]
    fn test_build_inject_commands_root_level_file() {
        let cmds = build_inject_commands("/host/file", "file");

        // No mkdir commands for root-level file
        assert!(!cmds.contains("mkdir"));

        // Should still write and set permissions
        assert!(cmds.contains("write \"/host/file\" /file\n"));
        assert!(cmds.contains("sif /file uid 0\n"));
        assert!(cmds.contains("sif /file gid 0\n"));
        assert!(cmds.contains("sif /file mode 0100555\n"));
    }

    #[test]
    fn test_build_inject_commands_deeply_nested() {
        let cmds = build_inject_commands("/src/bin", "a/b/c/d/bin");

        assert!(cmds.contains("mkdir /a\n"));
        assert!(cmds.contains("mkdir /a/b\n"));
        assert!(cmds.contains("mkdir /a/b/c\n"));
        assert!(cmds.contains("mkdir /a/b/c/d\n"));
        assert!(cmds.contains("write \"/src/bin\" /a/b/c/d/bin\n"));
    }

    #[test]
    fn test_build_inject_commands_path_with_spaces() {
        let cmds = build_inject_commands(
            "/Users/user/Library/Application Support/boxlite/runtimes/v0.6.0/boxlite-guest",
            "boxlite/bin/boxlite-guest",
        );

        // Source path must be quoted so debugfs handles the space correctly
        assert!(cmds.contains(
            "write \"/Users/user/Library/Application Support/boxlite/runtimes/v0.6.0/boxlite-guest\" /boxlite/bin/boxlite-guest\n"
        ));
    }
}
