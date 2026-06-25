//! Sized-volume image preparation (host side).
//!
//! Layout (host → box, virtio-blk path):
//!   sparse image at `<img_path>`        — bounded host disk consumption
//!     ↓ `mkfs.ext4`
//!   ext4 inside the image                — sized at create time
//!     ↓ libkrun `krun_add_disk2`
//!   `/dev/vdN` inside the VM            — guest kernel sees it as block device
//!     ↓ guest agent mounts (`BlockDeviceMount`)
//!   box's `/data`                        — what the workload sees
//!
//! Every layer sees ENOSPC at the cap because the underlying ext4 is sized.
//! This module owns ONLY image creation; libkrun wiring and guest mount are
//! handled by the existing block-device path the rootfs already uses.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::Path;
use std::process::Command;

/// Minimum size for a usable ext4 filesystem. ext4 reserves room for the
/// journal, super-block copies, and the inode table; below ~16 MiB there is
/// no room for user data and `mke2fs` either fails or produces a useless
/// volume. Reject smaller requests up front with a clear error.
pub const MIN_SIZED_VOLUME_BYTES: u64 = 16 * 1024 * 1024;

/// Bytes the host must retain free after a sized-volume admission decision.
///
/// Without this floor, `-v /data:size=N` with N close to `statvfs.f_bavail`
/// would succeed at create (the image file is sparse so `set_len` doesn't
/// allocate) but a runaway workload could later fill the sparse image and
/// drain the host root filesystem down to zero — corrupting SQLite WAL,
/// breaking concurrent box rootfs writes, and locking the operator out of
/// recovery commands until disk is freed by hand.
///
/// 10 GiB is a coarse default: large enough to keep image pulls + state
/// writes + log rotation working on a single-disk dev host, small enough
/// not to be absurd on a 1 TiB server. Production deployments with their
/// own SLO should override this.
pub const HOST_RESERVE_BYTES: u64 = 10 * 1024 * 1024 * 1024;

/// Create a sparse image file at `img_path` of `size_bytes` and format it
/// as ext4 in place. The image is **not mounted on the host** — the caller
/// is expected to attach it to the VM as a virtio-blk device (libkrun's
/// `krun_add_disk2`), the guest agent then mounts `/dev/vdN`.
///
/// `mkfs_bin` is explicit so the caller can pick the bundled binary
/// (production: `boxlite::util::find_binary("mke2fs")`) or the system
/// binary (tests).
///
/// Side effects on success: `img_path` is created (sparse, `size_bytes`
/// long, ext4-formatted). On any failure step the image file is removed.
pub fn create_sized_volume_image(
    img_path: &Path,
    size_bytes: u64,
    mkfs_bin: &Path,
) -> BoxliteResult<()> {
    if size_bytes < MIN_SIZED_VOLUME_BYTES {
        return Err(BoxliteError::Config(format!(
            "volume size must be at least {} bytes \
             (ext4 needs room for journal + reserved blocks); requested {}",
            MIN_SIZED_VOLUME_BYTES, size_bytes
        )));
    }

    // 0. Refuse to over-commit the host filesystem. The image file is
    // sparse, so create itself would succeed for any u64 size, but a
    // workload could later fill it and drain the host below the floor
    // we reserve for image pulls / state DB / recovery commands. Fail
    // fast at the size the operator declares, not later mid-write.
    let parent = img_path.parent().unwrap_or(std::path::Path::new("/"));
    let vfs = nix::sys::statvfs::statvfs(parent).map_err(|e| {
        BoxliteError::Storage(format!(
            "statvfs {} (for sized volume admission): {e}",
            parent.display()
        ))
    })?;
    let free_bytes = vfs.blocks_available() as u64 * vfs.fragment_size();
    if size_bytes.saturating_add(HOST_RESERVE_BYTES) > free_bytes {
        return Err(BoxliteError::Config(format!(
            "sized volume {} requests {} bytes but host fs at {} has only \
             {} free; refusing to over-commit (reserving {} bytes for the host)",
            img_path.display(),
            size_bytes,
            parent.display(),
            free_bytes,
            HOST_RESERVE_BYTES
        )));
    }

    // 1. Sparse image. `set_len` reserves the length without writing zeros,
    //    so the on-host bytes track real usage, not the cap.
    let f = std::fs::File::create(img_path)
        .map_err(|e| BoxliteError::Storage(format!("create image {}: {e}", img_path.display())))?;
    f.set_len(size_bytes).map_err(|e| {
        let _ = std::fs::remove_file(img_path);
        BoxliteError::Storage(format!("set image size {}: {e}", img_path.display()))
    })?;
    drop(f);

    // 2. mkfs.ext4 in place. `-F` forces (the file already exists), `-q`
    //    keeps stderr clean unless there's a real error.
    let mke = Command::new(mkfs_bin)
        .args(["-t", "ext4", "-F", "-q"])
        .arg(img_path)
        .output()
        .map_err(|e| {
            let _ = std::fs::remove_file(img_path);
            BoxliteError::Storage(format!("spawn mke2fs ({}): {e}", mkfs_bin.display()))
        })?;
    if !mke.status.success() {
        let _ = std::fs::remove_file(img_path);
        return Err(BoxliteError::Storage(format!(
            "mke2fs {} ({}): {}",
            img_path.display(),
            mke.status,
            String::from_utf8_lossy(&mke.stderr).trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn system_mkfs() -> PathBuf {
        for p in ["/usr/sbin/mke2fs", "/sbin/mke2fs", "/usr/bin/mke2fs"] {
            if Path::new(p).exists() {
                return PathBuf::from(p);
            }
        }
        panic!("mke2fs not found in standard paths");
    }

    /// Declared size that would push the host below `HOST_RESERVE_BYTES`
    /// is rejected at create time, before any image file is opened, so the
    /// operator gets a clean refusal instead of a runaway workload later
    /// draining the host root fs through a sparse image.
    #[test]
    fn rejects_size_exceeding_host_free_minus_reserve() {
        let tmp = tempfile::tempdir().unwrap();
        let img = tmp.path().join("huge.img");
        let mkfs = PathBuf::from("/usr/sbin/mke2fs"); // not invoked

        // statvfs the same parent dir the production code path will check.
        // Pick a size guaranteed to exceed (free - reserve): take current
        // free, add 1 EiB on top. u64 can hold it; the admission check
        // must refuse regardless of host capacity at test time.
        let vfs = nix::sys::statvfs::statvfs(tmp.path()).expect("statvfs in test");
        let free_bytes = vfs.blocks_available() as u64 * vfs.fragment_size();
        let oversize = free_bytes.saturating_add(1024_u64.pow(6)); // free + 1 EiB

        let err = create_sized_volume_image(&img, oversize, &mkfs)
            .expect_err("must reject sizes that would over-commit the host");
        assert!(
            matches!(err, BoxliteError::Config(_)),
            "expected Config error, got {err:?}"
        );
        assert!(
            !img.exists(),
            "no image must be created on host-over-commit refusal"
        );
    }

    /// Below the minimum size → `Config` error, no fs work attempted.
    #[test]
    fn rejects_too_small_size() {
        let tmp = tempfile::tempdir().unwrap();
        let img = tmp.path().join("tiny.img");
        let mkfs = PathBuf::from("/usr/sbin/mke2fs"); // unused at this guard
        let err = create_sized_volume_image(&img, 1024 * 1024, &mkfs)
            .expect_err("must reject sizes below the ext4 minimum");
        assert!(matches!(err, BoxliteError::Config(_)), "got {err:?}");
        assert!(
            !img.exists(),
            "no image must be created on size validation failure"
        );
    }

    /// The happy path: image created, sparse (on-host bytes ≪ declared length),
    /// ext4-formatted (mke2fs leaves an ext4 superblock the kernel recognises).
    #[test]
    fn creates_sparse_ext4_image() {
        use std::os::unix::fs::MetadataExt;

        let tmp = tempfile::tempdir().unwrap();
        let img = tmp.path().join("vol.img");
        let size = 16 * 1024 * 1024;
        create_sized_volume_image(&img, size, &system_mkfs()).expect("create");

        let meta = std::fs::metadata(&img).expect("stat image");
        assert_eq!(
            meta.len(),
            size,
            "image must be exactly the requested length"
        );
        // Sparse: blocks * 512 should be far smaller than the declared length.
        // After mke2fs there's metadata written (a few hundred KiB) but
        // nowhere near the full 16 MiB.
        let on_disk = meta.blocks() * 512;
        assert!(
            on_disk < size / 2,
            "image must be sparse (on-disk {} bytes vs declared {} bytes)",
            on_disk,
            size
        );

        // mke2fs writes the ext4 super-block magic `0xEF53` at offset 0x438.
        let bytes = std::fs::read(&img).expect("read");
        let magic = u16::from_le_bytes([bytes[0x438], bytes[0x439]]);
        assert_eq!(magic, 0xEF53, "missing ext4 super-block magic");
    }
}
