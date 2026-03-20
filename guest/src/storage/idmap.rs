//! ID-mapped mount support via the new mount API (kernel 5.12+).
//!
//! Remaps UID/GID ownership on an existing mount point in-place using
//! `open_tree(OPEN_TREE_CLONE)` + `mount_setattr(MOUNT_ATTR_IDMAP)` +
//! `move_mount()`. This is the same technique used by crun.
//!
//! The original mount is replaced transparently — callers accessing the
//! same path see remapped UIDs without any path changes.

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::libc;

/// UID/GID mapping for an ID-mapped mount.
///
/// Maps `count` IDs starting at `host_id` on the backing filesystem
/// to IDs starting at `container_id` as seen through the mount.
#[derive(Debug, Clone)]
pub struct IdMapping {
    pub host_id: u32,
    pub container_id: u32,
    pub count: u32,
}

/// Build a full-range swap mapping between two IDs.
///
/// Generates uid_map entries that swap `from_id` and `to_id` while
/// identity-mapping all other IDs in `[0, total_range)`.
///
/// Example: `build_swap_mapping(501, 0, 65536)` produces:
/// ```text
///   0    501   1       # ns 0 → host 501
///   1    1     500     # ns 1-500 → host 1-500 (identity)
///   501  0     1       # ns 501 → host 0
///   502  502   65034   # ns 502-65535 → host 502-65535 (identity)
/// ```
pub fn build_swap_mapping(from_id: u32, to_id: u32, total_range: u32) -> Vec<IdMapping> {
    if from_id == to_id {
        return vec![];
    }

    let (lo, hi) = if from_id < to_id {
        (from_id, to_id)
    } else {
        (to_id, from_id)
    };

    let mut mappings = Vec::with_capacity(4);

    // [0..lo) identity
    if lo > 0 {
        mappings.push(IdMapping {
            container_id: 0,
            host_id: 0,
            count: lo,
        });
    }

    // lo → swap target
    mappings.push(IdMapping {
        container_id: lo,
        host_id: hi,
        count: 1,
    });

    // (lo..hi) identity
    if hi - lo > 1 {
        mappings.push(IdMapping {
            container_id: lo + 1,
            host_id: lo + 1,
            count: hi - lo - 1,
        });
    }

    // hi → swap target
    mappings.push(IdMapping {
        container_id: hi,
        host_id: lo,
        count: 1,
    });

    // (hi..total_range) identity
    if hi + 1 < total_range {
        mappings.push(IdMapping {
            container_id: hi + 1,
            host_id: hi + 1,
            count: total_range - hi - 1,
        });
    }

    mappings
}

/// Apply ID mapping to an existing mount point in-place.
///
/// Clones the mount at `path`, applies the UID/GID mappings, then
/// replaces the original via `move_mount()` over the same path.
///
/// Returns `Ok(true)` if idmap was applied, `Ok(false)` if the kernel
/// doesn't support it — the original mount is left unchanged.
pub fn remap_mount(
    path: &Path,
    uid_mappings: &[IdMapping],
    gid_mappings: &[IdMapping],
) -> BoxliteResult<bool> {
    if uid_mappings.is_empty() && gid_mappings.is_empty() {
        return Ok(false);
    }

    let path_cstr = path_to_cstring(path)?;

    // Clone the mount as a detached fd
    let tree_fd = match sys::open_tree(
        libc::AT_FDCWD,
        &path_cstr,
        sys::OPEN_TREE_CLONE | sys::OPEN_TREE_CLOEXEC | sys::AT_RECURSIVE,
    ) {
        Ok(fd) => fd,
        Err(e) if e.raw_os_error() == Some(libc::ENOSYS) => {
            tracing::warn!("open_tree not supported (ENOSYS), skipping idmap");
            return Ok(false);
        }
        Err(e) if e.raw_os_error() == Some(libc::EPERM) => {
            tracing::warn!("open_tree denied (EPERM), skipping idmap");
            return Ok(false);
        }
        Err(e) => {
            return Err(BoxliteError::Storage(format!(
                "open_tree failed for {}: {}",
                path.display(),
                e
            )));
        }
    };

    // Create a user namespace with the desired UID/GID mappings
    let userns_fd = create_userns(uid_mappings, gid_mappings).map_err(|e| {
        BoxliteError::Storage(format!("Failed to create user namespace for idmap: {}", e))
    })?;

    // Apply MOUNT_ATTR_IDMAP on the cloned mount
    let attr = sys::MountAttr {
        attr_set: sys::MOUNT_ATTR_IDMAP,
        attr_clr: 0,
        propagation: 0,
        userns_fd: userns_fd.as_raw_fd() as u64,
    };

    let empty = CString::new("").unwrap();
    if let Err(e) = sys::mount_setattr(tree_fd.as_raw_fd(), &empty, sys::AT_EMPTY_PATH, &attr) {
        if e.raw_os_error() == Some(libc::EINVAL) {
            tracing::warn!("mount_setattr EINVAL — filesystem may not support idmap");
            return Ok(false);
        }
        if e.raw_os_error() == Some(libc::EPERM) {
            tracing::warn!("mount_setattr EPERM — lacking CAP_SYS_ADMIN");
            return Ok(false);
        }
        return Err(BoxliteError::Storage(format!(
            "mount_setattr failed for {}: {}",
            path.display(),
            e
        )));
    }

    drop(userns_fd);

    // Replace the original mount with the idmapped clone
    if let Err(e) = sys::move_mount(
        tree_fd.as_raw_fd(),
        &empty,
        libc::AT_FDCWD,
        &path_cstr,
        sys::MOVE_MOUNT_F_EMPTY_PATH,
    ) {
        return Err(BoxliteError::Storage(format!(
            "move_mount failed for {}: {}",
            path.display(),
            e
        )));
    }

    tracing::info!(
        "Applied idmap to {} ({} uid mappings, {} gid mappings)",
        path.display(),
        uid_mappings.len(),
        gid_mappings.len()
    );

    Ok(true)
}

// ─────────────────────────────────────────────────────────────────────
// User namespace creation
// ─────────────────────────────────────────────────────────────────────

/// Create a throwaway user namespace with the given UID/GID mappings.
///
/// Forks a child that calls `unshare(CLONE_NEWUSER)`, then the parent
/// writes uid_map/gid_map and opens the namespace fd. The child is
/// killed immediately after — only the namespace fd survives.
fn create_userns(uid_mappings: &[IdMapping], gid_mappings: &[IdMapping]) -> io::Result<OwnedFd> {
    // Pipe for child→parent synchronization
    let (read_fd, write_fd) = nix::unistd::pipe()?;

    // SAFETY: fork() is safe here because we're in a single-threaded context
    // (guest agent calls this during volume setup, before container start).
    // The child does minimal work: unshare + write + pause.
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }

    if child == 0 {
        // Child: create new user namespace, signal parent, wait to be killed
        drop(read_fd);
        let fd = write_fd.as_raw_fd();

        if unsafe { libc::unshare(libc::CLONE_NEWUSER) } != 0 {
            unsafe { libc::write(fd, b"F".as_ptr() as _, 1) };
            unsafe { libc::_exit(1) };
        }

        unsafe { libc::write(fd, b"R".as_ptr() as _, 1) };
        drop(write_fd);
        unsafe { libc::pause() };
        unsafe { libc::_exit(0) };
    }

    // Parent: wait for child to create userns
    drop(write_fd);
    let mut buf = [0u8; 1];
    nix::unistd::read(read_fd.as_raw_fd(), &mut buf)?;
    drop(read_fd);

    if buf[0] != b'R' {
        unsafe { libc::kill(child, libc::SIGKILL) };
        unsafe { libc::waitpid(child, std::ptr::null_mut(), 0) };
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "child failed to create user namespace",
        ));
    }

    // Write UID/GID maps
    let result = (|| -> io::Result<OwnedFd> {
        write_proc_file(child, "setgroups", "deny")?;
        write_id_map(child, "uid_map", uid_mappings)?;
        write_id_map(child, "gid_map", gid_mappings)?;

        // Open the namespace fd
        let ns_path = format!("/proc/{}/ns/user", child);
        let fd = nix::fcntl::open(
            ns_path.as_str(),
            nix::fcntl::OFlag::O_RDONLY,
            nix::sys::stat::Mode::empty(),
        )?;
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    })();

    // Always clean up the child
    unsafe { libc::kill(child, libc::SIGKILL) };
    unsafe { libc::waitpid(child, std::ptr::null_mut(), 0) };

    result
}

fn write_proc_file(pid: i32, name: &str, content: &str) -> io::Result<()> {
    let path = format!("/proc/{}/{}", pid, name);
    std::fs::write(&path, content)
        .map_err(|e| io::Error::new(e.kind(), format!("write {}: {}", path, e)))
}

/// Format ID mappings as uid_map/gid_map file content.
///
/// Each line: "container_id host_id count\n"
fn format_id_map(mappings: &[IdMapping]) -> String {
    let mut content = String::new();
    for m in mappings {
        content.push_str(&format!("{} {} {}\n", m.container_id, m.host_id, m.count));
    }
    content
}

fn write_id_map(pid: i32, map_file: &str, mappings: &[IdMapping]) -> io::Result<()> {
    if mappings.is_empty() {
        return Ok(());
    }
    write_proc_file(pid, map_file, &format_id_map(mappings))
}

// ─────────────────────────────────────────────────────────────────────
// Syscall wrappers
// ─────────────────────────────────────────────────────────────────────

fn path_to_cstring(path: &Path) -> BoxliteResult<CString> {
    CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| BoxliteError::Storage(format!("Path contains null byte: {}", path.display())))
}

/// Raw syscall wrappers for the new mount API (kernel 5.12+).
///
/// These syscalls are not yet in the nix crate, so we call them directly.
/// Syscall numbers are stable across aarch64 and x86_64.
mod sys {
    use std::ffi::CStr;
    use std::io;
    use std::os::fd::{FromRawFd, OwnedFd, RawFd};

    use nix::libc;

    // Syscall numbers (stable for aarch64 and x86_64)
    const NR_OPEN_TREE: libc::c_long = 428;
    const NR_MOVE_MOUNT: libc::c_long = 429;
    const NR_MOUNT_SETATTR: libc::c_long = 442;

    // Flags
    pub const OPEN_TREE_CLONE: u32 = 1;
    pub const OPEN_TREE_CLOEXEC: u32 = libc::O_CLOEXEC as u32;
    pub const AT_RECURSIVE: u32 = 0x8000;
    pub const AT_EMPTY_PATH: u32 = libc::AT_EMPTY_PATH as u32;
    pub const MOVE_MOUNT_F_EMPTY_PATH: u32 = 0x00000004;
    pub const MOUNT_ATTR_IDMAP: u64 = 0x00100000;

    #[repr(C)]
    pub struct MountAttr {
        pub attr_set: u64,
        pub attr_clr: u64,
        pub propagation: u64,
        pub userns_fd: u64,
    }

    pub fn open_tree(dirfd: RawFd, path: &CStr, flags: u32) -> io::Result<OwnedFd> {
        let ret =
            unsafe { libc::syscall(NR_OPEN_TREE, dirfd, path.as_ptr(), flags as libc::c_uint) };
        if ret < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(ret as RawFd) })
        }
    }

    pub fn mount_setattr(
        dirfd: RawFd,
        path: &CStr,
        flags: u32,
        attr: &MountAttr,
    ) -> io::Result<()> {
        let ret = unsafe {
            libc::syscall(
                NR_MOUNT_SETATTR,
                dirfd,
                path.as_ptr(),
                flags as libc::c_uint,
                attr as *const MountAttr,
                std::mem::size_of::<MountAttr>(),
            )
        };
        if ret < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub fn move_mount(
        from_dirfd: RawFd,
        from_path: &CStr,
        to_dirfd: RawFd,
        to_path: &CStr,
        flags: u32,
    ) -> io::Result<()> {
        let ret = unsafe {
            libc::syscall(
                NR_MOVE_MOUNT,
                from_dirfd,
                from_path.as_ptr(),
                to_dirfd,
                to_path.as_ptr(),
                flags as libc::c_uint,
            )
        };
        if ret < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remap_mount_empty_mappings_returns_false() {
        let path = Path::new("/tmp");
        let result = remap_mount(path, &[], &[]);
        assert!(result.is_ok());
        assert!(
            !result.unwrap(),
            "empty mappings should return false (no-op)"
        );
    }

    #[test]
    fn format_id_map_single_mapping() {
        let mappings = vec![IdMapping {
            host_id: 501,
            container_id: 1000,
            count: 1,
        }];
        assert_eq!(format_id_map(&mappings), "1000 501 1\n");
    }

    #[test]
    fn format_id_map_multiple_mappings() {
        let mappings = vec![
            IdMapping {
                host_id: 0,
                container_id: 0,
                count: 1000,
            },
            IdMapping {
                host_id: 65534,
                container_id: 65534,
                count: 1,
            },
        ];
        let result = format_id_map(&mappings);
        assert_eq!(result, "0 0 1000\n65534 65534 1\n");
    }

    #[test]
    fn format_id_map_empty() {
        assert_eq!(format_id_map(&[]), "");
    }

    #[test]
    fn path_to_cstring_valid() {
        let path = Path::new("/tmp/test");
        let result = path_to_cstring(path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().to_str().unwrap(), "/tmp/test");
    }

    #[test]
    fn path_to_cstring_null_byte_errors() {
        let path = Path::new("/tmp/\0bad");
        let result = path_to_cstring(path);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("null byte"),
            "error should mention null byte: {}",
            err
        );
    }

    #[test]
    fn swap_mapping_same_id_returns_empty() {
        let mappings = build_swap_mapping(501, 501, 65536);
        assert!(mappings.is_empty());
    }

    #[test]
    fn swap_mapping_covers_full_range() {
        // Swap 501 ↔ 0 across 65536
        let mappings = build_swap_mapping(501, 0, 65536);

        // Total coverage should be 65536
        let total: u32 = mappings.iter().map(|m| m.count).sum();
        assert_eq!(total, 65536, "mapping must cover full range");

        // Check the swap entries
        // lo=0, hi=501
        // Entry for 0: container_id=0, host_id=501 (swap)
        assert_eq!(mappings[0].container_id, 0);
        assert_eq!(mappings[0].host_id, 501);
        assert_eq!(mappings[0].count, 1);

        // Entry for 1..500: identity
        assert_eq!(mappings[1].container_id, 1);
        assert_eq!(mappings[1].host_id, 1);
        assert_eq!(mappings[1].count, 500);

        // Entry for 501: container_id=501, host_id=0 (reverse swap)
        assert_eq!(mappings[2].container_id, 501);
        assert_eq!(mappings[2].host_id, 0);
        assert_eq!(mappings[2].count, 1);

        // Entry for 502..65535: identity
        assert_eq!(mappings[3].container_id, 502);
        assert_eq!(mappings[3].host_id, 502);
        assert_eq!(mappings[3].count, 65034);
    }

    #[test]
    fn swap_mapping_adjacent_ids() {
        // Swap 0 ↔ 1 — no gap between them
        let mappings = build_swap_mapping(0, 1, 100);

        let total: u32 = mappings.iter().map(|m| m.count).sum();
        assert_eq!(total, 100);

        // lo=0 → host=1 (swap)
        assert_eq!(mappings[0].container_id, 0);
        assert_eq!(mappings[0].host_id, 1);
        assert_eq!(mappings[0].count, 1);

        // No gap between 0 and 1, so no identity range here

        // hi=1 → host=0 (reverse swap)
        assert_eq!(mappings[1].container_id, 1);
        assert_eq!(mappings[1].host_id, 0);
        assert_eq!(mappings[1].count, 1);

        // 2..99 identity
        assert_eq!(mappings[2].container_id, 2);
        assert_eq!(mappings[2].host_id, 2);
        assert_eq!(mappings[2].count, 98);
    }

    #[test]
    fn swap_mapping_reversed_order() {
        // build_swap_mapping(1000, 501, ...) should produce same result as (501, 1000, ...)
        let m1 = build_swap_mapping(501, 1000, 65536);
        let m2 = build_swap_mapping(1000, 501, 65536);

        assert_eq!(m1.len(), m2.len());
        for (a, b) in m1.iter().zip(m2.iter()) {
            assert_eq!(a.container_id, b.container_id);
            assert_eq!(a.host_id, b.host_id);
            assert_eq!(a.count, b.count);
        }
    }

    #[test]
    fn swap_mapping_generates_valid_uid_map_content() {
        let mappings = build_swap_mapping(501, 0, 65536);
        let content = format_id_map(&mappings);

        // Should have 4 lines (swap at 0, identity 1-500, swap at 501, identity 502+)
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0], "0 501 1");
        assert_eq!(lines[1], "1 1 500");
        assert_eq!(lines[2], "501 0 1");
        assert_eq!(lines[3], "502 502 65034");
    }
}
