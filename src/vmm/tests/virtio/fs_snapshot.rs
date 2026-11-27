// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Freeze, save and restore of the virtio-fs device over real host files,
//! without a VM.
//!
//! Bind mounts need privileges this suite does not assume. Their effect, one
//! host file behind two mount IDs, is modeled instead: the statx interposer in
//! `linux_tests` reports the mount ID a test assigns, and the mount table is
//! replaced for the thread.

use std::{
    collections::BTreeMap,
    ffi::CString,
    fs::{self, File},
    io,
    os::fd::AsRawFd,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
};

use virtio_queue::{Queue, QueueT, desc::split::Descriptor};
use vm_memory::{ByteValued, Bytes, GuestAddress};

use crate::{
    events::EventLoop,
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSnapshot, EventError, EventRegistrar,
        EventSource, RestoreContext, RestoreExport, SnapshotError, SnapshotSupport, SourceId,
        VirtioDevice, VirtioInterrupt,
        fs::{
            AggregateFs, ExportPhase, Share,
            device::Fs,
            filesystem::{Context, FileSystem},
            fuse::*,
            insert_aggregate,
            linux::{mounts, passthrough},
            lookup_aggregate,
            state::{
                self, ExportState, FileHandle, FsState, HandleState, IdentityState, MountState,
                NodeLocation, NodeState,
            },
        },
        queue::VirtQueues,
    },
};

const SIZE: u16 = 1024;
const DESC: [u64; 2] = [0x1000, 0xb000];
const AVAIL: [u64; 2] = [0x5000, 0xf000];
const USED: [u64; 2] = [0x6000, 0x10000];
const REQUEST: u64 = 0x20000;
const RESPONSE: u64 = 0x21000;

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A host directory. Its path doubles as the device tag, which keeps the
/// process mount registry of parallel tests apart.
struct Directory {
    path: PathBuf,
    tag: String,
}
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "boxlite-fs-snapshot-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let tag = path.to_str().unwrap().to_owned();
        Self { path, tag }
    }
    fn file(&self, name: &str, contents: &[u8]) -> PathBuf {
        let path = self.path.join(name);
        fs::write(&path, contents).unwrap();
        path
    }
    fn share(&self, name: &str, read_only: bool) -> Share {
        share(name, &self.path, read_only)
    }
    fn export(&self, name: &str, read_only: bool) -> RestoreExport {
        export(name, &self.path, read_only)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).unwrap();
    }
}

fn share(name: &str, path: &Path, read_only: bool) -> Share {
    Share {
        name: name.into(),
        path: path.to_path_buf(),
        read_only,
    }
}

fn export(name: &str, path: &Path, read_only: bool) -> RestoreExport {
    RestoreExport {
        name: name.into(),
        directory: File::open(path).unwrap(),
        read_only,
    }
}

#[derive(Default)]
struct Interrupt(AtomicU8);
impl VirtioInterrupt for Interrupt {
    fn raise(&self) {
        self.0.fetch_or(1, Ordering::SeqCst);
    }
    fn interrupt_status(&self) -> u8 {
        self.0.load(Ordering::SeqCst)
    }
    fn ack_interrupt(&self, bits: u8) {
        self.0.fetch_and(!bits, Ordering::SeqCst);
    }
    fn config_generation(&self) -> u8 {
        0
    }
    fn raise_config(&self) {
        self.0.fetch_or(2, Ordering::SeqCst);
    }
    fn device_status(&self) -> u8 {
        0
    }
    fn set_device_status(&self, _: u8) {}
    fn set_needs_reset(&self) {
        panic!("direct device tests do not invoke the worker's status path")
    }
}
struct Registrar;
impl EventRegistrar for Registrar {
    fn register(&self, _: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        panic!("synchronous fs must not register backend sources")
    }
    fn deregister(&self, _: SourceId) {
        panic!("no fs backend sources exist")
    }
}

/// One virtio-fs device behind real split queues.
struct Guest {
    device: Fs,
    memory: Arc<GuestMemoryMmap>,
    available: [u16; 2],
    used: [u16; 2],
    unique: u64,
    interrupt: Arc<Interrupt>,
}
impl Guest {
    /// An activated device that serves `shares`.
    fn new(tag: &str, shares: Vec<Share>) -> Self {
        let mut guest = Guest::inactive(tag, shares);
        guest.activate();
        guest
    }
    /// A device that was never activated: the only kind a saved state restores into.
    fn inactive(tag: &str, shares: Vec<Share>) -> Self {
        Self {
            device: Fs::new(tag, shares).unwrap(),
            memory: Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x30000)]).unwrap()),
            available: [0; 2],
            used: [0; 2],
            unique: 0,
            interrupt: Arc::new(Interrupt::default()),
        }
    }
    /// Restores `snapshot` into a fresh device for `tag`, then activates it.
    fn restore(
        tag: &str,
        snapshot: DeviceSnapshot,
        exports: Vec<RestoreExport>,
    ) -> Result<Self, DeviceError> {
        let mut guest = Guest::inactive(tag, Vec::new());
        guest
            .device
            .restore_state(snapshot, RestoreContext { exports })?;
        guest.activate();
        Ok(guest)
    }
    fn activate(&mut self) {
        // Fresh queues count from zero, as they would after a transport reset.
        self.available = [0; 2];
        self.used = [0; 2];
        let queues = (0..2)
            .map(|index| {
                let mut queue = Queue::new(SIZE).unwrap();
                queue.try_set_size(SIZE).unwrap();
                queue
                    .try_set_desc_table_address(GuestAddress(DESC[index]))
                    .unwrap();
                queue
                    .try_set_avail_ring_address(GuestAddress(AVAIL[index]))
                    .unwrap();
                queue
                    .try_set_used_ring_address(GuestAddress(USED[index]))
                    .unwrap();
                queue.set_ready(true);
                queue
            })
            .collect();
        self.device
            .activate(ActivationContext {
                memory: Arc::clone(&self.memory).into(),
                queues: VirtQueues::prepare(
                    queues,
                    &[SIZE, SIZE],
                    false,
                    false,
                    Arc::clone(&self.memory).into(),
                )
                .unwrap(),
                interrupt: self.interrupt.clone(),
                events: Arc::new(Registrar),
                waker: Arc::new(|| {}),
                sender: EventLoop::new().unwrap().sender(),
            })
            .unwrap();
    }
    fn send(&mut self, opcode: Opcode, node: u64, body: &[u8]) {
        self.unique += 1;
        let header = InHeader {
            len: (size_of::<InHeader>() + body.len()) as u32,
            opcode: opcode as u32,
            unique: self.unique,
            nodeid: node,
            // Host-user execution is deliberate; wire credentials are not changed.
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            ..Default::default()
        };
        let mut input = header.as_slice().to_vec();
        input.extend_from_slice(body);
        self.memory
            .write_slice(&input, GuestAddress(REQUEST))
            .unwrap();
        self.memory
            .write_obj(
                Descriptor::new(REQUEST, input.len() as u32, 1, 1),
                GuestAddress(DESC[1]),
            )
            .unwrap();
        self.memory
            .write_obj(
                Descriptor::new(RESPONSE, 8192, 2, 0),
                GuestAddress(DESC[1] + 16),
            )
            .unwrap();
        let slot = self.available[1] % SIZE;
        self.memory
            .write_obj(0u16, GuestAddress(AVAIL[1] + 4 + u64::from(slot) * 2))
            .unwrap();
        self.available[1] = self.available[1].wrapping_add(1);
        self.memory
            .write_obj(self.available[1].to_le(), GuestAddress(AVAIL[1] + 2))
            .unwrap();
        self.device.on_event(DeviceEvent::QueueKick(1)).unwrap();
    }
    /// The errno of the last request's reply and the body that follows its header.
    fn reply(&mut self) -> (i32, Vec<u8>) {
        let used = u16::from_le(self.memory.read_obj(GuestAddress(USED[1] + 2)).unwrap());
        assert_eq!(used, self.used[1].wrapping_add(1));
        let slot = u64::from(self.used[1] % SIZE);
        let len = u32::from_le(
            self.memory
                .read_obj(GuestAddress(USED[1] + 8 + slot * 8))
                .unwrap(),
        );
        self.used[1] = used;
        let mut response = vec![0; len as usize];
        self.memory
            .read_slice(&mut response, GuestAddress(RESPONSE))
            .unwrap();
        if response.is_empty() {
            // A reply-free request still publishes a used entry of length zero.
            return (0, Vec::new());
        }
        let header = obj::<OutHeader>(&response);
        assert_eq!(header.unique, self.unique);
        // FUSE reports a failure as the negated errno.
        (-header.error, response[size_of::<OutHeader>()..].to_vec())
    }
    fn call(&mut self, opcode: Opcode, node: u64, body: &[u8]) -> (i32, Vec<u8>) {
        self.send(opcode, node, body);
        self.reply()
    }
    /// Sends a request that must succeed and returns the body of its reply.
    fn ok(&mut self, opcode: Opcode, node: u64, body: &[u8]) -> Vec<u8> {
        let (error, reply) = self.call(opcode, node, body);
        assert_eq!(error, 0, "{opcode:?} on node {node} failed");
        reply
    }
    fn init(&mut self) {
        let reply = self.ok(
            Opcode::Init,
            0,
            InitInCompat {
                major: 7,
                minor: 41,
                max_readahead: 4096,
                // Ask for one option, so that a restored handshake has something to keep.
                flags: 1 << 13,
            }
            .as_slice(),
        );
        assert_eq!(obj::<InitOut>(&reply).major, 7);
    }
    fn lookup(&mut self, parent: u64, name: &[u8]) -> EntryOut {
        let mut entry = name.to_vec();
        entry.push(0);
        obj::<EntryOut>(&self.ok(Opcode::Lookup, parent, &entry))
    }
    fn getattr(&mut self, node: u64) -> i32 {
        self.call(Opcode::Getattr, node, GetattrIn::default().as_slice())
            .0
    }
    fn open(&mut self, node: u64, flags: i32) -> u64 {
        obj::<OpenOut>(
            &self.ok(
                Opcode::Open,
                node,
                OpenIn {
                    flags: flags as u32,
                    ..Default::default()
                }
                .as_slice(),
            ),
        )
        .fh
    }
    fn opendir(&mut self, node: u64) -> u64 {
        obj::<OpenOut>(
            &self.ok(
                Opcode::Opendir,
                node,
                OpenIn {
                    flags: libc::O_RDONLY as u32,
                    ..Default::default()
                }
                .as_slice(),
            ),
        )
        .fh
    }
    fn readdir(&mut self, node: u64, fh: u64) -> (i32, Vec<u8>) {
        self.call(
            Opcode::Readdir,
            node,
            ReadIn {
                fh,
                size: 4096,
                ..Default::default()
            }
            .as_slice(),
        )
    }
    fn create(&mut self, parent: u64, name: &[u8], flags: i32) -> (u64, u64) {
        let mut body = CreateIn {
            flags: flags as u32,
            mode: 0o600,
            ..Default::default()
        }
        .as_slice()
        .to_vec();
        body.extend_from_slice(name);
        body.push(0);
        let reply = self.ok(Opcode::Create, parent, &body);
        (
            obj::<EntryOut>(&reply).nodeid,
            obj::<OpenOut>(&reply[size_of::<EntryOut>()..]).fh,
        )
    }
    fn read(&mut self, node: u64, fh: u64) -> Result<Vec<u8>, i32> {
        let (error, reply) = self.call(
            Opcode::Read,
            node,
            ReadIn {
                fh,
                size: 4096,
                ..Default::default()
            }
            .as_slice(),
        );
        if error == 0 { Ok(reply) } else { Err(error) }
    }
    fn write(&mut self, node: u64, fh: u64, offset: u64, bytes: &[u8]) -> usize {
        let mut body = WriteIn {
            fh,
            offset,
            size: bytes.len() as u32,
            ..Default::default()
        }
        .as_slice()
        .to_vec();
        body.extend_from_slice(bytes);
        obj::<WriteOut>(&self.ok(Opcode::Write, node, &body)).size as usize
    }
    fn forget(&mut self, node: u64, lookups: u64) {
        // FORGET is the one request without a reply.
        self.send(
            Opcode::Forget,
            node,
            ForgetIn { nlookup: lookups }.as_slice(),
        );
        self.reply();
    }
    fn release(&mut self, node: u64, fh: u64) {
        self.ok(
            Opcode::Release,
            node,
            ReleaseIn {
                fh,
                ..Default::default()
            }
            .as_slice(),
        );
    }
    fn freeze(&mut self) {
        self.device.quiesce().unwrap();
    }
    fn thaw(&mut self) {
        self.device.resume().unwrap();
    }
    fn save(&mut self) -> DeviceSnapshot {
        self.freeze();
        let snapshot = self.device.save_state();
        self.thaw();
        snapshot.unwrap()
    }
    /// Quiesces the device and returns the reason `save_state` gives for refusing it.
    fn refusal(&mut self) -> String {
        self.freeze();
        let refused = match self.device.save_state() {
            Err(SnapshotError::Refused(reason)) => reason,
            other => panic!("expected a refusal, got {other:?}"),
        };
        self.thaw();
        refused
    }
}

fn obj<T: ByteValued>(bytes: &[u8]) -> T {
    // SAFETY: ByteValued permits all bit patterns; the length is checked first.
    assert!(bytes.len() >= size_of::<T>());
    unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast()) }
}

/// `(dev, ino)` of a host file as the device records it.
fn host_id(path: &Path) -> (u64, u64) {
    let metadata = fs::metadata(path).unwrap();
    (metadata.dev(), metadata.ino())
}

/// The mount ID statx reports for an open directory.
fn mount_id(file: &File) -> u64 {
    let mut status = std::mem::MaybeUninit::<libc::statx>::zeroed();
    // SAFETY: the empty path addresses the owned descriptor and the output has room.
    let result = unsafe {
        libc::statx(
            file.as_raw_fd(),
            c"".as_ptr(),
            libc::AT_EMPTY_PATH,
            libc::STATX_MNT_ID,
            status.as_mut_ptr(),
        )
    };
    assert_eq!(result, 0);
    // SAFETY: a successful statx initialized the status.
    unsafe { status.assume_init() }.stx_mnt_id
}

fn busy<T: std::fmt::Debug>(result: io::Result<T>) {
    assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EBUSY));
}

thread_local! {
    static HANDLE_ANSWER: std::cell::Cell<HandleAnswer> =
        const { std::cell::Cell::new(HandleAnswer::Host) };
}

/// What the interposed `name_to_handle_at` answers on this thread.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HandleAnswer {
    /// The real host result.
    Host,
    /// A file system without handles: `EOPNOTSUPP`.
    Unsupported,
    /// A failing host call: `EIO`.
    Failing,
}

/// Makes `name_to_handle_at` answer `answer` on this thread until the
/// returned guard drops.
fn handle_answer(answer: HandleAnswer) -> impl Drop {
    struct Assigned;
    impl Drop for Assigned {
        fn drop(&mut self) {
            HANDLE_ANSWER.with(|slot| slot.set(HandleAnswer::Host));
        }
    }
    HANDLE_ANSWER.with(|slot| slot.set(answer));
    Assigned
}

// Interpose only in the test binary. Production calls `libc::name_to_handle_at` directly.
#[unsafe(export_name = "name_to_handle_at")]
unsafe extern "C" fn host_name_to_handle_at(
    dirfd: libc::c_int,
    path: *const libc::c_char,
    handle: *mut libc::file_handle,
    mount_id: *mut libc::c_int,
    flags: libc::c_int,
) -> libc::c_int {
    let refused = match HANDLE_ANSWER
        .try_with(|slot| slot.get())
        .unwrap_or(HandleAnswer::Host)
    {
        HandleAnswer::Host => None,
        HandleAnswer::Unsupported => Some(libc::EOPNOTSUPP),
        HandleAnswer::Failing => Some(libc::EIO),
    };
    if let Some(errno) = refused {
        // SAFETY: setting this thread's errno has no other effect.
        unsafe { *libc::__errno_location() = errno };
        return -1;
    }
    // SAFETY: forward the libc ABI arguments unchanged to the Linux syscall.
    unsafe {
        libc::syscall(
            libc::SYS_name_to_handle_at,
            dirfd,
            path,
            handle,
            mount_id,
            flags,
        ) as libc::c_int
    }
}

/// Whether a READDIR reply lists `name`.
fn lists(reply: &[u8], name: &[u8]) -> bool {
    reply.windows(name.len()).any(|window| window == name)
}

/// One consistent state: an export on one mount, its root, a file below it and
/// a handle the guest still holds on that file.
fn consistent() -> FsState {
    FsState {
        tag: "boxlite".into(),
        fuse_initialized: true,
        fuse_options: 7,
        fuse_version: (KERNEL_VERSION, KERNEL_MINOR_VERSION),
        exports: vec![ExportState {
            root: 2,
            identity: 2,
            name: "data".into(),
            read_only: false,
            next_inode: 3,
            next_handle: 2,
        }],
        mounts: vec![MountState {
            export_root: 2,
            mnt_id: 7,
            path: Vec::new(),
        }],
        nodes: vec![
            NodeState {
                node: 2,
                identity: 2,
                export_root: 2,
                lookups: 1,
                local: 1,
                location: NodeLocation::Path(Vec::new()),
                dev: 3,
                ino: 100,
                handle: None,
            },
            NodeState {
                node: 3,
                identity: 3,
                export_root: 2,
                // A node the guest only holds open has no lookups left.
                lookups: 0,
                local: 2,
                location: NodeLocation::Path(vec![b"a".to_vec()]),
                dev: 3,
                ino: 101,
                handle: Some(FileHandle {
                    handle_type: 1,
                    handle: vec![1, 2, 3],
                }),
            },
        ],
        handles: vec![HandleState {
            fh: 1,
            node: 3,
            local: 1,
            flags: libc::O_RDONLY as u32,
            directory: false,
        }],
        next_node: 4,
        next_identity: 4,
        next_handle: 2,
        identities: vec![IdentityState {
            export_root: 2,
            dev: 3,
            ino: 101,
            mnt_id: 7,
            identity: 3,
        }],
    }
}

/// Encodes `saved` without the writer's checks, so a test exercises the
/// reader's own refusal.
fn unchecked(saved: &FsState) -> DeviceSnapshot {
    DeviceSnapshot {
        format: state::FORMAT,
        version: state::VERSION,
        payload: postcard::to_allocvec(saved).unwrap(),
    }
}

/// The reason `decode` refuses `saved`; it panics when the state is accepted.
fn refusal(saved: FsState) -> String {
    match state::decode(&unchecked(&saved), "boxlite") {
        Err(SnapshotError::Refused(reason)) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn snapshot_state_round_trips_through_postcard() {
    let saved = consistent();
    let snapshot = state::encode(&saved).unwrap();
    assert_eq!(
        (snapshot.format, snapshot.version),
        (state::FORMAT, state::VERSION)
    );
    assert_eq!(state::decode(&snapshot, "boxlite").unwrap(), saved);
}

#[test]
fn snapshot_decode_accepts_a_handle_on_an_invalid_node() {
    let mut saved = consistent();
    saved.nodes[1].location = NodeLocation::Invalid;
    saved.nodes[1].handle = None;
    // A node without a path takes no identity row.
    saved.identities.clear();
    assert_eq!(
        state::decode(&unchecked(&saved), &saved.tag).unwrap(),
        saved
    );
}

/// A change that makes a consistent state disagree with itself.
type Mutation = fn(&mut FsState);

#[test]
fn snapshot_decode_refuses_states_that_disagree_with_themselves() {
    let cases: [(&str, Mutation, &str); 26] = [
        (
            "another tag",
            |saved| saved.tag = "other".into(),
            "another device tag",
        ),
        (
            "another FUSE version",
            |saved| saved.fuse_version = (7, 28),
            "negotiated FUSE 7.28",
        ),
        (
            "a mount of no export",
            |saved| saved.mounts[0].export_root = 9,
            "belongs to no export",
        ),
        (
            "an identity on an unlisted mount",
            |saved| saved.identities[0].mnt_id = 8,
            "does not list",
        ),
        (
            "two mounts at one path",
            |saved| {
                let mount = MountState {
                    export_root: 2,
                    mnt_id: 8,
                    path: vec![b"m".to_vec()],
                };
                saved.mounts.push(mount.clone());
                saved.mounts.push(MountState { mnt_id: 9, ..mount });
            },
            "two mounts at one path",
        ),
        (
            "two mounts at the export root",
            |saved| {
                saved.mounts.push(MountState {
                    export_root: 2,
                    mnt_id: 8,
                    path: Vec::new(),
                });
            },
            "two mounts at one path",
        ),
        (
            "a node outside its export",
            |saved| {
                saved.nodes[1].location = NodeLocation::Path(vec![b"..".to_vec()]);
            },
            "component",
        ),
        (
            "a rootless export",
            |saved| {
                saved.nodes.remove(0);
            },
            "no root node",
        ),
        (
            "a handle on a missing node",
            |saved| saved.handles[0].node = 9,
            "no saved node",
        ),
        (
            "a file handle on the aggregate root",
            |saved| {
                saved.handles.push(HandleState {
                    fh: 2,
                    node: 1,
                    local: 0,
                    flags: 0,
                    directory: false,
                });
            },
            "aggregate root",
        ),
        (
            "an identity without a node",
            |saved| {
                saved.identities.push(IdentityState {
                    export_root: 2,
                    dev: 3,
                    ino: 102,
                    mnt_id: 7,
                    identity: 9,
                });
            },
            "no node with a path uses",
        ),
        (
            "a node without an identity",
            |saved| saved.identities.clear(),
            "no identity entry",
        ),
        (
            "a node nobody references",
            |saved| {
                saved.handles.clear();
            },
            "neither looked up nor open",
        ),
        (
            "a repeated node allocator",
            |saved| saved.next_node = 3,
            "saved node 3",
        ),
        (
            "a repeated backend allocator",
            |saved| saved.exports[0].next_inode = 2,
            "allocator",
        ),
        (
            "a node holding more lookups than a restore can add to",
            |saved| saved.nodes[1].lookups = u64::MAX,
            "more lookups than can be restored",
        ),
        (
            "a root owned by another export",
            |saved| saved.nodes[0].export_root = 3,
            "belongs to no export",
        ),
        (
            "a root with a backend inode of its own",
            |saved| saved.nodes[0].local = 2,
            "no root node at its own number",
        ),
        (
            "a second node at the top of an export",
            |saved| saved.nodes[1].location = NodeLocation::Path(Vec::new()),
            "sits at an export root",
        ),
        (
            "a node below a root on the root's backend inode",
            |saved| saved.nodes[1].local = 1,
            "repeats a backend inode",
        ),
        (
            "an invalid node with a file handle",
            |saved| saved.nodes[1].location = NodeLocation::Invalid,
            "invalid but carries a file handle",
        ),
        (
            "an invalid node with an identity row",
            |saved| {
                saved.nodes[1].location = NodeLocation::Invalid;
                saved.nodes[1].handle = None;
            },
            "no node with a path uses",
        ),
        (
            "a node identity that disagrees with its row",
            |saved| saved.nodes[1].identity = 9,
            "has no identity entry",
        ),
        (
            "a node identity at the identity allocator",
            |saved| {
                saved.nodes[1].identity = 4;
                saved.identities[0].identity = 4;
                saved.next_identity = 4;
            },
            "identity allocator 4",
        ),
        (
            "nodes out of ascending order",
            |saved| saved.nodes.swap(0, 1),
            "ascending order",
        ),
        (
            "an identity row repeated for one file",
            |saved| {
                let row = saved.identities[0].clone();
                saved.identities.push(row);
            },
            "repeats a file",
        ),
    ];
    for (what, mutate, reason) in cases {
        let mut saved = consistent();
        mutate(&mut saved);
        assert!(
            refusal(saved).contains(reason),
            "{what} was not refused with {reason}"
        );
    }
}

#[test]
fn snapshot_decode_refuses_malformed_snapshots() {
    let snapshot = state::encode(&consistent()).unwrap();
    let refusal = |snapshot: &DeviceSnapshot| match state::decode(snapshot, "boxlite") {
        Err(SnapshotError::Refused(reason)) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    };
    let mut other = snapshot.clone();
    other.format = 1;
    assert!(refusal(&other).contains("format 1 is not virtio-fs"));
    other = snapshot.clone();
    other.version = 2;
    assert!(refusal(&other).contains("version 2 is not supported"));
    other = snapshot.clone();
    other.payload.push(0);
    assert!(refusal(&other).contains("bytes follow the state"));
    other = snapshot.clone();
    other.payload.clear();
    assert!(refusal(&other).contains("not a virtio-fs state"));
    other = snapshot.clone();
    other.payload = vec![0; state::MAX_PAYLOAD_BYTES + 1];
    assert!(refusal(&other).contains("above the limit"));
    // Tables and handles beyond their limits are refused before anything indexes them.
    let mut saved = consistent();
    let mount = saved.mounts[0].clone();
    saved.mounts = vec![mount; state::MAX_MOUNTS + 1];
    assert!(state::encode(&saved).is_err());
    assert!(refusal(&unchecked(&saved)).contains("more than"));
    let mut saved = consistent();
    saved.nodes[1].handle.as_mut().unwrap().handle = vec![0; state::MAX_HANDLE_BYTES + 1];
    assert!(state::encode(&saved).is_err());
    assert!(refusal(&unchecked(&saved)).contains("longer than"));
}

#[test]
fn snapshot_mount_table_decodes_ids_and_escaped_points() {
    let table = mounts::parse_mountinfo(
        b"25 1 0:20 / /rw rw,noatime shared:1 - ext4 /dev/vda rw\n26 25 0:20 /dir\\040x /mnt/b\\011c rw - ext4 /dev/vda rw\n",
    )
    .unwrap();
    assert_eq!(
        table,
        BTreeMap::from([(25, b"/rw".to_vec()), (26, b"/mnt/b\tc".to_vec())])
    );
    let short = mounts::parse_mountinfo(b"25 1 0:20 /\n").unwrap_err();
    assert_eq!(short.raw_os_error(), Some(libc::EINVAL));
}

#[test]
fn snapshot_mount_points_resolve_against_the_export_root() {
    let path = |root: &str, point: &str| mounts::mount_path(root.as_bytes(), point.as_bytes());
    assert_eq!(path("/srv/box", "/srv/box").unwrap(), Vec::<Vec<u8>>::new());
    // The mount of an export root is usually the mount of one of its ancestors.
    assert_eq!(path("/srv/box", "/").unwrap(), Vec::<Vec<u8>>::new());
    assert_eq!(
        path("/srv/box", "/srv/box/mnt/a").unwrap(),
        [b"mnt".to_vec(), b"a".to_vec()]
    );
    assert_eq!(path("/", "/mnt").unwrap(), [b"mnt".to_vec()]);
    // A sibling is neither below the export nor above it.
    assert_eq!(
        path("/srv/box", "/srv/boxer").unwrap_err().raw_os_error(),
        Some(libc::EINVAL)
    );
    assert_eq!(
        path("/srv/box", "/elsewhere").unwrap_err().raw_os_error(),
        Some(libc::EINVAL)
    );
}

#[test]
fn snapshot_freeze_keeps_the_negotiated_session() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDWR);
    assert_eq!(guest.device.spec().snapshot, SnapshotSupport::Stopped);
    guest.freeze();
    // No second handshake is needed and every number the guest holds still resolves.
    assert_eq!(guest.getattr(node), 0);
    assert_eq!(guest.read(node, fh).unwrap(), b"body");
    assert_eq!(guest.write(node, fh, 4, b"!"), 1);
    assert_eq!(fs::read(directory.path.join("file")).unwrap(), b"body!");
    assert_eq!(guest.lookup(ROOT_ID, b"data").nodeid, root);
    // The negotiated session is the one in place, so INIT stays refused.
    assert_eq!(
        guest
            .call(Opcode::Init, 0, InitInCompat::default().as_slice())
            .0,
        libc::EPROTO
    );
}

#[test]
fn snapshot_repeated_freeze_keeps_the_session() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDONLY);
    guest.freeze();
    guest.freeze();
    assert_eq!(guest.read(node, fh).unwrap(), b"body");
    let first = guest.device.save_state();
    guest.freeze();
    assert_eq!(guest.device.save_state(), first);
}

#[test]
fn snapshot_reset_and_drop_still_close_a_frozen_session() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    insert_aggregate(&directory.tag, guest.device.filesystem());
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDONLY);
    guest.freeze();
    guest.device.reset().unwrap();
    assert!(matches!(
        guest.device.on_event(DeviceEvent::QueueKick(1)),
        Err(DeviceError::NeedsReset(_))
    ));
    // A new handshake hands out a new node and no longer knows the old handle.
    guest.activate();
    guest.init();
    assert_eq!(guest.lookup(ROOT_ID, b"data").nodeid, root);
    assert_ne!(guest.lookup(root, b"file").nodeid, node);
    assert_eq!(guest.read(node, fh), Err(libc::EBADF));
    drop(guest);
    assert_eq!(
        lookup_aggregate(&directory.tag).unwrap_err().raw_os_error(),
        Some(libc::ENODEV)
    );
}

#[test]
fn snapshot_frozen_device_refuses_mount_changes_and_stays_published() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDWR);
    let fs = guest.device.filesystem();
    insert_aggregate(&directory.tag, Arc::clone(&fs));
    guest.freeze();
    busy(fs.register_fd("late".into(), File::open(&directory.path).unwrap(), false));
    busy(fs.set_export_phase("data", ExportPhase::Detaching));
    busy(fs.remove("data"));
    // A descriptor that is not a directory still answers EBUSY rather than ENOTDIR.
    busy(fs.register_fd(
        "bad".into(),
        File::create(directory.path.join("stray")).unwrap(),
        false,
    ));
    // The export table is what it was, and the control plane still finds the device.
    assert_eq!(
        guest.call(Opcode::Lookup, ROOT_ID, b"late\0").0,
        libc::ENOENT
    );
    assert_eq!(guest.lookup(ROOT_ID, b"data").nodeid, root);
    assert!(Arc::ptr_eq(&lookup_aggregate(&directory.tag).unwrap(), &fs));
    // Resume hands the mount registry back; the session kept its handles.
    guest.thaw();
    fs.register_fd("late".into(), File::open(&directory.path).unwrap(), false)
        .unwrap();
    guest.lookup(ROOT_ID, b"late");
    assert_eq!(guest.read(node, fh).unwrap(), b"body");
    assert_eq!(guest.write(node, fh, 0, b"kept"), 4);
}

#[test]
fn snapshot_exports_start_mounted_and_follow_the_controller() {
    let directory = Directory::new();
    let fs = AggregateFs::new(vec![directory.share("data", false)]).unwrap();
    assert_eq!(fs.export_phase("data").unwrap(), ExportPhase::Mounted);
    fs.register_fd("late".into(), File::open(&directory.path).unwrap(), false)
        .unwrap();
    assert_eq!(fs.export_phase("late").unwrap(), ExportPhase::Preparing);
    fs.set_export_phase("late", ExportPhase::Mounted).unwrap();
    assert_eq!(fs.export_phase("late").unwrap(), ExportPhase::Mounted);
    fs.set_export_phase("late", ExportPhase::Detaching).unwrap();
    assert_eq!(fs.export_phase("late").unwrap(), ExportPhase::Detaching);
    assert_eq!(
        fs.export_phase("missing").unwrap_err().raw_os_error(),
        Some(libc::ENOENT)
    );
    assert_eq!(
        fs.set_export_phase("missing", ExportPhase::Mounted)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ENOENT)
    );
}

#[test]
fn snapshot_save_refuses_an_export_whose_mount_is_in_flight() {
    let directory = Directory::new();
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let fs = guest.device.filesystem();
    fs.register_fd("late".into(), File::open(&directory.path).unwrap(), false)
        .unwrap();
    assert_eq!(
        guest.refusal(),
        format!("export late is {:?}", ExportPhase::Preparing)
    );
    fs.set_export_phase("late", ExportPhase::Detaching).unwrap();
    assert_eq!(
        guest.refusal(),
        format!("export late is {:?}", ExportPhase::Detaching)
    );
    // Once every mount has settled, the phase no longer blocks the snapshot.
    fs.set_export_phase("late", ExportPhase::Mounted).unwrap();
    guest.save();
}

#[test]
fn snapshot_save_refuses_without_a_mount_table() {
    let directory = Directory::new();
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    guest.lookup(ROOT_ID, b"data");
    {
        let _unreadable = mounts::replace_mountinfo(Err(io::ErrorKind::PermissionDenied));
        assert!(guest.refusal().contains("mount table cannot be read"));
    }
    // A table that no longer lists the export's mount cannot name where to find it again.
    let _empty = mounts::replace_mountinfo(Ok(Vec::new()));
    assert!(
        guest
            .refusal()
            .contains("which the mount table does not list")
    );
}

#[test]
fn snapshot_save_refuses_two_mounts_at_one_path() {
    let directory = Directory::new();
    directory.file("a", b"a");
    directory.file("b", b"b");
    let root = directory.path.to_str().unwrap();
    let _table = mounts::replace_mountinfo(Ok(format!(
        "1000 1 0:1 / {root} rw - ext4 /dev/x rw\n1001 1 0:1 / {root}/stacked rw - ext4 /dev/x rw\n1002 1 0:1 / {root}/stacked rw - ext4 /dev/x rw\n"
    ).into_bytes()));
    // Each file sits on its own mount; both mounts are stacked on one path.
    let _mounts = super::linux_tests::mount_ids(vec![
        (root.as_bytes().to_vec(), 1000),
        (format!("{root}/a").into_bytes(), 1001),
        (format!("{root}/b").into_bytes(), 1002),
    ]);
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    guest.lookup(root, b"a");
    guest.lookup(root, b"b");
    assert_eq!(
        guest.refusal(),
        "export data stacks mounts 1001 and 1002 at stacked"
    );
}

#[test]
fn snapshot_save_marks_an_unlinked_open_file_invalid() {
    let directory = Directory::new();
    let file = directory.file("gone", b"g");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"gone").nodeid;
    let fh = guest.open(node, libc::O_RDONLY);
    guest.forget(node, 1);
    fs::remove_file(&file).unwrap();
    let saved = state::decode(&guest.save(), &directory.tag).unwrap();
    let row = saved.nodes.iter().find(|row| row.node == node).unwrap();
    assert_eq!(row.location, NodeLocation::Invalid);
    assert_eq!(row.handle, None);
    assert_eq!(row.lookups, 0);
    // Nothing can be reopened for the node, so it brings no identity or mount along.
    assert!(saved.identities.is_empty());
    assert_eq!(saved.mounts.len(), 1);
    assert!(
        saved
            .handles
            .iter()
            .any(|handle| (handle.node, handle.fh) == (node, fh))
    );
}

#[test]
fn snapshot_save_marks_an_unlinked_looked_up_file_invalid() {
    let directory = Directory::new();
    let file = directory.file("gone", b"g");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"gone").nodeid;
    fs::remove_file(&file).unwrap();
    let saved = state::decode(&guest.save(), &directory.tag).unwrap();
    let row = saved.nodes.iter().find(|row| row.node == node).unwrap();
    assert_eq!(row.location, NodeLocation::Invalid);
    assert_eq!(row.handle, None);
    assert_eq!(row.lookups, 1);
    assert!(saved.handles.is_empty());
    assert!(saved.identities.is_empty());
    assert_eq!(saved.mounts.len(), 1);
}

#[test]
fn snapshot_save_refuses_a_node_of_an_unmounted_export() {
    let directory = Directory::new();
    directory.file("file", b"f");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let fs = guest.device.filesystem();
    let late = fs
        .register_fd("late".into(), File::open(&directory.path).unwrap(), false)
        .unwrap();
    fs.set_export_phase("late", ExportPhase::Mounted).unwrap();
    let node = guest.lookup(late, b"file").nodeid;
    fs.remove("late").unwrap();
    assert_eq!(
        guest.refusal(),
        format!("node {node} belongs to an unmounted export")
    );
}

#[test]
fn snapshot_saved_state_lists_the_session() {
    let directory = Directory::new();
    let file = directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data");
    let entry = guest.lookup(root.nodeid, b"file");
    let fh = guest.open(entry.nodeid, libc::O_RDWR);
    let saved = state::decode(&guest.save(), &directory.tag).unwrap();
    let exported = File::open(&directory.path).unwrap();
    let opened = File::open(&file).unwrap();
    assert_eq!(saved.tag, directory.tag);
    assert!(saved.fuse_initialized);
    assert_ne!(saved.fuse_options, 0);
    assert_eq!(saved.fuse_version, (KERNEL_VERSION, KERNEL_MINOR_VERSION));
    assert_eq!(
        saved.exports,
        [ExportState {
            root: root.nodeid,
            identity: root.attr.ino,
            name: "data".into(),
            read_only: false,
            next_inode: 3,
            next_handle: 2,
        }]
    );
    // The export sits on one mount whose mount point lies outside the export.
    assert_eq!(
        saved.mounts,
        [MountState {
            export_root: root.nodeid,
            mnt_id: mount_id(&exported),
            path: Vec::new(),
        }]
    );
    assert_eq!(
        saved.nodes,
        [
            NodeState {
                node: root.nodeid,
                identity: root.attr.ino,
                export_root: root.nodeid,
                lookups: 1,
                local: 1,
                location: NodeLocation::Path(Vec::new()),
                dev: host_id(&directory.path).0,
                ino: host_id(&directory.path).1,
                handle: passthrough::file_handle(&exported).unwrap(),
            },
            NodeState {
                node: entry.nodeid,
                identity: entry.attr.ino,
                export_root: root.nodeid,
                lookups: 1,
                local: 2,
                location: NodeLocation::Path(vec![b"file".to_vec()]),
                dev: host_id(&file).0,
                ino: host_id(&file).1,
                handle: passthrough::file_handle(&opened).unwrap(),
            },
        ]
    );
    assert_eq!(
        saved.handles,
        [HandleState {
            fh,
            node: entry.nodeid,
            local: 1,
            flags: libc::O_RDWR as u32,
            directory: false,
        }]
    );
    assert_eq!((root.nodeid, entry.nodeid, fh), (2, 3, 1));
    assert_eq!(
        (saved.next_node, saved.next_identity, saved.next_handle),
        (4, 4, 2)
    );
    // The type is the one the kernel reported for the whole handle, not a
    // size probe's sentinel (FILEID_INVALID, 255).
    if let Some(handle) = &saved.nodes[1].handle {
        assert_ne!(handle.handle_type, 255);
    }
    assert_eq!(
        saved.identities,
        [IdentityState {
            export_root: root.nodeid,
            dev: host_id(&file).0,
            ino: host_id(&file).1,
            mnt_id: mount_id(&exported),
            identity: entry.attr.ino,
        }]
    );
}

#[test]
fn snapshot_saved_state_leaves_forgotten_and_unmounted_entries_out() {
    let directory = Directory::new();
    directory.file("forgotten", b"f");
    directory.file("kept", b"k");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let forgotten = guest.lookup(root, b"forgotten").nodeid;
    let kept = guest.lookup(root, b"kept");
    guest.forget(forgotten, 1);
    let (dev, ino) = host_id(&directory.path.join("forgotten"));
    let fs = guest.device.filesystem();
    let late = fs
        .register_fd("late".into(), File::open(&directory.path).unwrap(), false)
        .unwrap();
    fs.set_export_phase("late", ExportPhase::Mounted).unwrap();
    let late_kept = guest.lookup(late, b"kept").nodeid;
    // The guest drops its last reference into `late` before the export goes away.
    guest.forget(late_kept, 1);
    let before = state::decode(&guest.save(), &directory.tag).unwrap();
    fs.remove("late").unwrap();
    let after = state::decode(&guest.save(), &directory.tag).unwrap();
    let forgotten = |saved: &FsState| {
        saved
            .nodes
            .iter()
            .any(|node| node.node != root && (node.dev, node.ino) == (dev, ino))
            || saved
                .identities
                .iter()
                .any(|id| (id.dev, id.ino) == (dev, ino))
    };
    assert!(!forgotten(&before));
    assert!(!forgotten(&after));
    assert!(before.nodes.iter().any(|node| node.node == kept.nodeid));
    assert!(
        before
            .identities
            .iter()
            .any(|id| id.identity == kept.attr.ino)
    );
    // Removing an export allocates nothing, so every allocator is where it was.
    assert_eq!(
        (after.next_node, after.next_identity, after.next_handle),
        (before.next_node, before.next_identity, before.next_handle)
    );
    assert_eq!(after.exports.len(), 1);
    assert!(after.identities.iter().all(|id| id.export_root != late));
}

#[test]
fn snapshot_uninitialized_session_round_trips() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    // Before the handshake every request that needs a reply is refused.
    assert_eq!(guest.getattr(ROOT_ID), libc::EPROTO);
    let snapshot = guest.save();
    let saved = state::decode(&snapshot, &directory.tag).unwrap();
    assert!(!saved.fuse_initialized);
    // No node is looked up yet, but each export keeps its root.
    let [root] = saved.nodes.as_slice() else {
        panic!("only the export root is saved before the handshake");
    };
    assert_eq!((root.node, root.lookups), (2, 0));
    assert_eq!(root.location, NodeLocation::Path(Vec::new()));
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(restored.getattr(ROOT_ID), libc::EPROTO);
    restored.init();
    restored.lookup(ROOT_ID, b"data");
    restored.lookup(root.node, b"file");
}

#[test]
fn snapshot_session_reset_by_the_driver_restores_ready_for_a_new_handshake() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDONLY);
    // The driver reset the device: the session is gone, the exports stay.
    guest.device.reset().unwrap();
    let snapshot = guest.save();
    let saved = state::decode(&snapshot, &directory.tag).unwrap();
    assert!(!saved.fuse_initialized);
    assert!(saved.handles.is_empty() && saved.identities.is_empty());
    let [only] = saved.nodes.as_slice() else {
        panic!("only the export root is saved after a reset");
    };
    assert_eq!((only.node, only.lookups), (root, 0));
    // The restored device waits for the guest's handshake and then serves its export.
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(restored.getattr(node), libc::EPROTO);
    restored.init();
    assert_eq!(restored.lookup(ROOT_ID, b"data").nodeid, root);
    restored.lookup(root, b"file");
    // The handle the driver dropped with its reset is gone for good.
    assert_eq!(restored.read(node, fh), Err(libc::EBADF));
}

#[test]
fn snapshot_restored_device_republishes_under_its_tag() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let snapshot = guest.save();
    // The device a VM builds is published before its state is restored.
    let old = guest.device.filesystem();
    insert_aggregate(&directory.tag, Arc::clone(&old));
    let restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    let published = lookup_aggregate(&directory.tag).unwrap();
    assert!(Arc::ptr_eq(&published, &restored.device.filesystem()));
    assert!(!Arc::ptr_eq(&published, &old));
    drop(restored);
    assert_eq!(
        lookup_aggregate(&directory.tag).unwrap_err().raw_os_error(),
        Some(libc::ENODEV)
    );
}

#[test]
fn snapshot_restore_needs_an_inactive_device_without_exports() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let node = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(node, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDONLY);
    let snapshot = guest.save();
    let exports = || vec![directory.export("data", false)];
    assert!(matches!(
        guest
            .device
            .restore_state(snapshot.clone(), RestoreContext { exports: exports() }),
        Err(DeviceError::Unsupported(_))
    ));
    // The refused restore left the running session alone.
    assert_eq!(guest.read(node, fh).unwrap(), b"body");
    let mut configured = Guest::inactive(&directory.tag, vec![directory.share("data", false)]);
    assert!(
        configured
            .device
            .restore_state(snapshot, RestoreContext { exports: exports() })
            .is_err()
    );
}

#[test]
fn snapshot_restore_requires_the_saved_export_directories() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let snapshot = guest.save();
    assert!(Guest::restore(&directory.tag, snapshot.clone(), Vec::new()).is_err());
    assert!(
        Guest::restore(
            &directory.tag,
            snapshot.clone(),
            vec![directory.export("data", true)]
        )
        .is_err()
    );
    assert!(
        Guest::restore(
            &directory.tag,
            snapshot.clone(),
            vec![directory.export("other", false)]
        )
        .is_err()
    );
    // A name supplied twice is one directory too many.
    assert!(
        Guest::restore(
            &directory.tag,
            snapshot.clone(),
            vec![
                directory.export("data", false),
                directory.export("data", false)
            ]
        )
        .is_err()
    );
    Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
}

#[test]
fn snapshot_restore_refuses_swapped_export_directories() {
    let first = Directory::new();
    first.file("same", b"first");
    let second = Directory::new();
    second.file("same", b"second");
    let mut guest = Guest::new(
        &first.tag,
        vec![first.share("a", false), share("b", &second.path, false)],
    );
    guest.init();
    let a = guest.lookup(ROOT_ID, b"a").nodeid;
    let a_file = guest.lookup(a, b"same").nodeid;
    let b = guest.lookup(ROOT_ID, b"b").nodeid;
    let b_file = guest.lookup(b, b"same").nodeid;
    let fh_a = guest.open(a_file, libc::O_RDONLY);
    let fh_b = guest.open(b_file, libc::O_RDONLY);
    let snapshot = guest.save();
    let swapped = vec![
        export("a", &second.path, false),
        export("b", &first.path, false),
    ];
    assert!(Guest::restore(&first.tag, snapshot.clone(), swapped).is_err());
    let mut restored = Guest::restore(
        &first.tag,
        snapshot,
        vec![
            export("a", &first.path, false),
            export("b", &second.path, false),
        ],
    )
    .unwrap();
    assert_eq!(restored.read(a_file, fh_a).unwrap(), b"first");
    assert_eq!(restored.read(b_file, fh_b).unwrap(), b"second");
}

#[test]
fn snapshot_failed_restore_leaves_no_partial_session() {
    let directory = Directory::new();
    directory.file("kept", b"kept");
    let second = Directory::new();
    let wrong = Directory::new();
    let mut guest = Guest::new(
        &directory.tag,
        vec![
            directory.share("data", false),
            second.share("second", false),
        ],
    );
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let kept = guest.lookup(root, b"kept").nodeid;
    let _kept_fh = guest.open(kept, libc::O_RDONLY);
    let snapshot = guest.save();
    drop(guest);
    let mut target = Guest::inactive(&directory.tag, Vec::new());
    assert!(
        target
            .device
            .restore_state(
                snapshot,
                RestoreContext {
                    exports: vec![
                        directory.export("data", false),
                        wrong.export("second", false)
                    ]
                }
            )
            .is_err()
    );
    // Nothing of the half-built session survives, and nothing was published.
    assert!(!target.device.filesystem().has_exports());
    assert!(lookup_aggregate(&directory.tag).is_err());
}

#[test]
fn snapshot_restore_marks_only_the_replaced_file_stale() {
    let directory = Directory::new();
    let file = directory.file("file", b"old");
    directory.file("other", b"other");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let old = guest.lookup(root, b"file").nodeid;
    let other = guest.lookup(root, b"other").nodeid;
    let other_fh = guest.open(other, libc::O_RDONLY);
    let snapshot = guest.save();
    let exports = || vec![directory.export("data", false)];
    fs::remove_file(&file).unwrap();
    fs::write(&file, b"new").unwrap();
    let mut restored = Guest::restore(&directory.tag, snapshot, exports()).unwrap();
    assert_eq!(restored.getattr(old), libc::ESTALE);
    assert_eq!(
        restored
            .call(Opcode::Open, old, OpenIn::default().as_slice())
            .0,
        libc::ESTALE
    );
    let new = restored.lookup(root, b"file").nodeid;
    assert_ne!(new, old);
    let fh = restored.open(new, libc::O_RDONLY);
    assert_eq!(restored.read(new, fh).unwrap(), b"new");
    assert_eq!(restored.read(other, other_fh).unwrap(), b"other");
}

#[test]
fn snapshot_restore_marks_a_replaced_file_stale_without_file_handles() {
    let directory = Directory::new();
    let file = directory.file("file", b"old");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let snapshot = {
        let _unsupported = handle_answer(HandleAnswer::Unsupported);
        let snapshot = guest.save();
        assert!(
            state::decode(&snapshot, &directory.tag).unwrap().nodes[1]
                .handle
                .is_none()
        );
        snapshot
    };
    // Without a handle the file's device and inode are all a restore can check.
    fs::remove_file(&file).unwrap();
    fs::write(&file, b"new").unwrap();
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(restored.getattr(node), libc::ESTALE);
}

#[test]
fn snapshot_restore_without_saved_handles_never_asks_for_one() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    guest.lookup(root, b"file");
    let exports = || vec![directory.export("data", false)];
    let snapshot = {
        let _unsupported = handle_answer(HandleAnswer::Unsupported);
        let snapshot = guest.save();
        assert!(
            state::decode(&snapshot, &directory.tag)
                .unwrap()
                .nodes
                .iter()
                .all(|node| node.handle.is_none())
        );
        snapshot
    };
    // The host call fails outright now. With nothing saved to compare, that
    // is no reason to refuse the state.
    let _failing = handle_answer(HandleAnswer::Failing);
    Guest::restore(&directory.tag, snapshot, exports()).unwrap();
}

#[test]
fn snapshot_restore_marks_only_the_node_with_an_uncheckable_handle_stale() {
    let directory = Directory::new();
    directory.file("file", b"body");
    directory.file("other", b"other");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let other = guest.lookup(root, b"other").nodeid;
    let snapshot = {
        let _unsupported = handle_answer(HandleAnswer::Unsupported);
        guest.save()
    };
    let mut saved = state::decode(&snapshot, &directory.tag).unwrap();
    // Supply a saved handle even on hosts whose test filesystem exports none.
    saved
        .nodes
        .iter_mut()
        .find(|row| row.node == node)
        .unwrap()
        .handle = Some(FileHandle {
        handle_type: 1,
        handle: vec![1],
    });
    let _failing = handle_answer(HandleAnswer::Failing);
    let mut restored = Guest::restore(
        &directory.tag,
        state::encode(&saved).unwrap(),
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(restored.getattr(node), libc::ESTALE);
    assert_eq!(restored.getattr(other), 0);
    // The same host inode can be looked up again as a fresh guest node.
    let fresh = restored.lookup(root, b"file").nodeid;
    assert_ne!(fresh, node);
    let next = restored.save();
    let mut again =
        Guest::restore(&directory.tag, next, vec![directory.export("data", false)]).unwrap();
    assert_eq!(again.getattr(node), libc::ESTALE);
    assert_eq!(again.getattr(fresh), 0);
}

#[test]
fn snapshot_save_omits_failing_file_handles_and_restore_checks_inode() {
    let directory = Directory::new();
    let file = directory.file("file", b"old");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let snapshot = {
        let _failing = handle_answer(HandleAnswer::Failing);
        guest.save()
    };
    let saved = state::decode(&snapshot, &directory.tag).unwrap();
    assert!(saved.nodes.iter().all(|row| row.handle.is_none()));
    fs::remove_file(&file).unwrap();
    fs::write(&file, b"new").unwrap();
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(restored.getattr(root), 0);
    assert_eq!(restored.getattr(node), libc::ESTALE);
}

#[test]
fn snapshot_stale_handle_reads_fail_but_release_succeeds() {
    let directory = Directory::new();
    let file = directory.file("file", b"old");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDONLY);
    fs::remove_file(file).unwrap();
    let mut restored = Guest::restore(
        &directory.tag,
        guest.save(),
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(restored.read(node, fh), Err(libc::ESTALE));
    // The stale node and its handle travel through a second round unchanged.
    let mut again = Guest::restore(
        &directory.tag,
        restored.save(),
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(again.read(node, fh), Err(libc::ESTALE));
    assert_eq!(
        restored.call(Opcode::Lookup, root, b"file\0").0,
        libc::ENOENT
    );
    restored.release(node, fh);
    assert_eq!(restored.read(node, fh), Err(libc::EBADF));
    assert_eq!(restored.getattr(node), libc::ESTALE);
    restored.forget(node, 1);
    assert_eq!(restored.getattr(node), libc::EBADF);
}

#[test]
fn snapshot_stale_directory_refuses_lookups_and_readdir() {
    let directory = Directory::new();
    let subdir = directory.path.join("subdir");
    fs::create_dir(&subdir).unwrap();
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"subdir").nodeid;
    let fh = guest.opendir(node);
    let saved = guest.save();
    fs::remove_dir(subdir).unwrap();
    let mut restored =
        Guest::restore(&directory.tag, saved, vec![directory.export("data", false)]).unwrap();
    assert_eq!(
        restored.call(Opcode::Lookup, node, b"entry\0").0,
        libc::ESTALE
    );
    assert_eq!(restored.readdir(node, fh).0, libc::ESTALE);
    let mut rename = RenameIn { newdir: node }.as_slice().to_vec();
    rename.extend_from_slice(b"old\0new\0");
    assert_eq!(
        restored.call(Opcode::Rename, ROOT_ID, &rename).0,
        libc::ESTALE
    );
    let mut link = LinkIn { oldnodeid: node }.as_slice().to_vec();
    link.extend_from_slice(b"new\0");
    assert_eq!(restored.call(Opcode::Link, ROOT_ID, &link).0, libc::ESTALE);
    restored.forget(node, 1);
    assert_eq!(restored.getattr(node), libc::ESTALE);
    restored.ok(
        Opcode::Releasedir,
        node,
        ReleaseIn {
            fh,
            ..Default::default()
        }
        .as_slice(),
    );
    assert_eq!(restored.getattr(node), libc::EBADF);
}

#[test]
fn snapshot_retries_a_stale_handle_on_a_live_node_with_its_saved_flags() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};

    let directory = Directory::new();
    let shell = directory.path.join("shell");
    fs::copy("/bin/sh", &shell).unwrap();
    fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"shell").nodeid;
    let fh = guest.open(node, libc::O_RDWR);
    let snapshot = guest.save();
    drop(guest);

    // Linux refuses writable opens with ETXTBSY while this executable runs.
    // The shell waits for EOF on its pipe, so the failure lasts exactly one restore.
    let mut child = Command::new(&shell).stdin(Stdio::piped()).spawn().unwrap();
    let exports = || vec![directory.export("data", false)];
    let mut restored = Guest::restore(&directory.tag, snapshot, exports()).unwrap();
    assert_eq!(restored.getattr(node), 0);
    assert_eq!(restored.read(node, fh), Err(libc::ESTALE));
    let snapshot = restored.save();
    restored.release(node, fh);
    assert_eq!(restored.read(node, fh), Err(libc::EBADF));
    // wait closes the child's stdin before waiting for it to exit.
    assert!(child.wait().unwrap().success());
    let mut again = Guest::restore(&directory.tag, snapshot, exports()).unwrap();
    assert!(!again.read(node, fh).unwrap().is_empty());
    assert_eq!(again.write(node, fh, 0, b"x"), 1);
}

#[test]
fn snapshot_restored_handles_and_lookups_keep_their_numbers() {
    let directory = Directory::new();
    let file = directory.file("file", b"0123456789");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let entry = guest.lookup(root, b"file");
    let fh = guest.open(entry.nodeid, libc::O_RDWR);
    let snapshot = guest.save();
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    // The old handle reads and writes the file the guest opened before the snapshot.
    assert_eq!(restored.read(entry.nodeid, fh).unwrap(), b"0123456789");
    assert_eq!(restored.write(entry.nodeid, fh, 10, b"!"), 1);
    assert_eq!(restored.read(entry.nodeid, fh).unwrap(), b"0123456789!");
    assert_eq!(fs::read(&file).unwrap(), b"0123456789!");
    // Looking the file up again finds the same node and inode number.
    let again = restored.lookup(root, b"file");
    assert_eq!(
        (again.nodeid, again.attr.ino),
        (entry.nodeid, entry.attr.ino)
    );
}

#[test]
fn snapshot_restored_allocators_never_repeat_a_saved_number() {
    let directory = Directory::new();
    directory.file("file", b"body");
    directory.file("next", b"next");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDONLY);
    let snapshot = guest.save();
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    // New numbers follow the saved allocators instead of starting over.
    let next = restored.lookup(root, b"next");
    assert_eq!((next.nodeid, next.attr.ino), (4, 4));
    assert_eq!(restored.open(node, libc::O_RDONLY), fh + 1);
    let late = restored
        .device
        .filesystem()
        .register_fd("late".into(), File::open(&directory.path).unwrap(), false)
        .unwrap();
    assert_eq!(late, 5);
    // The saved numbers still mean what they meant.
    assert_eq!(restored.lookup(root, b"file").nodeid, node);
    assert_eq!(restored.read(node, fh).unwrap(), b"body");
}

#[test]
fn snapshot_same_state_restores_into_independent_devices() {
    let directory = Directory::new();
    directory.file("file", b"");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let fh = guest.open(node, libc::O_RDWR);
    let snapshot = guest.save();
    let exports = || vec![directory.export("data", false)];
    let mut first = Guest::restore(&directory.tag, snapshot.clone(), exports()).unwrap();
    let mut second = Guest::restore(&directory.tag, snapshot, exports()).unwrap();
    // Each device reopened its own handles; the host file is the same one.
    assert_eq!(first.write(node, fh, 0, b"first"), 5);
    assert_eq!(second.read(node, fh).unwrap(), b"first");
    assert_eq!(second.write(node, fh, 5, b" second"), 7);
    assert_eq!(first.read(node, fh).unwrap(), b"first second");
    first.release(node, fh);
    assert!(first.read(node, fh).is_err());
    assert_eq!(second.read(node, fh).unwrap(), b"first second");
}

#[test]
fn snapshot_restore_reopens_created_and_truncated_files_as_they_are() {
    let directory = Directory::new();
    directory.file("truncated", b"lost on open");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let (created, created_fh) = guest.create(
        root,
        b"created",
        libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
    );
    guest.write(created, created_fh, 0, b"created once");
    let truncated = guest.lookup(root, b"truncated").nodeid;
    let truncated_fh = guest.open(truncated, libc::O_TRUNC | libc::O_RDWR);
    guest.write(truncated, truncated_fh, 0, b"kept");
    let created_id = host_id(&directory.path.join("created"));
    let snapshot = guest.save();
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    // Reopening neither recreates nor truncates: the file keeps its inode and its saved size.
    assert_eq!(host_id(&directory.path.join("created")), created_id);
    assert_eq!(restored.read(created, created_fh).unwrap(), b"created once");
    assert_eq!(restored.read(truncated, truncated_fh).unwrap(), b"kept");
    assert_eq!(
        fs::read(directory.path.join("created")).unwrap(),
        b"created once"
    );
    assert_eq!(fs::read(directory.path.join("truncated")).unwrap(), b"kept");
}

#[test]
fn snapshot_restored_directory_handles_list_their_entries() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let export = guest.opendir(root);
    let aggregate = guest.opendir(ROOT_ID);
    let snapshot = guest.save();
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    let (error, reply) = restored.readdir(root, export);
    assert_eq!(error, 0);
    assert!(lists(&reply, b"file"));
    // A directory handle on the aggregate root is rebuilt without a backend.
    let (error, reply) = restored.readdir(ROOT_ID, aggregate);
    assert_eq!(error, 0);
    assert!(lists(&reply, b"data"));
}

#[test]
fn snapshot_save_keeps_only_the_mounts_of_live_nodes() {
    let directory = Directory::new();
    let file = directory.file("shared", b"same");
    fs::create_dir(directory.path.join("left")).unwrap();
    fs::create_dir(directory.path.join("right")).unwrap();
    // One host file behind two mounts, as two bind mounts of one directory would show it.
    fs::hard_link(&file, directory.path.join("left/shared")).unwrap();
    fs::hard_link(&file, directory.path.join("right/shared")).unwrap();
    let root_path = directory.path.to_str().unwrap();
    let root_bytes = |suffix: &str| format!("{root_path}{suffix}").into_bytes();
    let _mounts = super::linux_tests::mount_ids(vec![
        (root_bytes(""), 1000),
        (root_bytes("/left"), 1001),
        (root_bytes("/right"), 1002),
    ]);
    let table = |mounts: &[(&str, u64)]| {
        mounts
            .iter()
            .map(|(suffix, id)| format!("{id} 1 0:1 / {root_path}{suffix} rw - ext4 /dev/x rw\n"))
            .collect::<String>()
            .into_bytes()
    };
    let _table =
        mounts::replace_mountinfo(Ok(table(&[("", 1000), ("/left", 1001), ("/right", 1002)])));
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let left = guest.lookup(root, b"left").nodeid;
    let left_file = guest.lookup(left, b"shared");
    let right = guest.lookup(root, b"right").nodeid;
    let right_file = guest.lookup(right, b"shared");
    // The guest forgets the left alias, and the host then unmounts its mount.
    guest.forget(left_file.nodeid, 1);
    guest.forget(left, 1);
    let _table = mounts::replace_mountinfo(Ok(table(&[("", 1000), ("/right", 1002)])));
    let saved = state::decode(&guest.save(), &directory.tag).unwrap();
    assert_eq!(
        saved.mounts,
        [
            MountState {
                export_root: root,
                mnt_id: 1000,
                path: Vec::new(),
            },
            MountState {
                export_root: root,
                mnt_id: 1002,
                path: vec![b"right".to_vec()],
            },
        ]
    );
    let (dev, ino) = host_id(&file);
    let shared: Vec<IdentityState> = saved
        .identities
        .iter()
        .filter(|identity| (identity.dev, identity.ino) == (dev, ino))
        .cloned()
        .collect();
    assert_eq!(
        shared,
        [IdentityState {
            export_root: root,
            dev,
            ino,
            mnt_id: 1002,
            identity: right_file.attr.ino,
        }]
    );
    assert!(
        saved
            .identities
            .iter()
            .all(|identity| identity.mnt_id != 1001)
    );
}

#[test]
fn snapshot_mount_point_missing_still_restores() {
    let directory = Directory::new();
    let subdir = directory.path.join("mount");
    fs::create_dir(&subdir).unwrap();
    let root_path = directory.path.to_str().unwrap();
    let _mounts = super::linux_tests::mount_ids(vec![
        (root_path.as_bytes().to_vec(), 1000),
        (format!("{root_path}/mount").into_bytes(), 1001),
    ]);
    let root_row = format!("1000 1 0:1 / {root_path} rw - ext4 /dev/x rw\n");
    let sub_row = format!("1001 1 0:1 / {root_path}/mount rw - ext4 /dev/x rw\n");
    let _table = mounts::replace_mountinfo(Ok(format!("{root_row}{sub_row}").into_bytes()));
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"mount").nodeid;
    let snapshot = guest.save();
    let before = state::decode(&snapshot, &directory.tag).unwrap();
    fs::remove_dir(subdir).unwrap();
    let _table = mounts::replace_mountinfo(Ok(root_row.into_bytes()));
    let mut restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(restored.getattr(root), 0);
    assert_eq!(restored.getattr(node), libc::ESTALE);
    let after = state::decode(&restored.save(), &directory.tag).unwrap();
    // The vanished mount and its identity row leave with the node's path.
    assert_eq!(after.mounts, [before.mounts[0].clone()]);
    assert!(after.identities.is_empty());
    let mut expected = before.nodes;
    let row = expected.iter_mut().find(|row| row.node == node).unwrap();
    row.location = NodeLocation::Invalid;
    row.handle = None;
    assert_eq!(after.nodes, expected);
}

#[test]
fn snapshot_restores_submount_identities_under_new_mount_ids() {
    let directory = Directory::new();
    let file = directory.file("shared", b"same");
    fs::create_dir(directory.path.join("left")).unwrap();
    fs::create_dir(directory.path.join("right")).unwrap();
    // One host file behind two mounts, as two bind mounts of one directory would show it.
    fs::hard_link(&file, directory.path.join("left/shared")).unwrap();
    fs::hard_link(&file, directory.path.join("right/shared")).unwrap();
    let root_path = directory.path.to_str().unwrap();
    let _table = mounts::replace_mountinfo(Ok(format!(
        "1000 1 0:1 / {root_path} rw - ext4 /dev/x rw\n1001 1 0:1 / {root_path}/left rw - ext4 /dev/x rw\n1002 1 0:1 / {root_path}/right rw - ext4 /dev/x rw\n"
    ).into_bytes()));
    let root_bytes = |suffix: &str| format!("{root_path}{suffix}").into_bytes();
    let _mounts = super::linux_tests::mount_ids(vec![
        (root_bytes(""), 1000),
        (root_bytes("/left"), 1001),
        (root_bytes("/right"), 1002),
    ]);
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let left = guest.lookup(root, b"left").nodeid;
    let left_file = guest.lookup(left, b"shared");
    let right = guest.lookup(root, b"right").nodeid;
    let right_file = guest.lookup(right, b"shared");
    assert_ne!(left_file.attr.ino, right_file.attr.ino);
    let saved = state::decode(&guest.save(), &directory.tag).unwrap();
    assert_eq!(
        saved.mounts,
        [
            MountState {
                export_root: root,
                mnt_id: 1000,
                path: Vec::new()
            },
            MountState {
                export_root: root,
                mnt_id: 1001,
                path: vec![b"left".to_vec()]
            },
            MountState {
                export_root: root,
                mnt_id: 1002,
                path: vec![b"right".to_vec()]
            },
        ]
    );
    let (dev, ino) = host_id(&file);
    let shared: Vec<IdentityState> = saved
        .identities
        .iter()
        .filter(|identity| (identity.dev, identity.ino) == (dev, ino))
        .cloned()
        .collect();
    assert_eq!(
        shared,
        [
            IdentityState {
                export_root: root,
                dev,
                ino,
                mnt_id: 1001,
                identity: left_file.attr.ino
            },
            IdentityState {
                export_root: root,
                dev,
                ino,
                mnt_id: 1002,
                identity: right_file.attr.ino
            },
        ]
    );
    // The restored process reports other mount IDs. Each path still answers
    // with the node and inode number it had before the snapshot.
    let _new_mounts = super::linux_tests::mount_ids(vec![
        (root_bytes(""), 2000),
        (root_bytes("/left"), 2001),
        (root_bytes("/right"), 2002),
    ]);
    let mut restored = Guest::restore(
        &directory.tag,
        state::encode(&saved).unwrap(),
        vec![directory.export("data", false)],
    )
    .unwrap();
    assert_eq!(restored.lookup(root, b"left").nodeid, left);
    let left_again = restored.lookup(left, b"shared");
    assert_eq!(
        (left_again.nodeid, left_again.attr.ino),
        (left_file.nodeid, left_file.attr.ino)
    );
    let right_again = restored.lookup(right, b"shared");
    assert_eq!(
        (right_again.nodeid, right_again.attr.ino),
        (right_file.nodeid, right_file.attr.ino)
    );
}

#[test]
fn snapshot_aggregate_paths_still_answer_after_a_round_trip() {
    let directory = Directory::new();
    directory.file("file", b"body");
    let mut guest = Guest::new(&directory.tag, vec![directory.share("data", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"data").nodeid;
    let node = guest.lookup(root, b"file").nodeid;
    let snapshot = guest.save();
    let restored = Guest::restore(
        &directory.tag,
        snapshot,
        vec![directory.export("data", false)],
    )
    .unwrap();
    // The FileSystem API the control plane does not use still sees the restored namespace.
    let fs = restored.device.filesystem();
    let entry = fs
        .lookup(
            Context {
                uid: 0,
                gid: 0,
                pid: 0,
            },
            root,
            &CString::new("file").unwrap(),
        )
        .unwrap();
    assert_eq!((entry.inode, entry.attr.st_ino), (node, 3));
    assert_eq!(fs.export_phase("data").unwrap(), ExportPhase::Mounted);
}
