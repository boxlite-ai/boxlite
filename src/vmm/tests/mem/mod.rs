// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! virtio-mem device tests: request responses, the configuration layout, the
//! host handle, activation and one request through a real queue.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use virtio_queue::{Queue, QueueT, desc::split::Descriptor};
use vm_memory::{GuestAddress, GuestAddressSpace, GuestMemoryBackend};

use super::*;
use crate::{
    events::EventLoop,
    hotplug::{BLOCK_SIZE, HOTPLUG_START},
    memory::{GuestMemoryMmap, GuestMemoryView},
    mock_vm::MockVm,
    virtio::{
        EventError, EventRegistrar, EventSource, SourceId, VirtioInterrupt, queue::VirtQueues,
    },
};

const DESC: u64 = 0x1000;
const AVAIL: u64 = 0x2000;
const USED: u64 = 0x3000;
const REQUEST: u64 = 0x4000;
const RESPONSE: u64 = 0x5000;
const WRITE: u16 = 2;
const NEXT: u16 = 1;

fn view() -> GuestMemoryView {
    GuestMemoryView::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x1_0000)]).unwrap())
}

fn device(capacity_mib: u32) -> (GuestMemoryView, VirtioMem<MockVm>) {
    let view = view();
    let memory = HotplugMemory::new(Arc::new(MockVm::new()), view.clone(), capacity_mib).unwrap();
    (view, VirtioMem::new(memory))
}

fn block(index: u64) -> u64 {
    HOTPLUG_START + index * BLOCK_SIZE
}

#[test]
fn a_plug_above_the_target_is_nacked_not_an_error() {
    let (_, mut mem) = device(256);
    assert_eq!(mem.handle(PLUG, block(0), 1), (NACK, 0));
    mem.requested = 128 * MIB;
    assert_eq!(mem.handle(PLUG, block(0), 64), (ACK, 0));
    assert_eq!(mem.handle(PLUG, block(64), 1), (NACK, 0));
    assert_eq!(mem.memory.plugged_bytes(), 128 * MIB);
}

#[test]
fn requests_on_the_wrong_state_or_range_are_errors() {
    let (_, mut mem) = device(128);
    mem.requested = 128 * MIB;
    assert_eq!(mem.handle(UNPLUG, block(0), 1), (ERROR, 0));
    assert_eq!(mem.handle(PLUG, block(0) + 4096, 1), (ERROR, 0));
    assert_eq!(mem.handle(PLUG, block(64), 1), (ERROR, 0));
    assert_eq!(mem.handle(PLUG, block(0), 0), (ERROR, 0));
    assert_eq!(mem.handle(7, block(0), 1), (ERROR, 0));
    assert_eq!(mem.handle(PLUG, block(0), 2), (ACK, 0));
    assert_eq!(mem.handle(PLUG, block(1), 1), (ERROR, 0));
}

#[test]
fn state_unplug_and_unplug_all_follow_the_blocks() {
    let (_, mut mem) = device(128);
    mem.requested = 128 * MIB;
    mem.handle(PLUG, block(0), 2);
    assert_eq!(mem.handle(STATE, block(0), 2), (ACK, 0));
    assert_eq!(mem.handle(STATE, block(1), 2), (ACK, 2));
    assert_eq!(mem.handle(STATE, block(2), 2), (ACK, 1));
    assert_eq!(mem.handle(UNPLUG, block(1), 1), (ACK, 0));
    assert_eq!(mem.memory.plugged_bytes(), BLOCK_SIZE);
    assert_eq!(mem.handle(UNPLUG_ALL, 0, 0), (ACK, 0));
    assert_eq!(
        (mem.memory.plugged_bytes(), mem.memory.mapped_bytes()),
        (0, 0)
    );
    assert_eq!(mem.requested, 128 * MIB, "unplug-all keeps the host target");
}

#[test]
fn the_configuration_follows_the_virtio_layout() {
    let (_, mut mem) = device(256);
    mem.requested = 128 * MIB;
    mem.handle(PLUG, block(0), 1);
    let mut config = [0u8; 56];
    mem.read_config(0, &mut config).unwrap();
    let field = |offset: usize| u64::from_le_bytes(config[offset..offset + 8].try_into().unwrap());
    assert_eq!(field(0), BLOCK_SIZE);
    assert_eq!(field(16), HOTPLUG_START);
    assert_eq!((field(24), field(32)), (256 * MIB, 256 * MIB));
    assert_eq!((field(40), field(48)), (BLOCK_SIZE, 128 * MIB));
    let mut tail = [0xffu8; 4];
    mem.read_config(54, &mut tail).unwrap();
    assert_eq!(tail, [0, 0, 0, 0]);
}

#[test]
fn the_handle_accepts_slot_multiples_within_capacity_in_both_directions() {
    let (_, mem) = device(256);
    let control: Mutex<VirtioMem<MockVm>> = Mutex::new(mem);
    for bad in [64, 384] {
        assert!(matches!(
            control.request(bad),
            Err(Error::InvalidHotplugSize(mib)) if mib == bad
        ));
    }
    control.request(256).unwrap();
    control.request(128).unwrap();
    assert_eq!(
        control.status(),
        MemoryStatus {
            capacity_mib: 256,
            requested_mib: 128,
            plugged_mib: 0,
            mapped_mib: 0,
        }
    );
}

#[test]
fn features_other_than_unplugged_inaccessible_are_refused() {
    let (_, mut mem) = device(128);
    assert_eq!(mem.set_features(1).unwrap_err().unsupported, 1);
    mem.set_features(UNPLUGGED_INACCESSIBLE).unwrap();
}

#[derive(Default)]
struct Interrupt {
    raised: AtomicUsize,
    config: AtomicUsize,
}

impl VirtioInterrupt for Interrupt {
    fn raise(&self) {
        self.raised.fetch_add(1, Ordering::SeqCst);
    }
    fn interrupt_status(&self) -> u8 {
        0
    }
    fn ack_interrupt(&self, _: u8) {}
    fn config_generation(&self) -> u8 {
        0
    }
    fn raise_config(&self) {
        self.config.fetch_add(1, Ordering::SeqCst);
    }
    fn device_status(&self) -> u8 {
        0
    }
    fn set_device_status(&self, _: u8) {}
    fn set_needs_reset(&self) {}
}

struct NoSources;
impl EventRegistrar for NoSources {
    fn register(&self, _: Box<dyn EventSource>) -> std::result::Result<SourceId, EventError> {
        Err(EventError::Closed)
    }
    fn deregister(&self, _: SourceId) {}
}

fn context(view: &GuestMemoryView, interrupt: Arc<Interrupt>) -> ActivationContext {
    let mut queue = Queue::new(128).unwrap();
    queue.try_set_size(8).unwrap();
    queue
        .try_set_desc_table_address(GuestAddress(DESC))
        .unwrap();
    queue
        .try_set_avail_ring_address(GuestAddress(AVAIL))
        .unwrap();
    queue.try_set_used_ring_address(GuestAddress(USED)).unwrap();
    queue.set_ready(true);
    ActivationContext {
        memory: view.clone(),
        queues: VirtQueues::prepare(vec![queue], SPEC.queue_max, false, false, view.clone())
            .unwrap(),
        interrupt,
        events: Arc::new(NoSources),
        waker: Arc::new(|| {}),
        sender: EventLoop::new().unwrap().sender(),
    }
}

#[test]
fn activation_requires_unplugged_inaccessible() {
    let (view, mut mem) = device(128);
    mem.set_features(0).unwrap();
    assert!(mem.activate(context(&view, Arc::default())).is_err());
    mem.set_features(UNPLUGGED_INACCESSIBLE).unwrap();
    mem.activate(context(&view, Arc::default())).unwrap();
}

#[test]
fn a_plug_request_through_the_queue_maps_the_slot_and_answers_ack() {
    let (view, mem) = device(128);
    let mem = Mutex::new(mem);
    let interrupt = Arc::new(Interrupt::default());
    {
        let mut device = mem.lock().unwrap();
        device.set_features(UNPLUGGED_INACCESSIBLE).unwrap();
        device
            .activate(context(&view, Arc::clone(&interrupt)))
            .unwrap();
    }
    mem.request(128).unwrap();
    assert_eq!(interrupt.config.load(Ordering::SeqCst), 1);

    let ram = view.memory();
    let mut request = [0u8; 24];
    request[8..16].copy_from_slice(&block(0).to_le_bytes());
    request[16..18].copy_from_slice(&1u16.to_le_bytes());
    ram.write_slice(&request, GuestAddress(REQUEST)).unwrap();
    ram.write_obj(Descriptor::new(REQUEST, 24, NEXT, 1), GuestAddress(DESC))
        .unwrap();
    ram.write_obj(
        Descriptor::new(RESPONSE, 10, WRITE, 0),
        GuestAddress(DESC + 16),
    )
    .unwrap();
    ram.write_obj(0u16, GuestAddress(AVAIL + 4)).unwrap();
    ram.write_obj(1u16, GuestAddress(AVAIL + 2)).unwrap();
    ram.write_obj(0xffffu16, GuestAddress(RESPONSE)).unwrap();
    drop(ram);

    mem.lock()
        .unwrap()
        .on_event(DeviceEvent::QueueKick(0))
        .unwrap();

    let ram = view.memory();
    assert_eq!(ram.read_obj::<u16>(GuestAddress(RESPONSE)).unwrap(), ACK);
    assert_eq!(ram.read_obj::<u16>(GuestAddress(USED + 2)).unwrap(), 1);
    assert_eq!(ram.read_obj::<u32>(GuestAddress(USED + 8)).unwrap(), 10);
    assert_eq!(interrupt.raised.load(Ordering::SeqCst), 1);
    assert_eq!(mem.status().plugged_mib, 2);
    assert!(view.memory().address_in_range(GuestAddress(block(0))));
}
