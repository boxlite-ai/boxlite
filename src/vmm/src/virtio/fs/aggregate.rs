// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! One guest namespace over independent per-share filesystems.
//!
//! Only this layer owns global node/handle numbers and read-only policy. Host
//! objects, local lookup references and file operations belong to each backend.
//! A global node reserves one extra backend lookup until its final Arc drops;
//! FORGET can therefore remove the guest lookup without invalidating a request
//! that has already acquired that node. No namespace lock spans backend I/O.

use std::collections::BTreeMap;
use std::ffi::{CStr, CString};
use std::io;
use std::mem;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::filesystem::{
    Context, DirEntry, Entry, Extensions, FileSystem, FsOptions, GetxattrReply, ListxattrReply,
    OpenOptions, SetattrValid, ZeroCopyReader, ZeroCopyWriter,
};
use super::linux::passthrough::{InodeAltKey, PassthroughFs};

const ROOT: u64 = 1;
const TIMEOUT: Duration = Duration::ZERO;
const INTERNAL: Context = Context {
    uid: 0,
    gid: 0,
    pid: 0,
};

pub(crate) struct Share {
    pub(crate) name: String,
    pub(crate) path: PathBuf,
    pub(crate) read_only: bool,
}

struct Export {
    name: CString,
    root: u64,
    backend: Arc<PassthroughFs>,
    read_only: bool,
}

struct Node {
    global: u64,
    identity: u64,
    share: usize,
    local: u64,
    backend: Arc<PassthroughFs>,
    root: bool,
}

impl Drop for Node {
    fn drop(&mut self) {
        if !self.root {
            self.backend.forget(INTERNAL, self.local, 1);
        }
    }
}

struct NodeRecord {
    node: Arc<Node>,
    lookups: u64,
    opens: u64,
}

struct Handle {
    inode: u64,
    node: Option<Arc<Node>>,
    local: u64,
    directory: bool,
    flags: u32,
}

impl Drop for Handle {
    fn drop(&mut self) {
        if let Some(node) = &self.node {
            // Removing a guest handle prevents new requests. Its last owned Arc
            // releases the backend handle only after existing requests finish.
            let result = if self.directory {
                node.backend
                    .releasedir(INTERNAL, node.local, self.flags, self.local)
            } else {
                node.backend.release(
                    INTERNAL, node.local, self.flags, self.local, false, false, None,
                )
            };
            if let Err(error) = result {
                tracing::error!(%error, inode = self.inode, "failed to release filesystem handle");
            }
        }
    }
}

#[derive(Default)]
struct State {
    nodes: BTreeMap<u64, NodeRecord>,
    local_ids: BTreeMap<(usize, u64), u64>,
    // Scalar identities survive node reclamation, without retaining backend FDs.
    identities: BTreeMap<(usize, InodeAltKey), u64>,
    handles: BTreeMap<u64, Arc<Handle>>,
    next_node: u64,
    next_identity: u64,
    next_handle: u64,
}

pub(crate) struct AggregateFs {
    shares: Vec<Export>,
    state: Mutex<State>,
}

fn errno(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

fn allocate(next: &mut u64) -> io::Result<u64> {
    let value = *next;
    *next = value.checked_add(1).ok_or_else(|| errno(libc::EOVERFLOW))?;
    Ok(value)
}

fn component(name: &CStr, mutation: bool) -> io::Result<()> {
    let bytes = name.to_bytes();
    if bytes.is_empty() || bytes.contains(&b'/') || (mutation && matches!(bytes, b"." | b"..")) {
        return Err(errno(libc::EINVAL));
    }
    Ok(())
}

fn normalize(mut entry: Entry, global: u64, identity: u64) -> Entry {
    entry.inode = global;
    entry.attr.st_ino = identity;
    entry
}

fn synthetic_attr(shares: usize) -> libc::stat64 {
    // SAFETY: stat64 contains integer fields, all of which permit zero.
    let mut attr: libc::stat64 = unsafe { mem::zeroed() };
    attr.st_ino = ROOT;
    attr.st_mode = libc::S_IFDIR | 0o555;
    attr.st_nlink = (shares + 2) as _;
    attr.st_blksize = 4096;
    // SAFETY: identity queries do not access caller memory or alter credentials.
    attr.st_uid = unsafe { libc::geteuid() };
    // SAFETY: identity queries do not access caller memory or alter credentials.
    attr.st_gid = unsafe { libc::getegid() };
    attr
}

fn entry_from_attr(inode: u64, attr: libc::stat64) -> Entry {
    Entry {
        inode,
        generation: 0,
        attr,
        attr_flags: 0,
        attr_timeout: TIMEOUT,
        entry_timeout: TIMEOUT,
    }
}

impl AggregateFs {
    pub(crate) fn new(shares: Vec<Share>) -> io::Result<Self> {
        let mut exports = Vec::with_capacity(shares.len());
        let mut names = std::collections::BTreeSet::new();
        for (index, share) in shares.into_iter().enumerate() {
            let name = CString::new(share.name).map_err(|_| errno(libc::EINVAL))?;
            component(&name, true)?;
            if !names.insert(name.clone()) {
                return Err(errno(libc::EINVAL));
            }
            exports.push(Export {
                name,
                root: index as u64 + 2,
                backend: Arc::new(PassthroughFs::new(share.path)?),
                read_only: share.read_only,
            });
        }
        let first = exports.len() as u64 + 2;
        let fs = Self {
            shares: exports,
            state: Mutex::new(State {
                next_node: first,
                next_identity: first,
                next_handle: 1,
                ..State::default()
            }),
        };
        fs.install_roots();
        Ok(fs)
    }

    fn install_roots(&self) {
        let mut state = self.state.lock().unwrap();
        for (share, export) in self.shares.iter().enumerate() {
            state.local_ids.insert((share, ROOT), export.root);
            state
                .nodes
                .entry(export.root)
                .or_insert_with(|| NodeRecord {
                    node: Arc::new(Node {
                        global: export.root,
                        identity: export.root,
                        share,
                        local: ROOT,
                        backend: export.backend.clone(),
                        root: true,
                    }),
                    lookups: 1,
                    opens: 0,
                });
        }
    }

    fn node(&self, inode: u64) -> io::Result<Arc<Node>> {
        self.state
            .lock()
            .unwrap()
            .nodes
            .get(&inode)
            .map(|record| record.node.clone())
            .ok_or_else(|| errno(libc::EBADF))
    }

    fn handle(&self, inode: u64, handle: u64, directory: Option<bool>) -> io::Result<Arc<Handle>> {
        self.state
            .lock()
            .unwrap()
            .handles
            .get(&handle)
            .filter(|data| {
                data.inode == inode && directory.is_none_or(|kind| data.directory == kind)
            })
            .cloned()
            .ok_or_else(|| errno(libc::EBADF))
    }

    fn writable(&self, node: &Node) -> io::Result<()> {
        if self.shares[node.share].read_only {
            Err(errno(libc::EROFS))
        } else {
            Ok(())
        }
    }

    fn mutation_parent(&self, inode: u64, name: &CStr) -> io::Result<Arc<Node>> {
        component(name, true)?;
        if inode == ROOT {
            return Err(errno(libc::EROFS));
        }
        let node = self.node(inode)?;
        self.writable(&node)?;
        Ok(node)
    }

    fn map_entry(&self, share: usize, entry: Entry) -> io::Result<Entry> {
        let local = entry.inode;
        let backend = &self.shares[share].backend;
        let result = self.insert_entry(share, entry);
        if result.is_err() {
            backend.forget(INTERNAL, local, 1);
        }
        result
    }

    // READDIRPLUS callbacks leave rollback ownership with the backend.
    fn insert_entry(&self, share: usize, entry: Entry) -> io::Result<Entry> {
        let local = entry.inode;
        let backend = &self.shares[share].backend;
        let key = (share, backend.identity(local)?);
        let mut state = self.state.lock().unwrap();
        let (global, identity) = if let Some(global) = state.local_ids.get(&(share, local)).copied()
        {
            let record = state
                .nodes
                .get_mut(&global)
                .ok_or_else(|| errno(libc::EBADF))?;
            if !record.node.root {
                record.lookups = record
                    .lookups
                    .checked_add(1)
                    .ok_or_else(|| errno(libc::EOVERFLOW))?;
            }
            (global, record.node.identity)
        } else {
            let global = allocate(&mut state.next_node)?;
            let identity = match state.identities.get(&key) {
                Some(identity) => *identity,
                None => {
                    let identity = allocate(&mut state.next_identity)?;
                    state.identities.insert(key, identity);
                    identity
                }
            };
            // retain is map-only: it reserves the in-flight object reference,
            // distinct from the guest lookup that produced this entry.
            backend.retain(local)?;
            state.local_ids.insert((share, local), global);
            state.nodes.insert(
                global,
                NodeRecord {
                    node: Arc::new(Node {
                        global,
                        identity,
                        share,
                        local,
                        backend: backend.clone(),
                        root: false,
                    }),
                    lookups: 1,
                    opens: 0,
                },
            );
            (global, identity)
        };
        Ok(normalize(entry, global, identity))
    }

    fn collect_zero(state: &mut State, inode: u64) -> Option<NodeRecord> {
        let record = state.nodes.get(&inode)?;
        if record.node.root || record.lookups != 0 || record.opens != 0 {
            return None;
        }
        state
            .local_ids
            .remove(&(record.node.share, record.node.local));
        state.nodes.remove(&inode)
    }

    fn forget_entry(&self, inode: u64, count: u64, forward: bool) {
        let (node, released, removed) = {
            let mut state = self.state.lock().unwrap();
            let Some(record) = state.nodes.get_mut(&inode) else {
                return;
            };
            if record.node.root {
                return;
            }
            let released = count.min(record.lookups);
            record.lookups -= released;
            let node = record.node.clone();
            let removed = Self::collect_zero(&mut state, inode);
            (node, released, removed)
        };
        if forward {
            node.backend.forget(INTERNAL, node.local, released);
        }
        drop(removed);
    }

    fn add_handle(
        &self,
        inode: u64,
        node: Option<Arc<Node>>,
        local: u64,
        directory: bool,
        flags: u32,
    ) -> io::Result<u64> {
        // Ownership is transferred before allocation, so an ID overflow also
        // releases the backend handle rather than leaving an unreachable FD.
        let handle = Arc::new(Handle {
            inode,
            node,
            local,
            directory,
            flags,
        });
        let mut state = self.state.lock().unwrap();
        let id = allocate(&mut state.next_handle)?;
        if inode != ROOT {
            let record = state
                .nodes
                .get_mut(&inode)
                .ok_or_else(|| errno(libc::EBADF))?;
            record.opens = record
                .opens
                .checked_add(1)
                .ok_or_else(|| errno(libc::EOVERFLOW))?;
        }
        state.handles.insert(id, handle);
        Ok(id)
    }

    fn close(&self, inode: u64, handle: u64, directory: bool) -> io::Result<()> {
        let (removed, node) = {
            let mut state = self.state.lock().unwrap();
            let data = state
                .handles
                .get(&handle)
                .ok_or_else(|| errno(libc::EBADF))?;
            if data.inode != inode || data.directory != directory {
                return Err(errno(libc::EBADF));
            }
            let removed = state.handles.remove(&handle);
            if let Some(record) = state.nodes.get_mut(&inode) {
                record.opens -= 1;
            }
            let node = Self::collect_zero(&mut state, inode);
            (removed, node)
        };
        drop(removed);
        drop(node);
        Ok(())
    }

    fn open_node(
        &self,
        ctx: Context,
        inode: u64,
        flags: u32,
        directory: bool,
        kill_priv: bool,
    ) -> io::Result<(Option<u64>, OpenOptions)> {
        let writing = flags as i32 & (libc::O_ACCMODE | libc::O_TRUNC) != libc::O_RDONLY;
        if inode == ROOT {
            if writing {
                return Err(errno(libc::EROFS));
            }
            if !directory {
                return Err(errno(libc::EISDIR));
            }
            return Ok((
                Some(self.add_handle(inode, None, 0, true, flags)?),
                OpenOptions::empty(),
            ));
        }
        let node = self.node(inode)?;
        if writing {
            self.writable(&node)?;
        }
        let (local, options) = if directory {
            node.backend.opendir(ctx, node.local, flags)?
        } else {
            node.backend.open(ctx, node.local, kill_priv, flags)?
        };
        let local = local.ok_or_else(|| errno(libc::EIO))?;
        let handle = self.add_handle(inode, Some(node), local, directory, flags)?;
        Ok((Some(handle), options))
    }

    fn directory_dots<F>(
        &self,
        ctx: Context,
        node: &Node,
        offset: u64,
        mut add: F,
    ) -> io::Result<bool>
    where
        F: FnMut(DirEntry, Entry) -> io::Result<usize>,
    {
        for (name, cookie) in [(c".", 1), (c"..", 2)] {
            if offset >= cookie || (name == c".." && !node.root) {
                continue;
            }
            let entry = if name == c"." {
                let (mut attr, _) = node.backend.getattr(ctx, node.local, None)?;
                attr.st_ino = node.identity;
                entry_from_attr(node.global, attr)
            } else {
                entry_from_attr(ROOT, synthetic_attr(self.shares.len()))
            };
            let result = add(
                DirEntry {
                    ino: entry.attr.st_ino,
                    offset: cookie,
                    type_: libc::DT_DIR as u32,
                    name: name.to_bytes(),
                },
                entry,
            );
            if result? == 0 {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn root_directory<F>(
        &self,
        ctx: Context,
        handle: u64,
        size: u32,
        offset: u64,
        mut add: F,
    ) -> io::Result<()>
    where
        F: FnMut(DirEntry, Entry) -> io::Result<usize>,
    {
        let _held = self.handle(ROOT, handle, Some(true))?;
        if size == 0 {
            return Ok(());
        }
        for (name, cookie) in [(c".", 1), (c"..", 2)] {
            if offset < cookie {
                let entry = entry_from_attr(ROOT, synthetic_attr(self.shares.len()));
                if add(
                    DirEntry {
                        ino: ROOT,
                        offset: cookie,
                        type_: libc::DT_DIR as u32,
                        name: name.to_bytes(),
                    },
                    entry,
                )? == 0
                {
                    return Ok(());
                }
            }
        }
        let start = usize::try_from(offset.saturating_sub(2)).map_err(|_| errno(libc::EINVAL))?;
        if start > self.shares.len() {
            return Err(errno(libc::EINVAL));
        }
        for (index, share) in self.shares.iter().enumerate().skip(start) {
            let (mut attr, _) = share.backend.getattr(ctx, ROOT, None)?;
            attr.st_ino = share.root;
            let entry = entry_from_attr(share.root, attr);
            if add(
                DirEntry {
                    ino: share.root,
                    offset: index as u64 + 3,
                    type_: libc::DT_DIR as u32,
                    name: share.name.to_bytes(),
                },
                entry,
            )? == 0
            {
                break;
            }
        }
        Ok(())
    }
}

impl FileSystem for AggregateFs {
    type Inode = u64;
    type Handle = u64;

    fn init(&self, capable: FsOptions) -> io::Result<FsOptions> {
        let mut options = capable;
        for share in &self.shares {
            options &= share.backend.init(capable)?;
        }
        self.install_roots();
        Ok(options & (FsOptions::DO_READDIRPLUS | FsOptions::READDIRPLUS_AUTO))
    }

    fn destroy(&self) {
        let (handles, nodes) = {
            let mut state = self.state.lock().unwrap();
            state.local_ids.clear();
            state.identities.clear();
            (mem::take(&mut state.handles), mem::take(&mut state.nodes))
        };
        drop(handles);
        drop(nodes);
        for share in &self.shares {
            share.backend.destroy();
        }
    }

    fn lookup(&self, ctx: Context, parent: u64, name: &CStr) -> io::Result<Entry> {
        component(name, false)?;
        if parent == ROOT {
            if matches!(name.to_bytes(), b"." | b"..") {
                return Ok(entry_from_attr(ROOT, synthetic_attr(self.shares.len())));
            }
            let (index, share) = self
                .shares
                .iter()
                .enumerate()
                .find(|(_, share)| share.name.as_c_str() == name)
                .ok_or_else(|| errno(libc::ENOENT))?;
            return self.map_entry(index, share.backend.lookup(ctx, ROOT, c".")?);
        }
        let node = self.node(parent)?;
        if name == c".." {
            return Err(errno(libc::EPERM));
        }
        self.map_entry(node.share, node.backend.lookup(ctx, node.local, name)?)
    }

    fn forget(&self, _ctx: Context, inode: u64, count: u64) {
        self.forget_entry(inode, count, true);
    }

    fn getattr(
        &self,
        ctx: Context,
        inode: u64,
        handle: Option<u64>,
    ) -> io::Result<(libc::stat64, Duration)> {
        let held = handle
            .map(|handle| self.handle(inode, handle, None))
            .transpose()?;
        if inode == ROOT {
            return Ok((synthetic_attr(self.shares.len()), TIMEOUT));
        }
        let node = match held.as_ref().and_then(|handle| handle.node.clone()) {
            Some(node) => node,
            None => self.node(inode)?,
        };
        let local_handle = held.as_ref().map(|handle| handle.local);
        let (mut attr, timeout) = node.backend.getattr(ctx, node.local, local_handle)?;
        attr.st_ino = node.identity;
        Ok((attr, timeout))
    }

    fn setattr(
        &self,
        ctx: Context,
        inode: u64,
        attr: libc::stat64,
        handle: Option<u64>,
        valid: SetattrValid,
    ) -> io::Result<(libc::stat64, Duration)> {
        if inode == ROOT {
            return Err(errno(libc::EROFS));
        }
        let node = self.node(inode)?;
        self.writable(&node)?;
        let held = handle
            .map(|handle| self.handle(inode, handle, None))
            .transpose()?;
        let (mut attr, timeout) = node.backend.setattr(
            ctx,
            node.local,
            attr,
            held.as_ref().map(|handle| handle.local),
            valid,
        )?;
        attr.st_ino = node.identity;
        Ok((attr, timeout))
    }

    fn open(
        &self,
        ctx: Context,
        inode: u64,
        kill_priv: bool,
        flags: u32,
    ) -> io::Result<(Option<u64>, OpenOptions)> {
        self.open_node(ctx, inode, flags, false, kill_priv)
    }
    fn opendir(
        &self,
        ctx: Context,
        inode: u64,
        flags: u32,
    ) -> io::Result<(Option<u64>, OpenOptions)> {
        self.open_node(ctx, inode, flags, true, false)
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
        self.close(inode, handle, false)
    }
    fn releasedir(&self, _ctx: Context, inode: u64, _flags: u32, handle: u64) -> io::Result<()> {
        self.close(inode, handle, true)
    }

    fn create(
        &self,
        ctx: Context,
        parent: u64,
        name: &CStr,
        mode: u32,
        kill_priv: bool,
        flags: u32,
        umask: u32,
        extensions: Extensions,
    ) -> io::Result<(Entry, Option<u64>, OpenOptions)> {
        let node = self.mutation_parent(parent, name)?;
        let (entry, local_handle, options) = node.backend.create(
            ctx, node.local, name, mode, kill_priv, flags, umask, extensions,
        )?;
        let local_inode = entry.inode;
        let local_handle = local_handle.ok_or_else(|| errno(libc::EIO))?;
        let entry = match self.map_entry(node.share, entry) {
            Ok(entry) => entry,
            Err(error) => {
                node.backend
                    .release(ctx, local_inode, flags, local_handle, false, false, None)?;
                return Err(error);
            }
        };
        let child = self.node(entry.inode)?;
        let handle = match self.add_handle(entry.inode, Some(child), local_handle, false, flags) {
            Ok(handle) => handle,
            Err(error) => {
                self.forget_entry(entry.inode, 1, true);
                return Err(error);
            }
        };
        Ok((entry, Some(handle), options))
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
        let node = self.mutation_parent(parent, name)?;
        self.map_entry(
            node.share,
            node.backend
                .mkdir(ctx, node.local, name, mode, umask, extensions)?,
        )
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
        let node = self.mutation_parent(parent, name)?;
        self.map_entry(
            node.share,
            node.backend
                .mknod(ctx, node.local, name, mode, rdev, umask, extensions)?,
        )
    }
    fn symlink(
        &self,
        ctx: Context,
        linkname: &CStr,
        parent: u64,
        name: &CStr,
        extensions: Extensions,
    ) -> io::Result<Entry> {
        let node = self.mutation_parent(parent, name)?;
        self.map_entry(
            node.share,
            node.backend
                .symlink(ctx, linkname, node.local, name, extensions)?,
        )
    }
    fn readlink(&self, ctx: Context, inode: u64) -> io::Result<Vec<u8>> {
        let node = self.node(inode)?;
        node.backend.readlink(ctx, node.local)
    }
    fn unlink(&self, ctx: Context, parent: u64, name: &CStr) -> io::Result<()> {
        let node = self.mutation_parent(parent, name)?;
        node.backend.unlink(ctx, node.local, name)
    }
    fn rmdir(&self, ctx: Context, parent: u64, name: &CStr) -> io::Result<()> {
        let node = self.mutation_parent(parent, name)?;
        node.backend.rmdir(ctx, node.local, name)
    }
    fn rename(
        &self,
        ctx: Context,
        olddir: u64,
        oldname: &CStr,
        newdir: u64,
        newname: &CStr,
        flags: u32,
    ) -> io::Result<()> {
        component(oldname, true)?;
        component(newname, true)?;
        if olddir == ROOT || newdir == ROOT {
            return Err(errno(libc::EROFS));
        }
        let source = self.node(olddir)?;
        let target = self.node(newdir)?;
        if source.share != target.share {
            return Err(errno(libc::EXDEV));
        }
        self.writable(&source)?;
        self.writable(&target)?;
        source
            .backend
            .rename(ctx, source.local, oldname, target.local, newname, flags)
    }
    fn link(&self, ctx: Context, inode: u64, newparent: u64, newname: &CStr) -> io::Result<Entry> {
        component(newname, true)?;
        if inode == ROOT || newparent == ROOT {
            return Err(errno(libc::EROFS));
        }
        let source = self.node(inode)?;
        let target = self.node(newparent)?;
        if source.share != target.share {
            return Err(errno(libc::EXDEV));
        }
        self.writable(&target)?;
        self.map_entry(
            source.share,
            source
                .backend
                .link(ctx, source.local, target.local, newname)?,
        )
    }

    fn read<W: io::Write + ZeroCopyWriter>(
        &self,
        ctx: Context,
        inode: u64,
        handle: u64,
        writer: W,
        size: u32,
        offset: u64,
        lock_owner: Option<u64>,
        flags: u32,
    ) -> io::Result<usize> {
        let held = self.handle(inode, handle, Some(false))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        node.backend.read(
            ctx, node.local, held.local, writer, size, offset, lock_owner, flags,
        )
    }
    fn write<R: io::Read + ZeroCopyReader>(
        &self,
        ctx: Context,
        inode: u64,
        handle: u64,
        reader: R,
        size: u32,
        offset: u64,
        lock_owner: Option<u64>,
        delayed_write: bool,
        kill_priv: bool,
        flags: u32,
    ) -> io::Result<usize> {
        let held = self.handle(inode, handle, Some(false))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        self.writable(node)?;
        node.backend.write(
            ctx,
            node.local,
            held.local,
            reader,
            size,
            offset,
            lock_owner,
            delayed_write,
            kill_priv,
            flags,
        )
    }
    fn flush(&self, ctx: Context, inode: u64, handle: u64, lock_owner: u64) -> io::Result<()> {
        let held = self.handle(inode, handle, Some(false))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        node.backend.flush(ctx, node.local, held.local, lock_owner)
    }
    fn fsync(&self, ctx: Context, inode: u64, datasync: bool, handle: u64) -> io::Result<()> {
        let held = self.handle(inode, handle, Some(false))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        node.backend.fsync(ctx, node.local, datasync, held.local)
    }
    fn fsyncdir(&self, ctx: Context, inode: u64, datasync: bool, handle: u64) -> io::Result<()> {
        let held = self.handle(inode, handle, Some(true))?;
        let Some(node) = held.node.as_ref() else {
            return Ok(());
        };
        node.backend.fsyncdir(ctx, node.local, datasync, held.local)
    }

    fn readdir<F>(
        &self,
        ctx: Context,
        inode: u64,
        handle: u64,
        size: u32,
        offset: u64,
        mut add: F,
    ) -> io::Result<()>
    where
        F: FnMut(DirEntry) -> io::Result<usize>,
    {
        if inode == ROOT {
            return self.root_directory(ctx, handle, size, offset, |dirent, _| add(dirent));
        }
        let held = self.handle(inode, handle, Some(true))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        if size == 0 || !self.directory_dots(ctx, node, offset, |dirent, _| add(dirent))? {
            return Ok(());
        }
        node.backend.readdir(
            ctx,
            node.local,
            held.local,
            size,
            offset.saturating_sub(2),
            |dirent| {
                let mut name = [0_u8; libc::NAME_MAX as usize + 1];
                if dirent.name.len() >= name.len() {
                    return Err(errno(libc::ENAMETOOLONG));
                }
                name[..dirent.name.len()].copy_from_slice(dirent.name);
                let name = CStr::from_bytes_with_nul(&name[..=dirent.name.len()])
                    .map_err(|_| errno(libc::EINVAL))?;
                let cookie = dirent
                    .offset
                    .checked_add(2)
                    .ok_or_else(|| errno(libc::EOVERFLOW))?;
                let found = match node.backend.lookup(ctx, node.local, name) {
                    Ok(found) => found,
                    // getdents buffered this name before a host-side removal.
                    Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(1),
                    Err(error) => return Err(error),
                };
                let entry = self.map_entry(node.share, found)?;
                let global = entry.inode;
                let result = add(DirEntry {
                    ino: entry.attr.st_ino,
                    offset: cookie,
                    ..dirent
                });
                self.forget_entry(global, 1, true);
                result
            },
        )
    }

    fn readdirplus<F>(
        &self,
        ctx: Context,
        inode: u64,
        handle: u64,
        size: u32,
        offset: u64,
        mut add: F,
    ) -> io::Result<()>
    where
        F: FnMut(DirEntry, Entry) -> io::Result<usize>,
    {
        if inode == ROOT {
            return self.root_directory(ctx, handle, size, offset, add);
        }
        let held = self.handle(inode, handle, Some(true))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        if size == 0 || !self.directory_dots(ctx, node, offset, &mut add)? {
            return Ok(());
        }
        node.backend.readdirplus(
            ctx,
            node.local,
            held.local,
            size,
            offset.saturating_sub(2),
            |dirent, entry| {
                let cookie = dirent
                    .offset
                    .checked_add(2)
                    .ok_or_else(|| errno(libc::EOVERFLOW))?;
                let entry = self.insert_entry(node.share, entry)?;
                let global = entry.inode;
                let result = add(
                    DirEntry {
                        ino: entry.attr.st_ino,
                        offset: cookie,
                        ..dirent
                    },
                    entry,
                );
                if !matches!(result, Ok(count) if count > 0) {
                    // The backend rolls back the lookup on callback refusal/error;
                    // release only its global counterpart here, not the local twice.
                    self.forget_entry(global, 1, false);
                }
                result
            },
        )
    }

    fn access(&self, ctx: Context, inode: u64, mask: u32) -> io::Result<()> {
        if mask & !((libc::R_OK | libc::W_OK | libc::X_OK) as u32) != 0 {
            return Err(errno(libc::EINVAL));
        }
        if inode == ROOT {
            return if mask & libc::W_OK as u32 != 0 {
                Err(errno(libc::EROFS))
            } else {
                Ok(())
            };
        }
        let node = self.node(inode)?;
        if mask & libc::W_OK as u32 != 0 {
            self.writable(&node)?;
        }
        node.backend.access(ctx, node.local, mask)
    }

    fn statfs(&self, ctx: Context, inode: u64) -> io::Result<libc::statvfs64> {
        if inode == ROOT {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let node = self.node(inode)?;
        node.backend.statfs(ctx, node.local)
    }
    fn setxattr(
        &self,
        ctx: Context,
        inode: u64,
        name: &CStr,
        value: &[u8],
        flags: u32,
    ) -> io::Result<()> {
        if inode == ROOT {
            return Err(errno(libc::EROFS));
        }
        let node = self.node(inode)?;
        self.writable(&node)?;
        node.backend.setxattr(ctx, node.local, name, value, flags)
    }
    fn getxattr(
        &self,
        ctx: Context,
        inode: u64,
        name: &CStr,
        size: u32,
    ) -> io::Result<GetxattrReply> {
        if inode == ROOT {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let node = self.node(inode)?;
        node.backend.getxattr(ctx, node.local, name, size)
    }
    fn listxattr(&self, ctx: Context, inode: u64, size: u32) -> io::Result<ListxattrReply> {
        if inode == ROOT {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let node = self.node(inode)?;
        node.backend.listxattr(ctx, node.local, size)
    }
    fn removexattr(&self, ctx: Context, inode: u64, name: &CStr) -> io::Result<()> {
        if inode == ROOT {
            return Err(errno(libc::EROFS));
        }
        let node = self.node(inode)?;
        self.writable(&node)?;
        node.backend.removexattr(ctx, node.local, name)
    }
    fn fallocate(
        &self,
        ctx: Context,
        inode: u64,
        handle: u64,
        mode: u32,
        offset: u64,
        length: u64,
    ) -> io::Result<()> {
        let held = self.handle(inode, handle, Some(false))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        self.writable(node)?;
        node.backend
            .fallocate(ctx, node.local, held.local, mode, offset, length)
    }
    fn lseek(
        &self,
        ctx: Context,
        inode: u64,
        handle: u64,
        offset: u64,
        whence: u32,
    ) -> io::Result<u64> {
        let held = self.handle(inode, handle, Some(false))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        node.backend
            .lseek(ctx, node.local, held.local, offset, whence)
    }
    fn copyfilerange(
        &self,
        ctx: Context,
        inode_in: u64,
        handle_in: u64,
        offset_in: u64,
        inode_out: u64,
        handle_out: u64,
        offset_out: u64,
        length: u64,
        flags: u64,
    ) -> io::Result<usize> {
        let source = self.handle(inode_in, handle_in, Some(false))?;
        let target = self.handle(inode_out, handle_out, Some(false))?;
        let source_node = source.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        let target_node = target.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        if source_node.share != target_node.share {
            return Err(errno(libc::EXDEV));
        }
        self.writable(target_node)?;
        source_node.backend.copyfilerange(
            ctx,
            source_node.local,
            source.local,
            offset_in,
            target_node.local,
            target.local,
            offset_out,
            length,
            flags,
        )
    }
}
