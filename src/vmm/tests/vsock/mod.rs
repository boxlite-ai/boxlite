// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::{packet::*, *};
use crate::{
    events::EventLoop,
    memory::GuestMemoryMmap,
    virtio::{EventError, EventRegistrar, EventSource, SourceId, VirtioInterrupt},
};
use mio::{Events, Interest, Poll, Token};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicU32, AtomicUsize, Ordering},
    },
    time::Duration,
};
use virtio_queue::{Queue, QueueT};
use vm_memory::{Bytes, GuestAddress};

mod deferred;
mod scheduling;

const SIZE: u16 = 8;
static TEMP_ID: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = PathBuf::from("/tmp").join(format!(
            "bl-vsock-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

type Sources = HashMap<SourceId, (DeviceEvent, Box<dyn EventSource>)>;
struct Registrar {
    poll: Mutex<Poll>,
    sources: Mutex<Sources>,
    next: AtomicU32,
    fail_at: AtomicU32,
}
impl Registrar {
    fn new() -> Self {
        Self {
            poll: Mutex::new(Poll::new().unwrap()),
            sources: Mutex::new(HashMap::new()),
            next: AtomicU32::new(0),
            fail_at: AtomicU32::new(u32::MAX),
        }
    }
    fn ready(&self) -> Vec<DeviceEvent> {
        let mut events = Events::with_capacity(256);
        self.poll
            .lock()
            .unwrap()
            .poll(&mut events, Some(Duration::from_millis(2)))
            .unwrap();
        let sources = self.sources.lock().unwrap();
        events
            .iter()
            .filter_map(|e| sources.get(&SourceId(e.token().0 as u32)).map(|s| s.0))
            .collect()
    }
    fn len(&self) -> usize {
        self.sources.lock().unwrap().len()
    }
}
impl EventRegistrar for Registrar {
    fn register(&self, mut source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        let id = SourceId(self.next.fetch_add(1, Ordering::Relaxed));
        if id.0 == self.fail_at.load(Ordering::Relaxed) {
            return Err(EventError::Closed);
        }
        source
            .as_source()
            .register(
                self.poll.lock().unwrap().registry(),
                Token(id.0 as usize),
                Interest::READABLE | Interest::WRITABLE,
            )
            .unwrap();
        self.sources
            .lock()
            .unwrap()
            .insert(id, (DeviceEvent::BackendReady(id), source));
        Ok(id)
    }
    fn deregister(&self, id: SourceId) {
        if let Some((_, mut source)) = self.sources.lock().unwrap().remove(&id) {
            source
                .as_source()
                .deregister(self.poll.lock().unwrap().registry())
                .unwrap();
        }
    }
}

#[derive(Default)]
struct Interrupt {
    status: AtomicU8,
    raises: AtomicUsize,
}
impl VirtioInterrupt for Interrupt {
    fn raise(&self) {
        self.status.fetch_or(1, Ordering::Relaxed);
        self.raises.fetch_add(1, Ordering::Relaxed);
    }
    fn interrupt_status(&self) -> u8 {
        self.status.load(Ordering::Relaxed)
    }
    fn ack_interrupt(&self, bits: u8) {
        self.status.fetch_and(!bits, Ordering::Relaxed);
    }
    fn config_generation(&self) -> u8 {
        0
    }
    fn raise_config(&self) {
        self.status.fetch_or(2, Ordering::Relaxed);
    }
    fn device_status(&self) -> u8 {
        0
    }
    fn set_device_status(&self, _status: u8) {}
    fn set_needs_reset(&self) {}
}

struct Driver {
    base: u64,
    data: u64,
    avail: u16,
    used: u16,
}
impl Driver {
    fn new(index: u64) -> Self {
        Self {
            base: 0x1000 + index * 0x4000,
            data: 0x10000 + index * 0x90000,
            avail: 0,
            used: 0,
        }
    }
    fn queue(&self) -> Queue {
        let mut q = Queue::new(256).unwrap();
        q.set_size(SIZE);
        q.set_desc_table_address(Some(self.base as u32), None);
        q.set_avail_ring_address(Some((self.base + 0x1000) as u32), None);
        q.set_used_ring_address(Some((self.base + 0x2000) as u32), None);
        q.set_ready(true);
        q
    }
    fn submit(&mut self, mem: &GuestMemoryMmap, bytes: &[u8], writable: bool, length: usize) {
        let head = self.avail % SIZE;
        let addr = self.data + head as u64 * 0x11000;
        mem.write_slice(bytes, GuestAddress(addr)).unwrap();
        let mut descriptor = [0u8; 16];
        descriptor[0..8].copy_from_slice(&addr.to_le_bytes());
        descriptor[8..12].copy_from_slice(&(length as u32).to_le_bytes());
        descriptor[12..14].copy_from_slice(&(if writable { 2u16 } else { 0u16 }).to_le_bytes());
        mem.write_slice(&descriptor, GuestAddress(self.base + head as u64 * 16))
            .unwrap();
        mem.write_obj(
            head.to_le(),
            GuestAddress(self.base + 0x1004 + (self.avail % SIZE) as u64 * 2),
        )
        .unwrap();
        self.avail = self.avail.wrapping_add(1);
        mem.write_obj(self.avail.to_le(), GuestAddress(self.base + 0x1002))
            .unwrap();
    }
    fn take(&mut self, mem: &GuestMemoryMmap) -> Vec<Vec<u8>> {
        let used = u16::from_le(mem.read_obj(GuestAddress(self.base + 0x2002)).unwrap());
        let mut packets = vec![];
        while self.used != used {
            let entry = self.base + 0x2004 + (self.used % SIZE) as u64 * 8;
            let id = u32::from_le(mem.read_obj(GuestAddress(entry)).unwrap());
            let len = u32::from_le(mem.read_obj(GuestAddress(entry + 4)).unwrap());
            let mut data = vec![0; len as usize];
            mem.read_slice(&mut data, GuestAddress(self.data + id as u64 * 0x11000))
                .unwrap();
            packets.push(data);
            self.used = self.used.wrapping_add(1);
        }
        packets
    }
}

struct Harness {
    device: Vsock,
    memory: Arc<GuestMemoryMmap>,
    rx: Driver,
    tx: Driver,
    registrar: Arc<Registrar>,
    interrupt: Arc<Interrupt>,
    wakes: Arc<AtomicUsize>,
    packets: VecDeque<Packet>,
    refill: bool,
}
impl Harness {
    fn new(mappings: Vec<PortMapping>) -> Self {
        let mut h = Self {
            device: Vsock::new(3, mappings).unwrap(),
            memory: Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x200000)]).unwrap()),
            rx: Driver::new(0),
            tx: Driver::new(1),
            registrar: Arc::new(Registrar::new()),
            interrupt: Arc::new(Interrupt::default()),
            wakes: Arc::new(AtomicUsize::new(0)),
            packets: VecDeque::new(),
            refill: true,
        };
        h.activate();
        for _ in 0..SIZE {
            h.rx.submit(&h.memory, &[], true, HEADER_LEN + 4096);
        }
        h
    }
    fn context(&self) -> ActivationContext {
        let wakes = self.wakes.clone();
        ActivationContext {
            memory: self.memory.clone(),
            queues: crate::virtio::queue::VirtQueues::prepare(
                vec![self.rx.queue(), self.tx.queue(), Driver::new(2).queue()],
                &[256, 256, 256],
                false,
                false,
                self.memory.clone(),
            )
            .unwrap(),
            interrupt: self.interrupt.clone(),
            events: self.registrar.clone(),
            waker: Arc::new(move || {
                wakes.fetch_add(1, Ordering::Relaxed);
            }),
            sender: EventLoop::new().unwrap().sender(),
        }
    }
    fn activate(&mut self) {
        self.device.set_features(0).unwrap();
        self.device.activate(self.context()).unwrap();
    }
    fn send(&mut self, packet: Packet) {
        let mut data = packet.header.encode().to_vec();
        data.extend(packet.payload);
        self.tx.submit(&self.memory, &data, false, data.len());
        self.tick();
        assert!(self.tx.take(&self.memory).iter().all(Vec::is_empty));
    }
    fn tick(&mut self) {
        self.device.on_event(DeviceEvent::QueueKick(0)).unwrap();
        for event in self.registrar.ready() {
            self.device.on_event(event).unwrap();
        }
        let received = self.rx.take(&self.memory);
        let count = received.len();
        self.packets.extend(
            received
                .into_iter()
                .map(|data| Packet::read(&mut data.as_slice()).unwrap()),
        );
        if self.refill {
            for _ in 0..count {
                self.rx.submit(&self.memory, &[], true, HEADER_LEN + 4096);
            }
        }
    }
    fn next(&mut self, op: u16) -> Packet {
        for _ in 0..100 {
            if let Some(index) = self.packets.iter().position(|p| p.header.op == op) {
                return self.packets.remove(index).unwrap();
            }
            self.tick();
        }
        panic!(
            "no vsock operation {op}; received {:?}",
            self.packets.iter().map(|p| &p.header).collect::<Vec<_>>()
        );
    }
    fn guest_connect(&mut self, port: u32) -> Header {
        let h = guest(REQUEST, 7000, port);
        self.send(Packet {
            header: h.clone(),
            payload: vec![],
        });
        let response = self.next(RESPONSE);
        assert_eq!(
            (
                response.header.src_cid,
                response.header.dst_cid,
                response.header.src_port,
                response.header.dst_port
            ),
            (2, 3, port, 7000)
        );
        h
    }
}

fn guest(op: u16, src_port: u32, dst_port: u32) -> Header {
    Header {
        src_cid: 3,
        dst_cid: 2,
        src_port,
        dst_port,
        socket_type: STREAM,
        op,
        buf_alloc: BUFFER_SIZE as u32,
        ..Header::default()
    }
}
fn data(h: &Header, bytes: &[u8]) -> Packet {
    Packet {
        header: Header {
            op: RW,
            len: bytes.len() as u32,
            ..h.clone()
        },
        payload: bytes.to_vec(),
    }
}
fn bounded(stream: &UnixStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
}

#[test]
fn config_and_feature_contract() {
    let mut v = Vsock::new(3, vec![]).unwrap();
    assert_eq!(
        (v.spec().device_id, v.spec().queue_max, v.spec().config_len),
        (19, &[256, 256, 256][..], 8)
    );
    assert_eq!(v.set_features(1), Err(FeatureError { unsupported: 1 }));
    let mut bytes = [0xff; 12];
    v.read_config(0, &mut bytes).unwrap();
    assert_eq!(&bytes[..8], &3u64.to_le_bytes());
    assert_eq!(&bytes[8..], &[0; 4]);
    v.write_config(0, &[9; 8]).unwrap();
    v.read_config(u64::MAX, &mut bytes).unwrap();
    assert_eq!(bytes, [0; 12]);
    v.read_config(0, &mut bytes[..8]).unwrap();
    assert_eq!(&bytes[..8], &3u64.to_le_bytes());
    for cid in [0, 1, 2, u32::MAX as u64, 1 << 32] {
        assert!(Vsock::new(cid, vec![]).is_err());
    }
    let ports = vec![
        PortMapping::Connect {
            port: 1,
            path: "/tmp/a".into(),
        },
        PortMapping::Connect {
            port: 1,
            path: "/tmp/b".into(),
        },
    ];
    assert!(Vsock::new(3, ports).is_err());
    assert!(
        Vsock::new(
            3,
            vec![PortMapping::Connect {
                port: 2696,
                path: PathBuf::new()
            }]
        )
        .is_err()
    );
}

#[test]
fn guest_ready_connection_bridges_both_directions_without_a_host_prefix() {
    let temp = Temp::new();
    let path = temp.path("ready");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Connect { port: 2696, path }]);
    let header = h.guest_connect(2696);
    let (mut host, _) = listener.accept().unwrap();
    bounded(&host);
    h.send(data(&header, b"READY"));
    let mut bytes = [0; 5];
    host.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"READY");
    let update = h.next(CREDIT_UPDATE);
    assert_eq!(update.header.fwd_cnt, 5);
    host.write_all(b"hello guest").unwrap();
    assert_eq!(h.next(RW).payload, b"hello guest");
    assert_eq!(h.interrupt.interrupt_status() & 1, 1);
}

#[test]
fn host_agent_connection_has_unique_ports_and_waits_for_response() {
    let temp = Temp::new();
    let path = temp.path("agent");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Listen {
        port: 2695,
        listener,
    }]);
    let mut host = UnixStream::connect(&path).unwrap();
    bounded(&host);
    host.write_all(b"grpc").unwrap();
    let request = h.next(REQUEST);
    assert_eq!(
        (
            request.header.src_cid,
            request.header.dst_cid,
            request.header.dst_port
        ),
        (2, 3, 2695)
    );
    h.tick();
    assert!(!h.packets.iter().any(|p| p.header.op == RW));
    let header = guest(RESPONSE, 2695, request.header.src_port);
    h.send(Packet {
        header: header.clone(),
        payload: vec![],
    });
    assert_eq!(h.next(RW).payload, b"grpc");
    h.send(data(&header, b"reply"));
    let mut bytes = [0; 5];
    host.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"reply");
    let _second = UnixStream::connect(&path).unwrap();
    assert_ne!(h.next(REQUEST).header.src_port, request.header.src_port);
}

#[test]
fn unknown_ports_types_and_bad_credit_reset_only_the_flow() {
    let temp = Temp::new();
    let path = temp.path("ready");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Connect { port: 2696, path }]);
    h.send(Packet {
        header: guest(REQUEST, 8, 999),
        payload: vec![],
    });
    assert_eq!(h.next(RST).header.dst_port, 8);
    let mut unknown = guest(REQUEST, 9, 2696);
    unknown.socket_type = 2;
    h.send(Packet {
        header: unknown,
        payload: vec![],
    });
    assert_eq!(h.next(RST).header.dst_port, 9);
    let mut forged = guest(REQUEST, 10, 2696);
    forged.src_cid = 4;
    h.send(Packet {
        header: forged,
        payload: vec![],
    });
    assert_eq!(h.registrar.len(), 1); // Only the private notification remains.
    let mut header = h.guest_connect(2696);
    let (_host, _) = listener.accept().unwrap();
    header.op = CREDIT_UPDATE;
    header.fwd_cnt = 1;
    h.send(Packet {
        header,
        payload: vec![],
    });
    h.next(RST);
    assert_eq!(h.registrar.len(), 1);
}

#[test]
fn peer_credit_stalls_reads_and_update_resumes_exact_bytes() {
    let temp = Temp::new();
    let path = temp.path("ready");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Connect { port: 2696, path }]);
    let mut header = guest(REQUEST, 7000, 2696);
    header.buf_alloc = 3;
    h.send(Packet {
        header: header.clone(),
        payload: vec![],
    });
    h.next(RESPONSE);
    let (mut host, _) = listener.accept().unwrap();
    bounded(&host);
    host.write_all(b"abcdef").unwrap();
    assert_eq!(h.next(RW).payload, b"abc");
    h.next(CREDIT_REQUEST);
    for _ in 0..3 {
        h.tick();
    }
    assert!(!h.packets.iter().any(|p| p.header.op == RW));
    header.op = CREDIT_UPDATE;
    header.fwd_cnt = 3;
    h.send(Packet {
        header,
        payload: vec![],
    });
    // The zero-credit probe retained 'd'; stream packet boundaries are not
    // message boundaries, so the lookahead can precede a separate 'ef' packet.
    let mut resumed = Vec::new();
    while resumed.len() < 3 {
        resumed.extend(h.next(RW).payload);
    }
    assert_eq!(resumed, b"def");
}

#[test]
fn half_close_drains_accepted_data_and_keeps_the_other_direction_open() {
    let temp = Temp::new();
    let path = temp.path("ready");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Connect { port: 2696, path }]);
    let header = h.guest_connect(2696);
    let (mut host, _) = listener.accept().unwrap();
    bounded(&host);
    h.send(data(&header, b"tail"));
    h.send(Packet {
        header: Header {
            op: SHUTDOWN,
            flags: SEND,
            ..header.clone()
        },
        payload: vec![],
    });
    let mut bytes = Vec::new();
    host.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"tail");
    host.write_all(b"response after EOF").unwrap();
    assert_eq!(h.next(RW).payload, b"response after EOF");
    host.shutdown(Shutdown::Write).unwrap();
    assert_eq!(h.next(SHUTDOWN).header.flags, SEND);
    h.send(Packet {
        header: Header {
            op: SHUTDOWN,
            flags: RECEIVE,
            ..header
        },
        payload: vec![],
    });
    h.next(RST);
    assert_eq!(h.registrar.len(), 1);
}

#[test]
fn reset_and_drop_release_sources_and_reactivation_preserves_listener() {
    let temp = Temp::new();
    let path = temp.path("agent");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Listen {
        port: 2695,
        listener,
    }]);
    let mut host = UnixStream::connect(&path).unwrap();
    bounded(&host);
    h.next(REQUEST);
    assert_eq!(h.registrar.len(), 3);
    h.device.reset().unwrap();
    assert_eq!(h.registrar.len(), 0);
    let mut bytes = [0];
    assert_eq!(host.read(&mut bytes).unwrap(), 0);
    let ctx = h.context();
    assert!(h.device.activate(ctx).is_err()); // reset requires feature negotiation again
    h.activate();
    assert_eq!(h.registrar.len(), 2);
    let registrar = h.registrar.clone();
    drop(h);
    assert_eq!(registrar.len(), 0);
    assert!(path.exists());
}

#[test]
fn failed_activation_deregisters_its_successful_prefix() {
    let temp = Temp::new();
    let mappings = (0..2)
        .map(|i| PortMapping::Listen {
            port: 2695 + i,
            listener: UnixListener::bind(temp.path(&format!("s{i}"))).unwrap(),
        })
        .collect();
    let mut h = Harness::new(vec![]);
    h.device.reset().unwrap();
    h.device = Vsock::new(3, mappings).unwrap();
    h.device.set_features(0).unwrap();
    // Reject either listener or the final private notification registration.
    for offset in 0..3 {
        h.registrar.fail_at.store(
            h.registrar.next.load(Ordering::Relaxed) + offset,
            Ordering::Relaxed,
        );
        assert!(matches!(
            h.device.activate(h.context()),
            Err(DeviceError::Fatal(_))
        ));
        assert_eq!(h.registrar.len(), 0);
    }
    h.registrar.fail_at.store(u32::MAX, Ordering::Relaxed);
    h.device.activate(h.context()).unwrap();
    assert_eq!(h.registrar.len(), 3);
}

#[test]
fn malformed_tx_direction_length_and_address_require_device_reset() {
    for case in 0..4 {
        let mut h = Harness::new(vec![]);
        let mut header = guest(REQUEST, 7, 2696);
        if case == 1 {
            header.len = BUFFER_SIZE as u32 + 1;
        }
        let bytes = header.encode();
        h.tx.submit(
            &h.memory,
            &bytes,
            case == 0,
            if case == 2 {
                HEADER_LEN - 1
            } else {
                HEADER_LEN
            },
        );
        if case == 3 {
            h.memory
                .write_obj(0x300000u64, GuestAddress(h.tx.base))
                .unwrap();
        }
        assert!(matches!(
            h.device.on_event(DeviceEvent::QueueKick(1)),
            Err(DeviceError::NeedsReset(_))
        ));
        assert_eq!(h.registrar.len(), 1);
    }
}

#[test]
fn cyclic_tx_chain_requires_reset() {
    let mut h = Harness::new(vec![]);
    let bytes = guest(REQUEST, 7, 999).encode();
    h.tx.submit(&h.memory, &bytes, false, bytes.len());
    h.memory
        .write_obj(1u16, GuestAddress(h.tx.base + 12))
        .unwrap();
    h.memory
        .write_obj(0u16, GuestAddress(h.tx.base + 14))
        .unwrap();
    assert!(
        matches!(
            h.device.on_event(DeviceEvent::QueueKick(1)),
            Err(DeviceError::NeedsReset(_))
        ),
        "cyclic TX chain accepted"
    );
}

#[test]
fn cyclic_rx_chain_requires_reset() {
    let mut h = Harness::new(vec![]);
    let bytes = guest(REQUEST, 7, 999).encode();
    h.tx.submit(&h.memory, &bytes, false, bytes.len());
    h.memory
        .write_obj(3u16, GuestAddress(h.rx.base + 12))
        .unwrap();
    h.memory
        .write_obj(0u16, GuestAddress(h.rx.base + 14))
        .unwrap();
    assert!(
        matches!(
            h.device.on_event(DeviceEvent::QueueKick(1)),
            Err(DeviceError::NeedsReset(_))
        ),
        "cyclic RX chain accepted"
    );
}

#[test]
fn rx_starvation_retains_packets_until_guest_replenishes_buffers() {
    let mut h = Harness::new(vec![]);
    h.refill = false;
    for port in 0..SIZE as u32 {
        h.send(Packet {
            header: guest(REQUEST, port, 999),
            payload: vec![],
        });
    }
    assert_eq!(h.packets.len(), SIZE as usize);
    h.packets.clear();
    h.send(Packet {
        header: guest(REQUEST, 4321, 999),
        payload: vec![],
    });
    assert!(h.packets.is_empty());
    let active = h.device.active.as_ref().unwrap();
    assert_eq!(active.backend.outgoing.len(), 1);
    h.rx.submit(&h.memory, &[], true, HEADER_LEN);
    let reset = h.next(RST);
    assert_eq!(reset.header.dst_port, 4321);
    assert!(
        h.device
            .active
            .as_ref()
            .unwrap()
            .backend
            .outgoing
            .is_empty()
    );
}

#[test]
fn unix_backpressure_retains_bytes_and_counts_only_successful_writes() {
    let temp = Temp::new();
    let path = temp.path("ready");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = Harness::new(vec![PortMapping::Connect { port: 2696, path }]);
    let header = h.guest_connect(2696);
    let (mut host, _) = listener.accept().unwrap();
    host.set_nonblocking(true).unwrap();
    let mut sent = Vec::new();
    let mut forwarded = 0usize;
    for index in 0..64 {
        let bytes = vec![index; BUFFER_SIZE];
        h.send(data(&header, &bytes));
        sent.extend_from_slice(&bytes);
        while let Some(packet) = h.packets.pop_front() {
            if packet.header.op == CREDIT_UPDATE {
                forwarded = packet.header.fwd_cnt as usize;
            }
        }
        if forwarded < sent.len() {
            break;
        }
    }
    assert!(
        forwarded < sent.len(),
        "did not exercise Unix write backpressure"
    );
    for _ in 0..3 {
        h.tick();
    }
    assert!(
        h.packets.iter().all(|p| p.header.op != CREDIT_UPDATE),
        "WouldBlock advertised unforwarded credit"
    );
    let mut received = Vec::new();
    let mut buffer = [0u8; 8192];
    for _ in 0..1000 {
        loop {
            match host.read(&mut buffer) {
                Ok(0) => panic!("flow closed while writes were pending"),
                Ok(n) => received.extend_from_slice(&buffer[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("host read failed: {error}"),
            }
        }
        h.tick();
        while let Some(packet) = h.packets.pop_front() {
            assert_ne!(packet.header.op, RST);
            if packet.header.op == CREDIT_UPDATE {
                forwarded = packet.header.fwd_cnt as usize;
            }
        }
        if received.len() == sent.len() {
            break;
        }
    }
    assert_eq!(received, sent);
    assert_eq!(forwarded, sent.len());
}

struct IrqSignal(std::sync::mpsc::Sender<()>);
impl crate::irq::IrqChip for IrqSignal {
    fn set_line(&self, _line: u32, level: bool) -> crate::Result<()> {
        if level {
            let _ = self.0.send(());
        }
        Ok(())
    }
}

struct TransportHarness {
    mmio: crate::virtio::mmio::MmioTransport,
    workers: crate::virtio::worker::VirtioWorkers,
    device: Arc<Mutex<dyn VirtioDevice>>,
    memory: Arc<GuestMemoryMmap>,
    rx: Driver,
    tx: Driver,
    irq: std::sync::mpsc::Receiver<()>,
    packets: VecDeque<Packet>,
    events: EventLoop,
}

impl TransportHarness {
    fn new(mappings: Vec<PortMapping>) -> Self {
        let memory =
            Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x200000)]).unwrap());
        let events = EventLoop::new().unwrap();
        let (signal, irq) = std::sync::mpsc::channel();
        let line = crate::irq::IrqLine::new(Arc::new(IrqSignal(signal)), 5);
        let device: Arc<Mutex<dyn VirtioDevice>> =
            Arc::new(Mutex::new(Vsock::new(3, mappings).unwrap()));
        let interrupt = Arc::new(crate::virtio::interrupt::MmioInterrupt::new(line));
        let workers = crate::virtio::worker::VirtioWorkers::new(events.sender()).unwrap();
        let worker = workers.add(device.clone(), interrupt.clone());
        let mmio = crate::virtio::mmio::MmioTransport::new(
            device.clone(),
            interrupt,
            crate::virtio::mmio::MmioResources {
                memory: memory.clone(),
                sender: events.sender(),
                worker,
            },
        )
        .unwrap();
        Self {
            mmio,
            workers,
            device,
            memory,
            rx: Driver::new(0),
            tx: Driver::new(1),
            irq,
            packets: VecDeque::new(),
            events,
        }
    }
    fn read(&mut self, offset: u64) -> u32 {
        use crate::bus::BusDevice;
        let mut bytes = [0; 4];
        self.mmio.read(offset, &mut bytes);
        u32::from_le_bytes(bytes)
    }
    fn write(&mut self, offset: u64, value: u32) {
        use crate::bus::BusDevice;
        self.mmio.write(offset, &value.to_le_bytes());
    }
    fn activate(&mut self) {
        self.write(0x70, 1);
        self.write(0x70, 3);
        self.write(0x24, 0);
        self.write(0x20, 0);
        self.write(0x24, 1);
        self.write(0x20, 1);
        self.write(0x70, 11);
        assert_eq!(self.read(0x70), 11);
        for index in 0..3 {
            let driver = Driver::new(index);
            self.write(0x30, index as u32);
            assert_eq!(self.read(0x34), 256);
            self.write(0x38, SIZE as u32);
            self.write(0x80, driver.base as u32);
            self.write(0x84, 0);
            self.write(0x90, (driver.base + 0x1000) as u32);
            self.write(0x94, 0);
            self.write(0xa0, (driver.base + 0x2000) as u32);
            self.write(0xa4, 0);
            self.write(0x44, 1);
            assert_eq!(self.read(0x44), 1);
        }
        for _ in 0..SIZE {
            self.rx.submit(&self.memory, &[], true, HEADER_LEN + 4096);
        }
        self.write(0x70, 15);
        assert_eq!(self.read(0x70), 15);
    }
    fn send(&mut self, packet: Packet) {
        let mut bytes = packet.header.encode().to_vec();
        bytes.extend(packet.payload);
        self.tx.submit(&self.memory, &bytes, false, bytes.len());
        self.write(0x50, 1);
    }
    fn next(&mut self, op: u16) -> Packet {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let received = self.rx.take(&self.memory);
            let count = received.len();
            self.packets.extend(
                received
                    .into_iter()
                    .map(|data| Packet::read(&mut data.as_slice()).unwrap()),
            );
            if count != 0 {
                for _ in 0..count {
                    self.rx.submit(&self.memory, &[], true, HEADER_LEN + 4096);
                }
                self.write(0x50, 0);
            }
            if let Some(index) = self.packets.iter().position(|p| p.header.op == op) {
                return self.packets.remove(index).unwrap();
            }
            self.irq
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("device worker did not interrupt guest");
        }
    }
}

#[test]
fn mmio_negotiation_and_worker_bridge_real_sockets_without_manual_callbacks() {
    let temp = Temp::new();
    let path = temp.path("ready");
    let agent = temp.path("agent");
    let ready = UnixListener::bind(&path).unwrap();
    let listener = UnixListener::bind(&agent).unwrap();
    let mut h = TransportHarness::new(vec![
        PortMapping::Listen {
            port: 2695,
            listener,
        },
        PortMapping::Connect { port: 2696, path },
    ]);
    assert_eq!(h.read(0), 0x74726976);
    assert_eq!(h.read(4), 2);
    assert_eq!(h.read(8), 19);
    h.write(0x14, 1);
    assert_eq!(h.read(0x10), 1);
    h.write(0x14, 2);
    assert_eq!(h.read(0x10), 0);
    assert_eq!(h.read(0x100), 3);
    assert_eq!(h.read(0x104), 0);
    h.activate();
    let header = guest(REQUEST, 7000, 2696);
    h.send(Packet {
        header: header.clone(),
        payload: vec![],
    });
    h.next(RESPONSE);
    let (mut host, _) = ready.accept().unwrap();
    bounded(&host);
    h.send(data(&header, b"ready through worker"));
    let mut bytes = [0; 20];
    host.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"ready through worker");
    host.write_all(b"host to guest").unwrap();
    assert_eq!(h.next(RW).payload, b"host to guest");
    let mut agent = UnixStream::connect(&agent).unwrap();
    bounded(&agent);
    let request = h.next(REQUEST);
    let reply = guest(RESPONSE, 2695, request.header.src_port);
    h.send(Packet {
        header: reply.clone(),
        payload: vec![],
    });
    agent.write_all(b"grpc").unwrap();
    assert_eq!(h.next(RW).payload, b"grpc");
    h.send(data(&reply, b"reply"));
    let mut answer = [0; 5];
    agent.read_exact(&mut answer).unwrap();
    assert_eq!(&answer, b"reply");
    h.write(0x70, 0);
    assert_eq!(h.read(0x70), 0);
    assert_eq!(h.read(0x60), 0);
    assert_eq!(h.read(0x44), 0);
    assert_eq!(host.read(&mut [0]).unwrap(), 0);
    assert_eq!(agent.read(&mut [0]).unwrap(), 0);
    // DRIVER_OK starts a fresh worker after Status=0 closed the previous generation.
    h.rx = Driver::new(0);
    h.tx = Driver::new(1);
    h.packets.clear();
    for index in 0..3 {
        h.memory
            .write_slice(&vec![0; 0x3000], GuestAddress(Driver::new(index).base))
            .unwrap();
    }
    h.activate();
    let mut restarted = UnixStream::connect(temp.path("agent")).unwrap();
    bounded(&restarted);
    let request = h.next(REQUEST);
    h.send(Packet {
        header: guest(RESPONSE, 2695, request.header.src_port),
        payload: vec![],
    });
    restarted.write_all(b"after reset").unwrap();
    assert_eq!(h.next(RW).payload, b"after reset");
    h.workers.shutdown().unwrap();
    assert!(h.events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn mmio_rejects_features_and_worker_notifies_needs_reset_on_bad_queues() {
    let mut h = TransportHarness::new(vec![]);
    h.write(0x70, 1);
    h.write(0x70, 3);
    h.write(0x24, 0);
    h.write(0x20, 1);
    h.write(0x24, 1);
    h.write(0x20, 1);
    h.write(0x70, 11);
    assert_eq!(h.read(0x70) & 8, 0);
    h.write(0x70, 0);
    h.activate();
    let bytes = guest(REQUEST, 7, 999).encode();
    h.tx.submit(&h.memory, &bytes, true, bytes.len());
    h.write(0x50, 1);
    h.irq.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(h.read(0x70) & 64, 64);
    assert_eq!(h.read(0x60) & 2, 2);
    h.write(0x64, 2);
    assert_eq!(h.read(0x60) & 2, 0);
    assert!(h.events.wait(Some(Duration::ZERO)).unwrap().is_none());
    h.write(0x70, 0);
    assert_eq!(h.read(0x70), 0);
}

impl Drop for TransportHarness {
    fn drop(&mut self) {
        self.workers.shutdown().unwrap();
    }
}

#[test]
fn production_worker_drains_a_host_burst_without_more_kicks_or_writes() {
    let temp = Temp::new();
    let path = temp.path("burst");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = TransportHarness::new(vec![PortMapping::Connect { port: 2696, path }]);
    h.activate();
    h.send(Packet {
        header: guest(REQUEST, 7000, 2696),
        payload: vec![],
    });
    h.next(RESPONSE);
    let (mut host, _) = listener.accept().unwrap();
    bounded(&host);
    // Fits macOS's Unix send buffer while still requiring two 4 KiB reads
    // and a third read to discover EOF.
    let payload: Vec<_> = (0..2 * 4096).map(|i| (i % 251) as u8).collect();
    // Hold the real device callback while publishing one complete host burst.
    // The worker must consume it in multiple bounded rounds, not rely on a
    // fresh host write or guest refill kick to manufacture another event.
    {
        let _device = h.device.lock().unwrap();
        host.write_all(&payload).unwrap();
        host.shutdown(Shutdown::Write).unwrap();
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut received = Vec::new();
    let mut shutdown = false;
    while !shutdown {
        for bytes in h.rx.take(&h.memory) {
            let packet = Packet::read(&mut bytes.as_slice()).unwrap();
            match packet.header.op {
                RW => received.extend(packet.payload),
                SHUTDOWN => {
                    assert_eq!(received, payload, "shutdown overtook the stream tail");
                    assert_eq!(packet.header.flags, SEND);
                    shutdown = true;
                }
                op => panic!("unexpected operation {op}"),
            }
        }
        if !shutdown {
            h.irq
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("production continuation stalled before host EOF");
        }
    }
    assert_eq!(received, payload);
    assert!(h.events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn activation_schedules_through_private_readiness_without_public_waker() {
    let mut h = Harness::new(vec![]);
    assert_eq!(
        h.wakes.load(Ordering::Relaxed),
        0,
        "vsock must not rely on the public poller waker for callbacks"
    );
    let ready = h.registrar.ready();
    assert_eq!(
        ready.len(),
        1,
        "activation must schedule a private readiness callback"
    );
    // A queue kick while the activation callback is pending must not add a source.
    h.device.on_event(DeviceEvent::QueueKick(0)).unwrap();
    assert_eq!(h.registrar.len(), 1);
    h.device.on_event(ready[0]).unwrap();
    assert!(
        h.registrar.ready().is_empty(),
        "an idle device must stop scheduling"
    );
    h.device.reset().unwrap();
    assert_eq!(h.registrar.len(), 0);
}

#[test]
fn activation_requires_three_ready_queues_and_preserves_the_active_backend() {
    let temp = Temp::new();
    let mut h = Harness::new(vec![PortMapping::Listen {
        port: 2695,
        listener: UnixListener::bind(temp.path("activation")).unwrap(),
    }]);
    assert!(matches!(
        h.device.activate(h.context()),
        Err(DeviceError::NeedsReset(_))
    ));
    assert_eq!(h.registrar.len(), 2);
    h.device.reset().unwrap();
    h.device.set_features(0).unwrap();
    for unready in 0..3 {
        let mut ctx = h.context();
        let mut queues: Vec<_> = (0..3).map(|i| Driver::new(i).queue()).collect();
        queues[unready].set_ready(false);
        ctx.queues = crate::virtio::queue::VirtQueues::prepare(
            queues,
            &[256; 3],
            false,
            false,
            h.memory.clone(),
        )
        .unwrap();
        assert!(matches!(
            h.device.activate(ctx),
            Err(DeviceError::NeedsReset(_))
        ));
        assert_eq!(h.registrar.len(), 0);
    }
    let mut ctx = h.context();
    ctx.queues = crate::virtio::queue::VirtQueues::prepare(
        vec![h.rx.queue(), h.tx.queue()],
        &[256; 2],
        false,
        false,
        h.memory.clone(),
    )
    .unwrap();
    assert!(matches!(
        h.device.activate(ctx),
        Err(DeviceError::NeedsReset(_))
    ));
    h.device.activate(h.context()).unwrap();
    assert_eq!(h.registrar.len(), 2);
}

#[test]
fn snapshots_stay_unsupported_and_event_buffers_remain_available() {
    use crate::virtio::{DeviceSnapshot, RestoreContext, SnapshotError};
    let mut h = Harness::new(vec![]);
    let mut event = Driver::new(2);
    event.submit(&h.memory, &[], true, 4);
    h.device.on_event(DeviceEvent::QueueKick(2)).unwrap();
    let state = h
        .device
        .active
        .as_ref()
        .unwrap()
        .ctx
        .queues
        .state(2)
        .unwrap();
    assert_eq!((state.next_avail, state.next_used), (0, 0));
    for active in [true, false] {
        if !active {
            h.device.reset().unwrap();
        }
        assert_eq!(h.device.spec().snapshot, SnapshotSupport::Unsupported);
        assert_eq!(h.device.save_state(), Err(SnapshotError::Unsupported));
        assert_eq!(h.device.quiesce(), Err(DeviceError::Unsupported("quiesce")));
        assert_eq!(
            h.device.restore_state(
                DeviceSnapshot {
                    format: 19,
                    version: 1,
                    payload: vec![]
                },
                RestoreContext,
            ),
            Err(DeviceError::Unsupported("restore_state"))
        );
    }
}
