//! Mount and pivot init's root. No function here is used by tenant exec.

use super::super::spec::{Device, InitSpec, MountSpec};
use crate::storage::idmap::sys;
use nix::fcntl::{openat, readlinkat, OFlag};
use nix::libc;
use nix::mount::{mount, umount2, MntFlags, MsFlags};
use nix::sys::stat::{fstat, mkdirat, mknod, Mode, SFlag};
use nix::unistd::{chdir, fchdir, pivot_root};
use std::collections::VecDeque;
use std::ffi::{CString, OsString};
use std::fs::File;
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path, PathBuf};

const MASKED_PATHS: &[&str] = &[
    "/proc/acpi",
    "/proc/asound",
    "/proc/kcore",
    "/proc/keys",
    "/proc/latency_stats",
    "/proc/timer_list",
    "/proc/timer_stats",
    "/proc/sched_debug",
    "/proc/scsi",
    "/sys/firmware",
    "/sys/devices/virtual/powercap",
];

fn mount_fs(
    source: Option<&Path>,
    target: &Path,
    kind: Option<&str>,
    flags: MsFlags,
    data: Option<&str>,
) -> io::Result<()> {
    mount(source, target, kind, flags, data).map_err(|error| {
        io::Error::other(format!(
            "mount {source:?} on {} ({kind:?}, {flags:?}): {error}",
            target.display()
        ))
    })
}

fn proc_path(fd: &impl AsRawFd) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()))
}

fn open_path(dir: Option<RawFd>, path: &Path) -> io::Result<OwnedFd> {
    let fd = openat(
        dir,
        path,
        OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )?;
    // SAFETY: openat returned a new descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn file_type(fd: &OwnedFd) -> io::Result<SFlag> {
    Ok(SFlag::from_bits_truncate(fstat(fd.as_raw_fd())?.st_mode))
}

fn components(path: &Path) -> VecDeque<OsString> {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(x) => Some(x.into()),
            Component::ParentDir => Some("..".into()),
            _ => None,
        })
        .collect()
}

/// Resolve image symlinks relative to the container root, not the guest root.
/// Directory fds pin each traversed component; neither lookup nor creation
/// follows a concurrently replaced symlink. Absolute links restart at root.
fn scoped(root: &OwnedFd, path: &Path, create_directory: Option<bool>) -> io::Result<OwnedFd> {
    let mut stack = vec![root.try_clone()?];
    let mut remaining = components(path);
    let mut links = 0;
    while let Some(part) = remaining.pop_front() {
        if part == ".." {
            if stack.len() > 1 {
                stack.pop();
            }
            continue;
        }
        let dir = stack.last().unwrap().as_raw_fd();
        let part = Path::new(&part);
        let fd = match open_path(Some(dir), part) {
            Err(e) if e.kind() == io::ErrorKind::NotFound && create_directory.is_some() => {
                if !remaining.is_empty() || create_directory == Some(true) {
                    mkdirat(Some(dir), part, Mode::from_bits_truncate(0o755))?;
                } else {
                    let fd = openat(
                        Some(dir),
                        part,
                        OFlag::O_WRONLY
                            | OFlag::O_CREAT
                            | OFlag::O_EXCL
                            | OFlag::O_NOFOLLOW
                            | OFlag::O_CLOEXEC,
                        Mode::from_bits_truncate(0o644),
                    )?;
                    drop(unsafe { OwnedFd::from_raw_fd(fd) });
                }
                open_path(Some(dir), part)?
            }
            other => other?,
        };
        let typ = file_type(&fd)?;
        if typ == SFlag::S_IFLNK {
            links += 1;
            if links > 40 {
                return Err(io::Error::from_raw_os_error(nix::libc::ELOOP));
            }
            let link = readlinkat(Some(fd.as_raw_fd()), "")?;
            let link = Path::new(&link);
            if link.is_absolute() {
                stack.truncate(1);
            }
            let mut prefix = components(link);
            prefix.append(&mut remaining);
            remaining = prefix;
        } else {
            if (!remaining.is_empty() || create_directory == Some(true)) && typ != SFlag::S_IFDIR {
                return Err(io::Error::from_raw_os_error(nix::libc::ENOTDIR));
            }
            stack.push(fd);
        }
    }
    Ok(stack.pop().unwrap())
}

struct Options<'a> {
    flags: MsFlags,
    recursive_readonly: bool,
    propagation: MsFlags,
    data: Vec<&'a str>,
}

fn options(spec: &MountSpec) -> io::Result<Options<'_>> {
    let mut result = Options {
        flags: MsFlags::empty(),
        recursive_readonly: false,
        propagation: MsFlags::empty(),
        data: Vec::new(),
    };
    for option in &spec.options {
        let flag = match option.as_str() {
            "bind" => MsFlags::MS_BIND,
            "rbind" => MsFlags::MS_BIND | MsFlags::MS_REC,
            "ro" => MsFlags::MS_RDONLY,
            "rro" => {
                result.recursive_readonly = true;
                MsFlags::MS_RDONLY
            }
            "rw" => {
                result.flags.remove(MsFlags::MS_RDONLY);
                result.recursive_readonly = false;
                continue;
            }
            "nosuid" => MsFlags::MS_NOSUID,
            "noexec" => MsFlags::MS_NOEXEC,
            "nodev" => MsFlags::MS_NODEV,
            "strictatime" => MsFlags::MS_STRICTATIME,
            "private" => {
                result.propagation = MsFlags::MS_PRIVATE;
                continue;
            }
            "rprivate" => {
                result.propagation = MsFlags::MS_PRIVATE | MsFlags::MS_REC;
                continue;
            }
            "slave" => {
                result.propagation = MsFlags::MS_SLAVE;
                continue;
            }
            "rslave" => {
                result.propagation = MsFlags::MS_SLAVE | MsFlags::MS_REC;
                continue;
            }
            data if spec.kind.is_some() => {
                result.data.push(data);
                continue;
            }
            other => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unsupported bind option {other}"),
                ));
            }
        };
        result.flags |= flag;
    }
    Ok(result)
}

fn apply_mount(root: &OwnedFd, spec: &MountSpec) -> io::Result<()> {
    let opts = options(spec)?;
    let is_bind = spec.kind.is_none();
    let directory = !is_bind || spec.source.metadata()?.is_dir();
    let target = scoped(root, &spec.destination, Some(directory))?;
    if is_bind {
        let bind_flags = opts.flags & (MsFlags::MS_BIND | MsFlags::MS_REC);
        if !bind_flags.contains(MsFlags::MS_BIND) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "bind mount requires bind or rbind",
            ));
        }
        mount_fs(
            Some(&spec.source),
            &proc_path(&target),
            None,
            bind_flags,
            None,
        )?;
        let mounted = scoped(root, &spec.destination, None)?;
        let attrs = opts.flags - bind_flags;
        if !attrs.is_empty() {
            remount(&proc_path(&mounted), attrs)?;
        }
        if opts.recursive_readonly {
            recursive_readonly(&mounted)?;
        }
    } else {
        let data = opts.data.join(",");
        mount_fs(
            Some(&spec.source),
            &proc_path(&target),
            spec.kind.as_deref(),
            opts.flags,
            Some(&data),
        )?;
    }
    if !opts.propagation.is_empty() {
        let mounted = scoped(root, &spec.destination, None)?;
        mount_fs(None, &proc_path(&mounted), None, opts.propagation, None)?;
    }
    Ok(())
}

fn remount(path: &Path, attrs: MsFlags) -> io::Result<()> {
    // A bind remount otherwise overwrites existing per-mount restrictions.
    // Linux reports ST_RELATIME as 0x1000, but musl does not expose the
    // constant and nix strips unknown bits from Statvfs::flags().
    const ST_RELATIME: libc::c_ulong = 0x1000;
    let cpath = CString::new(path.as_os_str().as_bytes())?;
    let mut stat = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: cpath is NUL-terminated and stat points to writable storage.
    if unsafe { libc::statvfs(cpath.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statvfs succeeded and initialized the buffer.
    let flags = unsafe { stat.assume_init() }.f_flag;
    let preserve = MsFlags::MS_RDONLY
        | MsFlags::MS_NOSUID
        | MsFlags::MS_NODEV
        | MsFlags::MS_NOEXEC
        | MsFlags::MS_NOATIME
        | MsFlags::MS_NODIRATIME;
    let mut old = MsFlags::from_bits_truncate(flags as _) & preserve;
    if flags & ST_RELATIME != 0 {
        old |= MsFlags::MS_RELATIME;
    }
    mount_fs(
        None,
        path,
        None,
        MsFlags::MS_BIND | MsFlags::MS_REMOUNT | attrs | old,
        None,
    )
}

fn recursive_readonly(fd: &OwnedFd) -> io::Result<()> {
    let attr = sys::MountAttr {
        attr_set: sys::MOUNT_ATTR_RDONLY,
        attr_clr: 0,
        propagation: 0,
        userns_fd: 0,
    };
    match sys::mount_setattr(
        fd.as_raw_fd(),
        c"",
        sys::AT_EMPTY_PATH | sys::AT_RECURSIVE,
        &attr,
    ) {
        Ok(()) => return Ok(()),
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(nix::libc::ENOSYS | nix::libc::EINVAL | nix::libc::EOPNOTSUPP)
            ) => {}
        Err(e) => return Err(e),
    }
    // Older kernels: find this mount's descendants and remount each one.
    // Do not downgrade rro to a top-level remount that leaves cgroup2 writable.
    let root = std::fs::read_link(proc_path(fd))?;
    let info = std::fs::read("/proc/self/mountinfo")?;
    let mut descendants: Vec<_> = info
        .split(|b| *b == b'\n')
        .filter_map(|line| {
            let field = line.split(|b| *b == b' ').nth(4)?;
            let path = unescape_mountinfo(field);
            (path != root && path.starts_with(&root)).then_some(path)
        })
        .collect();
    descendants.sort_unstable();
    descendants.dedup();
    for path in descendants.iter().rev() {
        remount(path, MsFlags::MS_RDONLY)?;
    }
    remount(&proc_path(fd), MsFlags::MS_RDONLY)
}

fn unescape_mountinfo(input: &[u8]) -> PathBuf {
    let mut out = Vec::new();
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'\\'
            && input
                .get(i + 1..i + 4)
                .is_some_and(|v| v.iter().all(|b| (b'0'..=b'7').contains(b)))
        {
            out.push((input[i + 1] - b'0') * 64 + (input[i + 2] - b'0') * 8 + input[i + 3] - b'0');
            i += 4;
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    OsString::from_vec(out).into()
}

fn make_device(root: &OwnedFd, device: &Device) -> io::Result<()> {
    let dir = scoped(root, device.path.parent().unwrap(), Some(true))?;
    let kind = if device.block {
        SFlag::S_IFBLK
    } else {
        SFlag::S_IFCHR
    };
    mknod(
        &proc_path(&dir).join(device.path.file_name().unwrap()),
        kind,
        Mode::from_bits_truncate(device.mode),
        nix::sys::stat::makedev(device.major, device.minor),
    )?;
    Ok(())
}

fn populate_dev(root: &OwnedFd, spec: &InitSpec) -> io::Result<()> {
    for (name, major, minor) in [
        ("null", 1, 3),
        ("zero", 1, 5),
        ("full", 1, 7),
        ("random", 1, 8),
        ("urandom", 1, 9),
        ("tty", 5, 0),
    ] {
        let path = Path::new("/dev").join(name);
        if !spec.devices.0.iter().any(|d| d.path == path) {
            make_device(
                root,
                &Device {
                    path,
                    block: false,
                    major,
                    minor,
                    mode: 0o666,
                },
            )?;
        }
    }
    for device in &spec.devices.0 {
        make_device(root, device)?;
    }
    let dev = scoped(root, Path::new("/dev"), None)?;
    for (name, target) in [
        ("ptmx", "pts/ptmx"),
        ("fd", "/proc/self/fd"),
        ("stdin", "/proc/self/fd/0"),
        ("stdout", "/proc/self/fd/1"),
        ("stderr", "/proc/self/fd/2"),
        ("core", "/proc/kcore"),
    ] {
        std::os::unix::fs::symlink(target, proc_path(&dev).join(name))?;
    }
    Ok(())
}

fn mount_private_cgroup(root: &OwnedFd, spec: &MountSpec, cgroup: &File) -> io::Result<()> {
    // Bind the pinned subtree, not the guest hierarchy, so the container
    // sees its own limits without a new cgroup2 superblock mount.
    let target = scoped(root, &spec.destination, Some(true))?;
    mount_fs(
        Some(&proc_path(cgroup)),
        &proc_path(&target),
        None,
        MsFlags::MS_BIND,
        None,
    )?;
    let mounted = scoped(root, &spec.destination, None)?;
    remount(&proc_path(&mounted), options(spec)?.flags)
}

pub(super) fn prepare(spec: &InitSpec, cgroup: Option<&File>) -> io::Result<()> {
    // No propagation back to guest mounts (including volume attach paths).
    mount_fs(
        None,
        Path::new("/"),
        None,
        MsFlags::MS_REC | MsFlags::MS_PRIVATE,
        None,
    )?;
    let root_path = std::fs::canonicalize(&spec.rootfs)?;
    mount_fs(
        Some(&root_path),
        &root_path,
        None,
        MsFlags::MS_BIND | MsFlags::MS_REC,
        None,
    )?;
    let root = open_path(None, &root_path)?;
    let old_umask = nix::sys::stat::umask(Mode::empty());
    for spec_mount in &spec.mounts {
        let mounted = if spec_mount.kind.as_deref() == Some("cgroup2") {
            cgroup.map_or(Ok(()), |group| {
                mount_private_cgroup(&root, spec_mount, group)
            })
        } else {
            apply_mount(&root, spec_mount)
        };
        mounted.map_err(|e| {
            io::Error::other(format!("prepare {}: {e}", spec_mount.destination.display()))
        })?;
        if spec_mount.destination == Path::new("/dev/shm") && spec_mount.kind.is_some() {
            populate_dev(&root, spec)?;
        }
    }
    nix::sys::stat::umask(old_umask);
    for &path in MASKED_PATHS {
        let Some(fd) = optional_path(&root, Path::new(path))? else {
            continue;
        };
        if file_type(&fd)? == SFlag::S_IFDIR {
            mount_fs(
                None,
                &proc_path(&fd),
                Some("tmpfs"),
                MsFlags::MS_RDONLY | MsFlags::MS_NOSUID | MsFlags::MS_NODEV | MsFlags::MS_NOEXEC,
                Some("size=0,mode=000"),
            )?;
        } else {
            mount_fs(
                Some(Path::new("/dev/null")),
                &proc_path(&fd),
                None,
                MsFlags::MS_BIND,
                None,
            )?;
        }
    }
    for path in &spec.readonly_paths {
        let path = Path::new(path);
        let Some(fd) = optional_path(&root, path)? else {
            continue;
        };
        let target = proc_path(&fd);
        mount_fs(
            Some(&target),
            &target,
            None,
            MsFlags::MS_BIND | MsFlags::MS_REC,
            None,
        )?;
        let mounted = scoped(&root, path, None)?;
        remount(&proc_path(&mounted), MsFlags::MS_RDONLY)?;
    }
    // Stack the old root over the new one and detach it; no put_old dir is
    // written to the image or left behind in the container.
    fchdir(root.as_raw_fd())?;
    pivot_root(".", ".")?;
    umount2(".", MntFlags::MNT_DETACH)?;
    chdir("/")?;
    Ok(())
}

fn optional_path(root: &OwnedFd, path: &Path) -> io::Result<Option<OwnedFd>> {
    match scoped(root, path, None) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        other => other.map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_relative_symlinks_and_parent_traversals_stay_inside() {
        let dir = tempfile::tempdir().unwrap();
        let root = open_path(None, dir.path()).unwrap();
        std::os::unix::fs::symlink("/../../../inside/file", dir.path().join("link")).unwrap();
        let file = scoped(&root, Path::new("/link"), Some(false)).unwrap();
        assert_eq!(
            std::fs::read_link(proc_path(&file)).unwrap(),
            dir.path().join("inside/file")
        );
    }
}
