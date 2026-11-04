// Copyright 2019 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

//! Per-share Linux backend adapted from libkrun e12b9b3. O_PATH descriptors
//! anchor object identity; data descriptors belong to independently released
//! handles. Requests never change host credentials, capabilities, or umask.
use std::collections::BTreeMap;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io;
use std::mem::{self, MaybeUninit};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use super::super::filesystem::{
    Context, DirEntry, Entry, Extensions, FileSystem, FsOptions, GetxattrReply, ListxattrReply,
    OpenOptions, SetattrValid, ZeroCopyReader, ZeroCopyWriter,
};
use super::super::multikey::MultikeyBTreeMap;

const ROOT: u64 = 1;

pub(crate) fn errno(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

fn cvt(result: i32) -> io::Result<()> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn openat(parent: i32, name: &CStr, flags: i32, mode: u32) -> io::Result<File> {
    // SAFETY: name is terminated and a successful descriptor is owned below.
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags | libc::O_CLOEXEC, mode) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn stat(file: &File) -> io::Result<libc::stat64> {
    let mut attr = MaybeUninit::uninit();
    // SAFETY: attr has room for stat64; file owns the descriptor during the call.
    cvt(unsafe { libc::fstat64(file.as_raw_fd(), attr.as_mut_ptr()) })?;
    // SAFETY: fstat64 initialized attr on success.
    Ok(unsafe { attr.assume_init() })
}

// Keep libkrun's mount identity: dev/ino alone can merge distinct bind mounts.
fn statx(file: &File) -> io::Result<(libc::stat64, u64)> {
    let mut stx = MaybeUninit::<libc::statx>::zeroed();
    // SAFETY: the empty path addresses the owned O_PATH descriptor.
    cvt(unsafe {
        libc::statx(
            file.as_raw_fd(),
            c"".as_ptr(),
            libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
            libc::STATX_BASIC_STATS | libc::STATX_MNT_ID,
            stx.as_mut_ptr(),
        )
    })?;
    // SAFETY: statx initialized stx; stat64 consists of integer POD fields.
    let stx = unsafe { stx.assume_init() };
    let mut st = unsafe { MaybeUninit::<libc::stat64>::zeroed().assume_init() };
    st.st_dev = libc::makedev(stx.stx_dev_major, stx.stx_dev_minor);
    st.st_ino = stx.stx_ino;
    st.st_mode = stx.stx_mode as _;
    st.st_nlink = stx.stx_nlink as _;
    st.st_uid = stx.stx_uid;
    st.st_gid = stx.stx_gid;
    st.st_rdev = libc::makedev(stx.stx_rdev_major, stx.stx_rdev_minor);
    st.st_size = stx.stx_size as _;
    st.st_blksize = stx.stx_blksize as _;
    st.st_blocks = stx.stx_blocks as _;
    st.st_atime = stx.stx_atime.tv_sec;
    st.st_atime_nsec = stx.stx_atime.tv_nsec as _;
    st.st_mtime = stx.stx_mtime.tv_sec;
    st.st_mtime_nsec = stx.stx_mtime.tv_nsec as _;
    st.st_ctime = stx.stx_ctime.tv_sec;
    st.st_ctime_nsec = stx.stx_ctime.tv_nsec as _;
    Ok((st, stx.stx_mnt_id))
}

#[derive(Clone, PartialOrd, Ord, PartialEq, Eq)]
struct InodeAltKey {
    ino: u64,
    dev: u64,
    mnt_id: u64,
}

impl InodeAltKey {
    fn new(attr: &libc::stat64, mnt_id: u64) -> Self {
        Self {
            ino: attr.st_ino,
            dev: attr.st_dev,
            mnt_id,
        }
    }
}

struct InodeData {
    inode: u64,
    file: File,
}

struct InodeRecord {
    data: Arc<InodeData>,
    lookups: u64,
    opens: u64,
    inflight: u64,
}

struct HandleData {
    node: Arc<InodeData>,
    file: File,
    directory: bool,
    writable: bool,
    position: Mutex<()>,
}

struct State {
    inodes: MultikeyBTreeMap<u64, InodeAltKey, InodeRecord>,
    handles: BTreeMap<u64, Arc<HandleData>>,
    next_inode: u64,
    next_handle: u64,
}

/// A backend-local namespace; aggregate node IDs and share policy live above it.
pub(crate) struct PassthroughFs {
    root: Arc<InodeData>,
    root_key: InodeAltKey,
    proc_self_fd: File,
    my_uid: libc::uid_t,
    my_gid: libc::gid_t,
    state: Mutex<State>,
}

// Acquiring an inode also retains map membership. An OPEN racing with FORGET
// can therefore publish its handle after host I/O without resurrecting an ID.
struct InodeRef<'a> {
    fs: &'a PassthroughFs,
    data: Arc<InodeData>,
}

impl Drop for InodeRef<'_> {
    fn drop(&mut self) {
        let removed = {
            let mut state = self.fs.state();
            if let Some(record) = state.inodes.get_mut(&self.data.inode) {
                record.inflight = record.inflight.saturating_sub(1);
            }
            PassthroughFs::collect_zero(&mut state, self.data.inode)
        };
        drop(removed);
    }
}

struct HandleRef<'a> {
    data: Arc<HandleData>,
    _node: InodeRef<'a>,
}

impl std::ops::Deref for HandleRef<'_> {
    type Target = HandleData;

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

fn next(counter: &mut u64) -> io::Result<u64> {
    let value = *counter;
    *counter = value.checked_add(1).ok_or_else(|| errno(libc::EOVERFLOW))?;
    Ok(value)
}

fn component(name: &CStr, mutation: bool) -> io::Result<()> {
    let bytes = name.to_bytes();
    if bytes.is_empty() || bytes.contains(&b'/') || (mutation && (bytes == b"." || bytes == b".."))
    {
        return Err(errno(libc::EINVAL));
    }
    Ok(())
}

fn flags(value: u32) -> io::Result<i32> {
    let flags = i32::try_from(value).map_err(|_| errno(libc::EINVAL))?;
    if flags & libc::O_ACCMODE == libc::O_ACCMODE
        || flags & libc::O_PATH != 0
        || flags & libc::O_TMPFILE == libc::O_TMPFILE
    {
        return Err(errno(libc::EINVAL));
    }
    // libkrun's nonprivileged branch discards this optional optimization.
    Ok(flags & !libc::O_NOATIME)
}

fn extension(extensions: &Extensions) -> io::Result<()> {
    if extensions.secctx.is_some() || extensions.sup_gid.is_some() {
        Err(errno(libc::EOPNOTSUPP))
    } else {
        Ok(())
    }
}

fn entry(inode: u64, attr: libc::stat64) -> Entry {
    Entry {
        inode,
        generation: 0,
        attr,
        attr_flags: 0,
        attr_timeout: Duration::ZERO,
        entry_timeout: Duration::ZERO,
    }
}

fn checked_range(offset: u64, size: u32) -> io::Result<()> {
    let end = offset
        .checked_add(u64::from(size))
        .ok_or_else(|| errno(libc::EINVAL))?;
    i64::try_from(end).map_err(|_| errno(libc::EINVAL))?;
    Ok(())
}

impl PassthroughFs {
    pub(crate) fn new(root: PathBuf) -> io::Result<Self> {
        let path = CString::new(root.as_os_str().as_bytes()).map_err(|_| errno(libc::EINVAL))?;
        let file = openat(
            libc::AT_FDCWD,
            &path,
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            0,
        )?;
        let (attr, mount) = statx(&file)?;
        let fs = Self {
            root: Arc::new(InodeData { inode: ROOT, file }),
            root_key: InodeAltKey::new(&attr, mount),
            proc_self_fd: openat(
                libc::AT_FDCWD,
                c"/proc/self/fd",
                libc::O_PATH | libc::O_DIRECTORY,
                0,
            )?,
            // SAFETY: these syscalls always succeed and change no credentials.
            my_uid: unsafe { libc::getuid() },
            my_gid: unsafe { libc::getgid() },
            state: Mutex::new(State {
                inodes: MultikeyBTreeMap::new(),
                handles: BTreeMap::new(),
                next_inode: ROOT + 1,
                next_handle: 1,
            }),
        };
        fs.install_root();
        Ok(fs)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn install_root(&self) {
        let mut state = self.state();
        if state.inodes.get(&ROOT).is_none() {
            state.inodes.insert(
                ROOT,
                self.root_key.clone(),
                InodeRecord {
                    data: self.root.clone(),
                    lookups: 0,
                    opens: 0,
                    inflight: 0,
                },
            );
        }
    }

    /// Retain a local lookup for an aggregate Node Arc, without performing I/O.
    pub(crate) fn retain(&self, inode: u64) -> io::Result<()> {
        let mut state = self.state();
        let record = state
            .inodes
            .get_mut(&inode)
            .ok_or_else(|| errno(libc::EBADF))?;
        if inode != ROOT {
            record.lookups = record
                .lookups
                .checked_add(1)
                .ok_or_else(|| errno(libc::EOVERFLOW))?;
        }
        Ok(())
    }

    fn inode(&self, inode: u64) -> io::Result<InodeRef<'_>> {
        let data = {
            let mut state = self.state();
            let record = state
                .inodes
                .get_mut(&inode)
                .ok_or_else(|| errno(libc::EBADF))?;
            record.inflight = record
                .inflight
                .checked_add(1)
                .ok_or_else(|| errno(libc::EOVERFLOW))?;
            record.data.clone()
        };
        Ok(InodeRef { fs: self, data })
    }

    fn handle(
        &self,
        inode: u64,
        handle: u64,
        directory: Option<bool>,
    ) -> io::Result<HandleRef<'_>> {
        let (data, node) = {
            let mut state = self.state();
            let data = state
                .handles
                .get(&handle)
                .filter(|data| {
                    data.node.inode == inode && directory.is_none_or(|dir| data.directory == dir)
                })
                .cloned()
                .ok_or_else(|| errno(libc::EBADF))?;
            let record = state
                .inodes
                .get_mut(&inode)
                .ok_or_else(|| errno(libc::EBADF))?;
            record.inflight = record
                .inflight
                .checked_add(1)
                .ok_or_else(|| errno(libc::EOVERFLOW))?;
            let node = record.data.clone();
            (data, node)
        };
        Ok(HandleRef {
            data,
            _node: InodeRef {
                fs: self,
                data: node,
            },
        })
    }

    fn collect_zero(state: &mut State, inode: u64) -> Option<InodeRecord> {
        if inode != ROOT
            && state.inodes.get(&inode).is_some_and(|record| {
                record.lookups == 0 && record.opens == 0 && record.inflight == 0
            })
        {
            state.inodes.remove(&inode)
        } else {
            None
        }
    }

    fn forget_one(&self, inode: u64, count: u64) {
        let removed = {
            let mut state = self.state();
            if inode != ROOT
                && let Some(record) = state.inodes.get_mut(&inode)
            {
                record.lookups = record.lookups.saturating_sub(count);
            }
            Self::collect_zero(&mut state, inode)
        };
        drop(removed);
    }

    fn register(&self, file: File) -> io::Result<(Entry, InodeRef<'_>)> {
        let (attr, mount) = statx(&file)?;
        let key = InodeAltKey::new(&attr, mount);
        let data = {
            let mut state = self.state();
            if let Some(inode) = state.inodes.get_alt_key(&key) {
                let record = state
                    .inodes
                    .get_mut(&inode)
                    .ok_or_else(|| errno(libc::EIO))?;
                let lookups = if inode == ROOT {
                    record.lookups
                } else {
                    record
                        .lookups
                        .checked_add(1)
                        .ok_or_else(|| errno(libc::EOVERFLOW))?
                };
                let inflight = record
                    .inflight
                    .checked_add(1)
                    .ok_or_else(|| errno(libc::EOVERFLOW))?;
                record.lookups = lookups;
                record.inflight = inflight;
                record.data.clone()
            } else {
                let inode = next(&mut state.next_inode)?;
                let data = Arc::new(InodeData { inode, file });
                state.inodes.insert(
                    inode,
                    key,
                    InodeRecord {
                        data: data.clone(),
                        lookups: 1,
                        opens: 0,
                        inflight: 1,
                    },
                );
                data
            }
        };
        Ok((entry(data.inode, attr), InodeRef { fs: self, data }))
    }

    fn lookup_at(&self, parent: &InodeData, name: &CStr) -> io::Result<Entry> {
        component(name, false)?;
        // Never follow the exported root's host parent.
        let name = if parent.inode == ROOT && name == c".." {
            c"."
        } else {
            name
        };
        let file = openat(
            parent.file.as_raw_fd(),
            name,
            libc::O_PATH | libc::O_NOFOLLOW,
            0,
        )?;
        let (found, _held) = self.register(file)?;
        Ok(found)
    }

    fn proc_name(file: &File) -> io::Result<CString> {
        CString::new(file.as_raw_fd().to_string()).map_err(|_| errno(libc::EINVAL))
    }

    fn reopen(&self, file: &File, flags: i32) -> io::Result<File> {
        match stat(file)?.st_mode & libc::S_IFMT {
            libc::S_IFREG | libc::S_IFDIR => {}
            libc::S_IFLNK => return Err(errno(libc::ELOOP)),
            _ => return Err(errno(libc::EOPNOTSUPP)),
        }
        let name = Self::proc_name(file)?;
        openat(
            self.proc_self_fd.as_raw_fd(),
            &name,
            flags & !libc::O_NOFOLLOW,
            0,
        )
    }

    fn xattr_file(&self, inode: u64) -> io::Result<(File, InodeRef<'_>)> {
        let node = self.inode(inode)?;
        // l*xattr on a proc-FD symlink would address the proc entry, not the
        // guest symlink. Do not follow its target in the host namespace.
        let file = self
            .reopen(&node.data.file, libc::O_RDONLY | libc::O_NONBLOCK)
            .map_err(|error| {
                if error.raw_os_error() == Some(libc::ELOOP) {
                    errno(libc::EOPNOTSUPP)
                } else {
                    error
                }
            })?;
        Ok((file, node))
    }

    fn creation_credentials(&self, ctx: Context) -> io::Result<()> {
        // Port only libkrun's nonprivileged set_creds branch: each ID is
        // independently root or the host ID; no guest impersonation is allowed.
        if (ctx.uid != 0 && ctx.uid != self.my_uid) || (ctx.gid != 0 && ctx.gid != self.my_gid) {
            return Err(errno(libc::EPERM));
        }
        Ok(())
    }

    fn chmod(&self, file: &File, mode: u32) -> io::Result<()> {
        let path = Self::proc_name(file)?;
        // SAFETY: the caller pins a non-symlink object while proc resolves its FD.
        cvt(unsafe {
            libc::fchmodat(
                self.proc_self_fd.as_raw_fd(),
                path.as_ptr(),
                mode & 0o7777,
                0,
            )
        })
    }

    fn add_handle(
        &self,
        node: &InodeRef<'_>,
        file: File,
        directory: bool,
        writable: bool,
    ) -> io::Result<u64> {
        let mut state = self.state();
        let handle = next(&mut state.next_handle)?;
        let record = state
            .inodes
            .get_mut(&node.data.inode)
            .ok_or_else(|| errno(libc::EBADF))?;
        record.opens = record
            .opens
            .checked_add(1)
            .ok_or_else(|| errno(libc::EOVERFLOW))?;
        state.handles.insert(
            handle,
            Arc::new(HandleData {
                node: node.data.clone(),
                file,
                directory,
                writable,
                position: Mutex::new(()),
            }),
        );
        Ok(handle)
    }

    fn do_open(
        &self,
        inode: u64,
        kill_priv: bool,
        open_flags: u32,
        directory: bool,
    ) -> io::Result<(Option<u64>, OpenOptions)> {
        if kill_priv {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let flags = flags(open_flags)?;
        if flags & (libc::O_CREAT | libc::O_EXCL) != 0 {
            return Err(errno(libc::EINVAL));
        }
        let node = self.inode(inode)?;
        match stat(&node.data.file)?.st_mode & libc::S_IFMT {
            libc::S_IFREG if !directory => {}
            libc::S_IFDIR if directory => {}
            libc::S_IFREG => return Err(errno(libc::ENOTDIR)),
            libc::S_IFDIR => return Err(errno(libc::EISDIR)),
            libc::S_IFLNK => return Err(errno(libc::ELOOP)),
            _ => return Err(errno(libc::EOPNOTSUPP)),
        }
        let file = self.reopen(
            &node.data.file,
            flags | if directory { libc::O_DIRECTORY } else { 0 },
        )?;
        let handle = self.add_handle(
            &node,
            file,
            directory,
            flags & libc::O_ACCMODE != libc::O_RDONLY,
        )?;
        Ok((
            Some(handle),
            if directory {
                OpenOptions::empty()
            } else {
                OpenOptions::DIRECT_IO
            },
        ))
    }

    fn do_release(&self, inode: u64, handle: u64, directory: bool) -> io::Result<()> {
        let removed = {
            let mut state = self.state();
            if !state
                .handles
                .get(&handle)
                .is_some_and(|data| data.node.inode == inode && data.directory == directory)
            {
                return Err(errno(libc::EBADF));
            }
            let handle = state.handles.remove(&handle);
            if let Some(record) = state.inodes.get_mut(&inode) {
                record.opens = record.opens.saturating_sub(1);
            }
            (handle, Self::collect_zero(&mut state, inode))
        };
        drop(removed);
        Ok(())
    }

    fn do_unlink(&self, parent: u64, name: &CStr, flags: i32) -> io::Result<()> {
        component(name, true)?;
        let parent = self.inode(parent)?;
        // SAFETY: the parent descriptor and validated name remain alive.
        cvt(unsafe { libc::unlinkat(parent.data.file.as_raw_fd(), name.as_ptr(), flags) })
    }

    fn do_readdir<F>(
        &self,
        inode: u64,
        handle: u64,
        size: u32,
        offset: u64,
        mut add: F,
    ) -> io::Result<()>
    where
        F: FnMut(&InodeData, DirEntry<'_>, &CStr) -> io::Result<usize>,
    {
        let data = self.handle(inode, handle, Some(true))?;
        let offset = i64::try_from(offset).map_err(|_| errno(libc::EINVAL))?;
        if size == 0 {
            return Ok(());
        }
        // As in libkrun, serialize kernel offset changes, then release the
        // position lock before invoking callbacks or doing PLUS lookups.
        let mut buffer = [0_u8; 32768];
        let count = {
            let _position = data
                .position
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // SAFETY: data pins the directory descriptor; lseek changes no Rust memory.
            if unsafe { libc::lseek64(data.file.as_raw_fd(), offset, libc::SEEK_SET) } < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: buffer is writable for its advertised length.
            let result = unsafe {
                libc::syscall(
                    libc::SYS_getdents64,
                    data.file.as_raw_fd(),
                    buffer.as_mut_ptr(),
                    buffer.len(),
                )
            };
            if result < 0 {
                return Err(io::Error::last_os_error());
            }
            result as usize
        };
        let mut remaining = &buffer[..count];
        while !remaining.is_empty() {
            // Linux dirent64 has a 19-byte fixed prefix, including unaligned fields.
            if remaining.len() < 20 {
                return Err(errno(libc::EIO));
            }
            let ino = u64::from_ne_bytes(remaining[..8].try_into().map_err(|_| errno(libc::EIO))?);
            let cookie =
                i64::from_ne_bytes(remaining[8..16].try_into().map_err(|_| errno(libc::EIO))?);
            let length = u16::from_ne_bytes([remaining[16], remaining[17]]) as usize;
            if length < 20 || length > remaining.len() || cookie < 0 {
                return Err(errno(libc::EIO));
            }
            let name =
                CStr::from_bytes_until_nul(&remaining[19..length]).map_err(|_| errno(libc::EIO))?;
            // The kernel adds dot entries; never expose a host parent above root.
            if name != c"."
                && name != c".."
                && add(
                    &data.node,
                    DirEntry {
                        ino,
                        offset: cookie as u64,
                        type_: u32::from(remaining[18]),
                        name: name.to_bytes(),
                    },
                    name,
                )? == 0
            {
                break;
            }
            remaining = &remaining[length..];
        }
        Ok(())
    }
}

impl FileSystem for PassthroughFs {
    type Inode = u64;
    type Handle = u64;

    fn init(&self, capable: FsOptions) -> io::Result<FsOptions> {
        self.install_root();
        // No writeback, security contexts, killpriv handling, locks, or DAX.
        Ok(capable & (FsOptions::DO_READDIRPLUS | FsOptions::READDIRPLUS_AUTO))
    }

    fn destroy(&self) {
        let removed = {
            let mut state = self.state();
            let handles = mem::take(&mut state.handles);
            let inodes = mem::replace(&mut state.inodes, MultikeyBTreeMap::new());
            (handles, inodes)
        };
        // Keep root and counters, but close released objects outside map locks.
        drop(removed);
    }

    fn lookup(&self, _ctx: Context, parent: u64, name: &CStr) -> io::Result<Entry> {
        component(name, false)?;
        let parent = self.inode(parent)?;
        self.lookup_at(&parent.data, name)
    }

    fn forget(&self, _ctx: Context, inode: u64, count: u64) {
        self.forget_one(inode, count);
    }

    fn getattr(
        &self,
        _ctx: Context,
        inode: u64,
        handle: Option<u64>,
    ) -> io::Result<(libc::stat64, Duration)> {
        let attr = if let Some(handle) = handle {
            let data = self.handle(inode, handle, None)?;
            stat(&data.node.file)?
        } else {
            let node = self.inode(inode)?;
            stat(&node.data.file)?
        };
        Ok((attr, Duration::ZERO))
    }

    fn open(
        &self,
        _ctx: Context,
        inode: u64,
        kill_priv: bool,
        flags: u32,
    ) -> io::Result<(Option<u64>, OpenOptions)> {
        self.do_open(inode, kill_priv, flags, false)
    }

    fn opendir(
        &self,
        _ctx: Context,
        inode: u64,
        flags: u32,
    ) -> io::Result<(Option<u64>, OpenOptions)> {
        self.do_open(inode, false, flags, true)
    }

    fn release(
        &self,
        _ctx: Context,
        inode: u64,
        _flags: u32,
        handle: u64,
        _flush: bool,
        _flock_release: bool,
        _lock_owner: Option<u64>,
    ) -> io::Result<()> {
        self.do_release(inode, handle, false)
    }

    fn releasedir(&self, _ctx: Context, inode: u64, _flags: u32, handle: u64) -> io::Result<()> {
        self.do_release(inode, handle, true)
    }

    fn create(
        &self,
        ctx: Context,
        parent: u64,
        name: &CStr,
        mode: u32,
        kill_priv: bool,
        open_flags: u32,
        umask: u32,
        extensions: Extensions,
    ) -> io::Result<(Entry, Option<u64>, OpenOptions)> {
        component(name, true)?;
        extension(&extensions)?;
        self.creation_credentials(ctx)?;
        if kill_priv {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let flags = flags(open_flags)?;
        if flags & libc::O_DIRECTORY != 0 {
            return Err(errno(libc::EINVAL));
        }
        if !matches!(mode & libc::S_IFMT, 0 | libc::S_IFREG) {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let parent = self.inode(parent)?;
        let mode = mode & !umask & 0o7777;
        // O_EXCL pins a new regular file. Existing names are first opened with
        // O_PATH so CREATE cannot block on a FIFO or open a device or symlink.
        let file = match openat(
            parent.data.file.as_raw_fd(),
            name,
            flags | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW,
            mode,
        ) {
            Ok(file) => {
                // Restore guest mode without changing the process-wide umask.
                // SAFETY: this is the new regular file returned by O_EXCL.
                cvt(unsafe { libc::fchmod(file.as_raw_fd(), mode) })?;
                file
            }
            Err(error)
                if error.raw_os_error() == Some(libc::EEXIST) && flags & libc::O_EXCL == 0 =>
            {
                let existing = openat(
                    parent.data.file.as_raw_fd(),
                    name,
                    libc::O_PATH | libc::O_NOFOLLOW,
                    0,
                )?;
                match stat(&existing)?.st_mode & libc::S_IFMT {
                    libc::S_IFREG => {}
                    libc::S_IFDIR => return Err(errno(libc::EISDIR)),
                    libc::S_IFLNK => return Err(errno(libc::ELOOP)),
                    _ => return Err(errno(libc::EOPNOTSUPP)),
                }
                self.reopen(&existing, flags & !(libc::O_CREAT | libc::O_EXCL))?
            }
            Err(error) => return Err(error),
        };
        // Register the opened object, not a second lookup of a replaceable name.
        let path_file = self.reopen(&file, libc::O_PATH)?;
        let (found, node) = self.register(path_file)?;
        let handle = match self.add_handle(
            &node,
            file,
            false,
            flags & libc::O_ACCMODE != libc::O_RDONLY,
        ) {
            Ok(handle) => handle,
            Err(error) => {
                self.forget_one(found.inode, 1);
                return Err(error);
            }
        };
        Ok((found, Some(handle), OpenOptions::DIRECT_IO))
    }

    fn mkdir(
        &self,
        ctx: Context,
        parent: u64,
        name: &CStr,
        mode: u32,
        umask: u32,
        extensions: Extensions,
    ) -> io::Result<Entry> {
        component(name, true)?;
        extension(&extensions)?;
        self.creation_credentials(ctx)?;
        let parent = self.inode(parent)?;
        let mode = mode & !umask & 0o7777;
        // SAFETY: the parent descriptor and component remain alive.
        cvt(unsafe { libc::mkdirat(parent.data.file.as_raw_fd(), name.as_ptr(), mode) })?;
        let file = openat(
            parent.data.file.as_raw_fd(),
            name,
            libc::O_PATH | libc::O_NOFOLLOW | libc::O_DIRECTORY,
            0,
        )?;
        self.chmod(&file, mode)?;
        // Failed post-create work leaves the host object in place; deleting by
        // name could remove a concurrent replacement. No lookup was published.
        self.register(file).map(|(found, _held)| found)
    }

    fn mknod(
        &self,
        ctx: Context,
        parent: u64,
        name: &CStr,
        mode: u32,
        rdev: u32,
        umask: u32,
        extensions: Extensions,
    ) -> io::Result<Entry> {
        component(name, true)?;
        extension(&extensions)?;
        self.creation_credentials(ctx)?;
        if !matches!(mode & libc::S_IFMT, 0 | libc::S_IFREG) || rdev != 0 {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let parent = self.inode(parent)?;
        let mode = mode & !umask & 0o7777;
        // SAFETY: this creates only an ordinary regular file, never a special node.
        cvt(unsafe {
            libc::mknodat(
                parent.data.file.as_raw_fd(),
                name.as_ptr(),
                libc::S_IFREG | mode,
                0,
            )
        })?;
        let file = openat(
            parent.data.file.as_raw_fd(),
            name,
            libc::O_PATH | libc::O_NOFOLLOW,
            0,
        )?;
        if stat(&file)?.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(errno(libc::EOPNOTSUPP));
        }
        self.chmod(&file, mode)?;
        self.register(file).map(|(found, _held)| found)
    }

    fn symlink(
        &self,
        ctx: Context,
        linkname: &CStr,
        parent: u64,
        name: &CStr,
        extensions: Extensions,
    ) -> io::Result<Entry> {
        component(name, true)?;
        extension(&extensions)?;
        self.creation_credentials(ctx)?;
        let parent = self.inode(parent)?;
        // SAFETY: both strings and the owned directory descriptor remain alive.
        cvt(unsafe {
            libc::symlinkat(
                linkname.as_ptr(),
                parent.data.file.as_raw_fd(),
                name.as_ptr(),
            )
        })?;
        self.lookup_at(&parent.data, name)
    }

    fn readlink(&self, _ctx: Context, inode: u64) -> io::Result<Vec<u8>> {
        let node = self.inode(inode)?;
        let mut bytes = vec![0; libc::PATH_MAX as usize];
        // SAFETY: node pins the symlink itself; bytes has its advertised capacity.
        let result = unsafe {
            libc::readlinkat(
                node.data.file.as_raw_fd(),
                c"".as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        bytes.truncate(result as usize);
        Ok(bytes)
    }

    fn link(&self, _ctx: Context, inode: u64, newparent: u64, newname: &CStr) -> io::Result<Entry> {
        component(newname, true)?;
        let source = self.inode(inode)?;
        let parent = self.inode(newparent)?;
        // The proc-FD workaround must not resolve guest symlink targets in the
        // host namespace. Symlink hardlinks need a separate no-follow API.
        if stat(&source.data.file)?.st_mode & libc::S_IFMT == libc::S_IFLNK {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let name = Self::proc_name(&source.data.file)?;
        // SAFETY: the proc name targets the pinned source descriptor.
        cvt(unsafe {
            libc::linkat(
                self.proc_self_fd.as_raw_fd(),
                name.as_ptr(),
                parent.data.file.as_raw_fd(),
                newname.as_ptr(),
                libc::AT_SYMLINK_FOLLOW,
            )
        })?;
        let attr = stat(&source.data.file)?;
        self.retain(inode)?;
        Ok(entry(inode, attr))
    }

    fn unlink(&self, _ctx: Context, parent: u64, name: &CStr) -> io::Result<()> {
        self.do_unlink(parent, name, 0)
    }
    fn rmdir(&self, _ctx: Context, parent: u64, name: &CStr) -> io::Result<()> {
        self.do_unlink(parent, name, libc::AT_REMOVEDIR)
    }

    fn rename(
        &self,
        _ctx: Context,
        olddir: u64,
        oldname: &CStr,
        newdir: u64,
        newname: &CStr,
        flags: u32,
    ) -> io::Result<()> {
        component(oldname, true)?;
        component(newname, true)?;
        if flags & !(libc::RENAME_EXCHANGE | libc::RENAME_NOREPLACE) != 0
            || flags == (libc::RENAME_EXCHANGE | libc::RENAME_NOREPLACE)
        {
            return Err(errno(libc::EINVAL));
        }
        let old = self.inode(olddir)?;
        let new = self.inode(newdir)?;
        // SAFETY: both directory descriptors and component names remain alive.
        cvt(unsafe {
            libc::renameat2(
                old.data.file.as_raw_fd(),
                oldname.as_ptr(),
                new.data.file.as_raw_fd(),
                newname.as_ptr(),
                flags,
            )
        })
    }

    fn read<W: io::Write + ZeroCopyWriter>(
        &self,
        _ctx: Context,
        inode: u64,
        handle: u64,
        mut writer: W,
        size: u32,
        offset: u64,
        _lock_owner: Option<u64>,
        _flags: u32,
    ) -> io::Result<usize> {
        checked_range(offset, size)?;
        let data = self.handle(inode, handle, Some(false))?;
        writer.write_from(&data.file, size as usize, offset)
    }

    fn write<R: io::Read + ZeroCopyReader>(
        &self,
        _ctx: Context,
        inode: u64,
        handle: u64,
        mut reader: R,
        size: u32,
        offset: u64,
        _lock_owner: Option<u64>,
        _delayed_write: bool,
        kill_priv: bool,
        _flags: u32,
    ) -> io::Result<usize> {
        checked_range(offset, size)?;
        if kill_priv {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let data = self.handle(inode, handle, Some(false))?;
        reader.read_to(&data.file, size as usize, offset)
    }

    fn readdir<F>(
        &self,
        _ctx: Context,
        inode: u64,
        handle: u64,
        size: u32,
        offset: u64,
        mut add: F,
    ) -> io::Result<()>
    where
        F: FnMut(DirEntry) -> io::Result<usize>,
    {
        self.do_readdir(inode, handle, size, offset, |_, dirent, _| add(dirent))
    }

    fn readdirplus<F>(
        &self,
        _ctx: Context,
        inode: u64,
        handle: u64,
        size: u32,
        offset: u64,
        mut add: F,
    ) -> io::Result<()>
    where
        F: FnMut(DirEntry, Entry) -> io::Result<usize>,
    {
        self.do_readdir(inode, handle, size, offset, |parent, mut dirent, name| {
            let found = match self.lookup_at(parent, name) {
                Ok(found) => found,
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(1),
                Err(error) => return Err(error),
            };
            dirent.ino = found.attr.st_ino;
            let inode = found.inode;
            let result = add(dirent, found);
            if !matches!(result, Ok(count) if count > 0) {
                self.forget_one(inode, 1);
            }
            result
        })
    }

    fn flush(&self, _ctx: Context, inode: u64, handle: u64, _lock_owner: u64) -> io::Result<()> {
        let data = self.handle(inode, handle, Some(false))?;
        // As in libkrun, duplicate and close without releasing the guest handle.
        // FLUSH is not an fsync guarantee.
        // SAFETY: data pins the original; successful duplicate is closed once.
        let fd = unsafe { libc::fcntl(data.file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        cvt(unsafe { libc::close(fd) })
    }

    fn fsync(&self, _ctx: Context, inode: u64, datasync: bool, handle: u64) -> io::Result<()> {
        let data = self.handle(inode, handle, Some(false))?;
        if datasync {
            data.file.sync_data()
        } else {
            data.file.sync_all()
        }
    }

    fn fsyncdir(&self, _ctx: Context, inode: u64, datasync: bool, handle: u64) -> io::Result<()> {
        let data = self.handle(inode, handle, Some(true))?;
        if datasync {
            data.file.sync_data()
        } else {
            data.file.sync_all()
        }
    }

    fn setattr(
        &self,
        _ctx: Context,
        inode: u64,
        attr: libc::stat64,
        handle: Option<u64>,
        valid: SetattrValid,
    ) -> io::Result<(libc::stat64, Duration)> {
        let held = handle
            .map(|handle| self.handle(inode, handle, None))
            .transpose()?;
        let node = self.inode(inode)?;
        if valid.intersects(SetattrValid::CTIME | SetattrValid::KILL_SUIDGID)
            || valid.bits() & !SetattrValid::all().bits() != 0
            || !matches!(
                stat(&node.data.file)?.st_mode & libc::S_IFMT,
                libc::S_IFREG | libc::S_IFDIR
            )
        {
            return Err(errno(libc::EOPNOTSUPP));
        }
        if valid.contains(SetattrValid::SIZE) && attr.st_size < 0 {
            return Err(errno(libc::EINVAL));
        }
        for (set, now, nanos) in [
            (
                SetattrValid::ATIME,
                SetattrValid::ATIME_NOW,
                attr.st_atime_nsec,
            ),
            (
                SetattrValid::MTIME,
                SetattrValid::MTIME_NOW,
                attr.st_mtime_nsec,
            ),
        ] {
            if valid.contains(set) && !valid.contains(now) && !(0..1_000_000_000).contains(&nanos) {
                return Err(errno(libc::EINVAL));
            }
        }
        // Only truncation needs a data FD. Metadata calls continue to work on
        // owned mode-000 files; keep the handle Arc alive through every syscall.
        let reopened = if valid.contains(SetattrValid::SIZE) && held.is_none() {
            Some(self.reopen(&node.data.file, libc::O_WRONLY | libc::O_NONBLOCK)?)
        } else {
            None
        };
        let resize_file = if valid.contains(SetattrValid::SIZE) {
            Some(if let Some(data) = held.as_ref() {
                if !data.writable {
                    return Err(errno(libc::EBADF));
                }
                &data.file
            } else {
                reopened.as_ref().ok_or_else(|| errno(libc::EBADF))?
            })
        } else {
            None
        };
        if valid.contains(SetattrValid::MODE) {
            self.chmod(&node.data.file, attr.st_mode)?;
        }
        if valid.intersects(SetattrValid::UID | SetattrValid::GID) {
            let uid = if valid.contains(SetattrValid::UID) {
                attr.st_uid
            } else {
                u32::MAX
            };
            let gid = if valid.contains(SetattrValid::GID) {
                attr.st_gid
            } else {
                u32::MAX
            };
            // SAFETY: O_PATH pins this object; chown never changes serving credentials.
            cvt(unsafe {
                libc::fchownat(
                    node.data.file.as_raw_fd(),
                    c"".as_ptr(),
                    uid,
                    gid,
                    libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
                )
            })?;
        }
        if let Some(file) = resize_file {
            // SAFETY: held/reopened owns this descriptor throughout truncation.
            cvt(unsafe { libc::ftruncate64(file.as_raw_fd(), attr.st_size) })?;
        }
        if valid.intersects(
            SetattrValid::ATIME
                | SetattrValid::MTIME
                | SetattrValid::ATIME_NOW
                | SetattrValid::MTIME_NOW,
        ) {
            let times = [
                libc::timespec {
                    tv_sec: attr.st_atime,
                    tv_nsec: if valid.contains(SetattrValid::ATIME_NOW) {
                        libc::UTIME_NOW
                    } else if valid.contains(SetattrValid::ATIME) {
                        attr.st_atime_nsec
                    } else {
                        libc::UTIME_OMIT
                    },
                },
                libc::timespec {
                    tv_sec: attr.st_mtime,
                    tv_nsec: if valid.contains(SetattrValid::MTIME_NOW) {
                        libc::UTIME_NOW
                    } else if valid.contains(SetattrValid::MTIME) {
                        attr.st_mtime_nsec
                    } else {
                        libc::UTIME_OMIT
                    },
                },
            ];
            let path = Self::proc_name(&node.data.file)?;
            // SAFETY: the pinned non-symlink target and both times remain alive.
            cvt(unsafe {
                libc::utimensat(
                    self.proc_self_fd.as_raw_fd(),
                    path.as_ptr(),
                    times.as_ptr(),
                    0,
                )
            })?;
        }
        Ok((stat(&node.data.file)?, Duration::ZERO))
    }

    fn access(&self, ctx: Context, inode: u64, mask: u32) -> io::Result<()> {
        if mask & !((libc::R_OK | libc::W_OK | libc::X_OK) as u32) != 0 {
            return Err(errno(libc::EINVAL));
        }
        let node = self.inode(inode)?;
        let st = stat(&node.data.file)?;
        if mask == libc::F_OK as u32 {
            return Ok(());
        }
        if st.st_mode & libc::S_IFMT == libc::S_IFLNK {
            return Err(errno(libc::EOPNOTSUPP));
        }
        // POSIX selects exactly one class: owner, else group, else other. Root
        // bypasses the read and write bits and needs one execute bit for X_OK.
        if ctx.uid == 0 {
            if mask & libc::X_OK as u32 != 0 && st.st_mode & 0o111 == 0 {
                return Err(errno(libc::EACCES));
            }
        } else {
            let granted = if st.st_uid == ctx.uid {
                (st.st_mode >> 6) & 0o7
            } else if st.st_gid == ctx.gid {
                (st.st_mode >> 3) & 0o7
            } else {
                st.st_mode & 0o7
            };
            if mask & !granted != 0 {
                return Err(errno(libc::EACCES));
            }
        }
        // Bound success by what the host effective identity can actually access.
        let path = Self::proc_name(&node.data.file)?;
        // SAFETY: this internal path addresses the pinned object, not a guest path.
        cvt(unsafe {
            libc::faccessat(
                self.proc_self_fd.as_raw_fd(),
                path.as_ptr(),
                mask as i32,
                libc::AT_EACCESS,
            )
        })
    }

    fn statfs(&self, _ctx: Context, inode: u64) -> io::Result<libc::statvfs64> {
        let node = self.inode(inode)?;
        let mut out = MaybeUninit::uninit();
        // SAFETY: out has room for statvfs64 and node pins the descriptor.
        cvt(unsafe { libc::fstatvfs64(node.data.file.as_raw_fd(), out.as_mut_ptr()) })?;
        // SAFETY: fstatvfs64 initialized out on success.
        Ok(unsafe { out.assume_init() })
    }

    fn fallocate(
        &self,
        _ctx: Context,
        inode: u64,
        handle: u64,
        mode: u32,
        offset: u64,
        length: u64,
    ) -> io::Result<()> {
        let end = offset
            .checked_add(length)
            .ok_or_else(|| errno(libc::EINVAL))?;
        i64::try_from(end).map_err(|_| errno(libc::EINVAL))?;
        let mode = i32::try_from(mode).map_err(|_| errno(libc::EINVAL))?;
        let data = self.handle(inode, handle, Some(false))?;
        // SAFETY: data owns the descriptor and the signed range was checked.
        cvt(unsafe { libc::fallocate64(data.file.as_raw_fd(), mode, offset as i64, length as i64) })
    }

    fn lseek(
        &self,
        _ctx: Context,
        inode: u64,
        handle: u64,
        offset: u64,
        whence: u32,
    ) -> io::Result<u64> {
        let offset = i64::try_from(offset).map_err(|_| errno(libc::EINVAL))?;
        let whence = i32::try_from(whence).map_err(|_| errno(libc::EINVAL))?;
        if !matches!(
            whence,
            libc::SEEK_SET | libc::SEEK_CUR | libc::SEEK_END | libc::SEEK_DATA | libc::SEEK_HOLE
        ) {
            return Err(errno(libc::EINVAL));
        }
        let data = self.handle(inode, handle, Some(false))?;
        let _position = data
            .position
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // SAFETY: the descriptor is owned and position changes are serialized.
        let result = unsafe { libc::lseek64(data.file.as_raw_fd(), offset, whence) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result as u64)
        }
    }

    fn copyfilerange(
        &self,
        _ctx: Context,
        inode_in: u64,
        handle_in: u64,
        offset_in: u64,
        inode_out: u64,
        handle_out: u64,
        offset_out: u64,
        len: u64,
        flags: u64,
    ) -> io::Result<usize> {
        if flags != 0 {
            return Err(errno(libc::EINVAL));
        }
        for offset in [offset_in, offset_out] {
            let end = offset.checked_add(len).ok_or_else(|| errno(libc::EINVAL))?;
            i64::try_from(end).map_err(|_| errno(libc::EINVAL))?;
        }
        let length = usize::try_from(len).map_err(|_| errno(libc::EINVAL))?;
        let source = self.handle(inode_in, handle_in, Some(false))?;
        let target = self.handle(inode_out, handle_out, Some(false))?;
        let mut input = offset_in as i64;
        let mut output = offset_out as i64;
        // SAFETY: both descriptors and initialized offset pointers remain alive.
        let result = unsafe {
            libc::copy_file_range(
                source.file.as_raw_fd(),
                &mut input,
                target.file.as_raw_fd(),
                &mut output,
                length,
                0,
            )
        };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result as usize)
        }
    }

    fn setxattr(
        &self,
        _ctx: Context,
        inode: u64,
        name: &CStr,
        value: &[u8],
        flags: u32,
    ) -> io::Result<()> {
        if flags & !((libc::XATTR_CREATE | libc::XATTR_REPLACE) as u32) != 0 {
            return Err(errno(libc::EINVAL));
        }
        let (file, _node) = self.xattr_file(inode)?;
        // SAFETY: the descriptor, name and value remain alive for this call.
        cvt(unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                flags as i32,
            )
        })
    }

    fn getxattr(
        &self,
        _ctx: Context,
        inode: u64,
        name: &CStr,
        size: u32,
    ) -> io::Result<GetxattrReply> {
        if size > 65536 {
            return Err(errno(libc::E2BIG));
        }
        let (file, _node) = self.xattr_file(inode)?;
        let mut bytes = vec![0; size as usize];
        // SAFETY: the buffer has its advertised capacity and the descriptor is owned.
        let result = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        if size == 0 {
            Ok(GetxattrReply::Count(result as u32))
        } else {
            bytes.truncate(result as usize);
            Ok(GetxattrReply::Value(bytes))
        }
    }

    fn listxattr(&self, _ctx: Context, inode: u64, size: u32) -> io::Result<ListxattrReply> {
        if size > 65536 {
            return Err(errno(libc::E2BIG));
        }
        let (file, _node) = self.xattr_file(inode)?;
        let mut bytes = vec![0; size as usize];
        // SAFETY: the buffer has its advertised capacity and the descriptor is owned.
        let result =
            unsafe { libc::flistxattr(file.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len()) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        if size == 0 {
            Ok(ListxattrReply::Count(result as u32))
        } else {
            bytes.truncate(result as usize);
            Ok(ListxattrReply::Names(bytes))
        }
    }

    fn removexattr(&self, _ctx: Context, inode: u64, name: &CStr) -> io::Result<()> {
        let (file, _node) = self.xattr_file(inode)?;
        // SAFETY: the descriptor and terminated name remain alive.
        cvt(unsafe { libc::fremovexattr(file.as_raw_fd(), name.as_ptr()) })
    }
}
