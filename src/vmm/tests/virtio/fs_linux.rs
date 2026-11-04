// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Independent consumers of the per-share backend, using real host files.
use std::ffi::{CStr, CString, OsString};
use std::fs::{self, File};
use std::io::{self, Cursor, Read, Write};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{FileExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::{
    Arc, Barrier,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::time::Duration;

use crate::virtio::fs::filesystem::{
    Context, Entry, Extensions, FileSystem, FsOptions, GetxattrReply, ListxattrReply, OpenOptions,
    SetattrValid, ZeroCopyReader, ZeroCopyWriter,
};
use crate::virtio::fs::linux::passthrough::PassthroughFs;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "boxlite-fs-linux-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn backend(&self) -> PassthroughFs {
        PassthroughFs::new(self.0.clone()).unwrap()
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn ctx() -> Context {
    // SAFETY: these syscalls have no side effects and always succeed.
    Context {
        uid: unsafe { libc::getuid() },
        gid: unsafe { libc::getgid() },
        pid: 0,
    }
}

fn root() -> Context {
    Context {
        uid: 0,
        gid: 0,
        pid: 0,
    }
}

fn foreign(id: u32) -> u32 {
    if id == 1 { 2 } else { 1 }
}

fn error<T>(result: io::Result<T>, code: i32) {
    match result {
        Err(error) => assert_eq!(error.raw_os_error(), Some(code)),
        Ok(_) => panic!("expected errno {code}"),
    }
}

fn create(fs: &PassthroughFs, ctx: Context, parent: u64, name: &CStr) -> (Entry, u64) {
    let (found, handle, options) = fs
        .create(
            ctx,
            parent,
            name,
            0o600,
            false,
            libc::O_RDWR as u32,
            0,
            Extensions::default(),
        )
        .unwrap();
    assert_eq!(options, OpenOptions::DIRECT_IO);
    assert_eq!(found.attr_timeout, Duration::ZERO);
    assert_eq!(found.entry_timeout, Duration::ZERO);
    (found, handle.unwrap())
}

struct Input(Cursor<Vec<u8>>);
impl Read for Input {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}
impl ZeroCopyReader for Input {
    fn read_to(&mut self, file: &File, count: usize, offset: u64) -> io::Result<usize> {
        let start = self.0.position() as usize;
        let bytes = self.0.get_ref();
        let count = count.min(bytes.len().saturating_sub(start));
        let written = file.write_at(&bytes[start..start + count], offset)?;
        self.0.set_position((start + written) as u64);
        Ok(written)
    }
}

#[derive(Default)]
struct Output(Vec<u8>);
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl ZeroCopyWriter for Output {
    fn write_from(&mut self, file: &File, count: usize, offset: u64) -> io::Result<usize> {
        let mut bytes = vec![0; count];
        let read = file.read_at(&mut bytes, offset)?;
        self.0.extend_from_slice(&bytes[..read]);
        Ok(read)
    }
}

fn read(fs: &PassthroughFs, inode: u64, handle: u64) -> io::Result<Vec<u8>> {
    let mut output = Output::default();
    fs.read(ctx(), inode, handle, &mut output, 4096, 0, None, 0)?;
    Ok(output.0)
}

fn write(fs: &PassthroughFs, inode: u64, handle: u64, bytes: &[u8]) -> io::Result<usize> {
    fs.write(
        ctx(),
        inode,
        handle,
        Input(Cursor::new(bytes.to_vec())),
        bytes.len() as u32,
        0,
        None,
        false,
        false,
        0,
    )
}

#[test]
fn guest_root_and_each_matching_credential_component_create_as_host() {
    let directory = Directory::new();
    let fs = directory.backend();
    let host = ctx();
    let before = fs::read_to_string("/proc/self/status").unwrap();
    let umask = before
        .lines()
        .find(|line| line.starts_with("Umask:"))
        .unwrap()
        .to_owned();
    for (index, (uid, gid)) in [(0, 0), (host.uid, host.gid), (0, host.gid), (host.uid, 0)]
        .into_iter()
        .enumerate()
    {
        let guest = Context { uid, gid, pid: 0 };
        let file = CString::new(format!("file-{index}")).unwrap();
        let (found, handle) = create(&fs, guest, 1, &file);
        // No guest impersonation: host kernel supplies actual ownership.
        let metadata = fs::metadata(directory.0.join(file.to_str().unwrap())).unwrap();
        assert_eq!(found.attr.st_uid, metadata.uid());
        assert_eq!(found.attr.st_gid, metadata.gid());
        assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        assert_eq!(metadata.gid(), unsafe { libc::getegid() });
        fs.release(guest, found.inode, 0, handle, false, false, None)
            .unwrap();
        let name = CString::new(format!("directory-{index}")).unwrap();
        fs.mkdir(guest, 1, &name, 0o750, 0, Extensions::default())
            .unwrap();
        let name = CString::new(format!("node-{index}")).unwrap();
        fs.mknod(
            guest,
            1,
            &name,
            libc::S_IFREG | 0o640,
            0,
            0,
            Extensions::default(),
        )
        .unwrap();
        let name = CString::new(format!("link-{index}")).unwrap();
        let link = fs
            .symlink(guest, c"missing", 1, &name, Extensions::default())
            .unwrap();
        assert_eq!(fs.readlink(guest, link.inode).unwrap(), b"missing");
    }
    let after = fs::read_to_string("/proc/self/status").unwrap();
    assert_eq!(
        after
            .lines()
            .find(|line| line.starts_with("Umask:"))
            .unwrap(),
        umask
    );
    assert_eq!((ctx().uid, ctx().gid), (host.uid, host.gid));
}

#[test]
fn foreign_creation_credentials_fail_before_any_host_mutation() {
    let directory = Directory::new();
    let fs = directory.backend();
    let host = ctx();
    for (uid, gid) in [
        (foreign(host.uid), host.gid),
        (host.uid, foreign(host.gid)),
        (0, foreign(host.gid)),
        (foreign(host.uid), 0),
    ] {
        let guest = Context { uid, gid, pid: 0 };
        error(
            fs.create(guest, 1, c"file", 0o600, false, 0, 0, Extensions::default()),
            libc::EPERM,
        );
        error(
            fs.mkdir(guest, 1, c"directory", 0o700, 0, Extensions::default()),
            libc::EPERM,
        );
        error(
            fs.mknod(
                guest,
                1,
                c"node",
                libc::S_IFREG | 0o600,
                0,
                0,
                Extensions::default(),
            ),
            libc::EPERM,
        );
        error(
            fs.symlink(guest, c"target", 1, c"link", Extensions::default()),
            libc::EPERM,
        );
    }
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
}

#[test]
fn access_checks_guest_permissions_and_never_exceeds_host_ability() {
    let directory = Directory::new();
    let path = directory.0.join("file");
    fs::write(&path, b"contents").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let fs = directory.backend();
    let inode = fs.lookup(ctx(), 1, c"file").unwrap().inode;
    let outsider = Context {
        uid: foreign(ctx().uid),
        gid: foreign(ctx().gid),
        pid: 0,
    };
    fs.access(ctx(), inode, libc::R_OK as u32).unwrap();
    fs.access(root(), inode, libc::R_OK as u32).unwrap();
    fs.access(outsider, inode, libc::F_OK as u32).unwrap();
    error(fs.access(outsider, inode, libc::R_OK as u32), libc::EACCES);
    error(fs.access(root(), inode, libc::X_OK as u32), libc::EACCES);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    let group = Context {
        uid: foreign(ctx().uid),
        gid: ctx().gid,
        pid: 0,
    };
    fs.access(group, inode, libc::R_OK as u32).unwrap();
    error(fs.access(group, inode, libc::W_OK as u32), libc::EACCES);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
    // Independent host-path check establishes the host boundary even when the
    // test runner itself is root; guest root must not bypass a host denial.
    let name = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    let allowed =
        unsafe { libc::faccessat(libc::AT_FDCWD, name.as_ptr(), libc::R_OK, libc::AT_EACCESS) };
    let actual = fs.access(root(), inode, libc::R_OK as u32);
    if allowed == 0 {
        actual.unwrap();
    } else {
        error(actual, libc::EACCES);
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn never_cache_replies_and_open_objects_survive_repeated_forget_and_unlink() {
    let directory = Directory::new();
    let fs = directory.backend();
    let (found, handle) = create(&fs, root(), 1, c"file");
    let (another, options) = fs
        .open(ctx(), found.inode, false, libc::O_RDWR as u32)
        .unwrap();
    let another = another.unwrap();
    assert_eq!(options, OpenOptions::DIRECT_IO);
    assert_eq!(write(&fs, found.inode, handle, b"first").unwrap(), 5);
    assert_eq!(
        fs.getattr(ctx(), found.inode, Some(handle)).unwrap().1,
        Duration::ZERO
    );
    let duplicate = fs.lookup(ctx(), 1, c"file").unwrap();
    assert_eq!(duplicate.inode, found.inode);
    fs.forget(ctx(), found.inode, 1);
    fs.forget(ctx(), found.inode, u64::MAX);
    fs.forget(ctx(), found.inode, u64::MAX);
    fs.rename(ctx(), 1, c"file", 1, c"moved", 0).unwrap();
    fs.unlink(ctx(), 1, c"moved").unwrap();
    assert_eq!(fs.getattr(ctx(), found.inode, None).unwrap().0.st_nlink, 0);
    for _ in 0..3 {
        fs.flush(ctx(), found.inode, handle, 0).unwrap();
    }
    assert_eq!(read(&fs, found.inode, another).unwrap(), b"first");
    write(&fs, found.inode, another, b"later").unwrap();
    fs.fsync(ctx(), found.inode, false, handle).unwrap();
    fs.fsync(ctx(), found.inode, true, another).unwrap();
    fs.release(ctx(), found.inode, 0, handle, false, false, None)
        .unwrap();
    assert_eq!(read(&fs, found.inode, another).unwrap(), b"later");
    fs.release(ctx(), found.inode, 0, another, false, false, None)
        .unwrap();
    error(fs.getattr(ctx(), found.inode, None), libc::EBADF);
    error(read(&fs, found.inode, another), libc::EBADF);
    let (next, next_handle) = create(&fs, ctx(), 1, c"next");
    assert!(next.inode > found.inode);
    assert!(next_handle > another);
    let (directory_handle, options) = fs.opendir(ctx(), 1, 0).unwrap();
    assert_eq!(options, OpenOptions::empty());
    fs.fsyncdir(ctx(), 1, false, directory_handle.unwrap())
        .unwrap();
}

struct PausedOutput {
    entered: mpsc::Sender<()>,
    resume: mpsc::Receiver<()>,
    bytes: Vec<u8>,
}
impl Write for PausedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl ZeroCopyWriter for PausedOutput {
    fn write_from(&mut self, file: &File, count: usize, offset: u64) -> io::Result<usize> {
        self.entered.send(()).unwrap();
        self.resume.recv_timeout(Duration::from_secs(10)).unwrap();
        let mut bytes = vec![0; count];
        let count = file.read_at(&mut bytes, offset)?;
        self.bytes.extend_from_slice(&bytes[..count]);
        Ok(count)
    }
}

#[test]
fn an_inflight_read_retains_the_object_after_release_and_forget() {
    let directory = Directory::new();
    fs::write(directory.0.join("file"), b"still open").unwrap();
    let fs = Arc::new(directory.backend());
    let inode = fs.lookup(ctx(), 1, c"file").unwrap().inode;
    let handle = fs.open(ctx(), inode, false, 0).unwrap().0.unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let worker = {
        let fs = fs.clone();
        std::thread::spawn(move || {
            let mut output = PausedOutput {
                entered: entered_tx,
                resume: resume_rx,
                bytes: Vec::new(),
            };
            fs.read(ctx(), inode, handle, &mut output, 4096, 0, None, 0)
                .unwrap();
            output.bytes
        })
    };
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    fs.forget(ctx(), inode, u64::MAX);
    fs.release(ctx(), inode, 0, handle, false, false, None)
        .unwrap();
    let metadata = fs.getattr(ctx(), inode, None);
    resume_tx.send(()).unwrap();
    assert_eq!(worker.join().unwrap(), b"still open");
    assert_eq!(metadata.unwrap().0.st_size, 10);
    error(fs.getattr(ctx(), inode, None), libc::EBADF);
}

#[test]
fn concurrent_hardlink_lookups_share_identity_and_exact_reference_counts() {
    let directory = Directory::new();
    fs::write(directory.0.join("a"), b"same object").unwrap();
    fs::hard_link(directory.0.join("a"), directory.0.join("b")).unwrap();
    let fs = Arc::new(directory.backend());
    let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|index| {
            let fs = fs.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                fs.lookup(ctx(), 1, if index % 2 == 0 { c"a" } else { c"b" })
                    .unwrap()
            })
        })
        .collect();
    let entries: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let inode = entries[0].inode;
    for found in &entries {
        assert_eq!(found.inode, inode);
        assert_eq!(found.attr.st_ino, entries[0].attr.st_ino);
    }
    let linked = fs.link(ctx(), inode, 1, c"c").unwrap();
    assert_eq!(linked.inode, inode);
    assert_eq!(linked.attr.st_ino, entries[0].attr.st_ino);
    for _ in 0..8 {
        fs.forget(ctx(), inode, 1);
        assert!(fs.getattr(ctx(), inode, None).is_ok());
    }
    fs.forget(ctx(), inode, 1);
    error(fs.getattr(ctx(), inode, None), libc::EBADF);
    let again = fs.lookup(ctx(), 1, c"a").unwrap();
    assert!(again.inode > inode);
    assert_eq!(again.attr.st_ino, entries[0].attr.st_ino);
}

#[test]
fn root_is_pinned_at_construction_and_init_never_reuses_old_ids() {
    let directory = Directory::new();
    let share = directory.0.join("share");
    fs::create_dir(&share).unwrap();
    fs::write(share.join("original"), b"pinned").unwrap();
    let fs = PassthroughFs::new(share.clone()).unwrap();
    let before = fs.lookup(ctx(), 1, c"original").unwrap();
    let handle = fs.open(ctx(), before.inode, false, 0).unwrap().0.unwrap();
    let root_attr = fs.getattr(ctx(), 1, None).unwrap().0;
    fs.forget(ctx(), 1, u64::MAX);
    assert_eq!(
        fs.lookup(ctx(), 1, c"..").unwrap().attr.st_ino,
        root_attr.st_ino
    );
    fs::rename(&share, directory.0.join("moved")).unwrap();
    fs::create_dir(&share).unwrap();
    fs::write(share.join("replacement"), b"not exported").unwrap();
    fs.destroy();
    fs.init(FsOptions::all()).unwrap();
    error(fs.getattr(ctx(), before.inode, None), libc::EBADF);
    error(read(&fs, before.inode, handle), libc::EBADF);
    error(fs.lookup(ctx(), 1, c"replacement"), libc::ENOENT);
    let after = fs.lookup(ctx(), 1, c"original").unwrap();
    assert!(after.inode > before.inode);
    let next_handle = fs.open(ctx(), after.inode, false, 0).unwrap().0.unwrap();
    assert!(next_handle > handle);
    assert_eq!(read(&fs, after.inode, next_handle).unwrap(), b"pinned");
    assert_eq!(
        fs.getattr(ctx(), 1, None).unwrap().0.st_ino,
        root_attr.st_ino
    );
}

#[test]
fn directory_cookies_resume_and_rejected_plus_entries_do_not_keep_lookups() {
    let directory = Directory::new();
    for index in 0..300 {
        fs::write(directory.0.join(format!("file-{index:03}")), b"x").unwrap();
    }
    let raw_name = vec![b'x', 0xff];
    fs::write(
        directory.0.join(OsString::from_vec(raw_name.clone())),
        b"raw name",
    )
    .unwrap();
    let fs = directory.backend();
    let handle = fs.opendir(ctx(), 1, 0).unwrap().0.unwrap();
    let mut offset = 0;
    let mut names = std::collections::BTreeSet::new();
    loop {
        let mut accepted = false;
        fs.readdir(ctx(), 1, handle, 64, offset, |dirent| {
            if accepted {
                return Ok(0);
            }
            assert!(names.insert(dirent.name.to_vec()));
            offset = dirent.offset;
            accepted = true;
            Ok(32)
        })
        .unwrap();
        if !accepted {
            break;
        }
    }
    assert_eq!(names.len(), 301);
    assert!(names.contains(&raw_name));
    let mut rejected = 0;
    fs.readdirplus(ctx(), 1, handle, 4096, 0, |_, found| {
        rejected = found.inode;
        Ok(0)
    })
    .unwrap();
    assert_ne!(rejected, 0);
    error(fs.getattr(ctx(), rejected, None), libc::EBADF);
    let mut failed = 0;
    error(
        fs.readdirplus(ctx(), 1, handle, 4096, 0, |_, found| {
            failed = found.inode;
            Err(io::Error::from_raw_os_error(libc::ENOSPC))
        }),
        libc::ENOSPC,
    );
    error(fs.getattr(ctx(), failed, None), libc::EBADF);
    let mut found = Vec::new();
    fs.readdirplus(ctx(), 1, handle, 65536, 0, |dirent, entry| {
        assert_eq!(dirent.ino, entry.attr.st_ino);
        found.push(entry.inode);
        Ok(1)
    })
    .unwrap();
    assert_eq!(found.len(), 301);
    for inode in found {
        fs.forget(ctx(), inode, 1);
        error(fs.getattr(ctx(), inode, None), libc::EBADF);
    }
    fs.releasedir(ctx(), 1, 0, handle).unwrap();
}

#[test]
fn malformed_components_never_mutate_or_escape_the_share() {
    let directory = Directory::new();
    fs::write(directory.0.join("file"), b"unchanged").unwrap();
    let fs = directory.backend();
    let inode = fs.lookup(ctx(), 1, c"file").unwrap().inode;
    for name in [c"", c"/absolute", c"nested/name", c"../outside"] {
        error(fs.lookup(ctx(), 1, name), libc::EINVAL);
    }
    for name in [
        c"",
        c"/absolute",
        c"nested/name",
        c"../outside",
        c".",
        c"..",
    ] {
        error(
            fs.create(ctx(), 1, name, 0o600, false, 0, 0, Extensions::default()),
            libc::EINVAL,
        );
        error(
            fs.mkdir(ctx(), 1, name, 0o700, 0, Extensions::default()),
            libc::EINVAL,
        );
        error(
            fs.mknod(
                ctx(),
                1,
                name,
                libc::S_IFREG | 0o600,
                0,
                0,
                Extensions::default(),
            ),
            libc::EINVAL,
        );
        error(
            fs.symlink(ctx(), c"target", 1, name, Extensions::default()),
            libc::EINVAL,
        );
        error(fs.link(ctx(), inode, 1, name), libc::EINVAL);
        error(fs.unlink(ctx(), 1, name), libc::EINVAL);
        error(fs.rmdir(ctx(), 1, name), libc::EINVAL);
        error(fs.rename(ctx(), 1, c"file", 1, name, 0), libc::EINVAL);
        error(
            fs.rename(ctx(), 1, name, 1, c"replacement", 0),
            libc::EINVAL,
        );
    }
    assert_eq!(fs::read(directory.0.join("file")).unwrap(), b"unchanged");
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[test]
fn special_files_symlink_targets_and_unsupported_extensions_are_not_opened() {
    let directory = Directory::new();
    let fs = directory.backend();
    let (file, handle) = create(&fs, ctx(), 1, c"file");
    write(&fs, file.inode, handle, b"unchanged").unwrap();
    for kind in [libc::S_IFIFO, libc::S_IFCHR, libc::S_IFBLK, libc::S_IFSOCK] {
        error(
            fs.mknod(
                ctx(),
                1,
                c"special",
                kind | 0o600,
                0,
                0,
                Extensions::default(),
            ),
            libc::EOPNOTSUPP,
        );
        error(
            fs.create(
                ctx(),
                1,
                c"special",
                kind | 0o600,
                false,
                0,
                0,
                Extensions::default(),
            ),
            libc::EOPNOTSUPP,
        );
    }
    let fifo = CString::new(directory.0.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let fifo_inode = fs.lookup(ctx(), 1, c"fifo").unwrap().inode;
    error(
        fs.open(ctx(), fifo_inode, false, libc::O_RDWR as u32),
        libc::EOPNOTSUPP,
    );
    error(
        fs.create(ctx(), 1, c"fifo", 0o600, false, 0, 0, Extensions::default()),
        libc::EOPNOTSUPP,
    );
    let _socket = UnixListener::bind(directory.0.join("socket")).unwrap();
    let socket_inode = fs.lookup(ctx(), 1, c"socket").unwrap().inode;
    error(fs.open(ctx(), socket_inode, false, 0), libc::EOPNOTSUPP);
    let link = fs
        .symlink(ctx(), c"/etc/passwd", 1, c"link", Extensions::default())
        .unwrap();
    assert_eq!(fs.readlink(ctx(), link.inode).unwrap(), b"/etc/passwd");
    error(fs.open(ctx(), link.inode, false, 0), libc::ELOOP);
    error(fs.link(ctx(), link.inode, 1, c"hardlink"), libc::EOPNOTSUPP);
    error(
        fs.create(
            ctx(),
            1,
            c"link",
            0o600,
            false,
            libc::O_TRUNC as u32,
            0,
            Extensions::default(),
        ),
        libc::ELOOP,
    );
    error(
        fs.open(ctx(), file.inode, true, libc::O_TRUNC as u32),
        libc::EOPNOTSUPP,
    );
    error(
        fs.create(
            ctx(),
            1,
            c"killpriv",
            0o600,
            true,
            0,
            0,
            Extensions::default(),
        ),
        libc::EOPNOTSUPP,
    );
    for extensions in [
        Extensions {
            secctx: Some(()),
            sup_gid: None,
        },
        Extensions {
            secctx: None,
            sup_gid: Some(1),
        },
    ] {
        error(
            fs.create(
                ctx(),
                1,
                c"extension",
                0o600,
                false,
                0,
                0,
                extensions.clone(),
            ),
            libc::EOPNOTSUPP,
        );
        error(
            fs.mkdir(ctx(), 1, c"extension", 0o700, 0, extensions.clone()),
            libc::EOPNOTSUPP,
        );
        error(
            fs.symlink(ctx(), c"target", 1, c"extension", extensions.clone()),
            libc::EOPNOTSUPP,
        );
        error(
            fs.mknod(
                ctx(),
                1,
                c"extension",
                libc::S_IFREG | 0o600,
                0,
                0,
                extensions,
            ),
            libc::EOPNOTSUPP,
        );
    }
    assert_eq!(fs::read(directory.0.join("file")).unwrap(), b"unchanged");
    for name in ["special", "hardlink", "killpriv", "extension"] {
        assert!(!directory.0.join(name).exists());
    }
    error(
        fs.getxattr(ctx(), link.inode, c"user.test", 0),
        libc::EOPNOTSUPP,
    );
}

#[test]
fn setattr_modes_size_and_times_use_owned_objects_without_read_permission() {
    let directory = Directory::new();
    fs::write(directory.0.join("file"), b"truncate me").unwrap();
    let fs = directory.backend();
    let inode = fs.lookup(ctx(), 1, c"file").unwrap().inode;
    let mut attr = fs.getattr(ctx(), inode, None).unwrap().0;
    attr.st_mode = 0;
    fs.setattr(ctx(), inode, attr, None, SetattrValid::MODE)
        .unwrap();
    attr.st_mode = 0o200;
    let restore = fs.setattr(ctx(), inode, attr, None, SetattrValid::MODE);
    fs::set_permissions(directory.0.join("file"), fs::Permissions::from_mode(0o200)).unwrap();
    restore.unwrap();
    attr.st_size = 3;
    attr.st_atime = 1_600_000_000;
    attr.st_atime_nsec = 123;
    attr.st_mtime = 1_600_000_100;
    attr.st_mtime_nsec = 456;
    let (changed, timeout) = fs
        .setattr(
            ctx(),
            inode,
            attr,
            None,
            SetattrValid::SIZE | SetattrValid::ATIME | SetattrValid::MTIME,
        )
        .unwrap();
    assert_eq!(changed.st_size, 3);
    assert_eq!(
        (changed.st_atime, changed.st_atime_nsec),
        (attr.st_atime, 123)
    );
    assert_eq!(
        (changed.st_mtime, changed.st_mtime_nsec),
        (attr.st_mtime, 456)
    );
    assert_eq!(timeout, Duration::ZERO);
    attr.st_mode = 0o600;
    fs.setattr(ctx(), inode, attr, None, SetattrValid::MODE)
        .unwrap();
    assert_eq!(fs::read(directory.0.join("file")).unwrap(), b"tru");
    let before = fs.getattr(ctx(), inode, None).unwrap().0;
    attr.st_size = -1;
    attr.st_mode = 0o777;
    error(
        fs.setattr(
            ctx(),
            inode,
            attr,
            None,
            SetattrValid::MODE | SetattrValid::SIZE,
        ),
        libc::EINVAL,
    );
    let after = fs.getattr(ctx(), inode, None).unwrap().0;
    assert_eq!(
        (after.st_size, after.st_mode),
        (before.st_size, before.st_mode)
    );
    attr.st_size = 0;
    error(
        fs.setattr(
            ctx(),
            inode,
            attr,
            None,
            SetattrValid::SIZE | SetattrValid::KILL_SUIDGID,
        ),
        libc::EOPNOTSUPP,
    );
    assert_eq!(fs::metadata(directory.0.join("file")).unwrap().len(), 3);
    let readonly = fs.open(ctx(), inode, false, 0).unwrap().0.unwrap();
    error(
        fs.setattr(
            ctx(),
            inode,
            attr,
            Some(readonly),
            SetattrValid::MODE | SetattrValid::SIZE,
        ),
        libc::EBADF,
    );
    assert_eq!(
        fs.getattr(ctx(), inode, None).unwrap().0.st_mode,
        before.st_mode
    );
    fs.release(ctx(), inode, 0, readonly, false, false, None)
        .unwrap();
    // Source SETATTR uses host authority, not its request Context; chown to
    // the actual current owner must not impersonate or change host credentials.
    for guest in [
        root(),
        ctx(),
        Context {
            uid: foreign(ctx().uid),
            gid: foreign(ctx().gid),
            pid: 0,
        },
    ] {
        let mut same_owner = fs.getattr(guest, inode, None).unwrap().0;
        same_owner.st_mode = 0o640;
        let result = fs
            .setattr(
                guest,
                inode,
                same_owner,
                None,
                SetattrValid::UID | SetattrValid::GID | SetattrValid::MODE,
            )
            .unwrap()
            .0;
        assert_eq!(
            (result.st_uid, result.st_gid),
            (same_owner.st_uid, same_owner.st_gid)
        );
    }
}

#[test]
fn carried_linux_statfs_allocation_seek_copy_and_xattrs_use_real_files() {
    let directory = Directory::new();
    let fs = directory.backend();
    let (source, source_handle) = create(&fs, ctx(), 1, c"source");
    let (target, target_handle) = create(&fs, ctx(), 1, c"target");
    write(&fs, source.inode, source_handle, b"binary\0data").unwrap();
    let copied = fs
        .copyfilerange(
            ctx(),
            source.inode,
            source_handle,
            0,
            target.inode,
            target_handle,
            0,
            11,
            0,
        )
        .unwrap();
    assert_eq!(copied, 11);
    assert_eq!(
        fs::read(directory.0.join("target")).unwrap(),
        b"binary\0data"
    );
    assert_eq!(
        fs.lseek(ctx(), target.inode, target_handle, 0, libc::SEEK_END as u32)
            .unwrap(),
        11
    );
    assert!(fs.statfs(ctx(), source.inode).unwrap().f_bsize > 0);
    fs.fallocate(ctx(), target.inode, target_handle, 0, 0, 4096)
        .unwrap();
    assert_eq!(
        fs::metadata(directory.0.join("target")).unwrap().len(),
        4096
    );
    fs.setxattr(ctx(), source.inode, c"user.boxlite", b"value\0bytes", 0)
        .unwrap();
    match fs
        .getxattr(ctx(), source.inode, c"user.boxlite", 0)
        .unwrap()
    {
        GetxattrReply::Count(count) => assert_eq!(count, 11),
        GetxattrReply::Value(_) => panic!("expected xattr length"),
    }
    match fs
        .getxattr(ctx(), source.inode, c"user.boxlite", 11)
        .unwrap()
    {
        GetxattrReply::Value(bytes) => assert_eq!(bytes, b"value\0bytes"),
        GetxattrReply::Count(_) => panic!("expected xattr bytes"),
    }
    error(
        fs.getxattr(ctx(), source.inode, c"user.boxlite", 1),
        libc::ERANGE,
    );
    let count = match fs.listxattr(ctx(), source.inode, 0).unwrap() {
        ListxattrReply::Count(count) => count,
        ListxattrReply::Names(_) => panic!("expected xattr list length"),
    };
    match fs.listxattr(ctx(), source.inode, count).unwrap() {
        ListxattrReply::Names(bytes) => assert!(
            bytes
                .split(|byte| *byte == 0)
                .any(|name| name == b"user.boxlite")
        ),
        ListxattrReply::Count(_) => panic!("expected xattr names"),
    }
    fs.removexattr(ctx(), source.inode, c"user.boxlite")
        .unwrap();
    error(
        fs.getxattr(ctx(), source.inode, c"user.boxlite", 0),
        libc::ENODATA,
    );
}
