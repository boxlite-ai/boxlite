// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio device contract: object safety, feature delivery, pending
//! control, event contexts and the default snapshot methods.

use std::{
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicUsize, Ordering},
    },
};

use mio::{Interest, Registry, Token, event::Source};

use crate::{
    io::{Cancelled, Completion, ConfigBytes, Waker},
    virtio::{
        Budget, DeviceError, DeviceEvent, DeviceOp, DeviceSnapshot, DeviceSpec, EventContext,
        EventError, EventRegistrar, EventSource, FeatureError, MAX_CONFIG_LEN, MAX_QUEUES,
        PendingControl, RestoreContext, SnapshotError, SnapshotSupport, SourceId, VirtioDevice,
    },
};

struct TestDevice {
    spec: DeviceSpec,
    features: u64,
    events: Vec<DeviceEvent>,
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
            events: Vec::new(),
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

    fn read_config(&mut self, _offset: u64, _len: usize) -> DeviceOp<ConfigBytes> {
        DeviceOp::Ready(Ok(ConfigBytes::from_slice(&self.features.to_le_bytes())))
    }

    fn write_config(&mut self, _offset: u64, _value: ConfigBytes) -> DeviceOp<()> {
        DeviceOp::Ready(Ok(()))
    }

    fn on_event(
        &mut self,
        event: DeviceEvent,
        _cx: &mut EventContext<'_>,
    ) -> Result<(), DeviceError> {
        self.events.push(event);
        Ok(())
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

#[test]
fn the_contract_is_object_safe() {
    let mut device: Box<dyn VirtioDevice> = Box::new(TestDevice::new());
    assert_eq!(device.spec().name, "test");
    assert!(device.set_features(0b101).is_ok());
    let DeviceOp::Ready(Ok(bytes)) = device.read_config(0, 8) else {
        panic!("expected a ready configuration read");
    };
    assert_eq!(bytes.as_slice(), &0b101_u64.to_le_bytes());
    assert!(matches!(
        device.write_config(0, ConfigBytes::new(1)),
        DeviceOp::Ready(Ok(()))
    ));
}

#[test]
fn features_reach_the_device_before_configuration_reads() {
    let mut device = TestDevice::new();
    assert!(device.set_features(0b100).is_ok());
    let DeviceOp::Ready(Ok(bytes)) = device.read_config(0, 8) else {
        panic!("expected a ready configuration read");
    };
    assert_eq!(bytes.as_slice(), &0b100_u64.to_le_bytes());
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
fn a_pending_operation_keeps_its_completion() {
    let (completion, completer) = Completion::new();
    let op: DeviceOp<()> = DeviceOp::Pending(completion);
    assert!(completer.complete(()));
    let DeviceOp::Pending(completion) = op else {
        panic!("expected a pending operation");
    };
    assert_eq!(completion.wait(), Ok(()));
}

#[test]
fn a_pending_control_completes_once() {
    let (completion, completer) = Completion::new();
    let mut pending = PendingControl::new();
    assert!(!pending.is_pending());
    assert!(pending.begin(completer));
    assert!(pending.is_pending());
    assert!(pending.complete(7_u32));
    assert!(!pending.complete(8));
    assert!(!pending.is_pending());
    assert_eq!(completion.wait(), Ok(7));
}

#[test]
fn a_pending_control_rejects_a_second_operation_and_cancels() {
    let (completion, completer) = Completion::<()>::new();
    let mut pending = PendingControl::new();
    assert!(pending.begin(completer));
    let (_, second) = Completion::<()>::new();
    assert!(!pending.begin(second));
    assert!(pending.cancel());
    assert!(!pending.cancel());
    assert_eq!(completion.wait(), Err(Cancelled));
}

#[test]
fn snapshot_defaults_are_unsupported() {
    let mut device = TestDevice::new();
    assert!(matches!(
        device.quiesce(),
        DeviceOp::Ready(Err(DeviceError::Unsupported(_)))
    ));
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
        DeviceOp::Ready(Err(DeviceError::Unsupported(_)))
    ));
    assert!(matches!(device.resume(), DeviceOp::Ready(Ok(()))));
}

#[test]
fn events_reach_the_device() {
    let mut device = TestDevice::new();
    let registrar = TestRegistrar::default();
    let mut cx = EventContext::new(&registrar, 4, waker());
    assert!(device.on_event(DeviceEvent::QueueKick(3), &mut cx).is_ok());
    assert!(device.on_event(DeviceEvent::Continue, &mut cx).is_ok());
    assert_eq!(
        device.events,
        vec![DeviceEvent::QueueKick(3), DeviceEvent::Continue]
    );
}

#[test]
fn the_event_context_registers_deregisters_and_budgets() {
    let registrar = TestRegistrar::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let control: Waker = Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let mut cx = EventContext::new(&registrar, 4, control);
    let id = cx
        .register(DeviceEvent::BackendReady(SourceId(9)), Box::new(TestSource))
        .unwrap();
    let forwarded = cx.control().clone();
    forwarded();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(cx.consume(2));
    assert!(cx.consume(2));
    assert!(cx.exhausted());
    assert!(!cx.consume(1));
    cx.reschedule();
    assert!(cx.rescheduled());
    assert_eq!(
        *registrar.events.lock().unwrap(),
        vec![DeviceEvent::BackendReady(SourceId(9))]
    );
    cx.deregister(id);
    assert!(registrar.sources.lock().unwrap().is_empty());
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
fn the_budget_stops_at_zero() {
    let mut budget = Budget::new(3);
    assert_eq!(budget.remaining(), 3);
    assert!(budget.consume(2));
    assert_eq!(budget.remaining(), 1);
    assert!(!budget.consume(2));
    assert_eq!(budget.remaining(), 0);
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
