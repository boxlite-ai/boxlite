// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Device callbacks exercised against guest RAM and real split virtqueues.
//! These tests do not exercise an executor or a live guest's hvc0 driver.

use std::{
    io::{self, Write},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU8, AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

use virtio_queue::{Queue, QueueT, desc::split::Descriptor};
use vm_memory::{Bytes, GuestAddress};

use super::VirtioConsole;
use crate::{
    devices::console::ConsoleWorker,
    events::EventLoop,
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, EventError, EventRegistrar, EventSource,
        FeatureError, SnapshotSupport, SourceId, VirtioDevice, VirtioInterrupt, queue::VirtQueues,
    },
};

const MAX_SIZE: u16 = 256;
const SIZE: u16 = 8;
const RX_DESC: u64 = 0x1000;
const RX_AVAIL: u64 = 0x2000;
const RX_USED: u64 = 0x3000;
const DESC: u64 = 0x4000;
const AVAIL: u64 = 0x5000;
const USED: u64 = 0x6000;
const DATA: u64 = 0x10000;
const RAM_SIZE: usize = 0x20000;
const NEXT: u16 = 1;
const WRITE: u16 = 2;
const INDIRECT: u16 = 4;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
struct Taken(Arc<Mutex<Vec<u8>>>);

impl Taken {
    fn bytes(&self) -> Vec<u8> {
        self.0.lock().unwrap().clone()
    }
}

impl Write for Taken {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Broken;

impl Write for Broken {
    fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
        Err(io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    fn open(&self) {
        let (open, changed) = &*self.0;
        *open.lock().unwrap() = true;
        changed.notify_all();
    }
}

impl Drop for Gate {
    fn drop(&mut self) {
        self.open();
    }
}

struct GatedSink {
    gate: Arc<(Mutex<bool>, Condvar)>,
    entered: mpsc::Sender<()>,
    taken: Taken,
}

impl Write for GatedSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.entered.send(()).unwrap();
        let (open, changed) = &*self.gate;
        let mut open = open.lock().unwrap();
        while !*open {
            open = changed.wait(open).unwrap();
        }
        self.taken.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Default)]
struct Interrupt {
    raised: AtomicUsize,
    status: AtomicU8,
    device_status: AtomicU8,
}

impl VirtioInterrupt for Interrupt {
    fn raise(&self) {
        self.raised.fetch_add(1, Ordering::SeqCst);
        self.status.fetch_or(1, Ordering::SeqCst);
    }

    fn interrupt_status(&self) -> u8 {
        self.status.load(Ordering::SeqCst)
    }

    fn ack_interrupt(&self, bits: u8) {
        self.status.fetch_and(!bits, Ordering::SeqCst);
    }

    fn config_generation(&self) -> u8 {
        0
    }

    fn raise_config(&self) {
        panic!("TX must not raise a configuration interrupt");
    }

    fn device_status(&self) -> u8 {
        self.device_status.load(Ordering::SeqCst)
    }

    fn set_device_status(&self, status: u8) {
        self.device_status.store(status, Ordering::SeqCst);
    }

    fn set_needs_reset(&self) {
        self.device_status.fetch_or(0x40, Ordering::SeqCst);
    }
}

struct Registrar;

impl EventRegistrar for Registrar {
    fn register(&self, _source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        panic!("the device must not register its own backend worker");
    }

    fn deregister(&self, _id: SourceId) {
        panic!("the device has no backend registration");
    }
}

struct Guest {
    memory: Arc<GuestMemoryMmap>,
    interrupt: Arc<Interrupt>,
}

impl Guest {
    fn new() -> Self {
        Self {
            memory: Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), RAM_SIZE)]).unwrap()),
            interrupt: Arc::new(Interrupt::default()),
        }
    }

    fn activation(&self, rx_ready: bool, tx_ready: bool, event_idx: bool) -> ActivationContext {
        self.activation_with(
            vec![
                split_queue(RX_DESC, RX_AVAIL, RX_USED, rx_ready),
                split_queue(DESC, AVAIL, USED, tx_ready),
            ],
            event_idx,
        )
    }

    fn activation_with(&self, queues: Vec<Queue>, event_idx: bool) -> ActivationContext {
        let maxima = vec![MAX_SIZE; queues.len()];
        let queues =
            VirtQueues::prepare(queues, &maxima, event_idx, false, Arc::clone(&self.memory))
                .unwrap();
        ActivationContext {
            memory: Arc::clone(&self.memory),
            queues,
            interrupt: self.interrupt.clone(),
            events: Arc::new(Registrar),
            waker: Arc::new(|| panic!("console TX needs no device-owned waker")),
            sender: EventLoop::new().unwrap().sender(),
        }
    }

    fn descriptor(&self, index: u16, addr: u64, len: u32, flags: u16, next: u16) {
        self.memory
            .write_obj(
                Descriptor::new(addr, len, flags, next),
                GuestAddress(DESC + u64::from(index) * 16),
            )
            .unwrap();
    }

    fn payload(&self, index: u16, offset: u64, bytes: &[u8], flags: u16, next: u16) {
        self.memory
            .write_slice(bytes, GuestAddress(DATA + offset))
            .unwrap();
        self.descriptor(index, DATA + offset, bytes.len() as u32, flags, next);
    }

    fn publish(&self, head: u16) {
        self.publish_at(AVAIL, head);
    }

    fn publish_at(&self, avail: u64, head: u16) {
        let index = self.u16(avail + 2);
        self.put_u16(avail + 4 + 2 * u64::from(index % SIZE), head);
        self.put_u16(avail + 2, index.wrapping_add(1));
    }

    fn u16(&self, address: u64) -> u16 {
        u16::from_le(self.memory.read_obj(GuestAddress(address)).unwrap())
    }

    fn put_u16(&self, address: u64, value: u16) {
        self.memory
            .write_obj(value.to_le(), GuestAddress(address))
            .unwrap();
    }

    fn bytes(&self, address: u64, len: usize) -> Vec<u8> {
        let mut bytes = vec![0; len];
        self.memory
            .read_slice(&mut bytes, GuestAddress(address))
            .unwrap();
        bytes
    }

    fn used(&self, slot: u16) -> (u32, u32) {
        let address = USED + 4 + 8 * u64::from(slot % SIZE);
        let head = u32::from_le(self.memory.read_obj(GuestAddress(address)).unwrap());
        let len = u32::from_le(self.memory.read_obj(GuestAddress(address + 4)).unwrap());
        (head, len)
    }

    fn used_count(&self) -> u16 {
        self.u16(USED + 2)
    }

    fn interrupts(&self) -> usize {
        self.interrupt.raised.load(Ordering::SeqCst)
    }
}

fn split_queue(desc: u64, avail: u64, used: u64, ready: bool) -> Queue {
    let mut queue = Queue::new(MAX_SIZE).unwrap();
    queue.try_set_size(SIZE).unwrap();
    queue
        .try_set_desc_table_address(GuestAddress(desc))
        .unwrap();
    queue
        .try_set_avail_ring_address(GuestAddress(avail))
        .unwrap();
    queue.try_set_used_ring_address(GuestAddress(used)).unwrap();
    queue.set_ready(ready);
    queue
}

fn kick(device: &mut VirtioConsole) -> Result<(), DeviceError> {
    device.on_event(DeviceEvent::QueueKick(1))
}

/// Multi-descriptor and zero-length chains keep byte order, complete once,
/// and leave the RX queue untouched.
#[test]
fn ordered_chains_preserve_payload_complete_once_and_leave_rx_untouched() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 16384).unwrap();
    let mut device = VirtioConsole::new(writer);
    let large: Vec<u8> = (0..5003).map(|index| (index % 251) as u8).collect();
    guest.payload(0, 0, &large, NEXT, 1);
    guest.descriptor(1, u64::MAX, 0, NEXT, 2);
    guest.payload(2, 6000, b"tail", 0, 0);
    guest.descriptor(3, u64::MAX, 0, 0, 0);
    guest.payload(4, 7000, b"second", 0, 0);
    for head in [0, 3, 4] {
        guest.publish(head);
    }
    guest
        .memory
        .write_obj(
            Descriptor::new(DATA + 8000, 16, WRITE, 0),
            GuestAddress(RX_DESC),
        )
        .unwrap();
    guest.publish_at(RX_AVAIL, 0);
    let rx_before = guest.bytes(RX_DESC, (RX_USED - RX_DESC) as usize + 128);
    let payload_before = guest.bytes(DATA, 8192);
    device
        .activate(guest.activation(true, true, false))
        .unwrap();
    device.on_event(DeviceEvent::QueueKick(0)).unwrap();
    device
        .on_event(DeviceEvent::BackendReady(SourceId(9)))
        .unwrap();
    assert_eq!(guest.used_count(), 0);
    assert_eq!(guest.interrupts(), 0);
    kick(&mut device).unwrap();
    assert_eq!(guest.used_count(), 3);
    assert_eq!(guest.used(0), (0, 0));
    assert_eq!(guest.used(1), (3, 0));
    assert_eq!(guest.used(2), (4, 0));
    let interrupts = guest.interrupts();
    assert!(interrupts > 0);
    kick(&mut device).unwrap();
    device.quiesce().unwrap();
    assert_eq!(guest.used_count(), 3);
    assert_eq!(guest.interrupts(), interrupts);
    assert_eq!(guest.bytes(DATA, 8192), payload_before);
    assert_eq!(
        guest.bytes(RX_DESC, (RX_USED - RX_DESC) as usize + 128),
        rx_before
    );
    worker.finish();
    let mut expected = large;
    expected.extend_from_slice(b"tailsecond");
    assert_eq!(taken.bytes(), expected);
    assert_eq!(worker.dropped_bytes(), 0);
}

#[test]
fn protocol_shape_is_output_only() {
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(Taken::default()), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    let spec = *device.spec();
    assert_eq!(spec.device_id, 3);
    assert_eq!(spec.config_len, 12);
    assert_eq!(spec.queue_max, [256, 256]);
    assert_eq!(spec.features, 0);
    assert_eq!(spec.snapshot, SnapshotSupport::Unsupported);
    device.set_features(0).unwrap();
    assert_eq!(device.set_features(1), Err(FeatureError { unsupported: 1 }));
    let mut config = [0xAA; 12];
    device.read_config(0, &mut config).unwrap();
    assert_eq!(config, [0; 12]);
    device.write_config(4, &[1, 2, 3, 4]).unwrap();
    let mut config = [0xAA; 12];
    device.read_config(0, &mut config).unwrap();
    assert_eq!(config, [0; 12]);
    worker.finish();
}

#[test]
fn quiesce_drains_pending_tx_and_stops_kicks() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    guest.payload(0, 0, b"pending", 0, 0);
    guest.publish(0);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    device.quiesce().unwrap();
    assert_eq!(guest.used_count(), 1);
    guest.payload(1, 100, b"too late", 0, 0);
    guest.publish(1);
    kick(&mut device).unwrap();
    device.quiesce().unwrap();
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.used(0), (0, 0));
    worker.finish();
    assert_eq!(taken.bytes(), b"pending");
}

#[test]
fn resume_processes_new_tx_after_quiesce() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    device.quiesce().unwrap();
    guest.payload(0, 0, b"resumed", 0, 0);
    guest.publish(0);
    kick(&mut device).unwrap();
    assert_eq!(guest.used_count(), 0);

    device.resume().unwrap();
    kick(&mut device).unwrap();

    assert_eq!(guest.used_count(), 1);
    device.quiesce().unwrap();
    worker.finish();
    assert_eq!(taken.bytes(), b"resumed");
}

/// A writable, out-of-RAM or overflowing segment rejects the whole head.
#[test]
fn an_invalid_later_payload_needs_reset_without_a_prefix_or_completion() {
    for (addr, len, flags) in [
        (DATA + 100, 4, WRITE),
        (RAM_SIZE as u64 - 2, 4, 0),
        (u64::MAX - 1, 4, 0),
    ] {
        let guest = Guest::new();
        let taken = Taken::default();
        let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
        let mut device = VirtioConsole::new(writer);
        guest.payload(0, 0, b"must not escape", NEXT, 1);
        guest.descriptor(1, addr, len, flags, 0);
        guest.payload(2, 200, b"valid", 0, 0);
        guest.publish(0);
        guest.publish(2);
        device
            .activate(guest.activation(false, true, false))
            .unwrap();
        assert!(matches!(kick(&mut device), Err(DeviceError::NeedsReset(_))));
        assert_eq!(guest.used_count(), 0);
        assert_eq!(guest.interrupts(), 0);
        worker.finish();
        assert!(taken.bytes().is_empty());
        assert_eq!(worker.dropped_bytes(), 0);
    }
}

#[derive(Clone, Copy, Debug)]
enum Malformed {
    Next,
    Cycle,
    Indirect,
    AvailableIndex,
    AggregateLength,
}

/// Publishes the malformed chain for one traversal case.
fn malformed(guest: &Guest, case: Malformed) {
    guest.payload(0, 0, b"prefix", NEXT, 1);
    match case {
        Malformed::Next => guest.descriptor(1, DATA, 1, NEXT, SIZE),
        Malformed::Cycle => guest.descriptor(1, DATA, 1, NEXT, 0),
        Malformed::Indirect => guest.descriptor(1, DATA + 100, 16, INDIRECT, 0),
        Malformed::AvailableIndex => {
            guest.put_u16(AVAIL + 2, SIZE + 1);
            return;
        }
        Malformed::AggregateLength => guest.descriptor(1, DATA + 100, u32::MAX, 0, 0),
    }
    guest.publish(0);
}

/// Broken traversal, rings and indirect descriptors need a reset and emit
/// no prefix.
#[test]
fn malformed_traversal_or_ring_needs_reset_without_emitting_a_prefix() {
    for case in [
        Malformed::Next,
        Malformed::Cycle,
        Malformed::Indirect,
        Malformed::AvailableIndex,
        Malformed::AggregateLength,
    ] {
        let guest = Guest::new();
        let taken = Taken::default();
        let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
        let mut device = VirtioConsole::new(writer);
        malformed(&guest, case);
        device
            .activate(guest.activation(false, true, false))
            .unwrap();
        assert!(
            matches!(kick(&mut device), Err(DeviceError::NeedsReset(_))),
            "{case:?}"
        );
        assert_eq!(guest.used_count(), 0, "{case:?}");
        assert_eq!(guest.interrupts(), 0, "{case:?}");
        worker.finish();
        assert!(taken.bytes().is_empty(), "{case:?}");
        assert_eq!(worker.dropped_bytes(), 0, "{case:?}");
    }
}

#[test]
fn a_later_broken_head_preserves_prior_completion_and_interrupt() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    guest.payload(0, 0, b"completed", 0, 0);
    guest.payload(1, 100, b"broken prefix", NEXT, SIZE);
    guest.publish(0);
    guest.publish(1);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    assert!(matches!(kick(&mut device), Err(DeviceError::NeedsReset(_))));
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.used(0), (0, 0));
    assert!(guest.interrupts() > 0);
    let interrupts = guest.interrupts();
    device.quiesce().unwrap();
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.interrupts(), interrupts);
    worker.finish();
    assert_eq!(taken.bytes(), b"completed");
}

#[test]
fn event_idx_facade_suppresses_notifications_until_the_threshold() {
    // Console offers no EVENT_IDX feature. This explicitly supplies an
    // EVENT_IDX-prepared facade to check that the device honors its decision.
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    guest.put_u16(AVAIL + 4 + 2 * u64::from(SIZE), 1);
    guest.payload(0, 0, b"a", 0, 0);
    guest.payload(1, 100, b"b", 0, 0);
    device
        .activate(guest.activation(false, true, true))
        .unwrap();
    guest.publish(0);
    kick(&mut device).unwrap();
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.interrupts(), 0);
    guest.publish(1);
    kick(&mut device).unwrap();
    assert_eq!(guest.used_count(), 2);
    assert_eq!(guest.interrupts(), 1);
    kick(&mut device).unwrap();
    assert_eq!(guest.interrupts(), 1);
    worker.finish();
    assert_eq!(taken.bytes(), b"ab");
}

#[test]
fn a_blocked_sink_does_not_delay_completion_and_overflow_drops_oldest() {
    let guest = Guest::new();
    let taken = Taken::default();
    let gate = Gate(Arc::new((Mutex::new(false), Condvar::new())));
    let (entered, entering) = mpsc::channel();
    let sink = GatedSink {
        gate: Arc::clone(&gate.0),
        entered,
        taken: taken.clone(),
    };
    let (mut writer, mut worker) = ConsoleWorker::spawn(Box::new(sink), 8).unwrap();
    // The handshake proves the worker holds this byte outside its queue lock.
    writer.write_all(b"0").unwrap();
    entering.recv_timeout(HANDSHAKE_TIMEOUT).unwrap();
    let mut device = VirtioConsole::new(writer);
    guest.payload(0, 0, b"123456789abcdef", 0, 0);
    guest.publish(0);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    let (done, completion) = mpsc::channel();
    let callback = std::thread::spawn(move || {
        let result = kick(&mut device);
        done.send(result).unwrap();
        device
    });
    let completed_while_blocked = completion.recv_timeout(HANDSHAKE_TIMEOUT);
    let used_while_blocked = guest.used_count();
    let interrupts_while_blocked = guest.interrupts();
    let dropped_while_blocked = worker.dropped_bytes();
    gate.open();
    let mut device = callback.join().unwrap();
    device.quiesce().unwrap();
    worker.finish();
    assert_eq!(completed_while_blocked.unwrap(), Ok(()));
    assert_eq!(used_while_blocked, 1);
    assert!(interrupts_while_blocked > 0);
    assert_eq!(guest.used(0), (0, 0));
    assert_eq!(dropped_while_blocked, 7);
    assert_eq!(worker.dropped_bytes(), 7);
    assert_eq!(taken.bytes(), b"089abcdef");
}

#[test]
fn a_failing_sink_counts_loss_without_stopping_guest_completion() {
    let guest = Guest::new();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(Broken), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    guest.payload(0, 0, b"lost\n", 0, 0);
    guest.publish(0);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    kick(&mut device).unwrap();
    guest.payload(1, 100, b"still writing\n", 0, 0);
    guest.publish(1);
    kick(&mut device).unwrap();
    device.quiesce().unwrap();
    worker.finish();
    assert_eq!(guest.used_count(), 2);
    assert_eq!(guest.used(0), (0, 0));
    assert_eq!(guest.used(1), (1, 0));
    assert!(guest.interrupts() > 0);
    assert_eq!(worker.dropped_bytes(), 19);
}

#[test]
fn reset_recovers_a_broken_device_and_keeps_the_shared_writer() {
    let first = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 128).unwrap();
    let mut serial_writer = writer.clone();
    let mut device = VirtioConsole::new(writer);
    serial_writer.write_all(b"serial-before|").unwrap();
    first.payload(0, 0, b"first|", 0, 0);
    first.publish(0);
    device
        .activate(first.activation(false, true, false))
        .unwrap();
    kick(&mut device).unwrap();
    first.payload(1, 100, b"broken", NEXT, SIZE);
    first.publish(1);
    assert!(matches!(kick(&mut device), Err(DeviceError::NeedsReset(_))));
    device.reset().unwrap();
    first.payload(2, 200, b"stale", 0, 0);
    first.publish(2);
    kick(&mut device).unwrap();
    assert_eq!(first.used_count(), 1);
    let second = Guest::new();
    second.payload(0, 0, b"second|", 0, 0);
    second.publish(0);
    device
        .activate(second.activation(false, true, false))
        .unwrap();
    kick(&mut device).unwrap();
    serial_writer.write_all(b"serial-after").unwrap();
    device.quiesce().unwrap();
    worker.finish();
    assert_eq!(second.used_count(), 1);
    assert_eq!(second.used(0), (0, 0));
    assert_eq!(taken.bytes(), b"serial-before|first|second|serial-after");
    assert_eq!(worker.dropped_bytes(), 0);
}

#[test]
fn activation_is_single_use_until_reset() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    assert!(matches!(
        device.activate(guest.activation(false, true, false)),
        Err(DeviceError::NeedsReset(_))
    ));
    device.reset().unwrap();
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    device.quiesce().unwrap();
    worker.finish();
    assert_eq!(guest.used_count(), 0);
}

/// Activation rejects an unready or missing TX queue regardless of RX.
#[test]
fn activation_requires_tx_even_when_rx_is_ready() {
    for missing_slot in [false, true] {
        let guest = Guest::new();
        let taken = Taken::default();
        let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
        let mut device = VirtioConsole::new(writer);
        let activation = if missing_slot {
            guest.activation_with(vec![split_queue(RX_DESC, RX_AVAIL, RX_USED, true)], false)
        } else {
            guest.activation(true, false, false)
        };
        assert!(matches!(
            device.activate(activation),
            Err(DeviceError::NeedsReset(_))
        ));
        device.quiesce().unwrap();
        worker.finish();
        assert_eq!(guest.used_count(), 0);
        assert_eq!(guest.interrupts(), 0);
        assert!(taken.bytes().is_empty());
    }
}

#[test]
fn quiesce_scans_unkicked_tx_once_retains_activation_and_keeps_the_writer_open() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let mut serial_writer = writer.clone();
    let mut device = VirtioConsole::new(writer);
    guest.payload(0, 0, b"unkicked", 0, 0);
    guest.publish(0);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    device.quiesce().unwrap();
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.used(0), (0, 0));
    let interrupts = guest.interrupts();
    assert!(interrupts > 0);
    guest.payload(1, 100, b"too late", 0, 0);
    guest.publish(1);
    kick(&mut device).unwrap();
    device.quiesce().unwrap();
    serial_writer.write_all(b"|serial").unwrap();
    worker.finish();
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.interrupts(), interrupts);
    assert_eq!(taken.bytes(), b"unkicked|serial");
    assert!(Arc::strong_count(&guest.memory) > 1);
    device.reset().unwrap();
    assert_eq!(Arc::strong_count(&guest.memory), 1);
}

#[test]
fn quiesce_skips_a_broken_device_instead_of_retrying_repaired_descriptors() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    malformed(&guest, Malformed::Next);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    assert!(matches!(kick(&mut device), Err(DeviceError::NeedsReset(_))));
    guest.descriptor(1, DATA + 100, 0, 0, 0);
    guest.payload(2, 200, b"must remain unconsumed", 0, 0);
    guest.publish(2);
    assert!(matches!(kick(&mut device), Err(DeviceError::NeedsReset(_))));
    assert_eq!(guest.used_count(), 0);
    assert!(taken.bytes().is_empty());
    device.quiesce().unwrap();
    device.quiesce().unwrap();
    worker.finish();
    assert_eq!(guest.used_count(), 0);
    assert_eq!(guest.interrupts(), 0);
    assert!(taken.bytes().is_empty());
    assert!(Arc::strong_count(&guest.memory) > 1);
    device.reset().unwrap();
    assert_eq!(Arc::strong_count(&guest.memory), 1);
}

#[test]
fn quiesce_reports_a_scan_error_without_retrying_or_detaching_activation() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    guest.payload(0, 0, b"completed", 0, 0);
    guest.payload(1, 100, b"broken prefix", NEXT, SIZE);
    guest.publish(0);
    guest.publish(1);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    assert!(matches!(device.quiesce(), Err(DeviceError::NeedsReset(_))));
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.used(0), (0, 0));
    let interrupts = guest.interrupts();
    assert!(interrupts > 0);
    guest.descriptor(1, DATA + 100, 0, 0, 0);
    guest.payload(2, 200, b"must remain unconsumed", 0, 0);
    guest.publish(2);
    kick(&mut device).unwrap();
    device.quiesce().unwrap();
    worker.finish();
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.interrupts(), interrupts);
    assert_eq!(taken.bytes(), b"completed");
    assert!(Arc::strong_count(&guest.memory) > 1);
    device.reset().unwrap();
    assert_eq!(Arc::strong_count(&guest.memory), 1);
}

#[test]
fn a_duplicate_deferred_head_does_not_emit_or_complete_twice() {
    let guest = Guest::new();
    let taken = Taken::default();
    let (writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let mut device = VirtioConsole::new(writer);
    guest.payload(0, 0, b"once", 0, 0);
    guest.publish(0);
    guest.publish(0);
    device
        .activate(guest.activation(false, true, false))
        .unwrap();
    assert!(matches!(kick(&mut device), Err(DeviceError::NeedsReset(_))));
    assert_eq!(guest.used_count(), 1);
    assert_eq!(guest.used(0), (0, 0));
    assert!(guest.interrupts() > 0);
    device.quiesce().unwrap();
    worker.finish();
    assert_eq!(guest.used_count(), 1);
    assert_eq!(taken.bytes(), b"once");
    assert_eq!(worker.dropped_bytes(), 0);
}

mod transport;
