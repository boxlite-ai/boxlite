// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! These tests operate on real host files, without a guest or /dev/kvm.
use std::ffi::{CStr, CString, OsString};
use std::fs::{self, File};
use std::io::{self, Cursor, Read, Write};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::FileExt;
use std::path::PathBuf;
use std::sync::{
    Arc, Barrier,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use crate::virtio::fs::filesystem::{
    Context, Extensions, FileSystem, FsOptions, SetattrValid, ZeroCopyReader, ZeroCopyWriter,
};
use crate::virtio::fs::{AggregateFs, Share};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "boxlite-fs-backend-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn backend(&self) -> AggregateFs {
        AggregateFs::new(vec![
            Share {
                name: "rw".into(),
                path: self.0.clone(),
                read_only: false,
            },
            Share {
                name: "ro".into(),
                path: self.0.clone(),
                read_only: true,
            },
            Share {
                name: "other".into(),
                path: self.0.clone(),
                read_only: false,
            },
        ])
        .unwrap()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn ctx() -> Context {
    Context {
        // SAFETY: querying the process identity has no memory effects.
        uid: unsafe { libc::geteuid() },
        // SAFETY: querying the process identity has no memory effects.
        gid: unsafe { libc::getegid() },
        pid: 0,
    }
}
fn c(bytes: &[u8]) -> CString {
    CString::new(bytes).unwrap()
}
fn lookup(fs: &AggregateFs, parent: u64, name: &CStr) -> u64 {
    fs.lookup(ctx(), parent, name).unwrap().inode
}
fn roots(fs: &AggregateFs) -> (u64, u64, u64) {
    (
        lookup(fs, 1, c"rw"),
        lookup(fs, 1, c"ro"),
        lookup(fs, 1, c"other"),
    )
}
fn error<T>(result: io::Result<T>, code: i32) {
    match result {
        Err(error) => assert_eq!(error.raw_os_error(), Some(code)),
        Ok(_) => panic!("expected errno {code}"),
    }
}

struct Input(Cursor<Vec<u8>>);
impl Read for Input {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        self.0.read(out)
    }
}
impl ZeroCopyReader for Input {
    fn read_to(&mut self, file: &File, count: usize, off: u64) -> io::Result<usize> {
        let start = self.0.position() as usize;
        let bytes = self.0.get_ref();
        let length = count.min(bytes.len().saturating_sub(start));
        let written = file.write_at(&bytes[start..start + length], off)?;
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
    fn write_from(&mut self, file: &File, count: usize, off: u64) -> io::Result<usize> {
        let mut bytes = vec![0; count];
        let read = file.read_at(&mut bytes, off)?;
        self.0.extend_from_slice(&bytes[..read]);
        Ok(read)
    }
}
fn write(fs: &AggregateFs, inode: u64, handle: u64, bytes: &[u8]) -> io::Result<usize> {
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
fn read(fs: &AggregateFs, inode: u64, handle: u64) -> io::Result<Vec<u8>> {
    let mut output = Output::default();
    fs.read(ctx(), inode, handle, &mut output, 4096, 0, None, 0)?;
    Ok(output.0)
}
fn open(fs: &AggregateFs, inode: u64, flags: i32) -> u64 {
    fs.open(ctx(), inode, false, flags as u32)
        .unwrap()
        .0
        .unwrap()
}
fn create(fs: &AggregateFs, parent: u64, name: &CStr) -> (u64, u64) {
    let (entry, handle, _) = fs
        .create(
            ctx(),
            parent,
            name,
            0o600,
            false,
            libc::O_RDWR as u32,
            0,
            Extensions::default(),
        )
        .unwrap();
    (entry.inode, handle.unwrap())
}

#[test]
fn read_write_fsync_and_open_handle_survive_rename_unlink() {
    let dir = Directory::new();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let (inode, handle) = create(&fs, rw, c"file");
    assert_eq!(write(&fs, inode, handle, b"hello").unwrap(), 5);
    fs.fsync(ctx(), inode, false, handle).unwrap();
    assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"hello");
    fs.rename(ctx(), rw, c"file", rw, c"renamed", 0).unwrap();
    fs.unlink(ctx(), rw, c"renamed").unwrap();
    assert!(!dir.0.join("renamed").exists());
    fs.forget(ctx(), inode, 1);
    assert_eq!(read(&fs, inode, handle).unwrap(), b"hello");
    write(&fs, inode, handle, b"world").unwrap();
    fs.fsync(ctx(), inode, true, handle).unwrap();
    assert_eq!(read(&fs, inode, handle).unwrap(), b"world");
    fs.release(ctx(), inode, 0, handle, false, false, None)
        .unwrap();
    error(fs.getattr(ctx(), inode, None), libc::EBADF);
    error(read(&fs, inode, handle), libc::EBADF);
}

#[test]
fn cold_readdir_preserves_hardlink_identity_without_lookup_references() {
    let dir = Directory::new();
    fs::write(dir.0.join("a"), b"same").unwrap();
    fs::hard_link(dir.0.join("a"), dir.0.join("b")).unwrap();
    let fs = dir.backend();
    let (rw, ro, _) = roots(&fs);
    let handle = fs.opendir(ctx(), rw, 0).unwrap().0.unwrap();
    let mut entries = Vec::new();
    fs.readdir(ctx(), rw, handle, 4096, 0, |entry| {
        if entry.name != b"." && entry.name != b".." {
            entries.push(entry.ino);
        }
        Ok(1)
    })
    .unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0], entries[1],
        "cold READDIR must identify hardlinks"
    );
    fs.releasedir(ctx(), rw, 0, handle).unwrap();

    for name in [c"a", c"b"] {
        let entry = fs.lookup(ctx(), rw, name).unwrap();
        assert_eq!(entry.attr.st_ino, entries[0]);
        assert_eq!(
            fs.getattr(ctx(), entry.inode, None).unwrap().0.st_ino,
            entries[0]
        );
        fs.forget(ctx(), entry.inode, 1);
        error(fs.getattr(ctx(), entry.inode, None), libc::EBADF);
    }
    let readonly = fs.lookup(ctx(), ro, c"a").unwrap();
    assert_ne!(readonly.attr.st_ino, entries[0]);
    fs.forget(ctx(), readonly.inode, 1);
}

#[test]
fn hardlinks_are_stable_and_share_identity_is_not_host_identity() {
    let dir = Directory::new();
    fs::write(dir.0.join("a"), b"same").unwrap();
    fs::hard_link(dir.0.join("a"), dir.0.join("b")).unwrap();
    let fs = dir.backend();
    let (rw, ro, _) = roots(&fs);
    let a = fs.lookup(ctx(), rw, c"a").unwrap();
    let b = fs.lookup(ctx(), rw, c"b").unwrap();
    let read_only = fs.lookup(ctx(), ro, c"a").unwrap();
    assert_eq!(a.inode, b.inode);
    assert_eq!(a.attr.st_ino, b.attr.st_ino);
    assert_ne!(a.inode, read_only.inode);
    assert_ne!(a.attr.st_ino, read_only.attr.st_ino);
    let linked = fs.link(ctx(), a.inode, rw, c"c").unwrap();
    assert_eq!(linked.inode, a.inode);
    assert_eq!(linked.attr.st_ino, a.attr.st_ino);
    let dh = fs.opendir(ctx(), rw, 0).unwrap().0.unwrap();
    let mut names = Vec::new();
    fs.readdir(ctx(), rw, dh, 4096, 0, |entry| {
        if entry.name != b"." && entry.name != b".." {
            names.push((entry.name.to_vec(), entry.ino));
        }
        Ok(1)
    })
    .unwrap();
    assert_eq!(names.len(), 3);
    assert!(names.iter().all(|(_, ino)| *ino == a.attr.st_ino));
    assert_eq!(lookup(&fs, rw, c"a"), a.inode);
    fs.forget(ctx(), a.inode, 4);
    error(fs.getattr(ctx(), a.inode, None), libc::EBADF);
}

#[test]
fn readonly_policy_isolated_even_for_identical_host_objects() {
    let dir = Directory::new();
    fs::write(dir.0.join("file"), b"original").unwrap();
    let fs = dir.backend();
    let (rw, ro, other) = roots(&fs);
    let writable = lookup(&fs, rw, c"file");
    let readonly = lookup(&fs, ro, c"file");
    for flags in [libc::O_WRONLY, libc::O_RDWR, libc::O_RDONLY | libc::O_TRUNC] {
        error(fs.open(ctx(), readonly, false, flags as u32), libc::EROFS);
    }
    error(
        fs.create(ctx(), ro, c"new", 0o600, false, 0, 0, Extensions::default()),
        libc::EROFS,
    );
    error(
        fs.mkdir(ctx(), ro, c"directory", 0o700, 0, Extensions::default()),
        libc::EROFS,
    );
    error(
        fs.mknod(
            ctx(),
            ro,
            c"fifo",
            libc::S_IFIFO | 0o600,
            0,
            0,
            Extensions::default(),
        ),
        libc::EROFS,
    );
    error(
        fs.symlink(ctx(), c"target", ro, c"symlink", Extensions::default()),
        libc::EROFS,
    );
    error(fs.unlink(ctx(), ro, c"file"), libc::EROFS);
    error(fs.rmdir(ctx(), ro, c"file"), libc::EROFS);
    error(fs.rename(ctx(), ro, c"file", ro, c"new", 0), libc::EROFS);
    error(fs.link(ctx(), readonly, ro, c"new"), libc::EROFS);
    error(
        fs.setxattr(ctx(), readonly, c"user.test", b"value", 0),
        libc::EROFS,
    );
    error(fs.removexattr(ctx(), readonly, c"user.test"), libc::EROFS);
    let mut attr = fs.getattr(ctx(), readonly, None).unwrap().0;
    attr.st_size = 0;
    error(
        fs.setattr(ctx(), readonly, attr, None, SetattrValid::SIZE),
        libc::EROFS,
    );
    let handle_ro = open(&fs, readonly, libc::O_RDONLY);
    error(write(&fs, readonly, handle_ro, b"bad"), libc::EROFS);
    error(
        fs.fallocate(ctx(), readonly, handle_ro, 0, 0, 4096),
        libc::EROFS,
    );
    error(fs.access(ctx(), readonly, libc::W_OK as u32), libc::EROFS);
    let handle_rw = open(&fs, writable, libc::O_RDWR);
    error(fs.rename(ctx(), rw, c"file", other, c"new", 0), libc::EXDEV);
    error(fs.link(ctx(), writable, ro, c"new"), libc::EXDEV);
    error(
        fs.copyfilerange(ctx(), writable, handle_rw, 0, readonly, handle_ro, 0, 1, 0),
        libc::EXDEV,
    );
    assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"original");
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    write(&fs, writable, handle_rw, b"writable").unwrap();
    assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"writable");
}

#[test]
fn invalid_operands_and_handle_associations_never_mutate_host() {
    let dir = Directory::new();
    fs::write(dir.0.join("a"), b"untouched").unwrap();
    fs::write(dir.0.join("b"), b"second").unwrap();
    let fs = dir.backend();
    let (rw, ro, _) = roots(&fs);
    let a = lookup(&fs, rw, c"a");
    let b = lookup(&fs, rw, c"b");
    let other_a = lookup(&fs, ro, c"a");
    let ha = open(&fs, a, libc::O_RDWR);
    let hb = open(&fs, b, libc::O_RDWR);
    error(fs.getattr(ctx(), a, Some(hb)), libc::EBADF);
    error(fs.getattr(ctx(), 1, Some(ha)), libc::EBADF);
    error(fs.getattr(ctx(), other_a, Some(ha)), libc::EBADF);
    let mut attr = fs.getattr(ctx(), a, None).unwrap().0;
    attr.st_size = 0;
    error(
        fs.setattr(ctx(), a, attr, Some(hb), SetattrValid::SIZE),
        libc::EBADF,
    );
    error(write(&fs, a, hb, b"bad"), libc::EBADF);
    error(fs.release(ctx(), a, 0, hb, false, false, None), libc::EBADF);
    error(
        fs.rename(ctx(), rw, c"a", rw, c"b", libc::RENAME_WHITEOUT),
        libc::EINVAL,
    );
    error(
        fs.rename(
            ctx(),
            rw,
            c"a",
            rw,
            c"b",
            libc::RENAME_EXCHANGE | libc::RENAME_NOREPLACE,
        ),
        libc::EINVAL,
    );
    error(fs.open(ctx(), a, false, u32::MAX), libc::EINVAL);
    for name in [c"", c"/absolute", c"nested/name", c"../outside"] {
        error(fs.lookup(ctx(), rw, name), libc::EINVAL);
        error(
            fs.create(ctx(), rw, name, 0o600, false, 0, 0, Extensions::default()),
            libc::EINVAL,
        );
        error(fs.rename(ctx(), rw, c"a", rw, name, 0), libc::EINVAL);
        error(fs.link(ctx(), a, rw, name), libc::EINVAL);
    }
    for name in [c".", c".."] {
        error(fs.unlink(ctx(), rw, name), libc::EINVAL);
    }
    error(fs.lookup(ctx(), rw, c".."), libc::EPERM);
    assert_eq!(fs::read(dir.0.join("a")).unwrap(), b"untouched");
    assert_eq!(fs::read(dir.0.join("b")).unwrap(), b"second");
    assert_eq!(read(&fs, b, hb).unwrap(), b"second");
}

#[test]
fn reset_invalidates_node_and_handle_ids_but_pins_roots() {
    let dir = Directory::new();
    fs::write(dir.0.join("file"), b"data").unwrap();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let old = lookup(&fs, rw, c"file");
    let old_handle = open(&fs, old, 0);
    let old_dir = fs.opendir(ctx(), rw, 0).unwrap().0.unwrap();
    fs.forget(ctx(), rw, u64::MAX);
    fs.forget(ctx(), 1, u64::MAX);
    assert_eq!(lookup(&fs, 1, c"rw"), rw);
    fs.destroy();
    fs.init(FsOptions::empty()).unwrap();
    assert_eq!(lookup(&fs, 1, c"rw"), rw);
    error(fs.getattr(ctx(), old, None), libc::EBADF);
    error(read(&fs, old, old_handle), libc::EBADF);
    error(
        fs.readdir(ctx(), rw, old_dir, 4096, 0, |_| Ok(1)),
        libc::EBADF,
    );
    let new = lookup(&fs, rw, c"file");
    let new_handle = open(&fs, new, 0);
    assert!(new > old);
    assert!(new_handle > old_handle);
    error(fs.getattr(ctx(), new, Some(old_handle)), libc::EBADF);
    assert_eq!(read(&fs, new, new_handle).unwrap(), b"data");
}

// Run process-wide limits and fd accounting in an isolated test process. The
// parent watchdog kills a stuck child instead of hanging the suite.
pub(super) fn isolated_fd_child(marker: &str) -> bool {
    if std::env::var_os(marker).is_some() {
        return true;
    }
    let name = std::thread::current().name().unwrap().to_owned();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"])
        .env(marker, "1")
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "isolated fd test failed: {status}");
            return false;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("isolated fd test exceeded its watchdog");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(super) fn fd_count() -> usize {
    fs::read_dir("/proc/self/fd").unwrap().count()
}

#[test]
fn populated_sessions_return_to_fd_baseline_after_destroy_and_drop() {
    if !isolated_fd_child("BOXLITE_FS_FD_BASELINE_CHILD") {
        return;
    }
    let dir = Directory::new();
    fs::write(dir.0.join("file"), b"retained data").unwrap();
    let before = fd_count();
    for _ in 0..16 {
        let partial = AggregateFs::new(vec![
            Share {
                name: "valid".into(),
                path: dir.0.clone(),
                read_only: false,
            },
            Share {
                name: "missing".into(),
                path: dir.0.join("absent"),
                read_only: false,
            },
        ]);
        error(partial, libc::ENOENT);
        assert_eq!(
            fd_count(),
            before,
            "later export failure leaked earlier backend"
        );
    }
    for _ in 0..16 {
        let fs = dir.backend();
        fs.init(FsOptions::empty()).unwrap();
        let baseline = fd_count();
        for _ in 0..8 {
            let (rw, _, _) = roots(&fs);
            for _ in 0..16 {
                let inode = lookup(&fs, rw, c"file");
                open(&fs, inode, libc::O_RDWR);
                fs.opendir(ctx(), rw, 0).unwrap();
            }
            assert!(fd_count() > baseline + 16, "session was not populated");
            fs.destroy();
            fs.init(FsOptions::empty()).unwrap();
            assert_eq!(fd_count(), baseline, "destroy leaked session descriptors");
        }
        // Drop a populated session as well as repeatedly destroyed sessions.
        let (rw, _, _) = roots(&fs);
        let inode = lookup(&fs, rw, c"file");
        open(&fs, inode, libc::O_RDWR);
        fs.opendir(ctx(), rw, 0).unwrap();
        drop(fs);
        assert_eq!(fd_count(), before, "backend drop leaked descriptors");
    }
}

#[test]
fn emfile_lookup_and_open_fail_cleanly_and_recover_in_isolated_process() {
    if !isolated_fd_child("BOXLITE_FS_EMFILE_CHILD") {
        return;
    }
    let dir = Directory::new();
    fs::write(dir.0.join("file"), b"still accessible").unwrap();
    fs::write(dir.0.join("unseen"), b"lookup target").unwrap();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let inode = lookup(&fs, rw, c"file");
    let baseline = fd_count();
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: getrlimit initializes limit on success.
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) },
        0
    );
    // SAFETY: getrlimit succeeded.
    let original = unsafe { limit.assume_init() };
    let limited = libc::rlimit {
        rlim_cur: original.rlim_cur.min(128),
        ..original
    };
    // SAFETY: only the isolated child changes its own soft fd limit.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limited) }, 0);
    let mut held = Vec::new();
    loop {
        match File::open("/dev/null") {
            Ok(file) => held.push(file),
            Err(error) => {
                assert_eq!(error.raw_os_error(), Some(libc::EMFILE));
                break;
            }
        }
    }
    let failed_open = fs.open(ctx(), inode, false, libc::O_RDWR as u32);
    let failed_lookup = fs.lookup(ctx(), rw, c"unseen");
    let share = || {
        vec![Share {
            name: "init".into(),
            path: dir.0.clone(),
            read_only: false,
        }]
    };
    let failed_root = AggregateFs::new(share());
    // One available descriptor lets construction open the export root, then
    // forces the auxiliary /proc/self/fd open to fail. Its root must be closed.
    drop(held.pop().unwrap());
    let failed_auxiliary = AggregateFs::new(share());
    drop(held);
    // Restore before assertions and fixture teardown.
    // SAFETY: the original soft limit did not exceed the unchanged hard limit.
    assert_eq!(
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &original) },
        0
    );
    error(failed_open, libc::EMFILE);
    error(failed_lookup, libc::EMFILE);
    error(failed_root, libc::EMFILE);
    error(failed_auxiliary, libc::EMFILE);
    assert_eq!(fd_count(), baseline, "failed operations leaked descriptors");
    let recovered = AggregateFs::new(share()).unwrap();
    drop(recovered);
    assert_eq!(
        fd_count(),
        baseline,
        "recovered constructor leaked descriptors"
    );
    let handle = open(&fs, inode, libc::O_RDONLY);
    assert_eq!(read(&fs, inode, handle).unwrap(), b"still accessible");
    let unseen = lookup(&fs, rw, c"unseen");
    let handle = open(&fs, unseen, libc::O_RDONLY);
    assert_eq!(read(&fs, unseen, handle).unwrap(), b"lookup target");
}

#[test]
fn duplicate_lookup_references_are_atomic_with_forget() {
    let dir = Directory::new();
    fs::write(dir.0.join("file"), b"data").unwrap();
    let fs = Arc::new(dir.backend());
    let (rw, _, _) = roots(&fs);
    let threads = 8;
    let barrier = Arc::new(Barrier::new(threads));
    let workers: Vec<_> = (0..threads)
        .map(|_| {
            let fs = fs.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                lookup(&fs, rw, c"file")
            })
        })
        .collect();
    let inodes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert!(inodes.iter().all(|inode| *inode == inodes[0]));
    let inode = inodes[0];
    for _ in 0..threads - 1 {
        fs.forget(ctx(), inode, 1);
        assert!(fs.getattr(ctx(), inode, None).is_ok());
    }
    fs.forget(ctx(), inode, 1);
    error(fs.getattr(ctx(), inode, None), libc::EBADF);
}

#[test]
fn readdirplus_rejected_entries_rollback_lookup_and_accept_non_utf8_names() {
    let dir = Directory::new();
    let name = vec![b'x', 0xff];
    fs::write(dir.0.join(OsString::from_vec(name.clone())), b"bytes").unwrap();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let dh = fs.opendir(ctx(), rw, 0).unwrap().0.unwrap();
    let mut rejected = 0;
    fs.readdirplus(ctx(), rw, dh, 4096, 0, |dirent, entry| {
        if dirent.name == b"." || dirent.name == b".." {
            return Ok(1);
        }
        assert_eq!(dirent.name, name);
        assert_eq!(dirent.ino, entry.attr.st_ino);
        rejected = entry.inode;
        Ok(0)
    })
    .unwrap();
    assert_ne!(rejected, 0);
    error(fs.getattr(ctx(), rejected, None), libc::EBADF);
    let mut errored = 0;
    error(
        fs.readdirplus(ctx(), rw, dh, 4096, 0, |dirent, entry| {
            if dirent.name == b"." || dirent.name == b".." {
                return Ok(1);
            }
            errored = entry.inode;
            Err(io::Error::from_raw_os_error(libc::ENOSPC))
        }),
        libc::ENOSPC,
    );
    error(fs.getattr(ctx(), errored, None), libc::EBADF);
    let inode = lookup(&fs, rw, &c(&name));
    let handle = open(&fs, inode, 0);
    assert_eq!(read(&fs, inode, handle).unwrap(), b"bytes");
}

#[test]
fn validates_share_names_and_preserves_symlink_contents_without_host_traversal() {
    let dir = Directory::new();
    for name in ["", ".", "..", "a/b", "nul\0name"] {
        error(
            AggregateFs::new(vec![Share {
                name: name.into(),
                path: dir.0.clone(),
                read_only: false,
            }]),
            libc::EINVAL,
        );
    }
    error(
        AggregateFs::new(vec![
            Share {
                name: "same".into(),
                path: dir.0.clone(),
                read_only: false,
            },
            Share {
                name: "same".into(),
                path: dir.0.clone(),
                read_only: true,
            },
        ]),
        libc::EINVAL,
    );
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let link = fs
        .symlink(ctx(), c"/etc/passwd", rw, c"link", Extensions::default())
        .unwrap();
    assert_eq!(fs.readlink(ctx(), link.inode).unwrap(), b"/etc/passwd");
    error(fs.open(ctx(), link.inode, false, 0), libc::ELOOP);
    error(
        fs.access(ctx(), link.inode, libc::R_OK as u32),
        libc::EOPNOTSUPP,
    );
    error(
        fs.link(ctx(), link.inode, rw, c"hardlink"),
        libc::EOPNOTSUPP,
    );
    error(
        fs.getxattr(ctx(), link.inode, c"user.test", 0),
        libc::EOPNOTSUPP,
    );
    assert!(!dir.0.join("hardlink").exists());
    error(fs.lookup(ctx(), link.inode, c"child"), libc::ENOTDIR);
    error(
        fs.create(
            ctx(),
            rw,
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
        fs.mkdir(ctx(), 1, c"new", 0o700, 0, Extensions::default()),
        libc::EROFS,
    );
    let handle = fs.opendir(ctx(), 1, 0).unwrap().0.unwrap();
    let mut names = Vec::new();
    fs.readdir(ctx(), 1, handle, 4096, 0, |entry| {
        names.push(entry.name.to_vec());
        Ok(1)
    })
    .unwrap();
    assert_eq!(
        names,
        vec![
            b".".to_vec(),
            b"..".to_vec(),
            b"rw".to_vec(),
            b"ro".to_vec(),
            b"other".to_vec()
        ]
    );
}

#[test]
fn real_file_metadata_directory_and_copy_operations() {
    let dir = Directory::new();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let subdir = fs
        .mkdir(ctx(), rw, c"subdir", 0o700, 0, Extensions::default())
        .unwrap();
    let (source, source_handle) = create(&fs, subdir.inode, c"source");
    let (target, target_handle) = create(&fs, subdir.inode, c"target");
    write(&fs, source, source_handle, b"payload").unwrap();
    assert_eq!(
        fs.copyfilerange(
            ctx(),
            source,
            source_handle,
            0,
            target,
            target_handle,
            0,
            7,
            0
        )
        .unwrap(),
        7
    );
    assert_eq!(read(&fs, target, target_handle).unwrap(), b"payload");
    assert_eq!(
        fs.lseek(ctx(), target, target_handle, 0, libc::SEEK_END as u32)
            .unwrap(),
        7
    );
    let mut attr = fs.getattr(ctx(), target, Some(target_handle)).unwrap().0;
    attr.st_size = 3;
    attr.st_mode = 0o640;
    let changed = fs
        .setattr(
            ctx(),
            target,
            attr,
            Some(target_handle),
            SetattrValid::SIZE | SetattrValid::MODE,
        )
        .unwrap()
        .0;
    assert_eq!(changed.st_size, 3);
    assert_eq!(changed.st_mode & 0o777, 0o640);
    assert_eq!(read(&fs, target, target_handle).unwrap(), b"pay");
    fs.flush(ctx(), target, target_handle, 0).unwrap();
    fs.access(ctx(), target, libc::R_OK as u32).unwrap();
    assert!(fs.statfs(ctx(), target).unwrap().f_bsize > 0);
    let directory_handle = fs.opendir(ctx(), subdir.inode, 0).unwrap().0.unwrap();
    fs.fsyncdir(ctx(), subdir.inode, false, directory_handle)
        .unwrap();
    fs.releasedir(ctx(), subdir.inode, 0, directory_handle)
        .unwrap();
    fs.unlink(ctx(), subdir.inode, c"source").unwrap();
    fs.unlink(ctx(), subdir.inode, c"target").unwrap();
    fs.rmdir(ctx(), rw, c"subdir").unwrap();
    assert!(!dir.0.join("subdir").exists());
}

#[test]
fn rename_noreplace_and_exchange_preserve_host_semantics() {
    let dir = Directory::new();
    fs::write(dir.0.join("a"), b"a").unwrap();
    fs::write(dir.0.join("b"), b"b").unwrap();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    error(
        fs.rename(ctx(), rw, c"a", rw, c"b", libc::RENAME_NOREPLACE),
        libc::EEXIST,
    );
    assert_eq!(fs::read(dir.0.join("a")).unwrap(), b"a");
    assert_eq!(fs::read(dir.0.join("b")).unwrap(), b"b");
    fs.rename(ctx(), rw, c"a", rw, c"b", libc::RENAME_EXCHANGE)
        .unwrap();
    assert_eq!(fs::read(dir.0.join("a")).unwrap(), b"b");
    assert_eq!(fs::read(dir.0.join("b")).unwrap(), b"a");
}

#[test]
fn create_existing_file_uses_opened_identity_and_rejects_special_files() {
    let dir = Directory::new();
    fs::write(dir.0.join("existing"), b"old").unwrap();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let original = lookup(&fs, rw, c"existing");
    let (opened, handle) = create(&fs, rw, c"existing");
    assert_eq!(opened, original);
    write(&fs, opened, handle, b"new").unwrap();
    assert_eq!(fs::read(dir.0.join("existing")).unwrap(), b"new");
    error(
        fs.create(
            ctx(),
            rw,
            c"existing",
            0o600,
            false,
            (libc::O_RDWR | libc::O_EXCL) as u32,
            0,
            Extensions::default(),
        ),
        libc::EEXIST,
    );
    error(
        fs.mknod(
            ctx(),
            rw,
            c"fifo",
            libc::S_IFIFO | 0o600,
            0,
            0,
            Extensions::default(),
        ),
        libc::EOPNOTSUPP,
    );
    assert!(!dir.0.join("fifo").exists());
    // Preexisting host FIFOs must also be rejected without blocking open.
    let fifo_path = CString::new(dir.0.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: the fixture path is NUL-terminated and points inside its owned directory.
    assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
    let fifo = fs.lookup(ctx(), rw, c"fifo").unwrap();
    error(
        fs.open(ctx(), fifo.inode, false, libc::O_RDWR as u32),
        libc::EOPNOTSUPP,
    );
    error(
        fs.create(
            ctx(),
            rw,
            c"fifo",
            0o600,
            false,
            libc::O_WRONLY as u32,
            0,
            Extensions::default(),
        ),
        libc::EOPNOTSUPP,
    );
    fs.unlink(ctx(), rw, c"fifo").unwrap();
}

#[test]
fn guest_creation_modes_ignore_host_umask_in_an_isolated_process() {
    const CHILD: &str = "BOXLITE_FS_BACKEND_MODE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let name = std::thread::current()
            .name()
            .expect("libtest names test threads")
            .to_owned();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture"])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    // The child runs only this test. Never change umask in the parallel parent
    // test process; a restrictive mask also proves modes are restored via FDs.
    struct RestoreUmask(libc::mode_t);
    impl Drop for RestoreUmask {
        fn drop(&mut self) {
            // SAFETY: only the isolated child changes its process umask.
            unsafe {
                libc::umask(self.0);
            }
        }
    }
    // Restore before process teardown so coverage output is not created mode 000.
    // SAFETY: the child executes exactly one test, never parallel test threads.
    let _restore_umask = RestoreUmask(unsafe { libc::umask(0o777) });
    let dir = Directory::new();
    // Our fixture directory itself was created under the restrictive mask.
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o700)).unwrap();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let (regular, handle, _) = fs
        .create(
            ctx(),
            rw,
            c"regular",
            0o666,
            false,
            libc::O_RDWR as u32,
            0o027,
            Extensions::default(),
        )
        .unwrap();
    assert_eq!(regular.attr.st_mode & 0o777, 0o640);
    assert_eq!(
        fs::metadata(dir.0.join("regular"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
    let directory = fs
        .mkdir(ctx(), rw, c"directory", 0o777, 0o027, Extensions::default())
        .unwrap();
    assert_eq!(directory.attr.st_mode & 0o777, 0o750);
    let node = fs
        .mknod(
            ctx(),
            rw,
            c"node",
            libc::S_IFREG | 0o666,
            0,
            0o027,
            Extensions::default(),
        )
        .unwrap();
    assert_eq!(node.attr.st_mode & 0o777, 0o640);
    fs::set_permissions(dir.0.join("regular"), fs::Permissions::from_mode(0o604)).unwrap();
    fs.create(
        ctx(),
        rw,
        c"regular",
        0o777,
        false,
        libc::O_RDWR as u32,
        0,
        Extensions::default(),
    )
    .unwrap();
    assert_eq!(
        fs::metadata(dir.0.join("regular"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o604
    );
    fs.release(ctx(), regular.inode, 0, handle.unwrap(), false, false, None)
        .unwrap();
}

#[test]
fn readdirplus_dot_entries_do_not_pin_forgotten_directories() {
    let dir = Directory::new();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let parent = fs
        .mkdir(ctx(), rw, c"parent", 0o700, 0, Extensions::default())
        .unwrap()
        .inode;
    let child = fs
        .mkdir(ctx(), parent, c"child", 0o700, 0, Extensions::default())
        .unwrap()
        .inode;
    let dh = fs.opendir(ctx(), child, 0).unwrap().0.unwrap();
    fs.readdirplus(ctx(), child, dh, 4096, 0, |dirent, _| {
        assert!(dirent.name == b"." || dirent.name == b"..");
        Ok(1)
    })
    .unwrap();
    fs.releasedir(ctx(), child, 0, dh).unwrap();
    fs.rmdir(ctx(), parent, c"child").unwrap();
    fs.forget(ctx(), child, 1);
    error(fs.getattr(ctx(), child, None), libc::EBADF);
    fs.rmdir(ctx(), rw, c"parent").unwrap();
    fs.forget(ctx(), parent, 1);
    error(fs.getattr(ctx(), parent, None), libc::EBADF);
}

#[test]
fn setattr_metadata_and_truncate_do_not_require_read_permission() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Directory::new();
    fs::write(dir.0.join("owned"), b"truncate this").unwrap();
    let fs = dir.backend();
    let (rw, _, _) = roots(&fs);
    let node = lookup(&fs, rw, c"owned");
    let mut attr = fs.getattr(ctx(), node, None).unwrap().0;
    attr.st_mode = 0;
    fs.setattr(ctx(), node, attr, None, SetattrValid::MODE)
        .unwrap();
    attr.st_mode = 0o200;
    let restore = fs.setattr(ctx(), node, attr, None, SetattrValid::MODE);
    // Always leave cleanup possible, including when the pre-fix request failed.
    fs::set_permissions(dir.0.join("owned"), fs::Permissions::from_mode(0o200)).unwrap();
    restore.unwrap();
    attr.st_size = 3;
    fs.setattr(ctx(), node, attr, None, SetattrValid::SIZE)
        .unwrap();
    assert_eq!(fs::metadata(dir.0.join("owned")).unwrap().len(), 3);
    attr.st_mode = 0o600;
    fs.setattr(ctx(), node, attr, None, SetattrValid::MODE)
        .unwrap();
    assert_eq!(fs::read(dir.0.join("owned")).unwrap(), b"tru");
}

#[test]
fn fsync_propagates_host_sync_failure_instead_of_reporting_durability() {
    // procfs supplies a real regular file whose synchronization is unsupported.
    // This exercises the syscall error path without replacing the backend.
    let fs = AggregateFs::new(vec![Share {
        name: "proc".into(),
        path: "/proc".into(),
        read_only: true,
    }])
    .unwrap();
    let root = lookup(&fs, 1, c"proc");
    let inode = lookup(&fs, root, c"version");
    let handle = open(&fs, inode, libc::O_RDONLY);
    error(fs.fsync(ctx(), inode, false, handle), libc::EINVAL);
    error(fs.fsync(ctx(), inode, true, handle), libc::EINVAL);
    fs.release(ctx(), inode, 0, handle, false, false, None)
        .unwrap();
}

#[test]
fn forgotten_file_churn_reclaims_export_file_descriptors() {
    let directory = Directory::new();
    let fs = directory.backend();
    let (root, _, _) = roots(&fs);
    let owned_fds = || {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.ok()?.path()).ok())
            .filter(|target| target.starts_with(&directory.0))
            .count()
    };
    let pinned_roots = owned_fds();
    for index in 0..300 {
        let name = CString::new(format!("transient-{index}")).unwrap();
        let (inode, handle) = create(&fs, root, &name);
        write(&fs, inode, handle, b"retained until release").unwrap();
        fs.unlink(ctx(), root, &name).unwrap();
        fs.forget(ctx(), inode, u64::MAX);
        assert_eq!(read(&fs, inode, handle).unwrap(), b"retained until release");
        fs.release(ctx(), inode, 0, handle, false, false, None)
            .unwrap();
        error(fs.getattr(ctx(), inode, None), libc::EBADF);
    }
    assert_eq!(owned_fds(), pinned_roots);
}

#[test]
fn plain_readdir_skips_an_entry_removed_after_getdents() {
    let directory = Directory::new();
    fs::write(directory.0.join("first"), b"one").unwrap();
    fs::write(directory.0.join("second"), b"two").unwrap();
    let fs = directory.backend();
    let (root, _, _) = roots(&fs);
    let handle = fs.opendir(ctx(), root, 0).unwrap().0.unwrap();
    let mut observed = Vec::new();
    let result = fs.readdir(ctx(), root, handle, 4096, 0, |entry| {
        if entry.name == b"." || entry.name == b".." {
            return Ok(1);
        }
        // Both records are already in the backend's getdents buffer. Delete
        // the other name before the aggregate resolves that buffered record.
        if observed.is_empty() {
            let other = if entry.name == b"first" {
                "second"
            } else {
                "first"
            };
            fs::remove_file(directory.0.join(other)).unwrap();
        }
        observed.push(OsString::from_vec(entry.name.to_vec()));
        Ok(1)
    });
    result.unwrap();
    let surviving: Vec<_> = fs::read_dir(&directory.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(observed, surviving);
    assert_eq!(observed.len(), 1);
    fs.releasedir(ctx(), root, 0, handle).unwrap();
}

#[test]
fn renamed_export_directory_never_exposes_its_new_host_parent() {
    let directory = Directory::new();
    let outside = Directory::new();
    fs::create_dir(directory.0.join("child")).unwrap();
    fs::write(directory.0.join("child/retained"), b"authorized object").unwrap();
    fs::write(outside.0.join("secret"), b"not exported").unwrap();
    let fs = directory.backend();
    let (root, _, _) = roots(&fs);
    let child = lookup(&fs, root, c"child");
    let retained = lookup(&fs, child, c"retained");
    let handle = open(&fs, retained, libc::O_RDONLY);
    fs::rename(directory.0.join("child"), outside.0.join("moved")).unwrap();
    assert_eq!(read(&fs, retained, handle).unwrap(), b"authorized object");
    error(fs.lookup(ctx(), child, c".."), libc::EPERM);
    let dh = fs.opendir(ctx(), child, 0).unwrap().0.unwrap();
    fs.readdirplus(ctx(), child, dh, 4096, 0, |entry, _| {
        assert_ne!(
            entry.name, b"..",
            "listing must not resolve the new host parent"
        );
        assert_ne!(entry.name, b"secret");
        Ok(1)
    })
    .unwrap();
    fs.releasedir(ctx(), child, 0, dh).unwrap();
    fs.release(ctx(), retained, 0, handle, false, false, None)
        .unwrap();
}

#[test]
fn synthetic_root_xattr_queries_report_unsupported_not_invalid_inode() {
    let directory = Directory::new();
    let fs = directory.backend();
    error(fs.getxattr(ctx(), 1, c"user.absent", 0), libc::EOPNOTSUPP);
    error(fs.listxattr(ctx(), 1, 0), libc::EOPNOTSUPP);
    assert_eq!(
        fs.getattr(ctx(), 1, None).unwrap().0.st_mode & libc::S_IFMT,
        libc::S_IFDIR
    );
}
