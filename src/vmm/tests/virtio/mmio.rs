// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-mmio transport: registers, feature negotiation, queue setup,
//! activation, reset, interrupt and error paths.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use boxlite_hypervisor::VcpuExit;
use vm_memory::GuestAddress;

use super::{
    DeviceContext, MMIO_WINDOW_LEN, MmioResources, MmioTransport, Slot, Slots, add_device, announce,
};
use crate::virtio::worker::VirtioWorkers;
use crate::{
    bus::BusDevice,
    chipset::ChipsetBuilder,
    config::MAX_CMDLINE_BYTES,
    error::Error,
    events::{Event, EventLoop},
    irq::IrqLine,
    memory::GuestMemoryMmap,
    mock_vm::{Call, MockVm},
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, EventError, EventRegistrar,
        EventSource, FeatureError, SnapshotSupport, SourceId, VirtioDevice, VirtioInterrupt,
        WorkerContext, WorkerControl, interrupt::MmioInterrupt,
    },
};

const ACKNOWLEDGE: u8 = 0x1;
const DRIVER: u8 = 0x2;
const DRIVER_OK: u8 = 0x4;
const FEATURES_OK: u8 = 0x8;
const NEEDS_RESET: u8 = 0x40;

const LINE: u32 = 5;
const VERSION_1: u64 = 1 << 32;

const QUEUES: &[u16] = &[8, 4];

fn spec(features: u64) -> DeviceSpec {
    DeviceSpec {
        device_id: 1,
        name: "test",
        features,
        config_len: 0x10,
        queue_max: QUEUES,
        snapshot: SnapshotSupport::Stopped,
    }
}

#[derive(Default)]
struct DeviceState {
    features: u64,
    reads: Vec<(u64, usize)>,
    writes: Vec<(u64, Vec<u8>)>,
    set_features_calls: usize,
    activation: Option<ActivationContext>,
    events: Vec<DeviceEvent>,
    resets: usize,
    activate_error: Option<DeviceError>,
    config_error: Option<DeviceError>,
    reset_error: Option<DeviceError>,
}

struct TransportDevice {
    spec: DeviceSpec,
    state: Arc<Mutex<DeviceState>>,
    log: Arc<Mutex<Vec<&'static str>>>,
}

fn device(
    spec: DeviceSpec,
    log: Arc<Mutex<Vec<&'static str>>>,
) -> (Arc<Mutex<dyn VirtioDevice>>, Arc<Mutex<DeviceState>>) {
    let state = Arc::new(Mutex::new(DeviceState::default()));
    let device = TransportDevice {
        spec,
        state: Arc::clone(&state),
        log,
    };
    (Arc::new(Mutex::new(device)), state)
}

impl VirtioDevice for TransportDevice {
    fn spec(&self) -> &DeviceSpec {
        &self.spec
    }

    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        let unsupported = negotiated & !self.spec.features;
        if unsupported != 0 {
            return Err(FeatureError { unsupported });
        }
        let mut state = self.state.lock().unwrap();
        state.features = negotiated;
        state.set_features_calls += 1;
        Ok(())
    }

    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        let mut state = self.state.lock().unwrap();
        state.reads.push((offset, data.len()));
        if let Some(error) = state.config_error {
            return Err(error);
        }
        for (index, byte) in data.iter_mut().enumerate() {
            *byte = (offset as u8).wrapping_add(index as u8);
        }
        Ok(())
    }

    fn write_config(&mut self, offset: u64, data: &[u8]) -> Result<(), DeviceError> {
        let mut state = self.state.lock().unwrap();
        state.writes.push((offset, data.to_vec()));
        if let Some(error) = state.config_error {
            return Err(error);
        }
        Ok(())
    }

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        let mut state = self.state.lock().unwrap();
        self.log.lock().unwrap().push("activate");
        state.activation = Some(ctx);
        if let Some(error) = state.activate_error {
            return Err(error);
        }
        Ok(())
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        let mut state = self.state.lock().unwrap();
        self.log.lock().unwrap().push("reset");
        state.resets += 1;
        state.features = 0;
        state.activation = None;
        if let Some(error) = state.reset_error {
            return Err(error);
        }
        Ok(())
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        self.state.lock().unwrap().events.push(event);
        Ok(())
    }
}

struct Registrar;

impl EventRegistrar for Registrar {
    fn register(&self, _source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        Ok(SourceId(1))
    }

    fn deregister(&self, _id: SourceId) {}
}

struct RecordingWorker {
    log: Arc<Mutex<Vec<&'static str>>>,
    prepare_error: Mutex<Option<DeviceError>>,
    start_error: Mutex<Option<DeviceError>>,
    stop_error: Mutex<Option<DeviceError>>,
    starts: AtomicUsize,
    stops: AtomicUsize,
    kicks: Mutex<Vec<u16>>,
}

impl RecordingWorker {
    fn new(log: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self {
            log,
            prepare_error: Mutex::new(None),
            start_error: Mutex::new(None),
            stop_error: Mutex::new(None),
            starts: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
            kicks: Mutex::new(Vec::new()),
        }
    }
}

impl WorkerControl for RecordingWorker {
    fn prepare(&self) -> Result<WorkerContext, DeviceError> {
        self.log.lock().unwrap().push("prepare");
        match *self.prepare_error.lock().unwrap() {
            Some(error) => Err(error),
            None => Ok(WorkerContext {
                events: Arc::new(Registrar),
                waker: Arc::new(|| {}),
            }),
        }
    }

    fn kick(&self, index: u16) {
        self.kicks.lock().unwrap().push(index);
    }

    fn cancel_prepare(&self) {
        self.log.lock().unwrap().push("cancel");
    }

    fn start(&self) -> Result<(), DeviceError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.log.lock().unwrap().push("start");
        match *self.start_error.lock().unwrap() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn stop(&self) -> Result<(), DeviceError> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.log.lock().unwrap().push("stop");
        match *self.stop_error.lock().unwrap() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

struct Fixture {
    transport: MmioTransport,
    state: Arc<Mutex<DeviceState>>,
    interrupt: Arc<MmioInterrupt>,
    worker: Arc<RecordingWorker>,
    events: EventLoop,
    log: Arc<Mutex<Vec<&'static str>>>,
}

#[derive(Debug, PartialEq, Eq)]
struct QueueSummary {
    ready: bool,
    size: u16,
    desc: u64,
    avail: u64,
    used: u64,
    event_idx: bool,
}

fn make(spec: DeviceSpec) -> Fixture {
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap());
    let vm = Arc::new(MockVm::new());
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(vm, LINE)));
    let log = Arc::new(Mutex::new(Vec::new()));
    let worker = Arc::new(RecordingWorker::new(Arc::clone(&log)));
    let events = EventLoop::new().unwrap();
    let (device, state) = device(spec, Arc::clone(&log));
    let transport = MmioTransport::new(
        device,
        Arc::clone(&interrupt),
        MmioResources {
            memory,
            sender: events.sender(),
            worker: Arc::clone(&worker) as Arc<dyn WorkerControl>,
        },
    )
    .unwrap();
    Fixture {
        transport,
        state,
        interrupt,
        worker,
        events,
        log,
    }
}

fn try_make(spec: DeviceSpec) -> crate::error::Result<MmioTransport> {
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap());
    let vm = Arc::new(MockVm::new());
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(vm, LINE)));
    let log = Arc::new(Mutex::new(Vec::new()));
    let worker = Arc::new(RecordingWorker::new(log));
    let events = EventLoop::new().unwrap();
    let (device, _) = device(spec, Arc::new(Mutex::new(Vec::new())));
    MmioTransport::new(
        device,
        interrupt,
        MmioResources {
            memory,
            sender: events.sender(),
            worker,
        },
    )
}

impl Fixture {
    fn read(&mut self, offset: u64) -> u32 {
        let mut data = [0u8; 4];
        self.transport.read(offset, &mut data);
        u32::from_le_bytes(data)
    }

    fn write(&mut self, offset: u64, value: u32) {
        self.transport.write(offset, &value.to_le_bytes());
    }

    fn status(&mut self) -> u8 {
        self.read(0x070) as u8
    }

    fn set_status(&mut self, bits: u8) {
        self.write(0x070, u32::from(bits));
    }

    fn negotiate_with(&mut self, features: u64) {
        self.set_status(ACKNOWLEDGE);
        self.set_status(ACKNOWLEDGE | DRIVER);
        self.write(0x014, 0);
        self.write(0x024, 0);
        self.write(0x020, features as u32);
        self.write(0x014, 1);
        self.write(0x024, 1);
        self.write(0x020, (features >> 32) as u32);
        self.set_status(ACKNOWLEDGE | DRIVER | FEATURES_OK);
    }

    fn negotiate(&mut self) {
        self.negotiate_with(VERSION_1 | 0b111);
    }

    fn configure_queue(
        &mut self,
        index: u32,
        size: u32,
        desc: u64,
        avail: u64,
        used: u64,
        ready: u32,
    ) {
        self.write(0x030, index);
        self.write(0x038, size);
        self.write(0x080, desc as u32);
        self.write(0x084, (desc >> 32) as u32);
        self.write(0x090, avail as u32);
        self.write(0x094, (avail >> 32) as u32);
        self.write(0x0a0, used as u32);
        self.write(0x0a4, (used >> 32) as u32);
        self.write(0x044, ready);
    }

    fn activate(&mut self) {
        self.configure_queue(1, 4, 0x2000, 0x8100, 0x9100, 0);
        self.configure_queue(0, 8, 0x1000, 0x8000, 0x9000, 1);
        self.set_status(ACKNOWLEDGE | DRIVER | FEATURES_OK | DRIVER_OK);
    }

    fn activation_queues(&self) -> Vec<QueueSummary> {
        let state = self.state.lock().unwrap();
        let queues = &state
            .activation
            .as_ref()
            .expect("the device is activated")
            .queues;
        (0..queues.len())
            .map(|index| {
                let queue = queues.state(index).expect("the queue slot exists");
                QueueSummary {
                    ready: queue.ready,
                    size: queue.size,
                    desc: queue.desc_table,
                    avail: queue.avail_ring,
                    used: queue.used_ring,
                    event_idx: queue.event_idx_enabled,
                }
            })
            .collect()
    }
}

#[test]
fn identity_registers_and_unknown_offsets() {
    let mut fixture = make(spec(0b111));
    assert_eq!(fixture.read(0x000), 0x7472_6976);
    assert_eq!(fixture.read(0x004), 2);
    assert_eq!(fixture.read(0x008), 1);
    assert_eq!(fixture.read(0x00c), 0);
    for offset in [0x028, 0x03c, 0x040, 0x0c0, 0x1000] {
        assert_eq!(fixture.read(offset), 0, "offset {offset:#x}");
    }
    fixture.write(0x028, 1);
    assert_eq!(fixture.read(0x028), 0);
}

#[test]
fn shared_memory_registers_report_no_region() {
    let mut fixture = make(spec(0b111));
    for offset in [0x0b0, 0x0b4, 0x0b8, 0x0bc] {
        assert_eq!(fixture.read(offset), u32::MAX, "offset {offset:#x}");
    }
}

#[test]
fn control_accesses_must_be_aligned_four_byte_accesses() {
    let mut fixture = make(spec(0b111));
    let mut one = [0u8; 1];
    fixture.transport.read(0x000, &mut one);
    assert_eq!(one, [0]);
    let mut two = [0u8; 2];
    fixture.transport.read(0x000, &mut two);
    assert_eq!(two, [0, 0]);
    let mut eight = [0u8; 8];
    fixture.transport.read(0x000, &mut eight);
    assert_eq!(eight, [0; 8]);
    let mut unaligned = [0u8; 4];
    fixture.transport.read(0x002, &mut unaligned);
    assert_eq!(unaligned, [0; 4]);

    fixture.transport.write(0x070, &[ACKNOWLEDGE]);
    assert_eq!(fixture.status(), 0);
    fixture.transport.write(0x002, &[1, 0, 0, 0]);
    assert_eq!(fixture.status(), 0);
}

#[test]
fn feature_pages_include_version_1() {
    let mut fixture = make(spec(0b111));
    assert_eq!(fixture.read(0x010), 0b111);
    fixture.write(0x014, 1);
    assert_eq!(fixture.read(0x010), 1);
    fixture.write(0x014, 2);
    assert_eq!(fixture.read(0x010), 0);
}

#[test]
fn features_reach_the_device_once_without_transport_bits() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.features, 0b111);
        assert_eq!(state.set_features_calls, 1);
    }
    assert_eq!(fixture.status(), ACKNOWLEDGE | DRIVER | FEATURES_OK);
}

#[test]
fn features_ok_fails_without_version_1() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate_with(0b111);
    assert_eq!(fixture.status() & FEATURES_OK, 0);
    assert_eq!(fixture.state.lock().unwrap().set_features_calls, 0);
}

#[test]
fn features_ok_rejects_unoffered_features() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate_with(VERSION_1 | 0b111 | 0b1000);
    assert_eq!(fixture.status() & FEATURES_OK, 0);
    assert_eq!(fixture.state.lock().unwrap().set_features_calls, 0);
}

#[test]
fn config_reads_work_before_features_ok_and_split_eight_bytes() {
    let mut fixture = make(spec(0b111));
    let mut four = [0u8; 4];
    fixture.transport.read(0x100, &mut four);
    assert_eq!(four, [0, 1, 2, 3]);
    assert_eq!(fixture.state.lock().unwrap().reads, [(0, 4)]);

    let mut eight = [0u8; 8];
    fixture.transport.read(0x100, &mut eight);
    assert_eq!(eight, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(
        fixture.state.lock().unwrap().reads,
        [(0, 4), (0, 4), (4, 4)]
    );
    assert_eq!(fixture.state.lock().unwrap().set_features_calls, 0);
}

#[test]
fn config_writes_are_forwarded() {
    let mut fixture = make(spec(0b111));
    fixture.transport.write(0x100, &[7, 8, 9, 10]);
    assert_eq!(
        fixture.state.lock().unwrap().writes,
        [(0, vec![7, 8, 9, 10])]
    );
}

#[test]
fn queue_registers_are_gated_on_features_ok() {
    let mut fixture = make(spec(0b111));
    fixture.write(0x030, 1);
    fixture.write(0x038, 4);
    fixture.write(0x044, 1);
    assert_eq!(fixture.read(0x034), 8);
    assert_eq!(fixture.read(0x044), 0);

    fixture.negotiate();
    assert_eq!(fixture.read(0x034), 8);
    fixture.write(0x030, 1);
    assert_eq!(fixture.read(0x034), 4);
    fixture.write(0x030, 2);
    assert_eq!(fixture.read(0x034), 0);
}

#[test]
fn activation_builds_a_dense_queue_vector() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.activate();

    let queues = fixture.activation_queues();
    assert_eq!(queues.len(), 2);
    assert!(queues[0].ready);
    assert_eq!(queues[0].size, 8);
    assert_eq!(queues[0].desc, 0x1000);
    assert_eq!(queues[0].avail, 0x8000);
    assert_eq!(queues[0].used, 0x9000);
    assert!(!queues[1].ready);
    assert_eq!(fixture.worker.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        *fixture.log.lock().unwrap(),
        ["prepare", "activate", "start"]
    );
    assert_eq!(
        fixture.status(),
        ACKNOWLEDGE | DRIVER | FEATURES_OK | DRIVER_OK
    );
}

#[test]
fn activation_failure_rolls_back_and_needs_reset() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.configure_queue(0, 0, 0x1000, 0x8000, 0x9000, 1);
    fixture.configure_queue(1, 4, 0x2000, 0x8100, 0x9100, 0);
    fixture.set_status(ACKNOWLEDGE | DRIVER | FEATURES_OK | DRIVER_OK);

    let state = fixture.state.lock().unwrap();
    assert!(state.activation.is_none());
    assert_eq!(state.resets, 1);
    drop(state);
    assert_eq!(fixture.status() & DRIVER_OK, 0);
    assert_ne!(fixture.status() & NEEDS_RESET, 0);
    assert_eq!(fixture.worker.starts.load(Ordering::SeqCst), 0);
    assert_eq!(*fixture.log.lock().unwrap(), ["prepare", "cancel", "reset"]);
    assert_ne!(fixture.read(0x060) & 0x2, 0);
}

#[test]
fn a_prepare_failure_needs_reset_without_activating() {
    let mut fixture = make(spec(0b111));
    *fixture.worker.prepare_error.lock().unwrap() = Some(DeviceError::Fatal("worker"));
    fixture.negotiate();
    fixture.activate();

    assert!(fixture.state.lock().unwrap().activation.is_none());
    assert_eq!(*fixture.log.lock().unwrap(), ["prepare"]);
    assert_eq!(fixture.status() & DRIVER_OK, 0);
    assert_ne!(fixture.status() & NEEDS_RESET, 0);
    assert_ne!(fixture.read(0x060) & 0x2, 0);
    assert!(matches!(
        fixture.events.wait(Some(Duration::ZERO)).unwrap(),
        Some(Event::DeviceFailed(Error::VirtioDevice { .. }))
    ));
    fixture.write(0x050, 0);
    assert!(fixture.worker.kicks.lock().unwrap().is_empty());
}

#[test]
fn driver_ok_without_features_ok_needs_reset() {
    let mut fixture = make(spec(0b111));
    fixture.set_status(ACKNOWLEDGE);
    fixture.set_status(ACKNOWLEDGE | DRIVER);
    fixture.set_status(ACKNOWLEDGE | DRIVER | DRIVER_OK);

    assert_eq!(fixture.status() & DRIVER_OK, 0);
    assert_ne!(fixture.status() & NEEDS_RESET, 0);
    assert_eq!(fixture.worker.starts.load(Ordering::SeqCst), 0);
}

#[test]
fn status_writes_are_cumulative() {
    let mut fixture = make(spec(0b111));
    fixture.set_status(ACKNOWLEDGE);
    assert_eq!(fixture.status(), ACKNOWLEDGE);
    fixture.set_status(DRIVER);
    assert_eq!(fixture.status(), ACKNOWLEDGE | DRIVER);
}

#[test]
fn a_status_write_with_reserved_high_bits_does_not_reset() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.activate();

    fixture.write(0x070, 0x100);

    assert_eq!(
        fixture.status(),
        ACKNOWLEDGE | DRIVER | FEATURES_OK | DRIVER_OK,
        "a nonzero write whose low byte is zero is not Status=0"
    );
    assert_eq!(fixture.state.lock().unwrap().resets, 0);
    assert_eq!(fixture.worker.stops.load(Ordering::SeqCst), 0);
}

#[test]
fn queue_ready_zero_keeps_the_configuration() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.configure_queue(0, 8, 0x1000, 0x8000, 0x9000, 1);
    fixture.write(0x044, 0);
    assert_eq!(fixture.read(0x044), 0);
    fixture.write(0x044, 1);
    fixture.configure_queue(1, 4, 0x2000, 0x8100, 0x9100, 0);
    fixture.set_status(ACKNOWLEDGE | DRIVER | FEATURES_OK | DRIVER_OK);

    let queues = fixture.activation_queues();
    assert!(queues[0].ready);
    assert_eq!(queues[0].desc, 0x1000);
}

#[test]
fn post_driver_ok_queue_writes_are_rejected() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.activate();

    assert_eq!(fixture.read(0x044), 1);
    fixture.write(0x044, 0);
    assert_eq!(fixture.read(0x044), 1);
    fixture.write(0x030, 1);
    assert_eq!(fixture.read(0x034), 8);
    fixture.write(0x038, 4);
    fixture.write(0x080, 0);
    fixture.write(0x084, 0);

    let queues = fixture.activation_queues();
    assert_eq!(queues[0].size, 8);
    assert_eq!(queues[0].desc, 0x1000);
}

#[test]
fn status_zero_stops_the_worker_then_resets() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.activate();
    fixture.interrupt.raise_config();
    assert_eq!(fixture.read(0x0fc), 1);

    fixture.set_status(0);

    assert_eq!(fixture.status(), 0);
    assert_eq!(fixture.read(0x060), 0);
    assert_eq!(fixture.worker.stops.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.state.lock().unwrap().resets, 1);
    assert_eq!(
        *fixture.log.lock().unwrap(),
        ["prepare", "activate", "start", "stop", "reset"]
    );
    assert_eq!(fixture.read(0x0fc), 1);
    assert_eq!(fixture.read(0x034), 8);
    assert_eq!(fixture.read(0x044), 0);

    fixture.negotiate();
    fixture.activate();
    assert_eq!(fixture.worker.starts.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.state.lock().unwrap().resets, 1);
}

#[test]
fn queue_notify_kicks_in_range_queues_once_active() {
    let mut fixture = make(spec(0b111));
    fixture.write(0x050, 0);
    assert!(fixture.worker.kicks.lock().unwrap().is_empty());

    fixture.negotiate();
    fixture.activate();
    fixture.write(0x050, 0);
    fixture.write(0x050, 0x1_0001);
    fixture.write(0x050, 9);
    assert_eq!(*fixture.worker.kicks.lock().unwrap(), [0, 1]);
}

#[test]
fn a_fatal_config_error_ends_the_vm_without_stopping_the_worker() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.activate();
    fixture.state.lock().unwrap().config_error = Some(DeviceError::Fatal("test"));

    let mut data = [0u8; 4];
    fixture.transport.read(0x100, &mut data);

    assert_eq!(fixture.worker.stops.load(Ordering::SeqCst), 0);
    assert!(!fixture.log.lock().unwrap().contains(&"stop"));
    match fixture.events.wait(Some(Duration::ZERO)).unwrap() {
        Some(Event::DeviceFailed(Error::VirtioDevice { device, reason })) => {
            assert_eq!(device, "test");
            assert_eq!(reason, "test");
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

#[test]
fn a_needs_reset_config_error_sets_the_status_and_config_interrupt() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.state.lock().unwrap().config_error = Some(DeviceError::NeedsReset("test"));

    let mut data = [0u8; 4];
    fixture.transport.read(0x100, &mut data);

    assert_ne!(fixture.status() & NEEDS_RESET, 0);
    assert_ne!(fixture.read(0x060) & 0x2, 0);
}

#[test]
fn worker_start_failure_needs_reset_and_ends_the_vm() {
    let mut fixture = make(spec(0b111));
    *fixture.worker.start_error.lock().unwrap() = Some(DeviceError::Fatal("worker"));
    fixture.negotiate();
    fixture.activate();

    assert_eq!(fixture.worker.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        *fixture.log.lock().unwrap(),
        ["prepare", "activate", "start", "cancel"]
    );
    assert_eq!(fixture.state.lock().unwrap().resets, 0);
    assert_ne!(fixture.status() & NEEDS_RESET, 0);
    assert!(matches!(
        fixture.events.wait(Some(Duration::ZERO)).unwrap(),
        Some(Event::DeviceFailed(Error::VirtioDevice { .. }))
    ));
    fixture.write(0x050, 0);
    assert!(fixture.worker.kicks.lock().unwrap().is_empty());
}

#[test]
fn worker_stop_failure_skips_the_device_reset() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.activate();
    *fixture.worker.stop_error.lock().unwrap() = Some(DeviceError::Fatal("worker"));

    fixture.set_status(0);

    assert_eq!(fixture.worker.stops.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.state.lock().unwrap().resets, 0);
    assert!(matches!(
        fixture.events.wait(Some(Duration::ZERO)).unwrap(),
        Some(Event::DeviceFailed(Error::VirtioDevice { .. }))
    ));
}

#[test]
fn the_constructor_rejects_an_unusable_specification() {
    let cases = [
        DeviceSpec {
            device_id: 0,
            ..spec(0b111)
        },
        DeviceSpec {
            config_len: super::super::MAX_CONFIG_LEN + 1,
            ..spec(0b111)
        },
        DeviceSpec {
            queue_max: &[8; 17],
            ..spec(0b111)
        },
        DeviceSpec {
            queue_max: &[3],
            ..spec(0b111)
        },
    ];
    for case in cases {
        assert!(matches!(try_make(case), Err(Error::VirtioDevice { .. })));
    }
}

#[test]
fn event_idx_is_applied_when_negotiated() {
    let mut fixture = make(spec(1 << 29));
    fixture.negotiate_with(VERSION_1 | (1 << 29));
    fixture.activate();

    let queues = fixture.activation_queues();
    assert!(queues[0].event_idx);
    assert!(queues[1].event_idx);
}

#[test]
fn failed_stops_the_worker_without_resetting_the_device() {
    let mut fixture = make(spec(0b111));
    fixture.negotiate();
    fixture.activate();

    fixture.set_status(0x80);
    assert_eq!(fixture.worker.stops.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.state.lock().unwrap().resets, 0);
    assert_ne!(fixture.status() & 0x80, 0);

    fixture.set_status(0);
    assert_eq!(fixture.state.lock().unwrap().resets, 1);
    assert_eq!(fixture.status(), 0);
}

#[test]
fn a_chipset_dispatches_mmio_to_the_transport() {
    const BASE: u64 = 0xd000_0000;

    let vm = Arc::new(MockVm::new());
    let events = EventLoop::new().unwrap();
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let worker = Arc::new(RecordingWorker::new(Arc::clone(&log)));
    let (device, _state) = device(spec(0b111), log);
    let interrupt_slot = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&interrupt_slot);

    let mut builder = ChipsetBuilder::new(vm.clone(), events.sender());
    builder
        .add("virtio-test", move |resources| {
            resources.mmio(BASE, MMIO_WINDOW_LEN);
            let interrupt = Arc::new(MmioInterrupt::new(resources.line(LINE)));
            *slot.lock().unwrap() = Some(Arc::clone(&interrupt));
            MmioTransport::new(
                device,
                interrupt,
                MmioResources {
                    memory,
                    sender: resources.event_sender(),
                    worker,
                },
            )
        })
        .unwrap();
    let chipset = builder.build().unwrap();

    let mut magic = [0u8; 4];
    assert!(
        chipset
            .dispatch(VcpuExit::MmioRead {
                guest_addr: BASE,
                bytes: &mut magic,
            })
            .is_none()
    );
    assert_eq!(u32::from_le_bytes(magic), 0x7472_6976);

    chipset.dispatch(VcpuExit::MmioWrite {
        guest_addr: BASE + 0x070,
        bytes: &1u32.to_le_bytes(),
    });
    let mut status = [0u8; 4];
    chipset.dispatch(VcpuExit::MmioRead {
        guest_addr: BASE + 0x070,
        bytes: &mut status,
    });
    assert_eq!(u32::from_le_bytes(status), 1);

    let interrupt = interrupt_slot
        .lock()
        .unwrap()
        .as_ref()
        .expect("the transport stored its interrupt")
        .clone();
    interrupt.raise();
    assert!(vm.calls().contains(&Call::SetIrqLine {
        line: LINE,
        level: true,
    }));
    assert_eq!(chipset.buses().mmio.unclaimed(), (0, 0));
}

#[test]
fn the_transport_claims_a_four_kib_window() {
    assert_eq!(MMIO_WINDOW_LEN, 0x1000);
}

#[test]
fn slots_hand_out_consecutive_windows_and_skip_the_rtc_line_until_exhausted() {
    let mut slots = Slots::new();
    for index in 0..Slots::CAPACITY {
        let slot = slots.take().unwrap();
        assert_eq!(slot.base, 0xd000_0000 + u64::from(index) * MMIO_WINDOW_LEN);
        assert_eq!(slot.gsi, if index < 3 { 5 + index } else { 6 + index });
    }
    assert_eq!(Slots::CAPACITY, 18);
    assert!(matches!(slots.take(), Err(Error::VirtioSlotsExhausted)));
    assert_eq!(
        Error::VirtioSlotsExhausted.to_string(),
        "no virtio-mmio slot is free"
    );
}

#[test]
fn a_slot_names_itself_the_way_the_kernel_parses_it() {
    let slot = Slots::new().take().unwrap();
    assert_eq!(slot.cmdline_arg(), "virtio_mmio.device=4K@0xd0000000:5");
    let second = Slot {
        base: 0xd000_1000,
        gsi: 6,
    };
    assert_eq!(second.cmdline_arg(), "virtio_mmio.device=4K@0xd0001000:6");
}

#[test]
fn announcing_puts_each_slot_first_within_the_command_line_budget() {
    let mut slots = Slots::new();
    let taken = [slots.take().unwrap(), slots.take().unwrap()];
    let mut cmdline = String::from("console=ttyS0");
    announce(&mut cmdline, &taken).unwrap();
    assert_eq!(
        cmdline,
        "virtio_mmio.device=4K@0xd0000000:5 virtio_mmio.device=4K@0xd0001000:6 console=ttyS0"
    );
    let mut empty = String::new();
    announce(&mut empty, &taken[..1]).unwrap();
    assert_eq!(empty, "virtio_mmio.device=4K@0xd0000000:5");

    let argument = taken[0].cmdline_arg();
    let mut full = "a".repeat(MAX_CMDLINE_BYTES - argument.len() - 1);
    assert!(matches!(
        announce(&mut full, &taken[..1]),
        Err(Error::InvalidCommandLine(
            "leaves no room for the virtio device arguments"
        ))
    ));
    let mut fits = "a".repeat(MAX_CMDLINE_BYTES - argument.len() - 2);
    announce(&mut fits, &taken[..1]).unwrap();
    assert_eq!(fits.len(), MAX_CMDLINE_BYTES - 1);
}

#[test]
fn announce_puts_the_device_arguments_before_any_init_arguments() {
    let mut slots = Slots::new();
    let taken = [slots.take().unwrap()];
    // A quoted value may hold ` -- `; the kernel reads it as one parameter,
    // so the device argument must not land inside the quotes.
    let mut quoted = String::from("console=ttyS0 label=\"a -- b\" -- x");
    announce(&mut quoted, &taken).unwrap();
    assert!(
        quoted.contains("label=\"a -- b\""),
        "the quoted value changed: {quoted}"
    );
    assert_eq!(
        quoted,
        "virtio_mmio.device=4K@0xd0000000:5 console=ttyS0 label=\"a -- b\" -- x"
    );

    let mut cmdline = String::from("console=ttyS0 init=/init -- --listen vsock://2695");
    announce(&mut cmdline, &taken).unwrap();
    assert_eq!(
        cmdline,
        "virtio_mmio.device=4K@0xd0000000:5 console=ttyS0 init=/init -- --listen vsock://2695"
    );
}

#[test]
fn add_device_puts_each_device_in_its_own_slot() {
    let vm = Arc::new(MockVm::new());
    let events = EventLoop::new().unwrap();
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap());
    let workers = VirtioWorkers::new(events.sender()).unwrap();
    let ctx = DeviceContext {
        memory: &memory,
        workers: &workers,
    };

    let mut slots = Slots::new();
    let taken = [slots.take().unwrap(), slots.take().unwrap()];
    let mut builder = ChipsetBuilder::new(vm, events.sender());
    for (name, slot) in [("virtio-a", taken[0]), ("virtio-b", taken[1])] {
        let (device, _state) = device(spec(0b111), Arc::new(Mutex::new(Vec::new())));
        add_device(&mut builder, &ctx, name, slot, device).unwrap();
    }
    let chipset = builder.build().unwrap();

    for slot in taken {
        let mut magic = [0u8; 4];
        assert!(
            chipset
                .dispatch(VcpuExit::MmioRead {
                    guest_addr: slot.base,
                    bytes: &mut magic,
                })
                .is_none()
        );
        assert_eq!(u32::from_le_bytes(magic), 0x7472_6976);
    }
    workers.shutdown().unwrap();
}

#[cfg(target_arch = "x86_64")]
#[test]
fn virtio_slots_do_not_conflict_with_the_pc_rtc_interrupt() {
    let vm = Arc::new(MockVm::new());
    let events = crate::events::EventLoop::new().unwrap();
    let mut builder = crate::chipset::ChipsetBuilder::new(vm, events.sender());
    builder
        .add("rtc", |r| {
            r.line(8);
            Ok(crate::devices::i8042::I8042::new(r.event_sender()))
        })
        .unwrap();
    let mut slots = Slots::new();
    for _ in 0..Slots::CAPACITY {
        let slot = slots.take().unwrap();
        builder
            .add("virtio", |r| {
                r.mmio(slot.base, MMIO_WINDOW_LEN);
                r.line(slot.gsi);
                Ok(crate::devices::i8042::I8042::new(r.event_sender()))
            })
            .unwrap();
    }
    builder
        .build()
        .expect("virtio devices must leave GSI 8 for the PC RTC");
}
