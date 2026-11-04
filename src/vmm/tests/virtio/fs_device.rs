// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The device boundary: real split queues and real host files, without a VM.

use std::{
    fs,
    path::PathBuf,
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
        ActivationContext, DeviceError, DeviceEvent, EventError, EventRegistrar, EventSource,
        SourceId, VirtioDevice, VirtioInterrupt,
        fs::{Share, device::Fs, fuse::*},
        queue::{VIRTIO_F_EVENT_IDX, VirtQueues},
    },
};

const SIZE: u16 = 1024;
const DESC: [u64; 2] = [0x1000, 0xb000];
const AVAIL: [u64; 2] = [0x5000, 0xf000];
const USED: [u64; 2] = [0x6000, 0x10000];
const REQUEST: u64 = 0x20000;
const RESPONSE: u64 = 0x21000;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "boxlite-fs-device-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn share(&self, name: &str, read_only: bool) -> Share {
        Share {
            name: name.into(),
            path: self.0.clone(),
            read_only,
        }
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
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
}
struct Registrar;
impl EventRegistrar for Registrar {
    fn register(&self, _: DeviceEvent, _: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        panic!("synchronous fs must not register backend sources")
    }
    fn deregister(&self, _: SourceId) {
        panic!("no fs backend sources exist")
    }
}

struct Guest {
    device: Fs,
    memory: Arc<GuestMemoryMmap>,
    available: [u16; 2],
    used: [u16; 2],
    unique: u64,
    interrupt: Arc<Interrupt>,
}
impl Guest {
    fn new(shares: Vec<Share>) -> Self {
        let mut guest = Self {
            device: Fs::new("boxlite", shares).unwrap(),
            memory: Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x30000)]).unwrap()),
            available: [0; 2],
            used: [0; 2],
            unique: 0,
            interrupt: Arc::new(Interrupt::default()),
        };
        guest.activate();
        guest
    }
    fn activate(&mut self) {
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
                memory: Arc::clone(&self.memory),
                queues: VirtQueues::prepare(
                    queues,
                    &[SIZE, SIZE],
                    false,
                    false,
                    Arc::clone(&self.memory),
                )
                .unwrap(),
                interrupt: self.interrupt.clone(),
                events: Arc::new(Registrar),
                waker: Arc::new(|| {}),
                sender: EventLoop::new().unwrap().sender(),
            })
            .unwrap();
    }
    fn queue(&mut self, index: usize, head: u16, input: &[u8], output_size: u32) {
        self.memory
            .write_slice(input, GuestAddress(REQUEST))
            .unwrap();
        self.memory
            .write_obj(
                Descriptor::new(REQUEST, input.len() as u32, 1, head + 1),
                GuestAddress(DESC[index] + u64::from(head) * 16),
            )
            .unwrap();
        self.memory
            .write_obj(
                Descriptor::new(RESPONSE, output_size, 2, 0),
                GuestAddress(DESC[index] + u64::from(head + 1) * 16),
            )
            .unwrap();
        let slot = self.available[index] % SIZE;
        self.memory
            .write_obj(
                head.to_le(),
                GuestAddress(AVAIL[index] + 4 + u64::from(slot) * 2),
            )
            .unwrap();
        self.available[index] = self.available[index].wrapping_add(1);
        self.memory
            .write_obj(
                self.available[index].to_le(),
                GuestAddress(AVAIL[index] + 2),
            )
            .unwrap();
    }
    fn kick(&mut self, index: usize) {
        self.device
            .on_event(DeviceEvent::QueueKick(index as u16))
            .unwrap();
    }
    fn request(&mut self, opcode: Opcode, node: u64, body: &[u8]) -> Vec<u8> {
        self.unique += 1;
        self.raw_request(opcode, node, body, self.unique)
    }
    fn raw_request(&mut self, opcode: Opcode, node: u64, body: &[u8], unique: u64) -> Vec<u8> {
        let header = InHeader {
            len: (size_of::<InHeader>() + body.len()) as u32,
            opcode: opcode as u32,
            unique,
            nodeid: node,
            // Host-user execution is deliberate in PR1; wire credentials are not changed.
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            ..Default::default()
        };
        let mut input = header.as_slice().to_vec();
        input.extend_from_slice(body);
        self.queue(1, 0, &input, 8192);
        self.kick(1);
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
        if !response.is_empty() {
            let header = obj::<OutHeader>(&response);
            assert_eq!(header.unique, unique);
            assert_eq!(header.len, len);
        }
        response
    }
    fn init(&mut self) {
        let response = self.request(
            Opcode::Init,
            0,
            InitInCompat {
                major: 7,
                minor: 41,
                max_readahead: 4096,
                flags: 0,
            }
            .as_slice(),
        );
        assert_eq!(obj::<OutHeader>(&response).error, 0);
        assert_eq!(obj::<InitOut>(&response[size_of::<OutHeader>()..]).major, 7);
    }
    fn lookup(&mut self, parent: u64, name: &[u8]) -> u64 {
        let response = self.request(Opcode::Lookup, parent, name);
        assert_eq!(obj::<OutHeader>(&response).error, 0);
        obj::<EntryOut>(&response[size_of::<OutHeader>()..]).nodeid
    }
    fn open(&mut self, node: u64, flags: i32) -> u64 {
        let response = self.request(
            Opcode::Open,
            node,
            OpenIn {
                flags: flags as u32,
                ..Default::default()
            }
            .as_slice(),
        );
        assert_eq!(obj::<OutHeader>(&response).error, 0);
        obj::<OpenOut>(&response[size_of::<OutHeader>()..]).fh
    }
}
fn obj<T: ByteValued>(bytes: &[u8]) -> T {
    // SAFETY: ByteValued permits all bit patterns; length is checked before the unaligned copy.
    assert!(bytes.len() >= size_of::<T>());
    unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast()) }
}
fn payload<T: ByteValued>(fixed: T, tail: &[u8]) -> Vec<u8> {
    let mut bytes = fixed.as_slice().to_vec();
    bytes.extend_from_slice(tail);
    bytes
}

#[test]
fn fs_device_writes_syncs_and_reads_through_one_output_descriptor() {
    let directory = Directory::new();
    fs::write(directory.0.join("record"), b"host").unwrap();
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"shared\0");
    let node = guest.lookup(root, b"record\0");
    let fh = guest.open(node, libc::O_RDWR);
    let data = b"guest exit record";
    let response = guest.request(
        Opcode::Write,
        node,
        &payload(
            WriteIn {
                fh,
                offset: 0,
                size: data.len() as u32,
                ..Default::default()
            },
            data,
        ),
    );
    assert_eq!(obj::<OutHeader>(&response).error, 0);
    assert_eq!(obj::<WriteOut>(&response[16..]).size, data.len() as u32);
    let response = guest.request(
        Opcode::Fsync,
        node,
        FsyncIn {
            fh,
            ..Default::default()
        }
        .as_slice(),
    );
    assert_eq!(obj::<OutHeader>(&response).error, 0);
    assert_eq!(fs::read(directory.0.join("record")).unwrap(), data);
    let response = guest.request(
        Opcode::Read,
        node,
        ReadIn {
            fh,
            size: 4096,
            ..Default::default()
        }
        .as_slice(),
    );
    assert_eq!(obj::<OutHeader>(&response).error, 0);
    assert_eq!(&response[16..], data);
    assert_eq!(guest.interrupt.interrupt_status(), 1);
}

#[test]
fn fs_device_open_handle_survives_rename_and_unlink() {
    let directory = Directory::new();
    fs::write(directory.0.join("old"), b"still open").unwrap();
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"shared\0");
    let node = guest.lookup(root, b"old\0");
    let fh = guest.open(node, libc::O_RDWR);
    let renamed = guest.request(
        Opcode::Rename,
        root,
        &payload(RenameIn { newdir: root }, b"old\0new\0"),
    );
    assert_eq!(obj::<OutHeader>(&renamed).error, 0);
    assert!(!directory.0.join("old").exists());
    assert_eq!(fs::read(directory.0.join("new")).unwrap(), b"still open");
    let removed = guest.request(Opcode::Unlink, root, b"new\0");
    assert_eq!(obj::<OutHeader>(&removed).error, 0);
    assert!(!directory.0.join("new").exists());
    let response = guest.request(
        Opcode::Read,
        node,
        ReadIn {
            fh,
            size: 64,
            ..Default::default()
        }
        .as_slice(),
    );
    assert_eq!(obj::<OutHeader>(&response).error, 0);
    assert_eq!(&response[16..], b"still open");
}

#[test]
fn fs_device_duplicate_unique_requests_still_have_independent_completions() {
    let directory = Directory::new();
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"shared\0");
    let body = payload(
        MkdirIn {
            mode: 0o755,
            umask: 0,
        },
        b"once\0",
    );
    let first = guest.raw_request(Opcode::Mkdir, root, &body, 55);
    let second = guest.raw_request(Opcode::Mkdir, root, &body, 55);
    assert_eq!(obj::<OutHeader>(&first).error, 0);
    assert_eq!(obj::<OutHeader>(&second).error, -libc::EEXIST);
    assert!(directory.0.join("once").is_dir());
}

#[test]
fn fs_device_drains_full_priority_queue_without_replies_or_lost_completions() {
    let directory = Directory::new();
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let header = InHeader {
        len: (size_of::<InHeader>() + size_of::<ForgetIn>()) as u32,
        opcode: Opcode::Forget as u32,
        nodeid: 9999,
        unique: 88,
        ..Default::default()
    };
    let bytes = payload(header, ForgetIn { nlookup: 1 }.as_slice());
    guest
        .memory
        .write_slice(&bytes, GuestAddress(REQUEST))
        .unwrap();
    for index in 0..SIZE {
        guest
            .memory
            .write_obj(
                Descriptor::new(REQUEST, bytes.len() as u32, 0, 0),
                GuestAddress(DESC[0] + u64::from(index) * 16),
            )
            .unwrap();
        guest
            .memory
            .write_obj(
                index.to_le(),
                GuestAddress(AVAIL[0] + 4 + u64::from(index) * 2),
            )
            .unwrap();
    }
    guest
        .memory
        .write_obj(SIZE.to_le(), GuestAddress(AVAIL[0] + 2))
        .unwrap();
    guest.kick(0);
    assert_eq!(
        u16::from_le(guest.memory.read_obj(GuestAddress(USED[0] + 2)).unwrap()),
        SIZE
    );
    for index in 0..SIZE {
        let address = USED[0] + 4 + u64::from(index) * 8;
        assert_eq!(
            u32::from_le(guest.memory.read_obj(GuestAddress(address)).unwrap()),
            u32::from(index)
        );
        assert_eq!(
            u32::from_le(guest.memory.read_obj(GuestAddress(address + 4)).unwrap()),
            0
        );
    }
    guest.kick(0);
    assert_eq!(
        u16::from_le(guest.memory.read_obj(GuestAddress(USED[0] + 2)).unwrap()),
        SIZE
    );
}

#[test]
fn fs_device_reset_releases_old_session_and_rejects_stale_ids() {
    let directory = Directory::new();
    fs::write(directory.0.join("file"), b"preserved").unwrap();
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"shared\0");
    let node = guest.lookup(root, b"file\0");
    let fh = guest.open(node, libc::O_RDWR);
    let old_memory = Arc::downgrade(&guest.memory);
    guest.device.reset().unwrap();
    assert!(matches!(
        guest.device.on_event(DeviceEvent::QueueKick(1)),
        Err(DeviceError::NeedsReset(_))
    ));
    guest.memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x30000)]).unwrap());
    assert!(old_memory.upgrade().is_none());
    guest.available = [0; 2];
    guest.used = [0; 2];
    guest.activate();
    guest.init();
    let root2 = guest.lookup(ROOT_ID, b"shared\0");
    let node2 = guest.lookup(root2, b"file\0");
    assert_ne!(node2, node);
    let stale = guest.request(
        Opcode::Read,
        node,
        ReadIn {
            fh,
            size: 32,
            ..Default::default()
        }
        .as_slice(),
    );
    assert_ne!(obj::<OutHeader>(&stale).error, 0);
    let fresh = guest.open(node2, libc::O_RDONLY);
    let stale_handle = guest.request(
        Opcode::Read,
        node2,
        ReadIn {
            fh,
            size: 32,
            ..Default::default()
        }
        .as_slice(),
    );
    assert_ne!(obj::<OutHeader>(&stale_handle).error, 0);
    let response = guest.request(
        Opcode::Read,
        node2,
        ReadIn {
            fh: fresh,
            size: 32,
            ..Default::default()
        }
        .as_slice(),
    );
    assert_eq!(&response[16..], b"preserved");
}

#[test]
fn fs_device_rejects_unsupported_features_and_invalid_tags() {
    assert!(Fs::new("", vec![]).is_err());
    assert!(Fs::new(&"x".repeat(37), vec![]).is_err());
    assert!(Fs::new("a\0b", vec![]).is_err());
    let directory = Directory::new();
    let mut device = Fs::new("valid", vec![directory.share("shared", false)]).unwrap();
    assert!(device.set_features(1 << 28).is_err());
    device.set_features(VIRTIO_F_EVENT_IDX).unwrap();
    let mut config = [0; 40];
    device.read_config(0, &mut config).unwrap();
    assert_eq!(&config[..5], b"valid");
    assert_eq!(&config[36..], &1u32.to_le_bytes());
    assert!(device.read_config(u64::MAX, &mut [0]).is_err());
}

#[test]
fn fs_device_rejects_readable_descriptors_after_writable_before_host_mutation() {
    let directory = Directory::new();
    fs::write(directory.0.join("file"), b"must not truncate").unwrap();
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"shared\0");
    let node = guest.lookup(root, b"file\0");
    let header = InHeader {
        len: (size_of::<InHeader>() + size_of::<OpenIn>()) as u32,
        opcode: Opcode::Open as u32,
        nodeid: node,
        unique: 99,
        ..Default::default()
    };
    let body = OpenIn {
        flags: (libc::O_WRONLY | libc::O_TRUNC) as u32,
        ..Default::default()
    };
    guest.queue(1, 0, &payload(header, body.as_slice()), 8192);
    guest
        .memory
        .write_obj(
            Descriptor::new(REQUEST, size_of::<InHeader>() as u32, 1, 1),
            GuestAddress(DESC[1]),
        )
        .unwrap();
    guest
        .memory
        .write_obj(
            Descriptor::new(RESPONSE, 8192, 3, 2),
            GuestAddress(DESC[1] + 16),
        )
        .unwrap();
    guest
        .memory
        .write_obj(
            Descriptor::new(
                REQUEST + size_of::<InHeader>() as u64,
                size_of::<OpenIn>() as u32,
                0,
                0,
            ),
            GuestAddress(DESC[1] + 32),
        )
        .unwrap();
    let result = guest.device.on_event(DeviceEvent::QueueKick(1));
    assert_eq!(
        fs::read(directory.0.join("file")).unwrap(),
        b"must not truncate"
    );
    assert!(matches!(result, Err(DeviceError::NeedsReset(_))));
}

#[test]
fn fs_device_oversized_batch_forget_is_reply_free_without_device_reset() {
    let directory = Directory::new();
    for capacity in [0, 8192] {
        let mut guest = Guest::new(vec![directory.share("shared", false)]);
        guest.init();
        let body = BatchForgetIn {
            count: 65537,
            ..Default::default()
        };
        let header = InHeader {
            len: (size_of::<InHeader>() + size_of::<BatchForgetIn>()) as u32,
            opcode: Opcode::BatchForget as u32,
            unique: 100,
            ..Default::default()
        };
        guest.queue(0, 0, &payload(header, body.as_slice()), capacity);
        guest.device.on_event(DeviceEvent::QueueKick(0)).unwrap();
        assert_eq!(
            u16::from_le(guest.memory.read_obj(GuestAddress(USED[0] + 2)).unwrap()),
            1
        );
        assert_eq!(
            u32::from_le(guest.memory.read_obj(GuestAddress(USED[0] + 8)).unwrap()),
            0
        );
    }
}

#[test]
fn fs_device_paginates_large_directory_without_lost_or_duplicate_names() {
    let directory = Directory::new();
    let expected: std::collections::BTreeSet<_> =
        (0..300).map(|index| format!("entry-{index:03}")).collect();
    for name in &expected {
        fs::write(directory.0.join(name), name).unwrap();
    }
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"shared\0");
    for opcode in [Opcode::Readdir, Opcode::Readdirplus] {
        let response = guest.request(Opcode::Opendir, root, OpenIn::default().as_slice());
        assert_eq!(obj::<OutHeader>(&response).error, 0);
        let fh = obj::<OpenOut>(&response[16..]).fh;
        let mut offset = 0;
        let mut observed = std::collections::BTreeSet::new();
        let mut ended = false;
        for _ in 0..1000 {
            let response = guest.request(
                opcode,
                root,
                ReadIn {
                    fh,
                    offset,
                    size: 224,
                    ..Default::default()
                }
                .as_slice(),
            );
            assert_eq!(obj::<OutHeader>(&response).error, 0);
            assert!(response.len() <= 16 + 224);
            if response.len() == 16 {
                ended = true;
                break;
            }
            let mut remaining = &response[16..];
            while !remaining.is_empty() {
                let prefix = if matches!(opcode, Opcode::Readdirplus) {
                    size_of::<EntryOut>()
                } else {
                    0
                };
                let dirent = obj::<Dirent>(&remaining[prefix..]);
                let start = prefix + size_of::<Dirent>();
                let end = start + dirent.namelen as usize;
                assert!(end <= remaining.len());
                let name = std::str::from_utf8(&remaining[start..end]).unwrap();
                if name != "." && name != ".." {
                    assert!(observed.insert(name.to_string()), "duplicate {name}");
                }
                assert_ne!(offset, dirent.off);
                offset = dirent.off;
                let encoded = (end + 7) & !7;
                assert!(encoded <= remaining.len());
                remaining = &remaining[encoded..];
            }
        }
        assert!(ended, "directory pagination did not terminate");
        assert_eq!(observed, expected);
        let response = guest.request(
            Opcode::Releasedir,
            root,
            ReleaseIn {
                fh,
                ..Default::default()
            }
            .as_slice(),
        );
        assert_eq!(obj::<OutHeader>(&response).error, 0);
    }
}

#[test]
fn fs_device_open_and_create_disable_regular_file_caching() {
    let directory = Directory::new();
    fs::write(directory.0.join("existing"), b"host data").unwrap();
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"shared\0");
    let node = guest.lookup(root, b"existing\0");
    let response = guest.request(Opcode::Open, node, OpenIn::default().as_slice());
    assert_eq!(obj::<OutHeader>(&response).error, 0);
    let opened = obj::<OpenOut>(&response[16..]);
    assert_eq!(opened.open_flags, OpenOptions::DIRECT_IO.bits());
    let response = guest.request(
        Opcode::Create,
        root,
        &payload(
            CreateIn {
                flags: libc::O_RDWR as u32,
                mode: 0o600,
                ..Default::default()
            },
            b"created\0",
        ),
    );
    assert_eq!(obj::<OutHeader>(&response).error, 0);
    let entry = obj::<EntryOut>(&response[16..]);
    let created = obj::<OpenOut>(&response[16 + size_of::<EntryOut>()..]);
    assert_eq!(created.open_flags, OpenOptions::DIRECT_IO.bits());
    assert_eq!((entry.entry_valid, entry.attr_valid), (0, 0));
    assert!(directory.0.join("created").is_file());
    let response = guest.request(Opcode::Opendir, root, OpenIn::default().as_slice());
    assert_eq!(obj::<OutHeader>(&response).error, 0);
    assert_eq!(obj::<OpenOut>(&response[16..]).open_flags, 0);
}

#[test]
fn fs_device_rejects_each_missing_queue_without_partial_activation() {
    let directory = Directory::new();
    fs::write(directory.0.join("sentinel"), b"activation restored").unwrap();
    for missing in 0..2 {
        let mut guest = Guest::new(vec![directory.share("shared", false)]);
        guest.device.reset().unwrap();
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
                queue.set_ready(index != missing);
                queue
            })
            .collect();
        let context = ActivationContext {
            memory: guest.memory.clone(),
            queues: VirtQueues::prepare(queues, &[SIZE, SIZE], false, false, guest.memory.clone())
                .unwrap(),
            interrupt: guest.interrupt.clone(),
            events: Arc::new(Registrar),
            waker: Arc::new(|| {}),
            sender: EventLoop::new().unwrap().sender(),
        };
        assert!(matches!(
            guest.device.activate(context),
            Err(DeviceError::NeedsReset(_))
        ));
        guest.activate();
        guest.init();
        let root = guest.lookup(ROOT_ID, b"shared\0");
        let inode = guest.lookup(root, b"sentinel\0");
        let fh = guest.open(inode, libc::O_RDONLY);
        let reply = guest.request(
            Opcode::Read,
            inode,
            ReadIn {
                fh,
                size: 64,
                ..Default::default()
            }
            .as_slice(),
        );
        assert_eq!(&reply[16..], b"activation restored");
    }
}

#[test]
fn fs_device_missing_reply_capacity_never_truncates_host_file() {
    let directory = Directory::new();
    fs::write(directory.0.join("file"), b"retained").unwrap();
    let mut guest = Guest::new(vec![directory.share("shared", false)]);
    guest.init();
    let root = guest.lookup(ROOT_ID, b"shared\0");
    let inode = guest.lookup(root, b"file\0");
    let header = InHeader {
        len: (size_of::<InHeader>() + size_of::<OpenIn>()) as u32,
        opcode: Opcode::Open as u32,
        nodeid: inode,
        ..Default::default()
    };
    let input = payload(
        header,
        OpenIn {
            flags: (libc::O_WRONLY | libc::O_TRUNC) as u32,
            ..Default::default()
        }
        .as_slice(),
    );
    let completed = guest.used[1];
    guest.queue(1, 0, &input, 0);
    assert!(matches!(
        guest.device.on_event(DeviceEvent::QueueKick(1)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert_eq!(fs::read(directory.0.join("file")).unwrap(), b"retained");
    let used: u16 = guest.memory.read_obj(GuestAddress(USED[1] + 2)).unwrap();
    assert_eq!(u16::from_le(used), completed);
}
