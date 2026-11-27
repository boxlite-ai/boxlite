// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-fs device state: what a snapshot keeps and how it is checked.
//!
//! [`FsState`] is Postcard-encoded into the payload of a [`DeviceSnapshot`].
//! Its checks run on both ends. The reader treats the payload as untrusted
//! input: a length above the limits is refused before decoding, and a state
//! that disagrees with itself is refused before one host file is reopened.
//! The writer runs the same checks, so it never emits a state this build
//! would refuse. Directory contents, host descriptors and host paths are
//! never part of the state.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::fuse::{KERNEL_MINOR_VERSION, KERNEL_VERSION, ROOT_ID};
use crate::virtio::{DeviceSnapshot, SnapshotError};

/// `format` of every virtio-fs device state: the virtio device ID.
pub(crate) const FORMAT: u32 = 26;
/// The only `version` this build writes and reads.
pub(crate) const VERSION: u32 = 1;
/// Largest payload accepted for decoding.
pub(crate) const MAX_PAYLOAD_BYTES: usize = 64 << 20;
/// Largest number of exports accepted in one state.
pub(crate) const MAX_EXPORTS: usize = 1 << 16;
/// Largest number of mount entries accepted in one state.
pub(crate) const MAX_MOUNTS: usize = 1 << 16;
/// Largest number of nodes accepted in one state.
pub(crate) const MAX_NODES: usize = 1 << 20;
/// Largest number of handles accepted in one state.
pub(crate) const MAX_HANDLES: usize = 1 << 20;
/// Largest number of identity entries accepted in one state.
pub(crate) const MAX_IDENTITIES: usize = 1 << 20;
/// Longest path a node or a mount may name, in bytes across its components.
pub(crate) const MAX_PATH_BYTES: usize = 4096;
/// Longest file handle in one node. The kernel returns no more than this.
pub(crate) const MAX_HANDLE_BYTES: usize = libc::MAX_HANDLE_SZ as usize;

/// The state of one virtio-fs device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FsState {
    /// The device tag. A restoring device must be built with the same one.
    pub(crate) tag: String,
    /// Whether the guest completed `FUSE_INIT`.
    pub(crate) fuse_initialized: bool,
    /// The options `FUSE_INIT` negotiated.
    pub(crate) fuse_options: u64,
    /// The protocol version the handshake replied with; it must equal this build's.
    pub(crate) fuse_version: (u32, u32),
    /// The registered exports, by ascending root.
    pub(crate) exports: Vec<ExportState>,
    /// The mounts the nodes with a path are on, by ascending `(export_root, mnt_id)`.
    pub(crate) mounts: Vec<MountState>,
    /// The nodes the guest still references, by ascending number. Export roots included.
    pub(crate) nodes: Vec<NodeState>,
    /// The handles the guest still holds, by ascending number.
    pub(crate) handles: Vec<HandleState>,
    /// The node allocator. It is restored as saved, so a new node never repeats a saved number.
    pub(crate) next_node: u64,
    /// The identity allocator, restored as saved.
    pub(crate) next_identity: u64,
    /// The handle allocator, restored as saved.
    pub(crate) next_handle: u64,
    /// One entry per node below an export root that has a path: the inode number the guest sees for its host file.
    pub(crate) identities: Vec<IdentityState>,
}

/// One export. The directory is not part of the state; the caller supplies it on restore.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ExportState {
    /// The root's node number, which is also the registry key.
    pub(crate) root: u64,
    /// The inode number the guest sees for the root.
    pub(crate) identity: u64,
    /// The export name: one directory below the aggregate root.
    pub(crate) name: String,
    pub(crate) read_only: bool,
    /// The backend's inode allocator, restored as saved.
    pub(crate) next_inode: u64,
    /// The backend's handle allocator, restored as saved.
    pub(crate) next_handle: u64,
}

/// One mount an export's nodes with a path are on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct MountState {
    pub(crate) export_root: u64,
    /// The mount ID when the state was saved.
    pub(crate) mnt_id: u64,
    /// The mount point below the export root. The mount of the export root itself is empty.
    pub(crate) path: Vec<Vec<u8>>,
}

/// One node the guest still references.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct NodeState {
    /// The node number the guest sees.
    pub(crate) node: u64,
    /// The inode number the guest sees.
    pub(crate) identity: u64,
    /// The root of the export the node belongs to.
    pub(crate) export_root: u64,
    /// The lookups the guest still holds on the node.
    pub(crate) lookups: u64,
    /// The backend's inode number, restored as saved.
    pub(crate) local: u64,
    /// How to find the node below the export root.
    pub(crate) location: NodeLocation,
    /// The host device and inode the node was saved as, to verify on restore.
    pub(crate) dev: u64,
    pub(crate) ino: u64,
    /// The file handle `name_to_handle_at` returned, when the file system provides one.
    pub(crate) handle: Option<FileHandle>,
}

/// Where a node sits inside its export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum NodeLocation {
    /// One component per name; empty for an export root.
    Path(Vec<Vec<u8>>),
    /// The host file could no longer be found below the export root.
    Invalid,
}

/// A file handle from `name_to_handle_at`. The mount ID is not kept: it changes on restore.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FileHandle {
    pub(crate) handle_type: i32,
    pub(crate) handle: Vec<u8>,
}

/// One handle the guest still holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct HandleState {
    /// The handle number the guest holds.
    pub(crate) fh: u64,
    /// The node the handle is open on; `1` for a directory handle on the aggregate root.
    pub(crate) node: u64,
    /// The backend's handle number, restored as saved; `0` on the aggregate root.
    pub(crate) local: u64,
    /// The POSIX open flags of the OPEN, CREATE or OPENDIR request.
    pub(crate) flags: u32,
    pub(crate) directory: bool,
}

/// One identity entry: which inode number the guest sees for one host file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct IdentityState {
    pub(crate) export_root: u64,
    pub(crate) dev: u64,
    pub(crate) ino: u64,
    /// The mount ID when the state was saved.
    pub(crate) mnt_id: u64,
    /// The inode number the guest sees.
    pub(crate) identity: u64,
}

/// Ends the enclosing function with a refusal that names what failed.
macro_rules! refuse {
    ($($arg:tt)*) => {
        return Err(refused(format!($($arg)*)))
    };
}
pub(crate) use refuse;

/// A snapshot refusal that carries its reason.
pub(crate) fn refused(reason: impl Into<String>) -> SnapshotError {
    SnapshotError::Refused(reason.into())
}

/// Encodes `state` into the device snapshot a state file stores. The writer
/// runs the reader's checks, so it never emits a state this build would refuse.
pub(crate) fn encode(state: &FsState) -> Result<DeviceSnapshot, SnapshotError> {
    check(state, &state.tag)?;
    let payload = postcard::to_allocvec(state)
        .map_err(|error| refused(format!("the state cannot be encoded: {error}")))?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        refuse!(
            "the encoded state is {} bytes, above the limit of {MAX_PAYLOAD_BYTES}",
            payload.len()
        );
    }
    Ok(DeviceSnapshot {
        format: FORMAT,
        version: VERSION,
        payload,
    })
}

/// Decodes a snapshot saved for the device `tag`, refusing anything this build cannot restore.
pub(crate) fn decode(snapshot: &DeviceSnapshot, tag: &str) -> Result<FsState, SnapshotError> {
    if snapshot.format != FORMAT {
        refuse!("format {} is not virtio-fs ({FORMAT})", snapshot.format);
    }
    if snapshot.version != VERSION {
        refuse!(
            "version {} is not supported; this build reads {VERSION}",
            snapshot.version
        );
    }
    if snapshot.payload.len() > MAX_PAYLOAD_BYTES {
        refuse!(
            "the payload is {} bytes, above the limit of {MAX_PAYLOAD_BYTES}",
            snapshot.payload.len()
        );
    }
    let (state, trailing) = postcard::take_from_bytes(&snapshot.payload)
        .map_err(|error| refused(format!("the payload is not a virtio-fs state: {error}")))?;
    if !trailing.is_empty() {
        refuse!("{} bytes follow the state", trailing.len());
    }
    check(&state, tag)?;
    Ok(state)
}

/// Checks that `state` describes one consistent session of the device `tag`.
fn check(state: &FsState, tag: &str) -> Result<(), SnapshotError> {
    if state.tag != tag {
        refuse!("the state was saved for another device tag");
    }
    if state.fuse_version != (KERNEL_VERSION, KERNEL_MINOR_VERSION) {
        refuse!(
            "the state negotiated FUSE {}.{} and this build speaks {KERNEL_VERSION}.{KERNEL_MINOR_VERSION}",
            state.fuse_version.0,
            state.fuse_version.1
        );
    }
    let exports = check_exports(state)?;
    let mounts = check_mounts(state, &exports)?;
    let (nodes, inodes) = check_nodes(state, &exports)?;
    let handles = check_handles(state, &nodes)?;
    check_identities(state, &mounts)?;
    check_allocators(state, &nodes, &inodes, &handles)
}

/// Returns each export by root, after checking that roots and names are unique
/// and each name is one path component.
fn check_exports(state: &FsState) -> Result<BTreeMap<u64, u64>, SnapshotError> {
    bound(state.exports.len(), MAX_EXPORTS, "export")?;
    let by_root: BTreeMap<u64, u64> = state
        .exports
        .iter()
        .map(|export| (export.root, export.identity))
        .collect();
    let names: BTreeSet<&str> = state
        .exports
        .iter()
        .map(|export| export.name.as_str())
        .collect();
    if by_root.len() != state.exports.len() || names.len() != state.exports.len() {
        refuse!("two exports share a root or a name");
    }
    if state
        .exports
        .iter()
        .any(|export| !component(export.name.as_bytes()))
    {
        refuse!("an export name is not one path component");
    }
    Ok(by_root)
}

/// Returns the `(export root, mount ID)` pairs the state lists.
fn check_mounts(
    state: &FsState,
    exports: &BTreeMap<u64, u64>,
) -> Result<BTreeSet<(u64, u64)>, SnapshotError> {
    bound(state.mounts.len(), MAX_MOUNTS, "mount")?;
    let mut listed = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for mount in &state.mounts {
        if !exports.contains_key(&mount.export_root) {
            refuse!("mount {} belongs to no export", mount.mnt_id);
        }
        if !listed.insert((mount.export_root, mount.mnt_id)) {
            refuse!(
                "export {} lists mount {} twice",
                mount.export_root,
                mount.mnt_id
            );
        }
        // The one empty path an export may list is the mount of its own root.
        if !paths.insert((mount.export_root, mount.path.as_slice())) {
            refuse!("export {} lists two mounts at one path", mount.export_root);
        }
        check_path(&mount.path)?;
    }
    Ok(listed)
}

/// The nodes of a state, by number.
type Nodes<'a> = BTreeMap<u64, &'a NodeState>;
/// The highest backend number each export uses.
type Highest = BTreeMap<u64, u64>;

/// Returns each node by number and the highest backend inode number of each
/// export, after checking the rows against the exports and each other.
fn check_nodes<'a>(
    state: &'a FsState,
    exports: &BTreeMap<u64, u64>,
) -> Result<(Nodes<'a>, Highest), SnapshotError> {
    bound(state.nodes.len(), MAX_NODES, "node")?;
    let mut nodes = BTreeMap::new();
    let mut locals = BTreeSet::new();
    let mut inodes = BTreeMap::new();
    for node in &state.nodes {
        if node.node <= ROOT_ID {
            refuse!(
                "node number {} is reserved for the aggregate root",
                node.node
            );
        }
        if !exports.contains_key(&node.export_root) {
            refuse!("node {} belongs to no export", node.node);
        }
        // Restore holds one lookup of its own on every node below a root.
        if node.lookups == u64::MAX {
            refuse!("node {} holds more lookups than can be restored", node.node);
        }
        if let Some(handle) = &node.handle
            && handle.handle.len() > MAX_HANDLE_BYTES
        {
            refuse!(
                "node {} carries a file handle longer than {MAX_HANDLE_BYTES} bytes",
                node.node
            );
        }
        if let Some(identity) = exports.get(&node.node) {
            // An export root belongs to itself, sits at the top of its export
            // and carries the identity of the export.
            if node.export_root != node.node
                || node.local != ROOT_ID
                || node.identity != *identity
                || !at_root(node)
            {
                refuse!("export {} has no root node at its own number", node.node);
            }
        } else {
            // No other row may sit at the top of an export or share a backend inode.
            if at_root(node)
                || node.local == ROOT_ID
                || !locals.insert((node.export_root, node.local))
            {
                refuse!(
                    "node {} repeats a backend inode or sits at an export root",
                    node.node
                );
            }
            match &node.location {
                NodeLocation::Path(path) => check_path(path)?,
                NodeLocation::Invalid if node.handle.is_some() => {
                    refuse!("node {} is invalid but carries a file handle", node.node);
                }
                NodeLocation::Invalid => {}
            }
        }
        raise(&mut inodes, node.export_root, node.local);
        if nodes.insert(node.node, node).is_some() {
            refuse!("two nodes share the number {}", node.node);
        }
    }
    // Restore finds each export root by number with a binary search.
    if state
        .nodes
        .windows(2)
        .any(|pair| pair[0].node >= pair[1].node)
    {
        refuse!("the nodes are not in ascending order");
    }
    if let Some(root) = exports.keys().find(|root| !nodes.contains_key(root)) {
        refuse!("export {root} has no root node at its own number");
    }
    Ok((nodes, inodes))
}

/// Whether `node` sits at the top of its export, which only an export root may.
fn at_root(node: &NodeState) -> bool {
    matches!(&node.location, NodeLocation::Path(path) if path.is_empty())
}

/// Returns the highest backend handle number of each export, after checking
/// each handle against the node it is open on.
fn check_handles(state: &FsState, nodes: &Nodes) -> Result<BTreeMap<u64, u64>, SnapshotError> {
    bound(state.handles.len(), MAX_HANDLES, "handle")?;
    let mut numbers = BTreeSet::new();
    let mut locals = BTreeSet::new();
    let mut open = BTreeSet::new();
    let mut handles = BTreeMap::new();
    for handle in &state.handles {
        if handle.fh == 0 || !numbers.insert(handle.fh) {
            refuse!("two handles share the number {} or it is zero", handle.fh);
        }
        if handle.node == ROOT_ID {
            if !handle.directory {
                refuse!(
                    "handle {} is a file handle on the aggregate root",
                    handle.fh
                );
            }
            continue;
        }
        let Some(node) = nodes.get(&handle.node) else {
            refuse!("handle {} is open on no saved node", handle.fh);
        };
        if !locals.insert((node.export_root, handle.local)) {
            refuse!(
                "export {} lists backend handle {} twice",
                node.export_root,
                handle.local
            );
        }
        open.insert(node.node);
        raise(&mut handles, node.export_root, handle.local);
    }
    // A node the guest neither looks up nor holds open would never be reclaimed again.
    if let Some(node) = state
        .nodes
        .iter()
        .find(|node| node.lookups == 0 && node.local != ROOT_ID && !open.contains(&node.node))
    {
        refuse!("node {} is neither looked up nor open", node.node);
    }
    Ok(handles)
}

/// Whether a node below an export root has a path. Only such a node takes an identity row.
fn has_path(node: &NodeState) -> bool {
    node.local != ROOT_ID && matches!(node.location, NodeLocation::Path(_))
}

/// Checks that every identity row describes a node below an export root that has a
/// path, and every such node has a row that agrees with it.
fn check_identities(state: &FsState, mounts: &BTreeSet<(u64, u64)>) -> Result<(), SnapshotError> {
    bound(state.identities.len(), MAX_IDENTITIES, "identity")?;
    if let Some(row) = state
        .identities
        .iter()
        .find(|row| !mounts.contains(&(row.export_root, row.mnt_id)))
    {
        refuse!(
            "identity {} is on mount {}, which its export does not list",
            row.identity,
            row.mnt_id
        );
    }
    let rows: BTreeSet<(u64, u64, u64, u64)> = state
        .identities
        .iter()
        .map(|row| (row.export_root, row.dev, row.ino, row.identity))
        .collect();
    let located: BTreeSet<(u64, u64, u64, u64)> = state
        .nodes
        .iter()
        .filter(|node| has_path(node))
        .map(|node| (node.export_root, node.dev, node.ino, node.identity))
        .collect();
    if rows.len() != state.identities.len() {
        refuse!("an identity row repeats a file of its export");
    }
    if let Some(node) = state.nodes.iter().find(|node| {
        has_path(node) && !rows.contains(&(node.export_root, node.dev, node.ino, node.identity))
    }) {
        refuse!("node {} has no identity entry", node.node);
    }
    if let Some(row) = state
        .identities
        .iter()
        .find(|row| !located.contains(&(row.export_root, row.dev, row.ino, row.identity)))
    {
        refuse!(
            "identity {} describes a file that no node with a path uses",
            row.identity
        );
    }
    Ok(())
}

/// Checks every allocator against the largest number its table uses.
fn check_allocators(
    state: &FsState,
    nodes: &Nodes,
    inodes: &Highest,
    handles: &Highest,
) -> Result<(), SnapshotError> {
    let numbers = [
        (
            "node",
            state.next_node,
            nodes.keys().copied().max().unwrap_or(ROOT_ID),
        ),
        (
            "identity",
            state.next_identity,
            state
                .identities
                .iter()
                .map(|row| row.identity)
                .chain(state.nodes.iter().map(|node| node.identity))
                .max()
                .unwrap_or(ROOT_ID),
        ),
        (
            "handle",
            state.next_handle,
            state
                .handles
                .iter()
                .map(|handle| handle.fh)
                .max()
                .unwrap_or(0),
        ),
    ];
    for (table, next, highest) in numbers {
        if next <= highest {
            refuse!("the {table} allocator {next} does not exceed the saved {table} {highest}");
        }
    }
    for export in &state.exports {
        let inode = inodes.get(&export.root).copied().unwrap_or(ROOT_ID);
        let handle = handles.get(&export.root).copied().unwrap_or(0);
        if export.next_inode <= inode || export.next_handle <= handle {
            refuse!(
                "export {} has an allocator that does not exceed the numbers it saved",
                export.root
            );
        }
    }
    Ok(())
}

/// Refuses a table longer than `max`, before anything indexes into it.
fn bound(len: usize, max: usize, table: &str) -> Result<(), SnapshotError> {
    if len > max {
        refuse!("the state lists more than {max} {table} entries");
    }
    Ok(())
}

/// Raises the highest backend number recorded for `export`.
fn raise(highest: &mut Highest, export: u64, number: u64) {
    let top = highest.entry(export).or_insert(0);
    *top = (*top).max(number);
}

/// Checks a path below an export root: every component is a real name and the
/// whole stays within [`MAX_PATH_BYTES`].
fn check_path(path: &[Vec<u8>]) -> Result<(), SnapshotError> {
    let bytes: usize = path
        .iter()
        .map(Vec::len)
        .sum::<usize>()
        .saturating_add(path.len().saturating_sub(1));
    if bytes > MAX_PATH_BYTES {
        refuse!("a path is longer than {MAX_PATH_BYTES} bytes");
    }
    if path.iter().any(|entry| !component(entry)) {
        refuse!("a path has an empty, rooted or relative component");
    }
    Ok(())
}

/// Whether `name` can be one component of a path below an export root.
fn component(name: &[u8]) -> bool {
    !name.is_empty()
        && !name.iter().any(|byte| matches!(byte, b'/' | 0))
        && !matches!(name, b"." | b"..")
}
