// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{
    events::EventLoop,
    memory::GuestMemoryMmap,
    virtio::{
        DeviceSnapshot, EventError, EventRegistrar, RestoreContext, SnapshotError, VirtioInterrupt,
        WorkerContext, queue::VirtQueues,
    },
};
use mio::{Events, Poll, Token};
use std::{
    collections::HashMap,
    fs,
    os::{fd::OwnedFd, unix::net::UnixListener},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use virtio_queue::{Queue, QueueT};
use vm_memory::GuestAddress;

pub(crate) const MACS: [[u8; 6]; 2] = [[0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xee], [0x02, 1, 2, 3, 4, 5]];
const RAM_LEN: usize = 0x1400000;
const DATA: u64 = 0x10000;
const STRIDE: u64 = 0x11000;
const QUEUE_BASES: [u64; 2] = [0x1000, 0x5000];

#[derive(Default)]
struct Interrupt {
    count: AtomicUsize,
    status: AtomicU8,
}
impl VirtioInterrupt for Interrupt {
    fn raise(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }
    fn interrupt_status(&self) -> u8 {
        0
    }
    fn ack_interrupt(&self, _: u8) {}
    fn config_generation(&self) -> u8 {
        0
    }
    fn raise_config(&self) {}
    fn device_status(&self) -> u8 {
        self.status.load(Ordering::SeqCst)
    }
    fn set_device_status(&self, status: u8) {
        self.status.store(status, Ordering::SeqCst);
    }
    fn set_needs_reset(&self) {
        self.status
            .fetch_or(crate::virtio::NEEDS_RESET, Ordering::SeqCst);
    }
}

struct Registration {
    source: Box<dyn EventSource>,
    event: DeviceEvent,
}
struct PollState {
    poll: Poll,
    sources: HashMap<SourceId, Registration>,
    next: u32,
}
pub(crate) struct Registrar {
    state: Mutex<PollState>,
    fail_register: Mutex<bool>,
}
impl Registrar {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(PollState {
                poll: Poll::new().unwrap(),
                sources: HashMap::new(),
                next: 0,
            }),
            fail_register: Mutex::new(false),
        }
    }
    pub(crate) fn ready(&self, timeout: Duration) -> Vec<DeviceEvent> {
        let mut state = self.state.lock().unwrap();
        let mut events = Events::with_capacity(8);
        state.poll.poll(&mut events, Some(timeout)).unwrap();
        events
            .iter()
            .filter_map(|event| {
                state
                    .sources
                    .get(&SourceId(event.token().0 as u32))
                    .map(|source| source.event)
            })
            .collect()
    }
}
impl EventRegistrar for Registrar {
    fn register(&self, mut source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        if *self.fail_register.lock().unwrap() {
            return Err(EventError::Closed);
        }
        let mut state = self.state.lock().unwrap();
        let id = SourceId(state.next);
        state.next += 1;
        // Deliberately request READABLE: the Net source must register WRITABLE too.
        state
            .poll
            .registry()
            .register(source.as_source(), Token(id.0 as usize), Interest::READABLE)
            .unwrap();
        state.sources.insert(
            id,
            Registration {
                source,
                event: DeviceEvent::BackendReady(id),
            },
        );
        Ok(id)
    }
    fn deregister(&self, id: SourceId) {
        let mut state = self.state.lock().unwrap();
        if let Some(mut registration) = state.sources.remove(&id) {
            state
                .poll
                .registry()
                .deregister(registration.source.as_source())
                .unwrap();
        }
    }
}

pub(crate) struct SocketPath(pub(crate) PathBuf);
impl SocketPath {
    pub(crate) fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        Self(std::env::temp_dir().join(format!(
            "vmm-net-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for SocketPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct Harness {
    net: Net,
    memory: Arc<GuestMemoryMmap>,
    interrupt: Arc<Interrupt>,
    registrar: Arc<Registrar>,
    available: [u16; 2],
    queue_size: u16,
    _event_loop: EventLoop,
    path: SocketPath,
}
impl Harness {
    fn new(mac: [u8; 6]) -> Self {
        let path = SocketPath::new();
        Self {
            net: Net::new(path.0.clone(), mac),
            memory: Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), RAM_LEN)]).unwrap()),
            interrupt: Arc::new(Interrupt::default()),
            registrar: Arc::new(Registrar::new()),
            available: [0, 0],
            queue_size: 8,
            _event_loop: EventLoop::new().unwrap(),
            path,
        }
    }
    fn context(&self, size: u16) -> ActivationContext {
        let queues = QUEUE_BASES
            .into_iter()
            .map(|base| {
                let mut queue = Queue::new(QUEUE_SIZE).unwrap();
                queue.set_size(size);
                queue.set_desc_table_address(Some(base as u32), None);
                queue.set_avail_ring_address(Some((base + 0x1000) as u32), None);
                queue.set_used_ring_address(Some((base + 0x2000) as u32), None);
                queue.set_ready(true);
                queue
            })
            .collect();
        ActivationContext {
            memory: self.memory.clone(),
            queues: VirtQueues::prepare(queues, SPEC.queue_max, false, false, self.memory.clone())
                .unwrap(),
            interrupt: self.interrupt.clone(),
            events: self.registrar.clone(),
            waker: Arc::new(|| {}),
            sender: self._event_loop.sender(),
        }
    }
    fn activate(&mut self, size: u16) -> UnixStream {
        self.queue_size = size;
        let listener = UnixListener::bind(&self.path.0).unwrap();
        self.net.set_features(FEATURES).unwrap();
        self.net.activate(self.context(size)).unwrap();
        let peer = listener.accept().unwrap().0;
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        peer.set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        self.pump();
        peer
    }
    fn connected() -> (Self, UnixStream) {
        let mut harness = Self::new(MACS[0]);
        let peer = harness.activate(8);
        (harness, peer)
    }
    fn event(&mut self, event: DeviceEvent) {
        self.net.on_event(event).unwrap();
    }
    fn backend(&mut self) {
        self.event(DeviceEvent::BackendReady(
            self.net.active.as_ref().unwrap().source_id,
        ));
    }
    fn pump(&mut self) {
        for _ in 0..1024 {
            let events = self.registrar.ready(Duration::ZERO);
            if events.is_empty() {
                return;
            }
            for event in events {
                self.event(event);
            }
        }
        panic!("device kept rescheduling without waiting for readiness");
    }
    fn descriptor(&self, queue: usize, index: u16, addr: u64, len: usize, flags: u16, next: u16) {
        self.memory
            .write_obj(
                Descriptor::new(addr, len as u32, flags, next),
                GuestAddress(QUEUE_BASES[queue] + u64::from(index) * 16),
            )
            .unwrap();
    }
    fn submit(&mut self, queue: usize, head: u16) {
        let size = self.queue_size;
        let base = QUEUE_BASES[queue] + 0x1000;
        self.memory
            .write_obj(
                head.to_le(),
                GuestAddress(base + 4 + u64::from(self.available[queue] % size) * 2),
            )
            .unwrap();
        self.available[queue] = self.available[queue].wrapping_add(1);
        self.memory
            .store(
                self.available[queue].to_le(),
                GuestAddress(base + 2),
                Ordering::Release,
            )
            .unwrap();
    }
    fn tx(&mut self, head: u16, bytes: &[u8]) {
        let addr = DATA + u64::from(head) * STRIDE;
        self.memory.write_slice(bytes, GuestAddress(addr)).unwrap();
        self.descriptor(TX, head, addr, bytes.len(), 0, 0);
        self.submit(TX, head);
    }
    fn rx(&mut self, head: u16, capacity: usize) {
        self.descriptor(RX, head, DATA + u64::from(head) * STRIDE, capacity, 2, 0);
        self.submit(RX, head);
    }
    fn used(&self, queue: usize) -> u16 {
        u16::from_le(
            self.memory
                .read_obj(GuestAddress(QUEUE_BASES[queue] + 0x2002))
                .unwrap(),
        )
    }
    fn completion(&self, queue: usize, index: u16) -> (u32, u32) {
        let base = QUEUE_BASES[queue] + 0x2004 + u64::from(index) * 8;
        (
            u32::from_le(self.memory.read_obj(GuestAddress(base)).unwrap()),
            u32::from_le(self.memory.read_obj(GuestAddress(base + 4)).unwrap()),
        )
    }
    fn bytes(&self, addr: u64, len: usize) -> Vec<u8> {
        let mut bytes = vec![0; len];
        self.memory
            .read_slice(&mut bytes, GuestAddress(addr))
            .unwrap();
        bytes
    }
    fn assert_reset(&mut self, event: DeviceEvent) {
        assert!(matches!(
            self.net.on_event(event),
            Err(DeviceError::NeedsReset(_))
        ));
        assert!(self.net.active.is_none());
        assert!(self.registrar.state.lock().unwrap().sources.is_empty());
        assert!(matches!(
            self.net.on_event(event),
            Err(DeviceError::NeedsReset(_))
        ));
    }
}
fn packet(frame: &[u8]) -> Vec<u8> {
    [vec![0; HEADER_LEN], frame.to_vec()].concat()
}
fn wire(frame: &[u8]) -> Vec<u8> {
    [(frame.len() as u32).to_be_bytes().as_slice(), frame].concat()
}
fn receive_packet(frame: &[u8]) -> Vec<u8> {
    let mut bytes = packet(frame);
    bytes[10] = 1;
    bytes
}
fn read_wire(peer: &mut UnixStream) -> Vec<u8> {
    let mut prefix = [0; 4];
    peer.read_exact(&mut prefix).unwrap();
    let mut frame = vec![0; u32::from_be_bytes(prefix) as usize];
    peer.read_exact(&mut frame).unwrap();
    frame
}

#[test]
fn configuration_features_and_device_activation() {
    for mac in MACS {
        let mut harness = Harness::new(mac);
        assert_eq!(*harness.net.spec(), SPEC);
        assert_eq!(
            harness.net.set_features(FEATURES | 1),
            Err(FeatureError { unsupported: 1 })
        );
        harness.net.set_features(0).unwrap();
        assert_eq!(
            harness.net.set_features(1 << 32),
            Err(FeatureError {
                unsupported: 1 << 32
            })
        );
        harness.net.write_config(0, &[0xff; 6]).unwrap();
        let mut config = [0xff; 4];
        harness.net.read_config(2, &mut config).unwrap();
        assert_eq!(config, mac[2..]);
        let _peer = harness.activate(8);
        assert_eq!(harness.net.spec().snapshot, SnapshotSupport::Unsupported);
    }
}

#[test]
fn tx_gathers_a_split_header_and_completes_once() {
    let (mut h, mut peer) = Harness::connected();
    let frame: Vec<u8> = (0..120).collect();
    let mut bytes = packet(&frame);
    bytes[0] = 0x80; // Unknown flags must be ignored.
    bytes[2..4].copy_from_slice(&14u16.to_le_bytes()); // hdr_len is a hint.
    let sizes = [5, 4, bytes.len() - 9];
    let mut offset = 0;
    for (i, len) in sizes.into_iter().enumerate() {
        let addr = DATA + i as u64 * 0x1000;
        h.memory
            .write_slice(&bytes[offset..offset + len], GuestAddress(addr))
            .unwrap();
        h.descriptor(TX, i as u16, addr, len, u16::from(i < 2), (i + 1) as u16);
        offset += len;
    }
    h.submit(TX, 0);
    h.event(DeviceEvent::QueueKick(1));
    assert_eq!(read_wire(&mut peer), frame);
    assert_eq!(h.used(TX), 1);
    assert_eq!(h.completion(TX, 0), (0, 0));
    assert_eq!(h.interrupt.count.load(Ordering::SeqCst), 1);
    h.backend();
    assert_eq!(h.used(TX), 1);
    peer.set_nonblocking(true).unwrap();
    let mut byte = [0];
    assert_eq!(
        peer.read(&mut byte).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[test]
fn tx_ignores_unused_num_buffers_from_linux_without_mergeable_rx() {
    let (mut h, mut peer) = Harness::connected();
    let frame = [0x37; 60];
    let mut bytes = packet(&frame);
    bytes[10..12].copy_from_slice(&0x0102u16.to_le_bytes());
    h.tx(0, &bytes);
    h.net
        .on_event(DeviceEvent::QueueKick(1))
        .expect("unused TX num_buffers must not reset the device");
    assert_eq!(read_wire(&mut peer), frame);
    assert_eq!(h.completion(TX, 0), (0, 0));
    h.event(DeviceEvent::QueueKick(1));
    assert_eq!(h.used(TX), 1);
}

#[test]
fn rx_handles_fragmented_prefix_body_and_coalesced_frames() {
    let (mut h, mut peer) = Harness::connected();
    let first = vec![0x31; 70];
    let second = vec![0x42; 90];
    h.descriptor(RX, 0, DATA, 7, 3, 1);
    h.descriptor(RX, 1, DATA + 0x1000, 100, 2, 0);
    h.submit(RX, 0);
    h.rx(2, 200);
    let bytes = wire(&first);
    peer.write_all(&bytes[..2]).unwrap();
    h.backend();
    assert_eq!(h.used(RX), 0);
    peer.write_all(&bytes[2..9]).unwrap();
    h.backend();
    assert_eq!(h.used(RX), 0);
    peer.write_all(&[&bytes[9..], &wire(&second)].concat())
        .unwrap();
    h.backend();
    assert_eq!(h.used(RX), 2);
    assert_eq!(h.completion(RX, 0), (0, 82));
    assert_eq!(h.completion(RX, 1), (2, 102));
    assert_eq!(
        [h.bytes(DATA, 7), h.bytes(DATA + 0x1000, 75)].concat(),
        receive_packet(&first)
    );
    assert_eq!(h.bytes(DATA + 2 * STRIDE, 102), receive_packet(&second));
    assert_eq!(h.interrupt.count.load(Ordering::SeqCst), 2);
}

#[test]
fn rx_pauses_without_buffers_then_resumes_existing_readiness() {
    let (mut h, mut peer) = Harness::connected();
    let first = vec![0x33; 80];
    let second = vec![0x44; 80];
    peer.write_all(&[wire(&first), wire(&second)].concat())
        .unwrap();
    h.backend();
    assert_eq!(
        h.net.active.as_ref().unwrap().rx.bytes,
        receive_packet(&first)
    );
    h.rx(0, 100);
    h.rx(1, 100);
    h.event(DeviceEvent::QueueKick(0));
    assert_eq!(h.used(RX), 2);
    assert_eq!(h.bytes(DATA, 92), receive_packet(&first));
    assert_eq!(h.bytes(DATA + STRIDE, 92), receive_packet(&second));
    // A queue kick resumes bytes already waiting, without a new backend edge.
    peer.write_all(&wire(&first)).unwrap();
    h.backend();
    peer.write_all(&wire(&second)).unwrap();
    h.rx(2, 100);
    h.event(DeviceEvent::QueueKick(0));
    assert_eq!(h.used(RX), 3); // The second packet waits for another guest buffer.
    h.rx(3, 100);
    h.event(DeviceEvent::QueueKick(0));
    assert_eq!(h.used(RX), 4);
}

#[test]
fn undersized_rx_is_returned_without_any_truncated_write() {
    let (mut h, mut peer) = Harness::connected();
    h.memory
        .write_slice(&[0xaa; 100], GuestAddress(DATA))
        .unwrap();
    h.rx(0, 20);
    h.rx(1, 200);
    let first = vec![0x55; 80];
    let second = vec![0x66; 90];
    peer.write_all(&[wire(&first), wire(&second)].concat())
        .unwrap();
    h.backend();
    assert_eq!(h.completion(RX, 0), (0, 0));
    assert_eq!(h.bytes(DATA, 100), [0xaa; 100]);
    assert_eq!(h.completion(RX, 1), (1, 102));
    assert_eq!(h.bytes(DATA + STRIDE, 102), receive_packet(&second));
}

#[test]
fn invalid_frame_lengths_fail_before_reading_a_body() {
    for len in [0, 1, 13, MAX_FRAME_LEN as u32 + 1, u32::MAX] {
        let (mut h, mut peer) = Harness::connected();
        peer.write_all(&len.to_be_bytes()).unwrap();
        h.assert_reset(DeviceEvent::BackendReady(SourceId(0)));
        assert_eq!(h.used(RX), 0);
    }
}

#[test]
fn malformed_descriptors_never_reach_guest_or_backend() {
    for queue in [RX, TX] {
        // Bad address, direction, indirect/unknown flags, out-of-range next, cycle.
        for (addr, flags, next) in [
            (RAM_LEN as u64 - 4, 0, 0),
            (u64::MAX, 0, 0),
            (DATA, 2, 0),
            (DATA, 4, 0),
            (DATA, 8, 0),
            (DATA, 1, 8),
            (DATA, 1, 0),
        ] {
            let (mut h, mut peer) = Harness::connected();
            let flags = flags ^ if queue == RX { 2 } else { 0 };
            h.memory
                .write_slice(&packet(&[0x11; 60]), GuestAddress(DATA))
                .unwrap();
            h.descriptor(queue, 0, addr, 72, flags, next);
            h.submit(queue, 0);
            if queue == RX {
                peer.write_all(&wire(&[0x22; 60])).unwrap();
            }
            h.assert_reset(if queue == RX {
                DeviceEvent::BackendReady(SourceId(0))
            } else {
                DeviceEvent::QueueKick(1)
            });
            assert_eq!(h.used(queue), 0);
            peer.set_nonblocking(true).unwrap();
            let mut byte = [0];
            match peer.read(&mut byte) {
                Ok(0) => {}
                // Linux resets the peer when RX closes with the frame still unread.
                Err(e) if queue == RX && e.kind() == io::ErrorKind::ConnectionReset => {
                    assert_eq!(peer.read(&mut byte).unwrap(), 0);
                }
                result => panic!("expected closed backend without output, got {result:?}"),
            }
        }
    }
}

#[test]
fn bad_available_heads_and_index_require_reset() {
    for queue in [RX, TX] {
        for bad_index in [false, true] {
            let (mut h, mut peer) = Harness::connected();
            if bad_index {
                h.memory
                    .write_obj(9u16.to_le(), GuestAddress(QUEUE_BASES[queue] + 0x1002))
                    .unwrap();
            } else {
                h.submit(queue, 8);
            }
            if queue == RX {
                peer.write_all(&wire(&[0x22; 60])).unwrap();
            }
            h.assert_reset(if queue == RX {
                DeviceEvent::BackendReady(SourceId(0))
            } else {
                DeviceEvent::QueueKick(1)
            });
        }
    }
}

#[test]
fn invalid_tx_headers_and_lengths_require_reset() {
    for (offset, value) in [(0, 1), (0, 2), (0, 4), (1, 1)] {
        let (mut h, _peer) = Harness::connected();
        let mut bytes = packet(&[0x11; 60]);
        bytes[offset] = value;
        h.tx(0, &bytes);
        h.assert_reset(DeviceEvent::QueueKick(1));
    }
    for len in [0, 11, 25, HEADER_LEN + MAX_FRAME_LEN + 1] {
        let (mut h, _peer) = Harness::connected();
        h.tx(0, &vec![0; len]);
        h.assert_reset(DeviceEvent::QueueKick(1));
    }
}

#[test]
fn connection_failure_disconnect_and_event_failure_cleanup() {
    let mut h = Harness::new(MACS[0]);
    h.net.set_features(FEATURES).unwrap();
    assert!(matches!(
        h.net.activate(h.context(8)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert!(h.registrar.state.lock().unwrap().sources.is_empty());
    h.net.reset().unwrap();
    let peer = h.activate(8);
    drop(peer);
    h.assert_reset(DeviceEvent::BackendReady(
        h.net.active.as_ref().unwrap().source_id,
    ));
    for partial in [vec![0, 0], [vec![0, 0, 0, 60], vec![0; 15]].concat()] {
        let (mut h, mut peer) = Harness::connected();
        peer.write_all(&partial).unwrap();
        drop(peer);
        h.assert_reset(DeviceEvent::BackendReady(SourceId(0)));
    }
    let mut h = Harness::new(MACS[0]);
    let listener = UnixListener::bind(&h.path.0).unwrap();
    *h.registrar.fail_register.lock().unwrap() = true;
    assert!(matches!(
        h.net.activate(h.context(8)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert!(h.registrar.state.lock().unwrap().sources.is_empty());
    let mut peer = listener.accept().unwrap().0;
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
}

#[test]
fn reset_and_drop_release_registration_and_discard_inflight_rx() {
    for partial in [wire(&[0x31; 60])[..9].to_vec(), wire(&[0x31; 60])] {
        let (mut h, mut peer) = Harness::connected();
        peer.write_all(&partial).unwrap();
        h.backend();
        let old_id = h.net.active.as_ref().unwrap().source_id;
        h.net.reset().unwrap();
        assert!(h.registrar.state.lock().unwrap().sources.is_empty());
        let mut byte = [0];
        assert_eq!(peer.read(&mut byte).unwrap(), 0);
        fs::remove_file(&h.path.0).unwrap();
        let mut peer = h.activate(8);
        let id = h.net.active.as_ref().unwrap().source_id;
        assert_ne!(id, old_id);
        h.event(DeviceEvent::BackendReady(old_id));
        h.rx(0, 100);
        peer.write_all(&wire(&[0x42; 60])).unwrap();
        h.backend();
        assert_eq!(h.bytes(DATA, 72), receive_packet(&[0x42; 60]));
        let registrar = h.registrar.clone();
        drop(h);
        assert!(registrar.state.lock().unwrap().sources.is_empty());
        assert_eq!(peer.read(&mut byte).unwrap(), 0);
    }
}

#[test]
fn tx_backpressure_keeps_progress_and_never_duplicates_frames() {
    let mut h = Harness::new(MACS[0]);
    let mut peer = h.activate(256);
    let mut expected = Vec::new();
    for head in 0..256u16 {
        let mut frame = vec![head as u8; MAX_FRAME_LEN];
        frame[..2].copy_from_slice(&head.to_be_bytes());
        expected.extend(wire(&frame));
        h.tx(head, &packet(&frame));
    }
    h.event(DeviceEvent::QueueKick(1));
    assert!(h.used(TX) < 256, "peer must exert backpressure");
    let active = h.net.active.as_ref().unwrap();
    assert!(active.tx.is_some());
    assert!(active.pending[TX].len() + usize::from(active.tx.is_some()) <= 256);
    let used_before = h.used(TX);
    let written_before = active.tx.as_ref().unwrap().written;
    h.event(DeviceEvent::QueueKick(1));
    assert_eq!(h.used(TX), used_before);
    assert_eq!(
        h.net.active.as_ref().unwrap().tx.as_ref().unwrap().written,
        written_before
    );
    peer.set_nonblocking(true).unwrap();
    let mut received = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while received.len() < expected.len() || h.used(TX) != 256 {
        assert!(Instant::now() < deadline, "backpressure never drained");
        let mut buffer = [0; 8192];
        loop {
            match peer.read(&mut buffer) {
                Ok(0) => panic!("unexpected EOF"),
                Ok(n) => received.extend_from_slice(&buffer[..n]),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("{e}"),
            }
        }
        for event in h.registrar.ready(Duration::from_millis(10)) {
            h.event(event);
        }
        h.pump();
    }
    assert_eq!(received, expected);
    for index in 0..256 {
        assert_eq!(h.completion(TX, index), (u32::from(index), 0));
    }
    assert!(h.net.active.as_ref().unwrap().pending[TX].is_empty());
    assert!(h.net.active.as_ref().unwrap().tx.is_none());
}

#[test]
fn io_budget_rearms_readiness_without_more_peer_writes() {
    let mut h = Harness::new(MACS[0]);
    let mut peer = h.activate(256);
    let frame = vec![0x19; 14];
    for head in 0..256u16 {
        h.rx(head, 100);
    }
    peer.write_all(&wire(&frame).repeat(256)).unwrap();
    h.backend();
    assert!(h.used(RX) > 0 && h.used(RX) < 256);
    // The peer writes no more data; registering again must observe pending readiness.
    h.pump();
    assert_eq!(h.used(RX), 256);
    for head in 0..256u16 {
        assert_eq!(
            h.bytes(DATA + u64::from(head) * STRIDE, 26),
            receive_packet(&frame)
        );
    }
}

impl Active {
    fn transmit_for_test(
        &mut self,
        write: impl FnMut(&mut UnixStream, &[u8]) -> io::Result<usize>,
    ) -> Result<(), DeviceError> {
        self.transmit_with(write)
    }
}

#[test]
fn tx_budget_rearms_readiness_with_an_incomplete_chain() {
    let (mut h, mut peer) = Harness::connected();
    let frame = [0x63; 60];
    h.tx(0, &packet(&frame));
    let active = h.net.active.as_mut().unwrap();
    let old_source = active.source_id;
    active.collect(TX).unwrap();
    let mut attempts = 0;
    // Keep the socket writable: signal timing and send-buffer sizes must not
    // decide whether the last budgeted write leaves an incomplete chain.
    active
        .transmit_for_test(|stream, bytes| {
            attempts += 1;
            if attempts < IO_BUDGET {
                Err(io::ErrorKind::Interrupted.into())
            } else {
                stream.write(&bytes[..1])
            }
        })
        .unwrap();
    assert_eq!(attempts, IO_BUDGET);
    assert_eq!(active.tx.as_ref().unwrap().written, HEADER_LEN - 4 + 1);
    assert_ne!(
        active.source_id, old_source,
        "TX budget must rearm readiness"
    );
    assert_eq!(h.used(TX), 0);

    // No peer read or guest kick may create a new writable edge before completion.
    let deadline = Instant::now() + Duration::from_secs(3);
    while h.used(TX) == 0 {
        assert!(Instant::now() < deadline, "TX budget continuation stalled");
        for event in h.registrar.ready(Duration::from_millis(10)) {
            h.event(event);
        }
    }
    h.pump();
    assert_eq!(h.used(TX), 1);
    assert_eq!(h.completion(TX, 0), (0, 0));
    assert!(h.net.active.as_ref().unwrap().tx.is_none());
    assert_eq!(read_wire(&mut peer), frame);
    peer.set_nonblocking(true).unwrap();
    assert_eq!(
        peer.read(&mut [0]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[test]
fn pending_connect_defers_queue_io_until_backend_readiness() {
    let (mut h, mut peer) = Harness::connected();
    // An established socket supplies the completion boundary; force only the
    // pending state so the queue gate can be checked without a backlog race.
    let active = h.net.active.as_mut().unwrap();
    active.connecting = true;
    h.tx(0, &packet(&[0x21; 60]));
    h.event(DeviceEvent::QueueKick(1));
    assert_eq!(h.used(TX), 0);
    h.backend();
    assert_eq!(read_wire(&mut peer), [0x21; 60]);
    assert!(!h.net.active.as_ref().unwrap().connecting);
}

#[test]
fn pending_connect_completion_failure_releases_active_state() {
    let (mut h, _peer) = Harness::connected();
    let path = SocketPath::new();
    let listener = UnixListener::bind(&path.0).unwrap();
    listener.set_nonblocking(true).unwrap();
    // A listening stream socket has no peer; owned conversion avoids raw FDs
    // and a connect/backlog race while reaching the real peer_addr() check.
    let stream = UnixStream::from(OwnedFd::from(listener));
    assert!(stream.take_error().unwrap().is_none());
    assert!(stream.peer_addr().is_err());
    let active = h.net.active.as_mut().unwrap();
    active.stream = stream;
    active.connecting = true;
    let event = DeviceEvent::BackendReady(active.source_id);

    assert!(matches!(
        h.net.on_event(event),
        Err(DeviceError::NeedsReset("complete gvproxy connect"))
    ));
    assert!(h.net.failed);
    assert!(h.net.active.is_none());
    assert!(h.registrar.state.lock().unwrap().sources.is_empty());
    assert!(matches!(
        h.net.on_event(event),
        Err(DeviceError::NeedsReset("net"))
    ));
}

#[test]
fn rx_accepts_the_maximum_frame_and_validates_the_entire_chain_before_writing() {
    let (mut h, mut peer) = Harness::connected();
    h.rx(0, MAX_FRAME_LEN + HEADER_LEN);
    let frame = vec![0x47; MAX_FRAME_LEN];
    // Write concurrently: macOS's send buffer can be smaller than one frame.
    let writer = std::thread::spawn(move || {
        peer.write_all(&wire(&frame)).unwrap();
        peer
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while h.used(RX) == 0 {
        assert!(Instant::now() < deadline);
        for event in h.registrar.ready(Duration::from_millis(10)) {
            h.event(event);
        }
        h.pump();
    }
    let mut peer = writer.join().unwrap();
    assert_eq!(
        h.completion(RX, 0),
        (0, (MAX_FRAME_LEN + HEADER_LEN) as u32)
    );
    assert_eq!(
        h.bytes(DATA, MAX_FRAME_LEN + HEADER_LEN),
        receive_packet(&vec![0x47; MAX_FRAME_LEN])
    );
    h.memory
        .write_slice(&[0xaa; 32], GuestAddress(DATA))
        .unwrap();
    h.descriptor(RX, 1, DATA, 32, 3, 2);
    h.descriptor(RX, 2, RAM_LEN as u64 - 4, 100, 2, 0);
    h.submit(RX, 1);
    peer.write_all(&wire(&[0x19; 60])).unwrap();
    h.assert_reset(DeviceEvent::BackendReady(SourceId(0)));
    assert_eq!(h.bytes(DATA, 32), [0xaa; 32]);
    assert_eq!(h.used(RX), 1);
}

#[test]
fn reset_discards_pending_tx_and_new_connection_gets_only_new_packets() {
    let mut h = Harness::new(MACS[0]);
    let old_peer = h.activate(256);
    for head in 0..256 {
        h.tx(head, &packet(&vec![0x31; MAX_FRAME_LEN]));
    }
    h.event(DeviceEvent::QueueKick(1));
    assert!(h.net.active.as_ref().unwrap().tx.is_some());
    h.net.reset().unwrap();
    drop(old_peer);
    h.available = [0; 2];
    for base in QUEUE_BASES {
        h.memory
            .write_slice(&[0; 0x3000], GuestAddress(base))
            .unwrap();
    }
    fs::remove_file(&h.path.0).unwrap();
    let mut new_peer = h.activate(8);
    h.tx(0, &packet(&[0x42; 60]));
    h.event(DeviceEvent::QueueKick(1));
    assert_eq!(read_wire(&mut new_peer), [0x42; 60]);
    assert_eq!(h.used(TX), 1);
    new_peer.set_nonblocking(true).unwrap();
    let mut byte = [0];
    assert_eq!(
        new_peer.read(&mut byte).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[test]
fn tx_disconnect_and_invalid_activation_do_not_leave_a_source() {
    let (mut h, peer) = Harness::connected();
    drop(peer);
    h.tx(0, &packet(&[0x17; 60]));
    h.assert_reset(DeviceEvent::QueueKick(1));
    for bad_count in [true, false] {
        let mut h = Harness::new(MACS[0]);
        h.net.set_features(FEATURES).unwrap();
        let mut context = h.context(8);
        if bad_count {
            context.queues = VirtQueues::prepare(
                vec![Queue::new(QUEUE_SIZE).unwrap()],
                &[QUEUE_SIZE],
                false,
                false,
                h.memory.clone(),
            )
            .unwrap();
        } else {
            context.queues = VirtQueues::prepare(
                vec![
                    Queue::new(QUEUE_SIZE).unwrap(),
                    Queue::new(QUEUE_SIZE).unwrap(),
                ],
                SPEC.queue_max,
                false,
                false,
                h.memory.clone(),
            )
            .unwrap();
        }
        assert!(matches!(
            h.net.activate(context),
            Err(DeviceError::NeedsReset(_))
        ));
        assert!(h.registrar.state.lock().unwrap().sources.is_empty());
    }
}

#[test]
fn upstream_mmio_negotiates_and_queues_net_work_for_later_dispatch() {
    use crate::{
        bus::BusDevice,
        irq::IrqLine,
        mock_vm::MockVm,
        virtio::{
            WorkerControl,
            interrupt::MmioInterrupt,
            mmio::{MmioResources, MmioTransport},
        },
    };
    struct Worker {
        context: Mutex<Option<WorkerContext>>,
        kicks: Mutex<Vec<u16>>,
    }
    impl WorkerControl for Worker {
        fn prepare(&self) -> Result<WorkerContext, DeviceError> {
            Ok(self.context.lock().unwrap().take().unwrap())
        }
        fn start(&self) -> Result<(), DeviceError> {
            Ok(())
        }
        fn kick(&self, index: u16) {
            self.kicks.lock().unwrap().push(index);
        }
        fn stop(&self) -> Result<(), DeviceError> {
            Ok(())
        }
        fn cancel_prepare(&self) {}
    }
    fn write(transport: &mut MmioTransport, offset: u64, value: u32) {
        transport.write(offset, &value.to_le_bytes());
    }

    let h = Harness::new(MACS[0]);
    let listener = UnixListener::bind(&h.path.0).unwrap();
    let net = Arc::new(Mutex::new(Net::new(h.path.0.clone(), MACS[0])));
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    let context = h.context(8);
    let worker = Arc::new(Worker {
        context: Mutex::new(Some(WorkerContext {
            events: context.events,
            waker: context.waker,
        })),
        kicks: Mutex::new(vec![]),
    });
    let mut transport = MmioTransport::new(
        net.clone(),
        interrupt.clone(),
        MmioResources {
            memory: context.memory,
            sender: context.sender,
            worker: worker.clone(),
        },
    )
    .unwrap();
    write(&mut transport, 0x70, 1); // ACKNOWLEDGE.
    write(&mut transport, 0x70, 3); // DRIVER.
    write(&mut transport, 0x24, 0); // Low feature page.
    write(&mut transport, 0x20, FEATURES as u32);
    write(&mut transport, 0x24, 1); // High page: VERSION_1.
    write(&mut transport, 0x20, 1);
    write(&mut transport, 0x70, 11); // FEATURES_OK.
    assert_eq!(net.lock().unwrap().spec().features, FEATURES);
    for (index, base) in QUEUE_BASES.into_iter().enumerate() {
        write(&mut transport, 0x30, index as u32);
        write(&mut transport, 0x38, 8);
        write(&mut transport, 0x80, base as u32);
        write(&mut transport, 0x90, (base + 0x1000) as u32);
        write(&mut transport, 0xa0, (base + 0x2000) as u32);
        write(&mut transport, 0x44, 1);
    }
    write(&mut transport, 0x70, 15); // DRIVER_OK.
    let mut peer = listener.accept().unwrap().0;
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    assert!(net.lock().unwrap().active.is_some());
    net.lock()
        .unwrap()
        .on_event(DeviceEvent::BackendReady(SourceId(0)))
        .unwrap();
    h.memory
        .write_slice(&packet(&[0x29; 60]), GuestAddress(DATA))
        .unwrap();
    h.descriptor(TX, 0, DATA, 72, 0, 0);
    h.memory
        .write_obj(0u16, GuestAddress(QUEUE_BASES[TX] + 0x1004))
        .unwrap();
    h.memory
        .store(
            1u16.to_le(),
            GuestAddress(QUEUE_BASES[TX] + 0x1002),
            Ordering::Release,
        )
        .unwrap();
    write(&mut transport, 0x50, 1); // QueueNotify names TX.
    assert_eq!(h.used(TX), 0, "the transport must not dispatch inline");
    assert_eq!(*worker.kicks.lock().unwrap(), [1]);
    let event = DeviceEvent::QueueKick(worker.kicks.lock().unwrap().pop().unwrap());
    net.lock().unwrap().on_event(event).unwrap();
    assert_eq!(read_wire(&mut peer), [0x29; 60]);
    assert_eq!(h.completion(TX, 0), (0, 0));
    assert_eq!(interrupt.interrupt_status(), 1);
    write(&mut transport, 0x70, 0);
    assert!(net.lock().unwrap().active.is_none());
    assert!(h.registrar.state.lock().unwrap().sources.is_empty());
}

pub(crate) mod worker;

#[test]
fn backend_events_use_registrar_ids_and_idle_polling_does_not_spin() {
    let mut h = Harness::new(MACS[0]);
    h.registrar.state.lock().unwrap().next = 100;
    let mut peer = h.activate(8);
    let event = DeviceEvent::BackendReady(h.net.active.as_ref().unwrap().source_id);
    assert_eq!(h.net.active.as_ref().unwrap().source_id, SourceId(100));
    assert_eq!(event, DeviceEvent::BackendReady(SourceId(100)));
    for ready in h.registrar.ready(Duration::from_millis(10)) {
        assert_eq!(ready, event);
        h.event(ready);
    }
    assert!(h.registrar.ready(Duration::ZERO).is_empty());
    h.rx(0, 100);
    peer.write_all(&wire(&[0x32; 60])).unwrap();
    let ready = h.registrar.ready(Duration::from_secs(1));
    assert!(!ready.is_empty());
    for ready in ready {
        assert_eq!(ready, event);
        h.event(ready);
    }
    assert_eq!(h.bytes(DATA, 72), receive_packet(&[0x32; 60]));
    h.net.reset().unwrap();
    assert!(h.registrar.state.lock().unwrap().sources.is_empty());
}

#[test]
fn snapshots_are_explicitly_unsupported() {
    let (mut h, _peer) = Harness::connected();
    assert_eq!(h.net.spec().snapshot, SnapshotSupport::Unsupported);
    assert_eq!(h.net.quiesce(), Err(DeviceError::Unsupported("quiesce")));
    assert_eq!(h.net.save_state(), Err(SnapshotError::Unsupported));
    assert_eq!(
        h.net.restore_state(
            DeviceSnapshot {
                format: 0,
                version: 0,
                payload: vec![]
            },
            RestoreContext
        ),
        Err(DeviceError::Unsupported("restore_state"))
    );
}

#[test]
fn final_budgeted_read_completes_rx_even_when_tx_is_blocked() {
    let mut h = Harness::new(MACS[0]);
    let mut peer = h.activate(256);
    for head in 0..256 {
        h.tx(head, &packet(&vec![0x31; MAX_FRAME_LEN]));
    }
    h.event(DeviceEvent::QueueKick(1));
    assert!(h.used(TX) < 256);
    let tx_used = h.used(TX);
    for head in 0..128u16 {
        h.descriptor(RX, head, 0x1200000 + u64::from(head) * 64, 32, 2, 0);
        h.submit(RX, head);
    }
    peer.write_all(&wire(&[0x42; 14]).repeat(128)).unwrap();
    h.backend();
    // Exactly 256 prefix/body reads: delivery must happen before yielding.
    assert_eq!(h.used(RX), 128);
    assert_eq!(h.used(TX), tx_used);
    for head in 0..128u16 {
        assert_eq!(
            h.bytes(0x1200000 + u64::from(head) * 64, 26),
            receive_packet(&[0x42; 14])
        );
    }
}
