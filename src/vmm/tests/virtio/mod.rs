// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio device contract: object safety, feature delivery, synchronous
//! configuration, activation, reset, event delivery and the default snapshot
//! methods.

use std::{
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicU32, AtomicUsize, Ordering},
    },
};

use mio::{Interest, Registry, Token, event::Source};
use virtio_queue::{Queue, QueueT};
use vm_memory::{GuestAddress, GuestMemoryBackend};

use crate::{
    events::EventLoop,
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSnapshot, DeviceSpec, EventError,
        EventRegistrar, EventSource, FeatureError, MAX_CONFIG_LEN, MAX_QUEUES, RestoreContext,
        SnapshotError, SnapshotSupport, SourceId, VirtioDevice, VirtioInterrupt, Waker,
    },
};

struct TestDevice {
    spec: DeviceSpec,
    features: u64,
    writes: Vec<(u64, Vec<u8>)>,
    events: Vec<DeviceEvent>,
    activation: Option<ActivationContext>,
    resets: usize,
}

impl TestDevice {
    fn new() -> Self {
        Self {
            spec: DeviceSpec {
                device_id: 1,
                name: "test",
                features: 0b111,
                config_len: 4,
                queue_max: &[4, 4],
                snapshot: SnapshotSupport::Stopped,
            },
            features: 0,
            writes: Vec::new(),
            events: Vec::new(),
            activation: None,
            resets: 0,
        }
    }
}

impl VirtioDevice for TestDevice {
    fn spec(&self) -> &DeviceSpec {
        &self.spec
    }

    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        let unsupported = negotiated & !self.spec.features;
        if unsupported != 0 {
            return Err(FeatureError { unsupported });
        }
        self.features = negotiated;
        Ok(())
    }

    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        let features = self.features.to_le_bytes();
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = features.get(offset as usize + i).copied().unwrap_or(0);
        }
        Ok(())
    }

    fn write_config(&mut self, offset: u64, data: &[u8]) -> Result<(), DeviceError> {
        self.writes.push((offset, data.to_vec()));
        Ok(())
    }

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        self.activation = Some(ctx);
        Ok(())
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.features = 0;
        self.activation = None;
        self.resets += 1;
        Ok(())
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        self.events.push(event);
        Ok(())
    }
}

#[derive(Default)]
struct TestInterrupt {
    status: AtomicU8,
    interrupt: AtomicU8,
}

impl VirtioInterrupt for TestInterrupt {
    fn raise(&self) {
        self.interrupt.fetch_or(0x1, Ordering::SeqCst);
    }

    fn interrupt_status(&self) -> u8 {
        self.interrupt.load(Ordering::SeqCst)
    }

    fn ack_interrupt(&self, bits: u8) {
        self.interrupt.fetch_and(!bits, Ordering::SeqCst);
    }

    fn config_generation(&self) -> u8 {
        0
    }

    fn raise_config(&self) {
        self.interrupt.fetch_or(0x2, Ordering::SeqCst);
    }

    fn device_status(&self) -> u8 {
        self.status.load(Ordering::SeqCst)
    }

    fn set_device_status(&self, status: u8) {
        self.status.store(status, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct TestRegistrar {
    events: Mutex<Vec<DeviceEvent>>,
    sources: Mutex<Vec<SourceId>>,
    next: AtomicU32,
}

impl EventRegistrar for TestRegistrar {
    fn register(
        &self,
        event: DeviceEvent,
        mut source: Box<dyn EventSource>,
    ) -> Result<SourceId, EventError> {
        let _ = source.as_source();
        let id = SourceId(self.next.fetch_add(1, Ordering::SeqCst));
        self.events.lock().unwrap().push(event);
        self.sources.lock().unwrap().push(id);
        Ok(id)
    }

    fn deregister(&self, id: SourceId) {
        self.sources.lock().unwrap().retain(|source| *source != id);
    }
}

struct TestSource;

impl EventSource for TestSource {
    fn as_source(&mut self) -> &mut dyn Source {
        self
    }
}

impl Source for TestSource {
    fn register(
        &mut self,
        _registry: &Registry,
        _token: Token,
        _interests: Interest,
    ) -> io::Result<()> {
        Ok(())
    }

    fn reregister(
        &mut self,
        _registry: &Registry,
        _token: Token,
        _interests: Interest,
    ) -> io::Result<()> {
        Ok(())
    }

    fn deregister(&mut self, _registry: &Registry) -> io::Result<()> {
        Ok(())
    }
}

fn waker() -> Waker {
    Arc::new(|| {})
}

fn sender() -> crate::events::EventSender {
    EventLoop::new().unwrap().sender()
}

fn activation_with(events: Arc<dyn EventRegistrar>, waker: Waker) -> ActivationContext {
    ActivationContext {
        memory: Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap()),
        queues: vec![Queue::new(8).unwrap()],
        interrupt: Arc::new(TestInterrupt::default()),
        events,
        waker,
        sender: sender(),
    }
}

fn activation() -> ActivationContext {
    activation_with(Arc::new(TestRegistrar::default()), waker())
}

#[test]
fn the_contract_is_object_safe() {
    let mut device: Box<dyn VirtioDevice> = Box::new(TestDevice::new());
    assert_eq!(device.spec().name, "test");
    assert!(device.set_features(0b101).is_ok());
    let mut bytes = [0u8; 8];
    assert!(device.read_config(0, &mut bytes).is_ok());
    assert_eq!(bytes, 0b101_u64.to_le_bytes());
    assert!(device.write_config(0, &[1, 2]).is_ok());
}

#[test]
fn features_reach_the_device_before_configuration_reads() {
    let mut device = TestDevice::new();
    assert!(device.set_features(0b100).is_ok());
    let mut bytes = [0u8; 8];
    assert!(device.read_config(0, &mut bytes).is_ok());
    assert_eq!(bytes, 0b100_u64.to_le_bytes());
}

#[test]
fn unsupported_features_are_rejected() {
    let mut device = TestDevice::new();
    assert_eq!(
        device.set_features(0b1000),
        Err(FeatureError {
            unsupported: 0b1000
        })
    );
    assert_eq!(
        FeatureError {
            unsupported: 0b1000
        }
        .to_string(),
        "unsupported feature bits 0x8"
    );
}

#[test]
fn configuration_writes_reach_the_device() {
    let mut device = TestDevice::new();
    assert!(device.write_config(2, &[7, 8, 9]).is_ok());
    assert_eq!(device.writes, vec![(2, vec![7, 8, 9])]);
}

#[test]
fn activation_takes_the_context_and_reset_clears_it() {
    let mut device = TestDevice::new();
    assert!(device.activate(activation()).is_ok());
    let ctx = device.activation.as_ref().expect("the device is activated");
    assert_eq!(ctx.queues.len(), 1);
    assert_eq!(ctx.memory.iter().count(), 1);
    ctx.interrupt.raise();
    assert_eq!(ctx.interrupt.interrupt_status(), 0x1);
    ctx.interrupt.raise_config();
    assert_eq!(ctx.interrupt.interrupt_status(), 0x3);
    ctx.interrupt.ack_interrupt(0x1);
    assert_eq!(ctx.interrupt.interrupt_status(), 0x2);
    assert_eq!(ctx.interrupt.config_generation(), 0);
    ctx.interrupt.set_device_status(0x08);
    assert_eq!(ctx.interrupt.device_status(), 0x08);
    assert!(
        ctx.events
            .register(DeviceEvent::BackendReady(SourceId(0)), Box::new(TestSource))
            .is_ok()
    );
    (ctx.waker)();
    assert!(!ctx.sender.is_stopping());

    assert!(device.set_features(0b1).is_ok());
    assert!(device.reset().is_ok());
    assert!(device.activation.is_none());
    assert_eq!(device.features, 0);
    assert_eq!(device.resets, 1);
}

#[test]
fn events_reach_the_device() {
    let mut device = TestDevice::new();
    assert!(device.on_event(DeviceEvent::QueueKick(3)).is_ok());
    assert!(
        device
            .on_event(DeviceEvent::BackendReady(SourceId(7)))
            .is_ok()
    );
    assert_eq!(
        device.events,
        vec![
            DeviceEvent::QueueKick(3),
            DeviceEvent::BackendReady(SourceId(7))
        ]
    );
}

#[test]
fn the_activation_context_registers_deregisters_and_wakes() {
    let registrar = Arc::new(TestRegistrar::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let control: Waker = Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let ctx = activation_with(registrar.clone(), control);
    let id = ctx
        .events
        .register(DeviceEvent::BackendReady(SourceId(9)), Box::new(TestSource))
        .unwrap();
    (ctx.waker)();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *registrar.events.lock().unwrap(),
        vec![DeviceEvent::BackendReady(SourceId(9))]
    );
    ctx.events.deregister(id);
    assert!(registrar.sources.lock().unwrap().is_empty());
}

#[test]
fn snapshot_defaults_are_unsupported() {
    let mut device = TestDevice::new();
    assert!(matches!(device.quiesce(), Err(DeviceError::Unsupported(_))));
    assert_eq!(device.save_state(), Err(SnapshotError::Unsupported));
    assert!(matches!(
        device.restore_state(
            DeviceSnapshot {
                format: 1,
                version: 1,
                payload: Vec::new(),
            },
            RestoreContext
        ),
        Err(DeviceError::Unsupported(_))
    ));
    assert!(matches!(device.resume(), Ok(())));
}

#[test]
fn the_spec_declares_bounded_queues_and_configuration() {
    let spec = *TestDevice::new().spec();
    assert_eq!(spec.device_id, 1);
    assert_eq!(spec.name, "test");
    assert_eq!(spec.features, 0b111);
    assert_eq!(spec.config_len, 4);
    assert!(spec.queue_max.len() <= MAX_QUEUES);
    assert!(spec.config_len <= MAX_CONFIG_LEN);
    assert_eq!(spec.snapshot, SnapshotSupport::Stopped);
    let unsupported = DeviceSpec {
        snapshot: SnapshotSupport::Unsupported,
        ..spec
    };
    assert_eq!(unsupported.snapshot, SnapshotSupport::Unsupported);
}

#[test]
fn device_errors_are_classified() {
    assert_eq!(
        DeviceError::Unsupported("x").to_string(),
        "x is not supported"
    );
    assert_eq!(
        DeviceError::NeedsReset("x").to_string(),
        "x requires a device reset"
    );
    assert_eq!(DeviceError::Fatal("x").to_string(), "x failed");
}

#[test]
fn snapshot_and_event_errors_name_their_cause() {
    assert_eq!(
        SnapshotError::Unsupported.to_string(),
        "the device does not support snapshots"
    );
    assert_eq!(EventError::Closed.to_string(), "the event worker is closed");
}
