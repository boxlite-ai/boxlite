// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! One guest namespace over independent per-share filesystems.
//!
//! Only this layer owns global node/handle numbers and read-only policy. Host
//! objects, local lookup references and file operations belong to each backend.
//! A global node reserves one extra backend lookup until its final Arc drops;
//! FORGET can therefore remove the guest lookup without invalidating a request
//! that has already acquired that node. No namespace lock spans backend I/O.

use std::collections::{BTreeMap, BTreeSet};
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
use super::fuse::{KERNEL_MINOR_VERSION, KERNEL_VERSION};
use super::linux::mounts;
use super::linux::passthrough::{ExportedInode, InodeAltKey, PassthroughFs, file_handle};
use super::state::{
    ExportState, FileHandle, FsState, HandleState, IdentityState, MountState, NodeLocation,
    NodeState, refuse, refused,
};
use crate::virtio::{RestoreExport, SnapshotError};

const ROOT: u64 = 1;
const TIMEOUT: Duration = Duration::ZERO;
const INTERNAL: Context = Context {
    uid: 0,
    gid: 0,
    pid: 0,
};

/// Where an export is in the life cycle the mount controller drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportPhase {
    /// Registered; the guest has not finished mounting it.
    Preparing,
    /// Mounted in the guest.
    Mounted,
    /// The guest is unmounting it.
    Detaching,
}

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
    // Restored nodes without a backend inode retain their identity for the next save.
    stale: Option<StaleNode>,
    root: bool,
    // Retired roots release their backend reference when their final guest
    // lookup, handle, and in-flight request have finished.
    retired: AtomicBool,
}

/// The host identity a stale node keeps for the next save.
struct StaleNode {
    dev: u64,
    ino: u64,
}

impl Drop for Node {
    fn drop(&mut self) {
        if self.stale.is_none() && (!self.root || self.retired.load(Ordering::Acquire)) {
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
    stale: bool,
}

impl Drop for Handle {
    fn drop(&mut self) {
        if let Some(node) = &self.node
            && !self.stale
        {
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
    /// The phase of every export, keyed like `exports`.
    phases: BTreeMap<u64, ExportPhase>,
    /// Cleared by `destroy`; mutations refuse the dead session.
    alive: bool,
}

/// One guest namespace over the aggregate's independent per-share backends.
/// The mount-control socket reaches a live device through the process mount
/// registry (`virtio::fs::lookup_aggregate`) and drives registration here.
pub struct AggregateFs {
    registry: Mutex<Registry>,
    state: Mutex<State>,
    /// Set while a snapshot owns the namespace: mount changes fail until it is cleared.
    frozen: AtomicBool,
}

/// What a snapshot takes under the two locks. Every host call runs once they are released.
struct Listed {
    /// The registered exports, each with the nodes the guest still holds below its root.
    groups: BTreeMap<u64, Group>,
    handles: Vec<HandleState>,
    next_node: u64,
    next_identity: u64,
    next_handle: u64,
}

/// One export's live nodes.
struct Group {
    export: Arc<Export>,
    /// The lookups held on the export root; a session waiting for FUSE_INIT holds none.
    root_lookups: u64,
    nodes: Vec<(Arc<Node>, u64)>,
}

fn errno(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

/// Ends the enclosing function with a restore failure that names what did not match.
macro_rules! mismatch {
    ($($arg:tt)*) => {
        return Err(mismatch(format!($($arg)*)))
    };
}

/// A restore failure that names what did not match its saved state.
fn mismatch(reason: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

/// The device and inode still identify a file when the host cannot supply its handle.
fn saved_handle(
    result: io::Result<Option<FileHandle>>,
    node: u64,
    export: &str,
) -> Option<FileHandle> {
    result.unwrap_or_else(|error| {
        tracing::warn!(node, export, %error, errno = error.raw_os_error(), "saving inode without a filesystem handle");
        None
    })
}

/// A path below an export as one slash-separated string, for messages.
fn shown(path: &[Vec<u8>]) -> String {
    if path.is_empty() {
        return ".".into();
    }
    path.iter()
        .map(|component| String::from_utf8_lossy(component))
        .collect::<Vec<_>>()
        .join("/")
}

/// Checks that a reopened host file is the object `node` saved: the same
/// device and inode and, when one was saved, the same file handle.
fn verify(node: &NodeState, key: (u64, u64, u64), handle: Option<FileHandle>) -> io::Result<()> {
    if (key.0, key.1) != (node.dev, node.ino) {
        mismatch!(
            "node {} is now device {} inode {} and was saved as device {} inode {}",
            node.node,
            key.0,
            key.1,
            node.dev,
            node.ino
        );
    }
    match (&node.handle, &handle) {
        (Some(saved), Some(actual)) if saved == actual => {}
        (None, _) => {}
        (Some(_), Some(_)) => mismatch!("node {} now has a different file handle", node.node),
        (Some(_), None) => mismatch!(
            "node {} was saved with a file handle that its file system no longer provides",
            node.node
        ),
    }
    Ok(())
}

/// Asks for the file handle of a reopened object only when `saved` holds one to compare.
fn checked_handle(
    saved: &Option<FileHandle>,
    handle: impl FnOnce() -> io::Result<Option<FileHandle>>,
) -> io::Result<Option<FileHandle>> {
    match saved {
        Some(_) => handle(),
        None => Ok(None),
    }
}

/// Checks a non-root inode before either backend index can resolve it.
fn reopen_node(node: &NodeState, backend: &PassthroughFs) -> io::Result<()> {
    let NodeLocation::Path(path) = &node.location else {
        return Err(mismatch("saved without a path".into()));
    };
    let file = backend.open_beneath(path)?;
    let key = InodeAltKey::of(&file)?;
    let handle = checked_handle(&node.handle, || file_handle(&file))?;
    verify(node, key.parts(), handle)?;
    // One backend lookup belongs to the aggregate until its last Node reference drops.
    backend.restore_inode(node.local, file, key, node.lookups + 1)
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
                phases: BTreeMap::new(),
                alive: true,
            }),
            state: Mutex::new(State {
                next_node: ROOT + 1,
                next_identity: ROOT + 1,
                next_handle: 1,
                ..State::default()
            }),
            frozen: AtomicBool::new(false),
        };
        for share in shares {
            fs.register(share)?;
        }
        fs.install_roots();
        Ok(fs)
    }

    /// Adds an export under `name` that is mounted from the start. The backend
    /// is constructed outside every lock so a slow source cannot stall device
    /// callbacks; the registry and state updates are short critical sections.
    /// Returns the export's root inode, which is also its registry key and its
    /// stable identity.
    pub(crate) fn register(&self, share: Share) -> io::Result<u64> {
        self.check_thawed()?;
        let backend = Arc::new(PassthroughFs::new(share.path)?);
        self.insert_export(share.name, backend, share.read_only, ExportPhase::Mounted)
    }

    /// Registers a backend over a directory descriptor delivered by the
    /// runtime. The export starts in [`ExportPhase::Preparing`] until the mount
    /// controller reports that the guest mounted it. `from_dir_fd` validates
    /// the descriptor's type; host permissions apply per operation.
    pub fn register_fd(&self, name: String, file: File, read_only: bool) -> io::Result<u64> {
        // A frozen device answers EBUSY before it looks at the descriptor.
        self.check_thawed()?;
        let backend = Arc::new(PassthroughFs::from_dir_fd(file)?);
        self.insert_export(name, backend, read_only, ExportPhase::Preparing)
    }

    fn insert_export(
        &self,
        name: String,
        backend: Arc<PassthroughFs>,
        read_only: bool,
        phase: ExportPhase,
    ) -> io::Result<u64> {
        let name = CString::new(name).map_err(|_| errno(libc::EINVAL))?;
        component(&name, true)?;
        let mut registry = self.registry.lock().unwrap();
        if !registry.alive {
            return Err(errno(libc::ENODEV));
        }
        self.check_thawed()?;
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
        Self::publish(&mut registry, &mut state, export, phase);
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
        self.check_thawed()?;
        let root = Self::named(&registry, &name)?;
        registry.exports.remove(&root);
        registry.phases.remove(&root);
        let mut state = self.state.lock().unwrap();
        if let Some(record) = state.nodes.get_mut(&root) {
            record.node.retired.store(true, Ordering::Release);
            Self::collect_zero(&mut state, root);
        }
        Ok(())
    }

    /// `EBUSY` while a snapshot owns the namespace and mount changes must stop.
    fn check_thawed(&self) -> io::Result<()> {
        if self.is_frozen() {
            Err(errno(libc::EBUSY))
        } else {
            Ok(())
        }
    }

    /// The root of the export published under `name`.
    fn named(registry: &Registry, name: &CStr) -> io::Result<u64> {
        registry
            .exports
            .values()
            .find(|export| export.name == name)
            .map(|export| export.root)
            .ok_or_else(|| errno(libc::ENOENT))
    }

    /// Publishes an export: its root node, its phase and its registry entry.
    fn publish(
        registry: &mut Registry,
        state: &mut State,
        export: Arc<Export>,
        phase: ExportPhase,
    ) {
        Self::install_root(state, &export);
        registry.phases.insert(export.root, phase);
        registry.exports.insert(export.root, export);
    }

    /// Installs an export root unless it is already there: the alias of the
    /// backend root and the root node. Returns the root's record.
    fn install_root<'a>(state: &'a mut State, export: &Arc<Export>) -> &'a mut NodeRecord {
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
                    stale: None,
                    root: true,
                    retired: AtomicBool::new(false),
                }),
                lookups: 0,
                opens: 0,
            })
    }

    /// Freezes the namespace for a snapshot. The session, its nodes and its
    /// handles stay; only mount changes are refused until [`Self::unfreeze`].
    pub(crate) fn freeze(&self) {
        self.frozen.store(true, Ordering::Release);
    }

    /// Ends a freeze started by [`Self::freeze`].
    pub(crate) fn unfreeze(&self) {
        self.frozen.store(false, Ordering::Release);
    }

    pub(crate) fn is_frozen(&self) -> bool {
        self.frozen.load(Ordering::Acquire)
    }

    /// Whether any export is registered.
    pub(crate) fn has_exports(&self) -> bool {
        !self.registry.lock().unwrap().exports.is_empty()
    }

    /// Records that the export published under `name` entered `phase`, as the
    /// mount controller observed it.
    pub fn set_export_phase(&self, name: &str, phase: ExportPhase) -> io::Result<()> {
        let name = CString::new(name).map_err(|_| errno(libc::EINVAL))?;
        let mut registry = self.registry.lock().unwrap();
        if !registry.alive {
            return Err(errno(libc::ENODEV));
        }
        self.check_thawed()?;
        let root = Self::named(&registry, &name)?;
        registry.phases.insert(root, phase);
        Ok(())
    }

    /// The phase of the export published under `name`.
    pub fn export_phase(&self, name: &str) -> io::Result<ExportPhase> {
        let name = CString::new(name).map_err(|_| errno(libc::EINVAL))?;
        let registry = self.registry.lock().unwrap();
        let root = Self::named(&registry, &name)?;
        registry
            .phases
            .get(&root)
            .copied()
            .ok_or_else(|| errno(libc::EIO))
    }

    fn install_roots(&self) {
        let registry = self.registry.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        for export in registry.exports.values() {
            Self::install_root(&mut state, export);
        }
    }

    fn node(&self, inode: u64) -> io::Result<Arc<Node>> {
        let state = self.state.lock().unwrap();
        let node = &state
            .nodes
            .get(&inode)
            .ok_or_else(|| errno(libc::EBADF))?
            .node;
        if node.stale.is_some() {
            return Err(errno(libc::ESTALE));
        }
        Ok(node.clone())
    }

    fn handle(&self, inode: u64, handle: u64, directory: Option<bool>) -> io::Result<Arc<Handle>> {
        let state = self.state.lock().unwrap();
        let held = state
            .handles
            .get(&handle)
            .filter(|data| {
                data.inode == inode && directory.is_none_or(|kind| data.directory == kind)
            })
            .ok_or_else(|| errno(libc::EBADF))?;
        if held.stale {
            return Err(errno(libc::ESTALE));
        }
        Ok(held.clone())
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

    /// LINK and RENAME must check both operands, even when one is the synthetic root.
    fn mutation_nodes(&self, source: u64, target: u64) -> io::Result<(Arc<Node>, Arc<Node>)> {
        let lookup = |inode| (inode != ROOT).then(|| self.node(inode)).transpose();
        let (source, target) = (lookup(source)?, lookup(target)?);
        let (Some(source), Some(target)) = (source, target) else {
            return Err(errno(libc::EROFS));
        };
        if !Arc::ptr_eq(&source.export, &target.export) {
            return Err(errno(libc::EXDEV));
        }
        self.writable(&target)?;
        Ok((source, target))
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
                            stale: None,
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
        if forward && node.stale.is_none() {
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
            stale: false,
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

impl AggregateFs {
    /// Captures the session of a frozen aggregate for a snapshot.
    ///
    /// The locks only list the tables. Paths, file handles and the mount table
    /// are read afterwards, so a slow host never widens a critical section.
    /// Unreachable inodes keep their guest references and are saved without a path.
    pub(crate) fn export_state(
        &self,
        tag: &str,
        handshake: (bool, u64),
    ) -> Result<FsState, SnapshotError> {
        if !self.is_frozen() {
            refuse!("the device is not quiesced");
        }
        let table = mounts::parse_mountinfo(
            &mounts::read_mountinfo()
                .map_err(|error| refused(format!("the mount table cannot be read: {error}")))?,
        )
        .map_err(|error| refused(format!("the mount table cannot be parsed: {error}")))?;
        // Lock order is `registry` before `state`.
        let listed = {
            let registry = self.registry.lock().unwrap();
            let state = self.state.lock().unwrap();
            for export in registry.exports.values() {
                // An export without a phase is not known to be mounted.
                let phase = registry
                    .phases
                    .get(&export.root)
                    .copied()
                    .unwrap_or(ExportPhase::Preparing);
                if phase != ExportPhase::Mounted {
                    refuse!("export {} is {phase:?}", export.name.to_string_lossy());
                }
            }
            let mut listed = Listed {
                groups: registry
                    .exports
                    .values()
                    .map(|export| {
                        (
                            export.root,
                            Group {
                                export: export.clone(),
                                root_lookups: 0,
                                nodes: Vec::new(),
                            },
                        )
                    })
                    .collect(),
                handles: state
                    .handles
                    .iter()
                    .map(|(number, handle)| HandleState {
                        fh: *number,
                        node: handle.node.as_ref().map_or(ROOT, |node| node.global),
                        local: handle.local,
                        flags: handle.flags,
                        directory: handle.directory,
                    })
                    .collect(),
                next_node: state.next_node,
                next_identity: state.next_identity,
                next_handle: state.next_handle,
            };
            for record in state.nodes.values() {
                let Some(group) = listed.groups.get_mut(&record.node.export.root) else {
                    refuse!("node {} belongs to an unmounted export", record.node.global);
                };
                if record.node.root {
                    group.root_lookups = record.lookups;
                } else {
                    group.nodes.push((record.node.clone(), record.lookups));
                }
            }
            listed
        };
        let mut saved = FsState {
            tag: tag.to_string(),
            fuse_initialized: handshake.0,
            fuse_options: handshake.1,
            fuse_version: (KERNEL_VERSION, KERNEL_MINOR_VERSION),
            exports: Vec::new(),
            mounts: Vec::new(),
            nodes: Vec::new(),
            handles: listed.handles,
            next_node: listed.next_node,
            next_identity: listed.next_identity,
            next_handle: listed.next_handle,
            identities: Vec::new(),
        };
        for Group {
            export,
            root_lookups,
            nodes,
        } in listed.groups.into_values()
        {
            let name = export.name.to_string_lossy();
            let backend = &export.backend;
            let failed = |error: io::Error| refused(format!("export {name}: {error}"));
            let root_path = backend.root_path().map_err(failed)?;
            let mut used_mounts: BTreeSet<u64> = BTreeSet::new();
            // The root is the export itself.
            let (dev, ino, mount) = backend.root_key();
            used_mounts.insert(mount);
            saved.nodes.push(NodeState {
                node: export.root,
                identity: export.identity,
                export_root: export.root,
                lookups: root_lookups,
                local: ROOT,
                location: NodeLocation::Path(Vec::new()),
                dev,
                ino,
                handle: saved_handle(backend.root_handle(), export.root, &name),
            });
            for (node, lookups) in &nodes {
                let inode = match &node.stale {
                    // A node without a path cannot be reopened. It needs neither a mount nor an
                    // identity row; its guest number travels in the node row itself.
                    Some(stale) => ExportedInode {
                        location: NodeLocation::Invalid,
                        key: (stale.dev, stale.ino, 0),
                        handle: Ok(None),
                    },
                    None => backend
                        .export_inode(node.local, &root_path)
                        .map_err(failed)?,
                };
                if inode.location == NodeLocation::Invalid {
                    tracing::warn!(node = node.global, export = %name, "saving inode without a path below the export");
                }
                let (dev, ino, mount) = inode.key;
                let located = matches!(inode.location, NodeLocation::Path(_));
                saved.nodes.push(NodeState {
                    node: node.global,
                    identity: node.identity,
                    export_root: export.root,
                    lookups: *lookups,
                    local: node.local,
                    location: inode.location,
                    dev,
                    ino,
                    handle: saved_handle(inode.handle, node.global, &name),
                });
                if located {
                    used_mounts.insert(mount);
                    saved.identities.push(IdentityState {
                        export_root: export.root,
                        dev,
                        ino,
                        mnt_id: mount,
                        identity: node.identity,
                    });
                }
            }
            let mut paths: BTreeMap<Vec<Vec<u8>>, u64> = BTreeMap::new();
            for mount in used_mounts {
                let point = table.get(&mount).ok_or_else(|| {
                    refused(format!(
                        "export {name} is on mount {mount}, which the mount table does not list"
                    ))
                })?;
                let path = mounts::mount_path(&root_path, point).map_err(|_| {
                    refused(format!(
                        "mount {mount} of export {name} lies outside the export"
                    ))
                })?;
                if let Some(first) = paths.insert(path.clone(), mount) {
                    refuse!(
                        "export {name} stacks mounts {first} and {mount} at {}",
                        shown(&path)
                    );
                }
                saved.mounts.push(MountState {
                    export_root: export.root,
                    mnt_id: mount,
                    path,
                });
            }
            let (next_inode, next_handle) = backend.allocators();
            saved.exports.push(ExportState {
                root: export.root,
                identity: export.identity,
                name: name.into_owned(),
                read_only: export.read_only,
                next_inode,
                next_handle,
            });
        }
        saved.nodes.sort_by_key(|node| node.node);
        Ok(saved)
    }

    /// Builds the aggregate that `saved` describes over the directories the
    /// caller supplies, one per export.
    ///
    /// Export roots must match. Unrecoverable children and handles retain their
    /// guest numbers and return ESTALE until the guest drops its references.
    /// A failed restore drops the unpublished aggregate.
    pub(crate) fn restore(saved: &FsState, directories: Vec<RestoreExport>) -> io::Result<Self> {
        let mut fs = Self::new(Vec::new())?;
        // The aggregate is not published yet, so nothing else can reach either table.
        let registry = fs.registry.get_mut().unwrap();
        let state = fs.state.get_mut().unwrap();
        // A name given twice or an unknown name leaves a directory unmatched.
        let mut directories = directories;
        if directories.len() != saved.exports.len() {
            mismatch!(
                "the state lists {} exports and {} directories were supplied",
                saved.exports.len(),
                directories.len()
            );
        }
        // Each export's saved mounts, keyed by `(export root, saved mount ID)`.
        let mut mounts = BTreeMap::new();
        for entry in &saved.exports {
            let position = directories
                .iter()
                .position(|directory| directory.name == entry.name)
                .ok_or_else(|| {
                    mismatch(format!(
                        "no directory was supplied for export {}",
                        entry.name
                    ))
                })?;
            let directory = directories.swap_remove(position);
            if directory.read_only != entry.read_only {
                mismatch!(
                    "export {} was saved read-only = {} and is supplied read-only = {}",
                    entry.name,
                    entry.read_only,
                    directory.read_only
                );
            }
            let backend = Arc::new(PassthroughFs::from_dir_fd(directory.directory).map_err(
                |error| {
                    mismatch(format!(
                        "the directory of export {} is unusable: {error}",
                        entry.name
                    ))
                },
            )?);
            let root = saved
                .nodes
                .binary_search_by_key(&entry.root, |node| node.node)
                .ok()
                .map(|index| &saved.nodes[index])
                .ok_or_else(|| mismatch(format!("export {} has no root node", entry.name)))?;
            let handle = checked_handle(&root.handle, || backend.root_handle())?;
            verify(root, backend.root_key(), handle)?;
            let export = Arc::new(Export {
                name: CString::new(entry.name.clone()).map_err(|_| errno(libc::EINVAL))?,
                root: entry.root,
                identity: entry.identity,
                backend: backend.clone(),
                read_only: entry.read_only,
            });
            Self::install_root(state, &export).lookups = root.lookups;
            registry.phases.insert(entry.root, ExportPhase::Mounted);
            registry.exports.insert(entry.root, export);
            for mount in saved
                .mounts
                .iter()
                .filter(|mount| mount.export_root == entry.root)
            {
                let current = backend.mount_id_at(&mount.path).unwrap_or_else(|error| {
                    tracing::warn!(export = %entry.name, mount = mount.mnt_id, path = %shown(&mount.path), %error, "retaining saved ID for unavailable mount");
                    mount.mnt_id
                });
                mounts.insert(
                    (entry.root, mount.mnt_id),
                    Arc::new(MountState {
                        export_root: entry.root,
                        mnt_id: current,
                        path: mount.path.clone(),
                    }),
                );
            }
        }
        // Decode gave each non-root node that has a path one identity row.
        let identities: BTreeMap<_, _> = saved
            .identities
            .iter()
            .map(|row| {
                (
                    (row.export_root, row.dev, row.ino, row.identity),
                    row.mnt_id,
                )
            })
            .collect();
        for node in saved
            .nodes
            .iter()
            .filter(|node| !registry.exports.contains_key(&node.node))
        {
            let export = &registry.exports[&node.export_root];
            let stale = match reopen_node(node, &export.backend) {
                Ok(()) => {
                    let saved_mount =
                        identities[&(node.export_root, node.dev, node.ino, node.identity)];
                    let mount = &mounts[&(node.export_root, saved_mount)];
                    state.local_ids.insert((export.root, node.local), node.node);
                    state.identities.insert(
                        (
                            export.root,
                            InodeAltKey::from_parts(node.dev, node.ino, mount.mnt_id),
                        ),
                        node.identity,
                    );
                    None
                }
                Err(error) => {
                    tracing::warn!(node = node.node, export = %export.name.to_string_lossy(), %error, "restoring stale inode");
                    Some(StaleNode {
                        dev: node.dev,
                        ino: node.ino,
                    })
                }
            };
            state.nodes.insert(
                node.node,
                NodeRecord {
                    node: Arc::new(Node {
                        global: node.node,
                        identity: node.identity,
                        export: export.clone(),
                        local: node.local,
                        stale,
                        root: false,
                        retired: AtomicBool::new(false),
                    }),
                    lookups: node.lookups,
                    opens: 0,
                },
            );
        }
        // Handles keep their numbers and are reopened the way they were opened.
        for handle in &saved.handles {
            let (node, stale) = if handle.node == ROOT {
                (None, false)
            } else {
                let record = state.nodes.get_mut(&handle.node).unwrap();
                let node = &record.node;
                let stale = node.stale.is_some() || node.export.backend
                    .restore_handle(node.local, handle.local, handle.flags, handle.directory)
                    .inspect_err(|error| tracing::warn!(fh = handle.fh, node = node.global, %error, "restoring stale handle"))
                    .is_err();
                record.opens += 1;
                (Some(node.clone()), stale)
            };
            state.handles.insert(
                handle.fh,
                Arc::new(Handle {
                    inode: handle.node,
                    node,
                    local: handle.local,
                    directory: handle.directory,
                    flags: handle.flags,
                    stale,
                }),
            );
        }
        state.next_node = saved.next_node;
        state.next_identity = saved.next_identity;
        state.next_handle = saved.next_handle;
        for entry in &saved.exports {
            registry.exports[&entry.root]
                .backend
                .restore_allocators(entry.next_inode, entry.next_handle);
        }
        Ok(fs)
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
        let held = handle
            .map(|handle| self.handle(inode, handle, None))
            .transpose()?;
        self.writable(&node)?;
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
        let (source, target) = self.mutation_nodes(olddir, newdir)?;
        source
            .export
            .backend
            .rename(ctx, source.local, oldname, target.local, newname, flags)
    }
    fn link(&self, ctx: Context, inode: u64, newparent: u64, newname: &CStr) -> io::Result<Entry> {
        component(newname, true)?;
        let (source, target) = self.mutation_nodes(inode, newparent)?;
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
