//! Filesystem trim via the FITRIM ioctl (what `fstrim` does).
//!
//! Filesystems are mounted with `discard`, but online discard only covers
//! blocks freed while that option is on: space freed by an older guest that
//! mounted without it, or discards lost to a crash, stay allocated on the host.
//! FITRIM walks all free space and sends it down in large, merged ranges, so
//! the host can punch holes for what online discard missed.

use std::collections::HashSet;
use std::fs::File;
use std::io;
use std::os::unix::io::AsRawFd;

use nix::libc;
use tracing::{debug, info, warn};

use super::fsfreeze::writable_mounts;

// Defined in include/uapi/linux/fs.h:
//   #define FITRIM _IOWR('X', 121, struct fstrim_range) = 0xC0185879
// Raw constant for the same reason as FIFREEZE in fsfreeze.rs.
const FITRIM: libc::c_ulong = 0xC018_5879;

/// Skip free extents smaller than this. qcow2 frees whole 64 KiB clusters, so
/// smaller ranges cannot be reclaimed on the host anyway.
const TRIM_MIN_EXTENT: u64 = 64 * 1024;

/// `struct fstrim_range` from include/uapi/linux/fs.h.
#[repr(C)]
struct FstrimRange {
    start: u64,
    len: u64,
    minlen: u64,
}

/// Trim all writable filesystems.
///
/// Best effort: filesystems that fail or don't support FITRIM are logged and
/// skipped. Returns the total number of bytes the filesystems reported as
/// trimmed.
pub fn trim_filesystems() -> u64 {
    // Commit pending deletes first: FITRIM only sees blocks the journal has freed.
    // SAFETY: sync(2) takes no arguments and cannot fail.
    unsafe { libc::sync() };

    let mut seen = HashSet::new();
    let mut trimmed = 0u64;

    for mount in writable_mounts() {
        // Bind mounts show up once per mount point; trim each filesystem once.
        if !seen.insert(mount.source.clone()) {
            continue;
        }
        let mount_point = mount.mount_point.as_str();

        match do_fstrim(mount_point) {
            Ok(bytes) => {
                debug!(mount_point, bytes, "Filesystem trimmed");
                trimmed += bytes;
            }
            Err(e) if e.raw_os_error() == Some(libc::EOPNOTSUPP) => {
                debug!(mount_point, fs_type = %mount.fs_type, "Filesystem does not support trim");
            }
            Err(e) => {
                warn!(mount_point, error = %e, "Failed to trim filesystem");
            }
        }
    }

    info!(trimmed, "Filesystems trimmed");
    trimmed
}

/// FITRIM ioctl — discard all free space of the filesystem at `mount_point`.
///
/// Returns the number of bytes trimmed, as reported by the kernel.
fn do_fstrim(mount_point: &str) -> io::Result<u64> {
    let file = File::open(mount_point)?;
    let mut range = FstrimRange {
        start: 0,
        len: u64::MAX,
        minlen: TRIM_MIN_EXTENT,
    };
    // SAFETY: FITRIM on a valid fd for a mount point; `range` is a valid
    // `struct fstrim_range` that the kernel reads and updates in place.
    let ret = unsafe { libc::ioctl(file.as_raw_fd(), FITRIM as _, &mut range) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(range.len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::mount::{mount, umount, MsFlags};
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const MB: u64 = 1 << 20;

    fn run(cmd: &mut Command) -> String {
        let out = cmd.output().expect("spawn");
        assert!(
            out.status.success(),
            "{cmd:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn allocated(path: &Path) -> u64 {
        std::fs::metadata(path).unwrap().blocks() * 512
    }

    /// Detaches the loop device and unmounts on drop.
    struct LoopMount {
        device: String,
        mount_point: PathBuf,
    }
    impl Drop for LoopMount {
        fn drop(&mut self) {
            let _ = umount(&self.mount_point);
            let _ = Command::new("losetup").args(["-d", &self.device]).status();
        }
    }

    /// Space freed while the filesystem was mounted without `discard` (a box
    /// created before discard was enabled) is only reclaimed by FITRIM. The
    /// loop device turns the trim into holes in its backing file.
    #[test]
    #[ignore = "needs root: loop device and mount (make test:guest-perms)"]
    fn privileged_fitrim_reclaims_space_freed_without_discard() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("fs.img");
        std::fs::File::create(&image)
            .unwrap()
            .set_len(256 * MB)
            .unwrap();
        run(Command::new("mkfs.ext4")
            .args(["-q", "-F", "-E", "nodiscard"])
            .arg(&image));
        let device = run(Command::new("losetup")
            .args(["--find", "--show"])
            .arg(&image));
        let mount_point = dir.path().join("mnt");
        std::fs::create_dir(&mount_point).unwrap();
        let _guard = LoopMount {
            device: device.clone(),
            mount_point: mount_point.clone(),
        };
        mount(
            Some(device.as_str()),
            &mount_point,
            Some("ext4"),
            MsFlags::empty(),
            Some("nodiscard"),
        )
        .unwrap();

        let data = mount_point.join("data");
        let mut file = std::fs::File::create(&data).unwrap();
        for _ in 0..64 {
            file.write_all(&[0xab; MB as usize]).unwrap();
        }
        file.sync_all().unwrap();
        drop(file);
        std::fs::remove_file(&data).unwrap();
        unsafe { libc::sync() };
        let before = allocated(&image);
        assert!(
            before >= 64 * MB,
            "deleted data must still be allocated: {before}"
        );

        let trimmed = do_fstrim(mount_point.to_str().unwrap()).unwrap();
        unsafe { libc::sync() };
        let after = allocated(&image);
        assert!(
            after + 48 * MB <= before,
            "FITRIM must shrink the image: before {before}, after {after}"
        );
        assert!(trimmed >= 64 * MB, "FITRIM reported {trimmed} bytes");
    }
}
