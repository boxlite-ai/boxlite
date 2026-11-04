// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! FUSE parser and volatile descriptor boundaries, without a VM or /dev/kvm.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::mem::size_of;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use virtio_queue::{DescriptorChain, Queue, QueueOwnedT, QueueT, desc::split::Descriptor};
use vm_memory::{ByteValued, Bytes, GuestAddress, GuestMemoryMmap};

use crate::virtio::fs::{
    aggregate::{AggregateFs, Share},
    descriptor::request_buffers,
    filesystem::FileSystem,
    fuse::*,
    server::{FsError, Server},
};

const INPUT: u64 = 0x4000;
const OUTPUT: u64 = 0x8000;

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "boxlite-fs-protocol-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self) -> File {
        OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(self.0.join("file"))
            .unwrap()
    }
    fn server(&self) -> Server<AggregateFs> {
        Server::new(
            AggregateFs::new(vec![Share {
                name: "shared".into(),
                path: self.0.clone(),
                read_only: false,
            }])
            .unwrap(),
        )
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn memory() -> GuestMemoryMmap {
    GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x20000)]).unwrap()
}

fn chain<'a>(
    memory: &'a GuestMemoryMmap,
    readable: usize,
    writable: &[usize],
) -> DescriptorChain<&'a GuestMemoryMmap> {
    let mut queue = Queue::new(16).unwrap();
    queue.try_set_size(16).unwrap();
    queue
        .try_set_desc_table_address(GuestAddress(0x1000))
        .unwrap();
    queue
        .try_set_avail_ring_address(GuestAddress(0x2000))
        .unwrap();
    queue
        .try_set_used_ring_address(GuestAddress(0x3000))
        .unwrap();
    queue.set_ready(true);
    memory
        .write_obj(
            Descriptor::new(
                INPUT,
                readable as u32,
                if writable.is_empty() { 0 } else { 1 },
                1,
            ),
            GuestAddress(0x1000),
        )
        .unwrap();
    let mut offset = 0;
    for (index, length) in writable.iter().enumerate() {
        let flags = 2 | if index + 1 < writable.len() { 1 } else { 0 };
        memory
            .write_obj(
                Descriptor::new(OUTPUT + offset, *length as u32, flags, index as u16 + 2),
                GuestAddress(0x1010 + index as u64 * 16),
            )
            .unwrap();
        offset += *length as u64;
    }
    memory.write_obj(0u16, GuestAddress(0x2004)).unwrap();
    memory.write_obj(1u16, GuestAddress(0x2002)).unwrap();
    queue.iter(memory).unwrap().next().unwrap()
}

fn request(opcode: u32, nodeid: u64, body: &[u8]) -> Vec<u8> {
    let mut bytes = InHeader {
        len: (size_of::<InHeader>() + body.len()) as u32,
        opcode,
        unique: 42,
        nodeid,
        ..Default::default()
    }
    .as_slice()
    .to_vec();
    bytes.extend_from_slice(body);
    bytes
}

fn execute<F: FileSystem + Sync>(
    server: &Server<F>,
    request: &[u8],
    writable: &[usize],
) -> (Result<usize, FsError>, Vec<u8>) {
    let memory = memory();
    memory.write_slice(request, GuestAddress(INPUT)).unwrap();
    let capacity: usize = writable.iter().sum();
    memory
        .write_slice(&vec![0xa5; capacity], GuestAddress(OUTPUT))
        .unwrap();
    let chain = chain(&memory, request.len(), writable);
    let (reader, writer) = request_buffers(&memory, chain).unwrap();
    let result = server.handle_message(reader, writer);
    let mut output = vec![0; capacity];
    memory
        .read_slice(&mut output, GuestAddress(OUTPUT))
        .unwrap();
    (result, output)
}

fn object<T: ByteValued>(bytes: &[u8], offset: usize) -> T {
    assert!(bytes.len() >= offset + size_of::<T>());
    // SAFETY: the bounds check covers T, and ByteValued allows all bit patterns.
    unsafe { std::ptr::read_unaligned(bytes[offset..].as_ptr().cast::<T>()) }
}
fn header(bytes: &[u8]) -> OutHeader {
    object(bytes, 0)
}
fn init<F: FileSystem + Sync>(server: &Server<F>) -> InitOut {
    let body = InitInCompat {
        major: KERNEL_VERSION,
        minor: KERNEL_MINOR_VERSION,
        max_readahead: 4096,
        flags: !(1 << 30),
    };
    let (result, bytes) = execute(
        server,
        &request(Opcode::Init as u32, 0, body.as_slice()),
        &[256],
    );
    assert_eq!(
        result.unwrap(),
        size_of::<OutHeader>() + size_of::<InitOut>()
    );
    assert_eq!(header(&bytes).error, 0);
    object(&bytes, size_of::<OutHeader>())
}
fn lookup(server: &Server<AggregateFs>, parent: u64, name: &[u8]) -> EntryOut {
    let (result, bytes) = execute(
        server,
        &request(Opcode::Lookup as u32, parent, name),
        &[256],
    );
    assert!(result.is_ok());
    assert_eq!(header(&bytes).error, 0);
    object(&bytes, size_of::<OutHeader>())
}

#[test]
fn malformed_declared_lengths_and_fixed_bodies_never_open_or_truncate() {
    let dir = TempDir::new();
    let file = dir.file();
    file.write_all_at(b"unchanged", 0).unwrap();
    let server = dir.server();
    init(&server);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let inode = lookup(&server, root, b"file\0").nodeid;
    let open = OpenIn {
        flags: (libc::O_WRONLY | libc::O_TRUNC) as u32,
        ..Default::default()
    };
    let valid = request(Opcode::Open as u32, inode, open.as_slice());
    for declared in [
        0,
        size_of::<InHeader>() - 1,
        size_of::<InHeader>(),
        valid.len() - 1,
        valid.len() + 1,
        (1 << 20) + 0x1001,
    ] {
        let mut malformed = valid.clone();
        malformed[..4].copy_from_slice(&(declared as u32).to_ne_bytes());
        let (result, bytes) = execute(&server, &malformed, &[256]);
        assert_eq!(result.unwrap(), size_of::<OutHeader>());
        assert_eq!(header(&bytes).error, -libc::EINVAL);
        assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"unchanged");
    }
    let mut extra = open.as_slice().to_vec();
    extra.push(0);
    let (_, bytes) = execute(
        &server,
        &request(Opcode::Open as u32, inode, &extra),
        &[256],
    );
    assert_eq!(header(&bytes).error, -libc::EINVAL);
    assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"unchanged");
}

#[test]
fn write_exact_size_and_short_output_are_checked_before_mutation() {
    let dir = TempDir::new();
    let file = dir.file();
    file.write_all_at(b"safe", 0).unwrap();
    let server = dir.server();
    init(&server);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let inode = lookup(&server, root, b"file\0").nodeid;
    let (_, opened) = execute(
        &server,
        &request(
            Opcode::Open as u32,
            inode,
            OpenIn {
                flags: libc::O_RDWR as u32,
                ..Default::default()
            }
            .as_slice(),
        ),
        &[256],
    );
    let fh = object::<OpenOut>(&opened, size_of::<OutHeader>()).fh;
    for actual in [0, 1, 3] {
        let mut body = WriteIn {
            fh,
            size: 2,
            ..Default::default()
        }
        .as_slice()
        .to_vec();
        body.extend(std::iter::repeat_n(b'X', actual));
        let (_, reply) = execute(
            &server,
            &request(Opcode::Write as u32, inode, &body),
            &[256],
        );
        assert_eq!(header(&reply).error, -libc::EINVAL);
        assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"safe");
    }
    let mut body = WriteIn {
        fh,
        size: 2,
        ..Default::default()
    }
    .as_slice()
    .to_vec();
    body.extend_from_slice(b"XX");
    let frame = request(Opcode::Write as u32, inode, &body);
    for capacity in 0..size_of::<OutHeader>() {
        assert!(matches!(
            execute(&server, &frame, &[capacity]).0,
            Err(FsError::EncodeMessage(_))
        ));
    }
    let (_, reply) = execute(&server, &frame, &[size_of::<OutHeader>()]);
    assert_eq!(header(&reply).error, -libc::ENOMEM);
    assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"safe");
}

#[test]
fn init_negotiates_only_implemented_flags_rejects_reinit_and_resets() {
    let dir = TempDir::new();
    let server = dir.server();
    let future = InitInCompat {
        major: KERNEL_VERSION + 1,
        minor: 0,
        ..Default::default()
    };
    let (_, reply) = execute(
        &server,
        &request(Opcode::Init as u32, 0, future.as_slice()),
        &[256],
    );
    assert_eq!(header(&reply).error, 0);
    assert_eq!(object::<InitOut>(&reply, 16).major, KERNEL_VERSION);
    let out = init(&server);
    let forbidden =
        (1u64 << 0) | (1 << 15) | (1 << 18) | (1 << 11) | (1 << 32) | (1 << 30) | (1 << 40);
    assert_eq!(out.flags as u64 & forbidden, 0);
    assert_eq!(out.flags2, 0);
    let (_, reply) = execute(
        &server,
        &request(Opcode::Init as u32, 0, future.as_slice()),
        &[256],
    );
    assert_eq!(header(&reply).error, -libc::EPROTO);
    server.reset();
    let (_, reply) = execute(
        &server,
        &request(Opcode::Lookup as u32, ROOT_ID, b"shared\0"),
        &[256],
    );
    assert_eq!(header(&reply).error, -libc::EPROTO);
    init(&server);
    lookup(&server, ROOT_ID, b"shared\0");
}

#[test]
fn extended_init_is_bounded_and_unnegotiated_creation_extensions_fail() {
    let dir = TempDir::new();
    let server = dir.server();
    let base = InitInCompat {
        major: KERNEL_VERSION,
        minor: KERNEL_MINOR_VERSION,
        flags: 1 << 30,
        ..Default::default()
    };
    for size in [0, 1, size_of::<InitInExt>() - 1] {
        let mut body = base.as_slice().to_vec();
        body.resize(body.len() + size, 0);
        let (_, reply) = execute(&server, &request(Opcode::Init as u32, 0, &body), &[256]);
        assert_eq!(header(&reply).error, -libc::EINVAL);
    }
    let mut body = base.as_slice().to_vec();
    body.extend_from_slice(
        InitInExt {
            flags2: u32::MAX,
            ..Default::default()
        }
        .as_slice(),
    );
    let (_, reply) = execute(&server, &request(Opcode::Init as u32, 0, &body), &[256]);
    assert_eq!(header(&reply).error, 0);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    for (size, kind) in [(u32::MAX, 0u32), (8, 32)] {
        let mut body = MkdirIn {
            mode: 0o755,
            umask: 0,
        }
        .as_slice()
        .to_vec();
        body.extend_from_slice(b"no-directory\0");
        body.extend_from_slice(&size.to_ne_bytes());
        body.extend_from_slice(&kind.to_ne_bytes());
        let (_, reply) = execute(&server, &request(Opcode::Mkdir as u32, root, &body), &[256]);
        assert_eq!(header(&reply).error, -libc::EINVAL);
        assert!(!dir.0.join("no-directory").exists());
    }
}

#[test]
fn real_backend_read_and_write_use_disjoint_split_response() {
    let dir = TempDir::new();
    let file = dir.file();
    file.write_all_at(b"abcdefgh", 0).unwrap();
    let server = dir.server();
    init(&server);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let inode = lookup(&server, root, b"file\0").nodeid;
    let (_, opened) = execute(
        &server,
        &request(
            Opcode::Open as u32,
            inode,
            OpenIn {
                flags: libc::O_RDWR as u32,
                ..Default::default()
            }
            .as_slice(),
        ),
        &[256],
    );
    let fh = object::<OpenOut>(&opened, 16).fh;
    let read = request(
        Opcode::Read as u32,
        inode,
        ReadIn {
            fh,
            size: 3,
            offset: 2,
            ..Default::default()
        }
        .as_slice(),
    );
    for output in [&[64][..], &[5, 7, 52][..], &[16, 48][..]] {
        let (result, reply) = execute(&server, &read, output);
        assert_eq!(result.unwrap(), 19);
        assert_eq!(header(&reply).len, 19);
        assert_eq!(header(&reply).error, 0);
        assert_eq!(&reply[16..19], b"cde");
        assert!(reply[19..].iter().all(|byte| *byte == 0xa5));
    }
    let mut write = WriteIn {
        fh,
        size: 1,
        offset: 4,
        ..Default::default()
    }
    .as_slice()
    .to_vec();
    write.push(b'Z');
    let (_, reply) = execute(
        &server,
        &request(Opcode::Write as u32, inode, &write),
        &[5, 59],
    );
    assert_eq!(header(&reply).error, 0);
    assert_eq!(object::<WriteOut>(&reply, 16).size, 1);
    assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"abcdZfgh");
}

#[test]
fn positioned_transfers_clamp_count_and_capacity_and_preserve_split_prefix() {
    let dir = TempDir::new();
    let file = dir.file();
    file.write_all_at(b"0123456789", 0).unwrap();
    let memory = memory();
    memory
        .write_slice(b"abcdefgh", GuestAddress(INPUT))
        .unwrap();
    memory
        .write_slice(&[0xa5; 32], GuestAddress(OUTPUT))
        .unwrap();
    let chain = chain(&memory, 8, &[32]);
    let (mut reader, mut writer) = request_buffers(&memory, chain).unwrap();
    assert_eq!(reader.read_to_at(&file, 1, 3).unwrap(), 1);
    assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"012a456789");
    assert_eq!(reader.available_bytes(), 7);
    assert!(writer.split_at(33).is_err());
    let mut data = writer.split_at(16).unwrap();
    assert_eq!(data.write_from_at(&file, 2, 4).unwrap(), 2);
    writer.write_all(&[0x11; 16]).unwrap();
    let mut result = [0; 32];
    memory
        .read_slice(&mut result, GuestAddress(OUTPUT))
        .unwrap();
    assert_eq!(&result[..16], &[0x11; 16]);
    assert_eq!(&result[16..18], b"45");
    assert_eq!(&result[18..], &[0xa5; 14]);
    assert!(data.write_from_at(&file, 1, u64::MAX).is_err());
    file.write_all_at(b"01234567890123456789", 0).unwrap();
    assert_eq!(data.write_from_at(&file, usize::MAX, 0).unwrap(), 14);
    let mut rest = [0; 7];
    reader.read_exact(&mut rest).unwrap();
    assert_eq!(&rest, b"bcdefgh");
}

#[test]
fn forget_and_destroy_have_zero_used_length_and_destroy_requires_new_init() {
    let dir = TempDir::new();
    let server = dir.server();
    init(&server);
    assert_eq!(
        execute(
            &server,
            &request(
                Opcode::Forget as u32,
                ROOT_ID,
                ForgetIn { nlookup: u64::MAX }.as_slice()
            ),
            &[]
        )
        .0
        .unwrap(),
        0
    );
    assert_eq!(
        execute(&server, &request(Opcode::Destroy as u32, 0, &[]), &[])
            .0
            .unwrap(),
        0
    );
    let (_, reply) = execute(
        &server,
        &request(Opcode::Lookup as u32, ROOT_ID, b"shared\0"),
        &[256],
    );
    assert_eq!(header(&reply).error, -libc::EPROTO);
    init(&server);
    lookup(&server, ROOT_ID, b"shared\0");
}

#[test]
fn request_views_retain_metadata_before_server_mutation() {
    let dir = TempDir::new();
    let server = dir.server();
    init(&server);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let mut body = MkdirIn {
        mode: 0o755,
        umask: 0,
    }
    .as_slice()
    .to_vec();
    body.extend_from_slice(b"original\0");
    let frame = request(Opcode::Mkdir as u32, root, &body);
    let memory = memory();
    memory.write_slice(&frame, GuestAddress(INPUT)).unwrap();
    memory
        .write_slice(&[0xa5; 256], GuestAddress(OUTPUT))
        .unwrap();
    memory
        .write_slice(&[0xa5; 256], GuestAddress(0xa000))
        .unwrap();
    let chain = chain(&memory, frame.len(), &[256]);
    let (reader, writer) = request_buffers(&memory, chain).unwrap();

    // Change both metadata entries after construction, before any server use.
    // The already validated frame and reply destination must remain authoritative.
    memory
        .write_obj(Descriptor::new(0x1ffff, 256, 2, 0), GuestAddress(0x1000))
        .unwrap();
    memory
        .write_obj(Descriptor::new(0xa000, 256, 2, 0), GuestAddress(0x1010))
        .unwrap();
    assert_eq!(
        server.handle_message(reader, writer).unwrap(),
        size_of::<OutHeader>() + size_of::<EntryOut>()
    );
    assert!(dir.0.join("original").is_dir());
    let reply: OutHeader = memory.read_obj(GuestAddress(OUTPUT)).unwrap();
    assert_eq!(reply.error, 0);
    assert_eq!(reply.unique, 42);
    let mut redirected = [0; 256];
    memory
        .read_slice(&mut redirected, GuestAddress(0xa000))
        .unwrap();
    assert_eq!(redirected, [0xa5; 256]);
}

#[test]
fn invalid_descriptor_suffixes_never_execute_truncating_open() {
    let dir = TempDir::new();
    let file = dir.file();
    file.write_all_at(b"unchanged", 0).unwrap();
    let server = dir.server();
    init(&server);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let inode = lookup(&server, root, b"file\0").nodeid;
    let frame = request(
        Opcode::Open as u32,
        inode,
        OpenIn {
            flags: (libc::O_WRONLY | libc::O_TRUNC) as u32,
            ..Default::default()
        }
        .as_slice(),
    );
    for suffix in [
        Descriptor::new(0x1ffff, 64, 2, 0), // Reply extends beyond guest RAM.
        Descriptor::new(OUTPUT + 64, 1, 0, 0), // Readable after writable.
        Descriptor::new(OUTPUT + 64, 1, 3, 16), // NEXT outside queue.
        Descriptor::new(OUTPUT + 64, 1, 3, 2), // Self cycle.
    ] {
        let memory = memory();
        memory.write_slice(&frame, GuestAddress(INPUT)).unwrap();
        let chain = chain(&memory, frame.len(), &[64, 64]);
        memory.write_obj(suffix, GuestAddress(0x1020)).unwrap();
        match request_buffers(&memory, chain) {
            Ok((reader, writer)) => {
                // On the candidate implementation, the unterminated prefix
                // reaches the real OPEN and truncates the file.
                let _ = server.handle_message(reader, writer);
                panic!(
                    "invalid suffix executed; host bytes: {:?}",
                    fs::read(dir.0.join("file")).unwrap()
                );
            }
            Err(_) => assert_eq!(fs::read(dir.0.join("file")).unwrap(), b"unchanged"),
        }
    }
}

#[test]
fn fuse_header_crosses_readable_descriptors_and_reply_crosses_writable_descriptors() {
    let dir = TempDir::new();
    let server = dir.server();
    init(&server);
    let frame = request(Opcode::Lookup as u32, ROOT_ID, b"shared\0");
    let memory = memory();
    memory.write_slice(&frame, GuestAddress(INPUT)).unwrap();
    let chain = chain(&memory, frame.len(), &[7, 249]);
    for (index, descriptor) in [
        Descriptor::new(INPUT, 17, 1, 1),
        Descriptor::new(INPUT + 17, (frame.len() - 17) as u32, 1, 2),
        Descriptor::new(OUTPUT, 7, 3, 3),
        Descriptor::new(OUTPUT + 7, 249, 2, 0),
    ]
    .into_iter()
    .enumerate()
    {
        memory
            .write_obj(descriptor, GuestAddress(0x1000 + index as u64 * 16))
            .unwrap();
    }
    let (reader, writer) = request_buffers(&memory, chain).unwrap();
    assert_eq!(
        server.handle_message(reader, writer).unwrap(),
        16 + size_of::<EntryOut>()
    );
    let reply: OutHeader = memory.read_obj(GuestAddress(OUTPUT)).unwrap();
    assert_eq!(reply.error, 0);
    let entry: EntryOut = memory.read_obj(GuestAddress(OUTPUT + 16)).unwrap();
    assert_ne!(entry.nodeid, ROOT_ID);
}

#[test]
fn positioned_read_returns_partial_eof_across_guest_slices() {
    let dir = TempDir::new();
    let file = dir.file();
    file.write_all_at(b"abc", 0).unwrap();
    let memory = memory();
    memory
        .write_slice(&[0xa5; 4], GuestAddress(OUTPUT))
        .unwrap();
    let chain = chain(&memory, 0, &[2, 2]);
    let (_, mut writer) = request_buffers(&memory, chain).unwrap();
    assert_eq!(writer.write_from_at(&file, 4, 0).unwrap(), 3);
    assert_eq!(writer.bytes_written(), 3);
    assert_eq!(writer.available_bytes(), 1);
    assert_eq!(writer.write_from_at(&file, 1, 3).unwrap(), 0);
    let mut output = [0; 4];
    memory
        .read_slice(&mut output, GuestAddress(OUTPUT))
        .unwrap();
    assert_eq!(&output, b"abc\xa5");
}

#[test]
fn malformed_batch_forget_and_destroy_neither_reply_nor_mutate_session() {
    let dir = TempDir::new();
    let file = dir.file();
    file.write_all_at(b"retained", 0).unwrap();
    let server = dir.server();
    init(&server);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let inode = lookup(&server, root, b"file\0").nodeid;
    let mut body = BatchForgetIn {
        count: 2,
        ..Default::default()
    }
    .as_slice()
    .to_vec();
    body.extend_from_slice(
        ForgetOne {
            nodeid: inode,
            nlookup: u64::MAX,
        }
        .as_slice(),
    );
    for (opcode, body) in [
        (Opcode::BatchForget as u32, body),
        (Opcode::Destroy as u32, vec![0]),
    ] {
        let (result, reply) = execute(&server, &request(opcode, 0, &body), &[32]);
        assert_eq!(result.unwrap(), 0);
        assert_eq!(reply, [0xa5; 32]);
        let (_, reply) = execute(
            &server,
            &request(
                Opcode::Getattr as u32,
                inode,
                GetattrIn::default().as_slice(),
            ),
            &[256],
        );
        assert_eq!(header(&reply).error, 0);
        assert_eq!(object::<AttrOut>(&reply, 16).attr.size, 8);
    }
    let body = BatchForgetIn::default();
    assert_eq!(
        execute(
            &server,
            &request(Opcode::BatchForget as u32, 0, body.as_slice()),
            &[]
        )
        .0
        .unwrap(),
        0
    );
}

#[test]
fn init_version_floor_and_adaptive_readdirplus_dependency_are_explicit() {
    for (major, minor) in [
        (KERNEL_VERSION - 1, KERNEL_MINOR_VERSION),
        (KERNEL_VERSION, KERNEL_MINOR_VERSION - 1),
    ] {
        let dir = TempDir::new();
        let server = dir.server();
        let body = InitInCompat {
            major,
            minor,
            ..Default::default()
        };
        let (_, reply) = execute(
            &server,
            &request(Opcode::Init as u32, 0, body.as_slice()),
            &[256],
        );
        assert_eq!(header(&reply).error, -libc::EPROTO);
        init(&server);
    }
    for requested in [
        FsOptions::READDIRPLUS_AUTO,
        FsOptions::DO_READDIRPLUS | FsOptions::READDIRPLUS_AUTO,
    ] {
        let dir = TempDir::new();
        let server = dir.server();
        let body = InitInCompat {
            major: KERNEL_VERSION,
            minor: KERNEL_MINOR_VERSION + 1,
            flags: requested.bits() as u32,
            ..Default::default()
        };
        let (_, reply) = execute(
            &server,
            &request(Opcode::Init as u32, 0, body.as_slice()),
            &[256],
        );
        assert_eq!(header(&reply).error, 0);
        let out: InitOut = object(&reply, 16);
        assert_eq!(
            (out.major, out.minor),
            (KERNEL_VERSION, KERNEL_MINOR_VERSION)
        );
        let expected = if requested.contains(FsOptions::DO_READDIRPLUS) {
            requested
        } else {
            FsOptions::empty()
        };
        assert_eq!(out.flags as u64, expected.bits());
        assert_eq!(out.flags2, 0);
    }
}

// Every operation goes through fragmented guest reply descriptors and checks
// the used length against the actual FUSE frame, including untouched capacity.
fn wire(
    server: &Server<AggregateFs>,
    opcode: Opcode,
    inode: u64,
    body: &[u8],
    error: i32,
) -> Vec<u8> {
    let (used, mut reply) = execute(server, &request(opcode as u32, inode, body), &[5, 11, 240]);
    let used = used.unwrap();
    assert_eq!(header(&reply).error, -error);
    assert_eq!(header(&reply).unique, 42);
    assert_eq!(header(&reply).len as usize, used);
    assert!(reply[used..].iter().all(|byte| *byte == 0xa5));
    if error != 0 {
        assert_eq!(used, size_of::<OutHeader>());
    }
    reply.truncate(used);
    reply
}

fn named<T: ByteValued>(arguments: T, name: &[u8]) -> Vec<u8> {
    let mut body = arguments.as_slice().to_vec();
    body.extend_from_slice(name);
    body
}

#[test]
fn wire_created_objects_keep_data_attributes_names_and_handles_consistent() {
    let dir = TempDir::new();
    let server = dir.server();
    init(&server);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let mkdir = named(
        MkdirIn {
            mode: 0o755,
            umask: 0,
        },
        b"nested\0",
    );
    let reply = wire(&server, Opcode::Mkdir, root, &mkdir, 0);
    assert_eq!(reply.len(), 16 + size_of::<EntryOut>());
    let nested = object::<EntryOut>(&reply, 16).nodeid;
    assert!(dir.0.join("nested").is_dir());
    wire(&server, Opcode::Mkdir, root, &mkdir, libc::EEXIST);
    let reply = wire(
        &server,
        Opcode::Opendir,
        nested,
        OpenIn::default().as_slice(),
        0,
    );
    let directory_handle = object::<OpenOut>(&reply, 16).fh;

    let create = named(
        CreateIn {
            flags: (libc::O_CREAT | libc::O_RDWR | libc::O_EXCL) as u32,
            mode: 0o600,
            ..Default::default()
        },
        b"data\0",
    );
    let reply = wire(&server, Opcode::Create, nested, &create, 0);
    assert_eq!(
        reply.len(),
        16 + size_of::<EntryOut>() + size_of::<OpenOut>()
    );
    let entry: EntryOut = object(&reply, 16);
    let inode = entry.nodeid;
    let handle = object::<OpenOut>(&reply, 16 + size_of::<EntryOut>()).fh;
    assert_eq!(entry.attr.size, 0);
    assert_ne!(handle, 0);
    let content = b"\0A\xffB\nC";
    let write = named(
        WriteIn {
            fh: handle,
            size: content.len() as u32,
            ..Default::default()
        },
        content,
    );
    let reply = wire(&server, Opcode::Write, inode, &write, 0);
    assert_eq!(object::<WriteOut>(&reply, 16).size as usize, content.len());
    let path = dir.0.join("nested/data");
    assert_eq!(fs::read(&path).unwrap(), content);

    let setattr = SetattrIn {
        valid: (SetattrValid::MODE | SetattrValid::SIZE | SetattrValid::MTIME).bits() | FATTR_FH,
        fh: handle,
        mode: 0o640,
        size: 4,
        mtime: 1_234_567_890,
        mtimensec: 123_456_789,
        ..Default::default()
    };
    let reply = wire(&server, Opcode::Setattr, inode, setattr.as_slice(), 0);
    let changed: AttrOut = object(&reply, 16);
    assert_eq!(changed.attr.size, 4);
    assert_eq!(changed.attr.mode & 0o777, 0o640);
    assert_eq!(
        (changed.attr.mtime, changed.attr.mtimensec),
        (1_234_567_890, 123_456_789)
    );
    let metadata = fs::metadata(&path).unwrap();
    assert_eq!((metadata.len(), metadata.mode() & 0o777), (4, 0o640));
    assert_eq!(
        (metadata.mtime(), metadata.mtime_nsec()),
        (1_234_567_890, 123_456_789)
    );
    assert_eq!(fs::read(&path).unwrap(), &content[..4]);
    let invalid_handle = SetattrIn {
        valid: SetattrValid::SIZE.bits() | FATTR_FH,
        fh: u64::MAX,
        size: 1,
        ..Default::default()
    };
    wire(
        &server,
        Opcode::Setattr,
        inode,
        invalid_handle.as_slice(),
        libc::EBADF,
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), 4);
    assert_eq!(fs::read(&path).unwrap(), &content[..4]);
    let invalid_time = SetattrIn {
        mode: 0o600,
        mtimensec: 1_000_000_000,
        ..setattr
    };
    wire(
        &server,
        Opcode::Setattr,
        inode,
        invalid_time.as_slice(),
        libc::EINVAL,
    );
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o640);
    let getattr = GetattrIn {
        flags: GETATTR_FH,
        fh: handle,
        ..Default::default()
    };
    let reply = wire(&server, Opcode::Getattr, inode, getattr.as_slice(), 0);
    assert_eq!(object::<AttrOut>(&reply, 16).attr.size, 4);
    let read = ReadIn {
        fh: handle,
        offset: 1,
        size: 8,
        ..Default::default()
    };
    let reply = wire(&server, Opcode::Read, inode, read.as_slice(), 0);
    assert_eq!(&reply[16..], &content[1..4]);
    for _ in 0..2 {
        assert_eq!(
            wire(
                &server,
                Opcode::Flush,
                inode,
                FlushIn {
                    fh: handle,
                    ..Default::default()
                }
                .as_slice(),
                0
            )
            .len(),
            16
        );
    }
    wire(
        &server,
        Opcode::Fsync,
        inode,
        FsyncIn {
            fh: handle,
            ..Default::default()
        }
        .as_slice(),
        0,
    );
    wire(
        &server,
        Opcode::Fsyncdir,
        nested,
        FsyncIn {
            fh: directory_handle,
            ..Default::default()
        }
        .as_slice(),
        0,
    );
    wire(
        &server,
        Opcode::Fsync,
        inode,
        FsyncIn {
            fh: u64::MAX,
            ..Default::default()
        }
        .as_slice(),
        libc::EBADF,
    );

    let reply = wire(
        &server,
        Opcode::Link,
        nested,
        &named(LinkIn { oldnodeid: inode }, b"alias\0"),
        0,
    );
    assert_eq!(object::<EntryOut>(&reply, 16).nodeid, inode);
    assert_eq!(
        fs::metadata(&path).unwrap().ino(),
        fs::metadata(dir.0.join("nested/alias")).unwrap().ino()
    );
    let reply = wire(&server, Opcode::Symlink, nested, b"symbol\0renamed\0", 0);
    let symlink = object::<EntryOut>(&reply, 16).nodeid;
    assert_eq!(
        fs::read_link(dir.0.join("nested/symbol")).unwrap(),
        PathBuf::from("renamed")
    );
    let reply = wire(&server, Opcode::Readlink, symlink, &[], 0);
    assert_eq!(&reply[16..], b"renamed");
    let no_replace = named(
        Rename2In {
            newdir: nested,
            flags: libc::RENAME_NOREPLACE,
            ..Default::default()
        },
        b"data\0alias\0",
    );
    wire(&server, Opcode::Rename2, nested, &no_replace, libc::EEXIST);
    let invalid_flags = named(
        Rename2In {
            newdir: nested,
            flags: u32::MAX,
            ..Default::default()
        },
        b"data\0renamed\0",
    );
    wire(
        &server,
        Opcode::Rename2,
        nested,
        &invalid_flags,
        libc::EINVAL,
    );
    let incompatible_flags = named(
        Rename2In {
            newdir: nested,
            flags: libc::RENAME_EXCHANGE | libc::RENAME_NOREPLACE,
            ..Default::default()
        },
        b"data\0alias\0",
    );
    wire(
        &server,
        Opcode::Rename2,
        nested,
        &incompatible_flags,
        libc::EINVAL,
    );
    assert_eq!(fs::read(&path).unwrap(), &content[..4]);
    assert!(dir.0.join("nested/alias").exists());
    wire(
        &server,
        Opcode::Rename2,
        nested,
        &named(
            Rename2In {
                newdir: nested,
                flags: libc::RENAME_NOREPLACE,
                ..Default::default()
            },
            b"alias\0hardlink\0",
        ),
        0,
    );
    assert!(!dir.0.join("nested/alias").exists());
    assert_eq!(
        fs::metadata(dir.0.join("nested/hardlink")).unwrap().ino(),
        fs::metadata(&path).unwrap().ino()
    );
    assert!(path.exists());
    wire(
        &server,
        Opcode::Rename,
        nested,
        &named(RenameIn { newdir: nested }, b"data\0renamed\0"),
        0,
    );
    assert!(!path.exists());
    assert_eq!(
        fs::read(dir.0.join("nested/symbol")).unwrap(),
        &content[..4]
    );
    wire(&server, Opcode::Rmdir, root, b"nested\0", libc::ENOTEMPTY);
    for name in [
        b"renamed\0".as_slice(),
        b"hardlink\0".as_slice(),
        b"symbol\0".as_slice(),
    ] {
        wire(&server, Opcode::Unlink, nested, name, 0);
    }
    assert_eq!(
        wire(&server, Opcode::Read, inode, read.as_slice(), 0)[16..],
        content[1..4]
    );
    let release = ReleaseIn {
        fh: handle,
        flags: libc::O_RDWR as u32,
        ..Default::default()
    };
    let mut malformed_release = release.as_slice().to_vec();
    malformed_release.push(0);
    wire(
        &server,
        Opcode::Release,
        inode,
        &malformed_release,
        libc::EINVAL,
    );
    assert_eq!(
        wire(&server, Opcode::Read, inode, read.as_slice(), 0)[16..],
        content[1..4]
    );
    wire(&server, Opcode::Release, inode, release.as_slice(), 0);
    wire(&server, Opcode::Read, inode, read.as_slice(), libc::EBADF);
    wire(
        &server,
        Opcode::Releasedir,
        nested,
        ReleaseIn {
            fh: directory_handle,
            ..Default::default()
        }
        .as_slice(),
        0,
    );
    wire(&server, Opcode::Rmdir, root, b"nested\0", 0);
    assert!(!dir.0.join("nested").exists());
}

#[test]
fn wire_xattrs_and_positioned_range_operations_match_host_results() {
    let dir = TempDir::new();
    let source = dir.file();
    source.write_all_at(b"0123456789abcdef", 0).unwrap();
    fs::write(dir.0.join("target"), b"xxxxxx").unwrap();
    let server = dir.server();
    init(&server);
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let inode = lookup(&server, root, b"file\0").nodeid;
    let target = lookup(&server, root, b"target\0").nodeid;
    let mut handles = Vec::new();
    for node in [inode, target] {
        let reply = wire(
            &server,
            Opcode::Open,
            node,
            OpenIn {
                flags: libc::O_RDWR as u32,
                ..Default::default()
            }
            .as_slice(),
            0,
        );
        handles.push(object::<OpenOut>(&reply, 16).fh);
    }
    let (input, output) = (handles[0], handles[1]);

    let name = b"user.boxlite.wire\0";
    let value = b"\0A\xffZ";
    let mut set = named(
        SetxattrIn {
            size: value.len() as u32,
            flags: libc::XATTR_CREATE as u32,
        },
        name,
    );
    set.extend_from_slice(value);
    let mut malformed = set.clone();
    malformed[..4].copy_from_slice(&99u32.to_ne_bytes());
    wire(&server, Opcode::Setxattr, inode, &malformed, libc::EINVAL);
    wire(
        &server,
        Opcode::Getxattr,
        inode,
        &named(GetxattrIn::default(), name),
        libc::ENODATA,
    );
    wire(&server, Opcode::Setxattr, inode, &set, 0);
    wire(&server, Opcode::Setxattr, inode, &set, libc::EEXIST);
    let mut host_value = [0; 4];
    // SAFETY: the live file, NUL-terminated name and writable array cover the call.
    let host_size = unsafe {
        libc::fgetxattr(
            source.as_raw_fd(),
            name.as_ptr().cast(),
            host_value.as_mut_ptr().cast(),
            host_value.len(),
        )
    };
    assert_eq!(host_size, value.len() as isize);
    assert_eq!(&host_value, value);
    let reply = wire(
        &server,
        Opcode::Getxattr,
        inode,
        &named(GetxattrIn::default(), name),
        0,
    );
    assert_eq!(reply.len(), 16 + size_of::<GetxattrOut>());
    assert_eq!(object::<GetxattrOut>(&reply, 16).size, 4);
    let reply = wire(
        &server,
        Opcode::Getxattr,
        inode,
        &named(
            GetxattrIn {
                size: 4,
                ..Default::default()
            },
            name,
        ),
        0,
    );
    assert_eq!(&reply[16..], value);
    wire(
        &server,
        Opcode::Getxattr,
        inode,
        &named(
            GetxattrIn {
                size: 3,
                ..Default::default()
            },
            name,
        ),
        libc::ERANGE,
    );
    let reply = wire(
        &server,
        Opcode::Listxattr,
        inode,
        GetxattrIn::default().as_slice(),
        0,
    );
    let count = object::<GetxattrOut>(&reply, 16).size;
    assert!(count as usize >= name.len());
    // Query the exact list through the production server without assuming which
    // security labels the host filesystem also attached to this temporary file.
    let (used, names) = execute(
        &server,
        &request(
            Opcode::Listxattr as u32,
            inode,
            GetxattrIn {
                size: count,
                ..Default::default()
            }
            .as_slice(),
        ),
        &[16, count as usize],
    );
    assert_eq!(used.unwrap(), 16 + count as usize);
    assert_eq!(header(&names).error, 0);
    assert!(
        names[16..]
            .split_inclusive(|byte| *byte == 0)
            .any(|entry| entry == name)
    );
    wire(
        &server,
        Opcode::Listxattr,
        inode,
        GetxattrIn {
            size: 1,
            ..Default::default()
        }
        .as_slice(),
        libc::ERANGE,
    );
    wire(&server, Opcode::Removexattr, inode, name, 0);
    wire(
        &server,
        Opcode::Getxattr,
        inode,
        &named(GetxattrIn::default(), name),
        libc::ENODATA,
    );

    for node in [root, inode] {
        let reply = wire(&server, Opcode::Statfs, node, &[], 0);
        assert_eq!(reply.len(), 16 + size_of::<Kstatfs>());
        let stats: Kstatfs = object(&reply, 16);
        assert!(stats.bsize > 0);
        assert!(stats.blocks > 0);
        assert!(stats.bfree <= stats.blocks);
        assert!(stats.bavail <= stats.bfree);
    }
    wire(
        &server,
        Opcode::Fallocate,
        target,
        FallocateIn {
            fh: output,
            offset: 8,
            length: 24,
            ..Default::default()
        }
        .as_slice(),
        0,
    );
    assert_eq!(fs::metadata(dir.0.join("target")).unwrap().len(), 32);
    let reply = wire(
        &server,
        Opcode::Lseek,
        target,
        LseekIn {
            fh: output,
            whence: libc::SEEK_END as u32,
            ..Default::default()
        }
        .as_slice(),
        0,
    );
    assert_eq!(object::<LseekOut>(&reply, 16).offset, 32);
    wire(
        &server,
        Opcode::Lseek,
        target,
        LseekIn {
            fh: output,
            whence: u32::MAX,
            ..Default::default()
        }
        .as_slice(),
        libc::EINVAL,
    );
    let copy = CopyfilerangeIn {
        fh_in: input,
        off_in: 2,
        nodeid_out: target,
        fh_out: output,
        off_out: 4,
        len: 5,
        flags: 0,
    };
    let reply = wire(&server, Opcode::CopyFileRange, inode, copy.as_slice(), 0);
    assert_eq!(object::<WriteOut>(&reply, 16).size, 5);
    let content = fs::read(dir.0.join("target")).unwrap();
    assert_eq!(&content[..4], b"xxxx");
    assert_eq!(&content[4..9], b"23456");
    assert!(content[9..].iter().all(|byte| *byte == 0));
    wire(
        &server,
        Opcode::CopyFileRange,
        inode,
        CopyfilerangeIn { flags: 1, ..copy }.as_slice(),
        libc::EINVAL,
    );
    assert_eq!(fs::read(dir.0.join("target")).unwrap(), content);
    let reply = wire(
        &server,
        Opcode::CopyFileRange,
        inode,
        CopyfilerangeIn {
            off_in: 14,
            off_out: 12,
            len: 8,
            ..copy
        }
        .as_slice(),
        0,
    );
    assert_eq!(object::<WriteOut>(&reply, 16).size, 2);
    assert_eq!(&fs::read(dir.0.join("target")).unwrap()[12..14], b"ef");
    for (node, handle) in [(inode, input), (target, output)] {
        wire(
            &server,
            Opcode::Release,
            node,
            ReleaseIn {
                fh: handle,
                ..Default::default()
            }
            .as_slice(),
            0,
        );
    }
}

#[test]
fn optional_kernel_requests_preserve_standard_enosys_fallback() {
    let directory = TempDir::new();
    let server = directory.server();
    init(&server);
    // Only these opt-outs avoid both EPOLLERR and false synchronization success.
    for (opcode, size) in [(39, 32), (40, 24)] {
        let (result, reply) = execute(&server, &request(opcode, ROOT_ID, &vec![0; size]), &[16]);
        assert_eq!(result.unwrap(), 16);
        assert_eq!(header(&reply).error, -libc::ENOSYS);
    }
    for opcode in [37, 48, 31, 50, u32::MAX] {
        let (_, reply) = execute(&server, &request(opcode, ROOT_ID, &[0; 32]), &[16]);
        assert_eq!(header(&reply).error, -libc::EOPNOTSUPP);
    }
    let root = lookup(&server, ROOT_ID, b"shared\0").nodeid;
    let (_, reply) = execute(
        &server,
        &request(Opcode::Lookup as u32, root, b"missing\0"),
        &[256],
    );
    assert_eq!(header(&reply).error, -libc::ENOENT);
}
