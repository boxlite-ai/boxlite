// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Direct boundary tests for the independently introduced vsock layers.

use crate::{
    memory::GuestMemoryMmap,
    virtio::{
        DeviceError, EventError, EventRegistrar, EventSource, SourceId,
        vsock::{buffer::Buffer, packet::*, source::Registration},
    },
};
use mio::{Events, Interest, Poll, Token};
use std::{
    collections::HashMap,
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};
use virtio_queue::{Queue, QueueT};
use vm_memory::{Bytes, GuestAddress};

pub(super) struct Registrar {
    poll: Mutex<Poll>,
    pub(super) sources: Mutex<HashMap<SourceId, Box<dyn EventSource>>>,
    next: AtomicU32,
}

impl Registrar {
    pub(super) fn new() -> Self {
        Self {
            poll: Mutex::new(Poll::new().unwrap()),
            sources: Mutex::new(HashMap::new()),
            next: AtomicU32::new(0),
        }
    }
}

impl EventRegistrar for Registrar {
    fn register(&self, mut source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        let id = SourceId(self.next.fetch_add(1, Ordering::Relaxed));
        source
            .as_source()
            .register(
                self.poll.lock().unwrap().registry(),
                Token(id.0 as usize),
                Interest::READABLE,
            )
            .map_err(|e| EventError::Register(e.kind()))?;
        self.sources.lock().unwrap().insert(id, source);
        Ok(id)
    }
    fn deregister(&self, id: SourceId) {
        if let Some(mut source) = self.sources.lock().unwrap().remove(&id) {
            source
                .as_source()
                .deregister(self.poll.lock().unwrap().registry())
                .unwrap();
        }
    }
}

pub(super) fn header(op: u16) -> Header {
    Header {
        src_cid: 3,
        dst_cid: HOST_CID,
        src_port: 7000,
        dst_port: 2696,
        socket_type: STREAM,
        op,
        buf_alloc: BUFFER_SIZE as u32,
        ..Header::default()
    }
}

#[test]
fn codec_preserves_wire_fields_and_reverses_reply_addresses() {
    for op in [
        REQUEST,
        RESPONSE,
        RST,
        SHUTDOWN,
        RW,
        CREDIT_UPDATE,
        CREDIT_REQUEST,
    ] {
        let h = Header {
            flags: RECEIVE | SEND,
            fwd_cnt: 0x12345678,
            ..header(op)
        };
        let encoded = h.encode();
        assert_eq!(&encoded[..8], &[3, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&encoded[28..30], &[1, 0]);
        assert_eq!(&encoded[40..44], &[0x78, 0x56, 0x34, 0x12]);
        assert_eq!(Header::decode(&encoded), h);
        let reply = h.reply(RST);
        assert_eq!((reply.header.src_cid, reply.header.dst_cid), (HOST_CID, 3));
        assert_eq!((reply.header.src_port, reply.header.dst_port), (2696, 7000));
        assert_eq!(reply.header.op, RST);
        assert!(reply.payload.is_empty());
    }
}

#[test]
fn packet_reader_rejects_truncation_and_oversized_payloads() {
    let mut encoded = Header {
        len: 3,
        ..header(RW)
    }
    .encode()
    .to_vec();
    encoded.extend_from_slice(b"abc");
    assert_eq!(
        Packet::read(&mut encoded.as_slice()).unwrap().payload,
        b"abc"
    );
    for size in 0..encoded.len() {
        assert!(Packet::read(&mut &encoded[..size]).is_err());
    }
    let oversized = Header {
        len: BUFFER_SIZE as u32 + 1,
        ..header(RW)
    }
    .encode();
    assert_eq!(
        Packet::read(&mut oversized.as_slice()).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
}

fn captured(memory: &GuestMemoryMmap, capacity: usize) -> Buffer {
    let mut queue = Queue::new(8).unwrap();
    queue.set_size(8);
    queue.set_desc_table_address(Some(0x1000), None);
    queue.set_avail_ring_address(Some(0x2000), None);
    queue.set_used_ring_address(Some(0x3000), None);
    queue.set_ready(true);
    // A header can span descriptors; the second buffer is deliberately disjoint.
    for (index, address, length, flags, next) in [
        (0u64, 0x4000u64, 20usize, 3u16, 1u16),
        (1, 0x5000, capacity - 20, 2, 0),
    ] {
        let mut desc = [0u8; 16];
        desc[..8].copy_from_slice(&address.to_le_bytes());
        desc[8..12].copy_from_slice(&(length as u32).to_le_bytes());
        desc[12..14].copy_from_slice(&flags.to_le_bytes());
        desc[14..].copy_from_slice(&next.to_le_bytes());
        memory
            .write_slice(&desc, GuestAddress(0x1000 + index * 16))
            .unwrap();
    }
    memory.write_obj(0u16, GuestAddress(0x2004)).unwrap();
    memory
        .write_obj(1u16.to_le(), GuestAddress(0x2002))
        .unwrap();
    Buffer::new(queue.pop_descriptor_chain(memory).unwrap()).unwrap()
}

#[test]
fn captured_buffers_write_checked_scatter_payloads() {
    let memory = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x6000)]).unwrap();
    let packet = Packet {
        header: Header {
            len: 6,
            ..header(RW)
        },
        payload: b"abcdef".to_vec(),
    };
    let mut bytes = packet.header.encode().to_vec();
    bytes.extend_from_slice(&packet.payload);
    let buffer = captured(&memory, bytes.len());
    assert_eq!(buffer.head, 0);
    // Changing the descriptor table after capture must not redirect the write.
    memory.write_obj(0xffffu64, GuestAddress(0x1000)).unwrap();
    buffer.write(&memory, &bytes).unwrap();
    let mut encoded = vec![0; bytes.len()];
    memory
        .read_slice(&mut encoded[..20], GuestAddress(0x4000))
        .unwrap();
    memory
        .read_slice(&mut encoded[20..], GuestAddress(0x5000))
        .unwrap();
    let received = Packet::read(&mut encoded.as_slice()).unwrap();
    assert_eq!(received.header, packet.header);
    assert_eq!(received.payload, packet.payload);
    let short = captured(&memory, HEADER_LEN - 1);
    assert!(matches!(
        short.write(&memory, &[0; HEADER_LEN]),
        Err(DeviceError::NeedsReset(_))
    ));
}

#[test]
fn registered_sources_deliver_readiness_and_release_registration() {
    let registrar = Arc::new(Registrar::new());
    let (mut device, mut host) = socket_pair();
    let registration =
        Registration::stream(&device, registrar.clone(), Interest::READABLE).unwrap();
    assert_eq!(registrar.sources.lock().unwrap().len(), 1);
    let mut received = [0; 4];
    for bytes in [b"ping", b"pong"] {
        host.write_all(bytes).unwrap();
        assert!(poll(&registrar).iter().any(|event| event.is_readable()));
        device.read_exact(&mut received).unwrap();
        assert_eq!(&received, bytes);
        assert_eq!(
            device.read(&mut received).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    drop(registration);
    assert!(registrar.sources.lock().unwrap().is_empty());
    device.write_all(b"back").unwrap();
    host.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"back");
    drop(device);
    assert_eq!(host.read(&mut received).unwrap(), 0);
}

fn socket_pair() -> (UnixStream, UnixStream) {
    let (device, host) = UnixStream::pair().unwrap();
    device.set_nonblocking(true).unwrap();
    host.set_nonblocking(true).unwrap();
    (device, host)
}

pub(super) fn poll(registrar: &Registrar) -> Events {
    let mut events = Events::with_capacity(8);
    registrar
        .poll
        .lock()
        .unwrap()
        .poll(&mut events, Some(Duration::from_secs(1)))
        .unwrap();
    events
}

#[test]
fn registered_sources_preserve_writable_interest_on_reregistration() {
    let registrar = Arc::new(Registrar::new());
    let (device, _host) = socket_pair();
    let _registration =
        Registration::stream(&device, registrar.clone(), Interest::WRITABLE).unwrap();
    assert!(poll(&registrar).iter().any(|event| event.is_writable()));
    {
        let mut sources = registrar.sources.lock().unwrap();
        let (&id, source) = sources.iter_mut().next().unwrap();
        source
            .as_source()
            .reregister(
                registrar.poll.lock().unwrap().registry(),
                Token(id.0 as usize),
                Interest::READABLE,
            )
            .unwrap();
    }
    assert!(poll(&registrar).iter().any(|event| event.is_writable()));
}

#[test]
fn registrar_cleanup_leaves_device_io_usable() {
    let registrar = Arc::new(Registrar::new());
    let (mut device, mut host) = socket_pair();
    let registration =
        Registration::stream(&device, registrar.clone(), Interest::READABLE).unwrap();
    let id = *registrar.sources.lock().unwrap().keys().next().unwrap();
    registrar.deregister(id);
    assert!(registrar.sources.lock().unwrap().is_empty());
    host.write_all(b"ping").unwrap();
    let mut received = [0; 4];
    device.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"ping");
    device.write_all(b"pong").unwrap();
    host.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"pong");
    drop(registration);
    drop(device);
    assert_eq!(host.read(&mut received).unwrap(), 0);
}

#[test]
fn polling_handle_survives_caller_socket_close_until_deregistration() {
    let registrar = Arc::new(Registrar::new());
    let (device, mut host) = socket_pair();
    let registration =
        Registration::stream(&device, registrar.clone(), Interest::READABLE).unwrap();
    drop(device);
    assert_eq!(
        host.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(registration);
    assert!(registrar.sources.lock().unwrap().is_empty());
    assert_eq!(host.read(&mut [0]).unwrap(), 0);
}

#[test]
fn rejected_registration_releases_polling_copy_and_preserves_caller_socket() {
    struct Closed;
    impl EventRegistrar for Closed {
        fn register(&self, _: Box<dyn EventSource>) -> Result<SourceId, EventError> {
            Err(EventError::Closed)
        }
        fn deregister(&self, _: SourceId) {
            panic!("a rejected registration has no id to deregister");
        }
    }
    let (mut device, mut host) = socket_pair();
    assert!(matches!(
        Registration::stream(&device, Arc::new(Closed), Interest::READABLE),
        Err(DeviceError::Fatal("vsock event registration"))
    ));
    device.write_all(b"ping").unwrap();
    let mut received = [0; 4];
    host.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"ping");
    drop(device);
    assert_eq!(host.read(&mut received).unwrap(), 0);
}

#[test]
fn registered_listener_delivers_readiness_for_device_accept() {
    struct SocketPath(std::path::PathBuf);
    impl Drop for SocketPath {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let path = SocketPath(std::env::temp_dir().join(format!(
        "boxlite-vsock-listener-{}.sock",
        std::process::id()
    )));
    let listener = UnixListener::bind(&path.0).unwrap();
    listener.set_nonblocking(true).unwrap();
    let registrar = Arc::new(Registrar::new());
    let registration =
        Registration::listener(&listener, registrar.clone(), Interest::READABLE).unwrap();
    let mut host = UnixStream::connect(&path.0).unwrap();
    host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    assert!(poll(&registrar).iter().any(|event| event.is_readable()));
    let (mut device, _) = listener.accept().unwrap();
    device.set_nonblocking(true).unwrap();
    host.write_all(b"ping").unwrap();
    let mut received = [0; 4];
    device.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"ping");
    drop(registration);
    assert!(registrar.sources.lock().unwrap().is_empty());
    drop(device);
    assert_eq!(host.read(&mut received).unwrap(), 0);
}
