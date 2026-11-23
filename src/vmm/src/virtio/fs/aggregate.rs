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
use std::fs::File;
use std::io;
use std::mem;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

#[derive(Debug)]
pub struct Share {
    pub name: String,
    pub path: PathBuf,
    pub read_only: bool,
}

struct Export {
    name: CString,
    root: u64,
    identity: u64,
    backend: Arc<PassthroughFs>,
    read_only: bool,
}

impl Drop for Export {
    fn drop(&mut self) {
        // The last aggregate reference releases the backend's descriptors.
        // destroy is idempotent, so a reset-cycle destroy first is harmless.
        self.backend.destroy();
    }
}

struct Node {
    global: u64,
    identity: u64,
    // The export Arc keeps a removed share's backend alive for this node.
    export: Arc<Export>,
    local: u64,
    root: bool,
    // Retired roots release their backend reference when their final guest
    // lookup, handle, and in-flight request have finished.
    retired: AtomicBool,
}

impl Drop for Node {
    fn drop(&mut self) {
        if !self.root || self.retired.load(Ordering::Acquire) {
            self.export.backend.forget(INTERNAL, self.local, 1);
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
                node.export
                    .backend
                    .releasedir(INTERNAL, node.local, self.flags, self.local)
            } else {
                node.export.backend.release(
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
    // (export root, backend-local inode) -> global node. The export root is
    // the export identity: never reused, so a re-registered name is a new key.
    local_ids: BTreeMap<(u64, u64), u64>,
    // Scalar identities survive node reclamation, without retaining backend FDs.
    identities: BTreeMap<(u64, InodeAltKey), u64>,
    handles: BTreeMap<u64, Arc<Handle>>,
    next_node: u64,
    next_identity: u64,
    next_handle: u64,
}

/// The export registry, keyed by export root, which doubles as the export
/// identity. Lock order is `registry` before `state`; neither lock spans
/// backend I/O.
struct Registry {
    exports: BTreeMap<u64, Arc<Export>>,
    /// Cleared by `destroy`; mutations refuse the dead session.
    alive: bool,
}

/// One guest namespace over the aggregate's independent per-share backends.
/// The mount-control socket reaches a live device through the process mount
/// registry (`virtio::fs::lookup_aggregate`) and drives registration here.
pub struct AggregateFs {
    registry: Mutex<Registry>,
    state: Mutex<State>,
}

fn errno(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

// Manual Debug: the registry and state hold backend descriptors and large
// maps that would make a derived dump unreadable; counts are what matters.
impl std::fmt::Debug for AggregateFs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (registry, state) = (self.registry.lock().unwrap(), self.state.lock().unwrap());
        f.debug_struct("AggregateFs")
            .field("exports", &registry.exports.len())
            .field("alive", &registry.alive)
            .field("nodes", &state.nodes.len())
            .field("handles", &state.handles.len())
            .finish()
    }
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
    pub fn new(shares: Vec<Share>) -> io::Result<Self> {
        let fs = Self {
            registry: Mutex::new(Registry {
                exports: BTreeMap::new(),
                alive: true,
            }),
            state: Mutex::new(State {
                next_node: ROOT + 1,
                next_identity: ROOT + 1,
                next_handle: 1,
                ..State::default()
            }),
        };
        for share in shares {
            fs.register(share)?;
        }
        fs.install_roots();
        Ok(fs)
    }

    /// Adds an export under `name`. The backend is constructed outside every
    /// lock so a slow source cannot stall device callbacks; the registry and
    /// state updates are short critical sections. Returns the export's root
    /// inode, which is also its registry key and its stable identity.
    pub(crate) fn register(&self, share: Share) -> io::Result<u64> {
        let backend = Arc::new(PassthroughFs::new(share.path)?);
        self.insert_export(share.name, backend, share.read_only)
    }

    /// Registers a backend over a directory descriptor delivered by the
    /// runtime. `from_dir_fd` validates its type; host permissions apply per operation.
    pub fn register_fd(&self, name: String, file: File, read_only: bool) -> io::Result<u64> {
        let backend = Arc::new(PassthroughFs::from_dir_fd(file)?);
        self.insert_export(name, backend, read_only)
    }

    fn insert_export(
        &self,
        name: String,
        backend: Arc<PassthroughFs>,
        read_only: bool,
    ) -> io::Result<u64> {
        let name = CString::new(name).map_err(|_| errno(libc::EINVAL))?;
        component(&name, true)?;
        let mut registry = self.registry.lock().unwrap();
        if !registry.alive {
            return Err(errno(libc::ENODEV));
        }
        if registry.exports.values().any(|export| export.name == name) {
            return Err(errno(libc::EEXIST));
        }
        let mut state = self.state.lock().unwrap();
        let root = allocate(&mut state.next_node)?;
        let identity = allocate(&mut state.next_identity)?;
        let export = Arc::new(Export {
            name,
            root,
            identity,
            backend,
            read_only,
        });
        state.local_ids.insert((root, ROOT), root);
        state.nodes.entry(root).or_insert_with(|| NodeRecord {
            node: Arc::new(Node {
                global: root,
                identity,
                export: export.clone(),
                local: ROOT,
                root: true,
                retired: AtomicBool::new(false),
            }),
            lookups: 0,
            opens: 0,
        });
        registry.exports.insert(root, export.clone());
        Ok(root)
    }

    /// Retires the export published under `name`. Only the name stops
    /// resolving: nodes, handles and in-flight requests keep their backend
    /// through their export Arc until their own references drop, and the
    /// export root becomes an ordinary reclaimable node.
    pub fn remove(&self, name: &str) -> io::Result<()> {
        let name = CString::new(name).map_err(|_| errno(libc::EINVAL))?;
        let mut registry = self.registry.lock().unwrap();
        if !registry.alive {
            return Err(errno(libc::ENODEV));
        }
        let root = registry
            .exports
            .values()
            .find(|export| export.name == name)
            .map(|export| export.root)
            .ok_or_else(|| errno(libc::ENOENT))?;
        registry.exports.remove(&root);
        let mut state = self.state.lock().unwrap();
        if let Some(record) = state.nodes.get_mut(&root) {
            record.node.retired.store(true, Ordering::Release);
            Self::collect_zero(&mut state, root);
        }
        Ok(())
    }

    fn install_roots(&self) {
        let registry = self.registry.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        for export in registry.exports.values() {
            state.local_ids.insert((export.root, ROOT), export.root);
            state
                .nodes
                .entry(export.root)
                .or_insert_with(|| NodeRecord {
                    node: Arc::new(Node {
                        global: export.root,
                        identity: export.identity,
                        export: export.clone(),
                        local: ROOT,
                        root: true,
                        retired: AtomicBool::new(false),
                    }),
                    lookups: 0,
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
        if node.export.read_only {
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

    fn map_entry(&self, export: &Arc<Export>, entry: Entry) -> io::Result<Entry> {
        let local = entry.inode;
        let result = self.insert_entry(export, entry);
        if result.is_err() {
            export.backend.forget(INTERNAL, local, 1);
        }
        result
    }

    // READDIRPLUS callbacks leave rollback ownership with the backend.
    fn insert_entry(&self, export: &Arc<Export>, entry: Entry) -> io::Result<Entry> {
        let local = entry.inode;
        let key = (export.root, export.backend.identity(local)?);
        let mut state = self.state.lock().unwrap();
        let (global, identity) =
            if let Some(global) = state.local_ids.get(&(export.root, local)).copied() {
                let record = state
                    .nodes
                    .get_mut(&global)
                    .ok_or_else(|| errno(libc::EBADF))?;
                record.lookups = record
                    .lookups
                    .checked_add(1)
                    .ok_or_else(|| errno(libc::EOVERFLOW))?;
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
                export.backend.retain(local)?;
                state.local_ids.insert((export.root, local), global);
                state.nodes.insert(
                    global,
                    NodeRecord {
                        node: Arc::new(Node {
                            global,
                            identity,
                            export: export.clone(),
                            local,
                            root: false,
                            retired: AtomicBool::new(false),
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
        let pinned = record.node.root && !record.node.retired.load(Ordering::Acquire);
        if pinned || record.lookups != 0 || record.opens != 0 {
            return None;
        }
        state
            .local_ids
            .remove(&(record.node.export.root, record.node.local));
        state.nodes.remove(&inode)
    }

    fn forget_entry(&self, inode: u64, count: u64, forward: bool) {
        let (node, released, removed) = {
            let mut state = self.state.lock().unwrap();
            let Some(record) = state.nodes.get_mut(&inode) else {
                return;
            };
            let released = count.min(record.lookups);
            record.lookups -= released;
            let node = record.node.clone();
            let removed = Self::collect_zero(&mut state, inode);
            (node, released, removed)
        };
        if forward {
            node.export.backend.forget(INTERNAL, node.local, released);
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
            node.export.backend.opendir(ctx, node.local, flags)?
        } else {
            node.export
                .backend
                .open(ctx, node.local, kill_priv, flags)?
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
                let (mut attr, _) = node.export.backend.getattr(ctx, node.local, None)?;
                attr.st_ino = node.identity;
                entry_from_attr(node.global, attr)
            } else {
                let count = self.registry.lock().unwrap().exports.len();
                entry_from_attr(ROOT, synthetic_attr(count))
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
        plus: bool,
        mut add: F,
    ) -> io::Result<()>
    where
        F: FnMut(DirEntry, Entry) -> io::Result<usize>,
    {
        let _held = self.handle(ROOT, handle, Some(true))?;
        if size == 0 {
            return Ok(());
        }
        let count = self.registry.lock().unwrap().exports.len();
        for (name, cookie) in [(c".", 1), (c"..", 2)] {
            if offset < cookie {
                let entry = entry_from_attr(ROOT, synthetic_attr(count));
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
        // Cookies are export roots plus one: strictly increasing, unique per
        // export and stable across removals, so a resumed stream neither
        // repeats nor skips exports that outlive it. New exports register with
        // higher roots and therefore sort after everything already streamed.
        let exports: Vec<Arc<Export>> = self
            .registry
            .lock()
            .unwrap()
            .exports
            .values()
            .filter(|export| export.root >= offset)
            .cloned()
            .collect();
        for export in &exports {
            if plus {
                let mut state = self.state.lock().unwrap();
                let Some(record) = state.nodes.get_mut(&export.root) else {
                    continue;
                };
                record.lookups = record
                    .lookups
                    .checked_add(1)
                    .ok_or_else(|| errno(libc::EOVERFLOW))?;
            }
            let result = (|| {
                let (mut attr, _) = export.backend.getattr(ctx, ROOT, None)?;
                attr.st_ino = export.identity;
                let entry = entry_from_attr(export.root, attr);
                add(
                    DirEntry {
                        ino: export.identity,
                        offset: export.root + 1,
                        type_: libc::DT_DIR as u32,
                        name: export.name.to_bytes(),
                    },
                    entry,
                )
            })();
            if plus && !matches!(result, Ok(count) if count > 0) {
                self.forget_entry(export.root, 1, false);
            }
            if result? == 0 {
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
        let exports: Vec<Arc<Export>> = self
            .registry
            .lock()
            .unwrap()
            .exports
            .values()
            .cloned()
            .collect();
        for export in &exports {
            options &= export.backend.init(capable)?;
        }
        self.registry.lock().unwrap().alive = true;
        self.install_roots();
        Ok(options & (FsOptions::DO_READDIRPLUS | FsOptions::READDIRPLUS_AUTO))
    }

    fn destroy(&self) {
        let exports = {
            let mut registry = self.registry.lock().unwrap();
            registry.alive = false;
            registry.exports.values().cloned().collect::<Vec<_>>()
        };
        let (handles, nodes) = {
            let mut state = self.state.lock().unwrap();
            state.local_ids.clear();
            state.identities.clear();
            (mem::take(&mut state.handles), mem::take(&mut state.nodes))
        };
        drop(handles);
        drop(nodes);
        for export in &exports {
            export.backend.destroy();
        }
    }

    fn lookup(&self, ctx: Context, parent: u64, name: &CStr) -> io::Result<Entry> {
        component(name, false)?;
        if parent == ROOT {
            if matches!(name.to_bytes(), b"." | b"..") {
                let count = self.registry.lock().unwrap().exports.len();
                return Ok(entry_from_attr(ROOT, synthetic_attr(count)));
            }
            let export = {
                let registry = self.registry.lock().unwrap();
                let export = registry
                    .exports
                    .values()
                    .find(|export| export.name.as_c_str() == name)
                    .cloned()
                    .ok_or_else(|| errno(libc::ENOENT))?;
                let mut state = self.state.lock().unwrap();
                let record = state
                    .nodes
                    .get_mut(&export.root)
                    .ok_or_else(|| errno(libc::EBADF))?;
                record.lookups = record
                    .lookups
                    .checked_add(1)
                    .ok_or_else(|| errno(libc::EOVERFLOW))?;
                export
            };
            match export.backend.lookup(ctx, ROOT, c".") {
                Ok(found) => return Ok(normalize(found, export.root, export.identity)),
                Err(error) => {
                    self.forget_entry(export.root, 1, false);
                    return Err(error);
                }
            }
        }
        let node = self.node(parent)?;
        if name == c".." {
            return Err(errno(libc::EPERM));
        }
        self.map_entry(
            &node.export,
            node.export.backend.lookup(ctx, node.local, name)?,
        )
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
            let count = self.registry.lock().unwrap().exports.len();
            return Ok((synthetic_attr(count), TIMEOUT));
        }
        let node = match held.as_ref().and_then(|handle| handle.node.clone()) {
            Some(node) => node,
            None => self.node(inode)?,
        };
        let local_handle = held.as_ref().map(|handle| handle.local);
        let (mut attr, timeout) = node.export.backend.getattr(ctx, node.local, local_handle)?;
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
        let (mut attr, timeout) = node.export.backend.setattr(
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
        let (entry, local_handle, options) = node.export.backend.create(
            ctx, node.local, name, mode, kill_priv, flags, umask, extensions,
        )?;
        let local_inode = entry.inode;
        let local_handle = local_handle.ok_or_else(|| errno(libc::EIO))?;
        let entry = match self.map_entry(&node.export, entry) {
            Ok(entry) => entry,
            Err(error) => {
                node.export.backend.release(
                    ctx,
                    local_inode,
                    flags,
                    local_handle,
                    false,
                    false,
                    None,
                )?;
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
            &node.export,
            node.export
                .backend
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
            &node.export,
            node.export
                .backend
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
            &node.export,
            node.export
                .backend
                .symlink(ctx, linkname, node.local, name, extensions)?,
        )
    }
    fn readlink(&self, ctx: Context, inode: u64) -> io::Result<Vec<u8>> {
        let node = self.node(inode)?;
        node.export.backend.readlink(ctx, node.local)
    }
    fn unlink(&self, ctx: Context, parent: u64, name: &CStr) -> io::Result<()> {
        let node = self.mutation_parent(parent, name)?;
        node.export.backend.unlink(ctx, node.local, name)
    }
    fn rmdir(&self, ctx: Context, parent: u64, name: &CStr) -> io::Result<()> {
        let node = self.mutation_parent(parent, name)?;
        node.export.backend.rmdir(ctx, node.local, name)
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
        if !Arc::ptr_eq(&source.export, &target.export) {
            return Err(errno(libc::EXDEV));
        }
        self.writable(&source)?;
        self.writable(&target)?;
        source
            .export
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
        if !Arc::ptr_eq(&source.export, &target.export) {
            return Err(errno(libc::EXDEV));
        }
        self.writable(&target)?;
        self.map_entry(
            &source.export,
            source
                .export
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
        node.export.backend.read(
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
        node.export.backend.write(
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
        node.export
            .backend
            .flush(ctx, node.local, held.local, lock_owner)
    }
    fn fsync(&self, ctx: Context, inode: u64, datasync: bool, handle: u64) -> io::Result<()> {
        let held = self.handle(inode, handle, Some(false))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        node.export
            .backend
            .fsync(ctx, node.local, datasync, held.local)
    }
    fn fsyncdir(&self, ctx: Context, inode: u64, datasync: bool, handle: u64) -> io::Result<()> {
        let held = self.handle(inode, handle, Some(true))?;
        let Some(node) = held.node.as_ref() else {
            return Ok(());
        };
        node.export
            .backend
            .fsyncdir(ctx, node.local, datasync, held.local)
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
            return self.root_directory(ctx, handle, size, offset, false, |dirent, _| add(dirent));
        }
        let held = self.handle(inode, handle, Some(true))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        if size == 0 || !self.directory_dots(ctx, node, offset, |dirent, _| add(dirent))? {
            return Ok(());
        }
        node.export.backend.readdir(
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
                let found = match node.export.backend.lookup(ctx, node.local, name) {
                    Ok(found) => found,
                    // getdents buffered this name before a host-side removal.
                    Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(1),
                    Err(error) => return Err(error),
                };
                let entry = self.map_entry(&node.export, found)?;
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
            return self.root_directory(ctx, handle, size, offset, true, add);
        }
        let held = self.handle(inode, handle, Some(true))?;
        let node = held.node.as_ref().ok_or_else(|| errno(libc::EBADF))?;
        if size == 0 || !self.directory_dots(ctx, node, offset, &mut add)? {
            return Ok(());
        }
        node.export.backend.readdirplus(
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
                let entry = self.insert_entry(&node.export, entry)?;
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
        node.export.backend.access(ctx, node.local, mask)
    }

    fn statfs(&self, ctx: Context, inode: u64) -> io::Result<libc::statvfs64> {
        if inode == ROOT {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let node = self.node(inode)?;
        node.export.backend.statfs(ctx, node.local)
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
        node.export
            .backend
            .setxattr(ctx, node.local, name, value, flags)
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
        node.export.backend.getxattr(ctx, node.local, name, size)
    }
    fn listxattr(&self, ctx: Context, inode: u64, size: u32) -> io::Result<ListxattrReply> {
        if inode == ROOT {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let node = self.node(inode)?;
        node.export.backend.listxattr(ctx, node.local, size)
    }
    fn removexattr(&self, ctx: Context, inode: u64, name: &CStr) -> io::Result<()> {
        if inode == ROOT {
            return Err(errno(libc::EROFS));
        }
        let node = self.node(inode)?;
        self.writable(&node)?;
        node.export.backend.removexattr(ctx, node.local, name)
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
        node.export
            .backend
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
        node.export
            .backend
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
        if !Arc::ptr_eq(&source_node.export, &target_node.export) {
            return Err(errno(libc::EXDEV));
        }
        self.writable(target_node)?;
        source_node.export.backend.copyfilerange(
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
