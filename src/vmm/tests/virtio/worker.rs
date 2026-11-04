// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio workers: delivery on the shared thread, kick coalescing, worker
//! generations, backend sources, device and runtime failures, stop and
//! shutdown timeouts, and the runtime seam the transport drives.

#![cfg(unix)]

use std::{
    collections::VecDeque,
    io::{self, Read as _, Write as _},
    os::fd::AsRawFd as _,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc,
    },
    thread::{self, ThreadId},
    time::Duration,
};

use mio::{
    Interest, Registry, Token,
    event::Source,
    unix::{SourceFd, pipe},
};
use virtio_queue::{Queue, QueueT as _};
use vm_memory::GuestAddress;

use super::{SharedRuntime, SlotId, Timeouts, VirtioWorkers, WorkerRuntime};
use crate::{
    bus::BusDevice,
    error::Error,
    events::{Event, EventLoop, EventSender},
    irq::IrqLine,
    memory::GuestMemoryMmap,
    mock_vm::MockVm,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, EventError, EventRegistrar,
        EventSource, FeatureError, NEEDS_RESET, SnapshotSupport, SourceId, VirtioDevice,
        VirtioInterrupt, WorkerContext, WorkerControl,
        interrupt::MmioInterrupt,
        mmio::{MmioResources, MmioTransport},
        queue::VirtQueues,
    },
};

/// How long a test waits for something that must happen.
const WAIT: Duration = Duration::from_secs(10);
/// How long a test waits to show that something blocked does not finish.
const BLOCKED: Duration = Duration::from_millis(50);
/// Short runtime timeouts, so the timeout paths run quickly.
const SHORT: Timeouts = Timeouts {
    stop: Duration::from_millis(200),
    shutdown: Duration::from_millis(400),
};

const QUEUES: &[u16] = &[8, 8, 8];

/// What a probe does with one event.
type Hook = Box<dyn FnMut(&ActivationContext, DeviceEvent) -> Result<(), DeviceError> + Send>;

fn ok() -> Hook {
    Box::new(|_, _| Ok(()))
}

/// The events a probe saw, in order, with the thread that delivered each.
#[derive(Default)]
struct Seen {
    events: Mutex<Vec<(DeviceEvent, ThreadId, Option<String>)>>,
    changed: Condvar,
}

impl Seen {
    fn push(&self, event: DeviceEvent) {
        let current = thread::current();
        let name = current.name().map(str::to_owned);
        self.events
            .lock()
            .unwrap()
            .push((event, current.id(), name));
        self.changed.notify_all();
    }

    /// Waits until `count` events arrived and returns every event so far.
    fn wait_for(&self, count: usize) -> Vec<DeviceEvent> {
        let events = self.events.lock().unwrap();
        let (events, wait) = self
            .changed
            .wait_timeout_while(events, WAIT, |events| events.len() < count)
            .unwrap();
        assert!(
            !wait.timed_out(),
            "{} of {count} events arrived: {:?}",
            events.len(),
            *events
        );
        events.iter().map(|(event, _, _)| *event).collect()
    }

    fn events(&self) -> Vec<DeviceEvent> {
        let events = self.events.lock().unwrap();
        events.iter().map(|(event, _, _)| *event).collect()
    }

    fn threads(&self) -> Vec<(ThreadId, Option<String>)> {
        let events = self.events.lock().unwrap();
        events
            .iter()
            .map(|(_, id, name)| (*id, name.clone()))
            .collect()
    }
}

/// Holds `on_event` until the test opens it.
#[derive(Default)]
struct Gate {
    state: Mutex<(usize, bool)>,
    changed: Condvar,
}

impl Gate {
    /// The device side: counts the entry, then waits for the gate to open.
    fn pass(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 += 1;
        self.changed.notify_all();
        let (_state, _) = self
            .changed
            .wait_timeout_while(state, WAIT, |state| !state.1)
            .unwrap();
    }

    fn wait_entered(&self, count: usize) {
        let state = self.state.lock().unwrap();
        let (_state, wait) = self
            .changed
            .wait_timeout_while(state, WAIT, |state| state.0 < count)
            .unwrap();
        assert!(!wait.timed_out(), "the device never reached the gate");
    }

    fn open(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}

/// A device that records its events and runs a hook on each.
struct Probe {
    spec: DeviceSpec,
    seen: Arc<Seen>,
    hook: Hook,
    ctx: Option<ActivationContext>,
    /// Results of the next activations, in order; `Ok` once empty.
    activations: VecDeque<Result<(), DeviceError>>,
    resets: usize,
    quiesces: usize,
}

impl VirtioDevice for Probe {
    fn spec(&self) -> &DeviceSpec {
        &self.spec
    }

    fn set_features(&mut self, _negotiated: u64) -> Result<(), FeatureError> {
        Ok(())
    }

    fn read_config(&mut self, _offset: u64, _data: &mut [u8]) -> Result<(), DeviceError> {
        Ok(())
    }

    fn write_config(&mut self, _offset: u64, _data: &[u8]) -> Result<(), DeviceError> {
        Ok(())
    }

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        self.ctx = Some(ctx);
        self.activations.pop_front().unwrap_or(Ok(()))
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.ctx = None;
        self.resets += 1;
        Ok(())
    }

    /// Runs the hook, then records the event, so a test that sees the event
    /// also sees what the hook did.
    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        let ctx = self
            .ctx
            .as_ref()
            .expect("events reach only an activated device");
        let result = (self.hook)(ctx, event);
        self.seen.push(event);
        result
    }

    fn quiesce(&mut self) -> Result<(), DeviceError> {
        self.quiesces += 1;
        Ok(())
    }
}

/// One probe in a runtime, driven the way the transport drives it.
struct Dev {
    device: Arc<Mutex<Probe>>,
    seen: Arc<Seen>,
    interrupt: Arc<MmioInterrupt>,
    worker: Arc<dyn WorkerControl>,
    sender: EventSender,
}

impl Dev {
    /// Prepares a generation, activates the probe with it and starts it, as
    /// the transport does at DRIVER_OK, and returns the generation's
    /// registrar.
    fn start(&self) -> Arc<dyn EventRegistrar> {
        let ctx = self.worker.prepare().expect("prepare a generation");
        let events = Arc::clone(&ctx.events);
        self.activate(ctx);
        self.worker.start().expect("start the generation");
        events
    }

    fn activate(&self, ctx: WorkerContext) {
        let interrupt: Arc<dyn VirtioInterrupt> = self.interrupt.clone();
        let activation = activation(ctx, interrupt, self.sender.clone());
        self.device.lock().unwrap().activate(activation).unwrap();
    }
}

/// A status handle whose `device_status` call simulates a driver write that
/// lands after the worker's read, which the old read-modify-write dropped.
#[derive(Default)]
struct RaceInterrupt {
    status: AtomicU8,
}

const DRIVER_BIT: u8 = 0x1;

impl RaceInterrupt {
    fn raw(&self) -> u8 {
        self.status.load(Ordering::SeqCst)
    }
}

impl VirtioInterrupt for RaceInterrupt {
    fn raise(&self) {}

    fn interrupt_status(&self) -> u8 {
        0
    }

    fn ack_interrupt(&self, _bits: u8) {}

    fn config_generation(&self) -> u8 {
        0
    }

    fn raise_config(&self) {}

    fn device_status(&self) -> u8 {
        let seen = self.status.load(Ordering::SeqCst);
        self.status.fetch_or(DRIVER_BIT, Ordering::SeqCst);
        seen
    }

    fn set_device_status(&self, status: u8) {
        self.status.store(status, Ordering::SeqCst);
    }

    fn set_needs_reset(&self) {
        self.status
            .fetch_or(DRIVER_BIT | NEEDS_RESET, Ordering::SeqCst);
    }
}

/// A runtime with short timeouts and the event loop its failures reach.
struct Rig {
    runtime: Arc<SharedRuntime>,
    workers: VirtioWorkers,
    events: EventLoop,
}

impl Rig {
    fn new() -> Self {
        Self::with_timeouts(SHORT)
    }

    fn with_timeouts(timeouts: Timeouts) -> Self {
        let events = EventLoop::new().unwrap();
        let runtime = Arc::new(SharedRuntime::new(events.sender(), timeouts).unwrap());
        let workers = VirtioWorkers::with_runtime(runtime.clone());
        Self {
            runtime,
            workers,
            events,
        }
    }

    fn device(&self, name: &'static str, hook: Hook) -> Dev {
        let (device, seen) = probe(name, hook);
        let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
        let shared: Arc<Mutex<dyn VirtioDevice>> = device.clone();
        let worker = self
            .workers
            .add(shared, Arc::clone(&interrupt) as Arc<dyn VirtioInterrupt>);
        Dev {
            device,
            seen,
            interrupt,
            worker,
            sender: self.events.sender(),
        }
    }

    /// The next event that ends the VM; fails the test if none arrives.
    fn failure(&mut self) -> Event {
        self.events
            .wait(Some(WAIT))
            .unwrap()
            .expect("a failure ends the VM")
    }

    /// Asserts that no further event has ended the VM.
    fn no_failure(&mut self) {
        let event = self.events.wait(Some(Duration::ZERO)).unwrap();
        assert!(event.is_none(), "unexpected event: {event:?}");
    }
}

/// A `Probe` and the record of the events it sees.
fn probe(name: &'static str, hook: Hook) -> (Arc<Mutex<Probe>>, Arc<Seen>) {
    let seen = Arc::new(Seen::default());
    let device = Arc::new(Mutex::new(Probe {
        spec: spec(name),
        seen: Arc::clone(&seen),
        hook,
        ctx: None,
        activations: VecDeque::new(),
        resets: 0,
        quiesces: 0,
    }));
    (device, seen)
}

/// Adds a device whose lock a panicking thread poisoned: building the VM must
/// not panic, and the dispatch path is what fails such a device afterwards.
#[test]
fn adding_a_device_with_a_poisoned_lock_does_not_panic() {
    let mut rig = Rig::new();
    let (device, _seen) = probe("poisoned", Box::new(|_, _| Ok(())));
    let shared: Arc<Mutex<dyn VirtioDevice>> = device.clone();
    assert!(
        thread::spawn(move || {
            let _guard = shared.lock().unwrap();
            panic!("poison the device lock");
        })
        .join()
        .is_err(),
        "the spawned thread must have panicked"
    );
    assert!(device.lock().is_err(), "the lock must be poisoned");

    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    let poisoned: Arc<Mutex<dyn VirtioDevice>> = device;
    let worker = rig.workers.add(poisoned, interrupt);
    assert!(worker.prepare().is_ok(), "a prepared generation");
    assert!(worker.cancel_prepare().is_ok());
    assert!(rig.events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

fn spec(name: &'static str) -> DeviceSpec {
    DeviceSpec {
        device_id: 1,
        name,
        features: 0,
        config_len: 0,
        queue_max: QUEUES,
        snapshot: SnapshotSupport::Unsupported,
    }
}

fn activation(
    worker: WorkerContext,
    interrupt: Arc<dyn VirtioInterrupt>,
    sender: EventSender,
) -> ActivationContext {
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap());
    let queues = QUEUES.iter().map(|&max| Queue::new(max).unwrap()).collect();
    let queues = VirtQueues::prepare(
        queues,
        QUEUES,
        false,
        false,
        Arc::clone(&memory),
        worker.requeue,
    )
    .unwrap();
    ActivationContext {
        memory,
        queues,
        interrupt,
        events: worker.events,
        waker: worker.waker,
        sender,
    }
}

fn kick(index: u16) -> DeviceEvent {
    DeviceEvent::QueueKick(index)
}

/// Runs `f` on another thread and returns the receiver of its result.
fn spawn<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> mpsc::Receiver<T> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx
}

/// A pipe's read end as a backend source. It records registration,
/// deregistration and drop, and refuses registration when asked to.
struct PipeSource {
    receiver: Arc<pipe::Receiver>,
    log: Arc<Mutex<Vec<&'static str>>>,
    refuse: bool,
}

impl EventSource for PipeSource {
    fn as_source(&mut self) -> &mut dyn Source {
        self
    }
}

impl Source for PipeSource {
    fn register(
        &mut self,
        registry: &Registry,
        token: Token,
        interests: Interest,
    ) -> io::Result<()> {
        if self.refuse {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        self.log.lock().unwrap().push("register");
        SourceFd(&self.receiver.as_raw_fd()).register(registry, token, interests)
    }

    fn reregister(
        &mut self,
        registry: &Registry,
        token: Token,
        interests: Interest,
    ) -> io::Result<()> {
        SourceFd(&self.receiver.as_raw_fd()).reregister(registry, token, interests)
    }

    fn deregister(&mut self, registry: &Registry) -> io::Result<()> {
        self.log.lock().unwrap().push("deregister");
        SourceFd(&self.receiver.as_raw_fd()).deregister(registry)
    }
}

impl Drop for PipeSource {
    fn drop(&mut self) {
        self.log.lock().unwrap().push("drop");
    }
}

/// A pipe whose read end a test registers and whose write end makes it ready.
struct Pipe {
    sender: pipe::Sender,
    receiver: Arc<pipe::Receiver>,
    log: Arc<Mutex<Vec<&'static str>>>,
}

impl Pipe {
    fn new() -> Self {
        let (sender, receiver) = pipe::new().unwrap();
        Self {
            sender,
            receiver: Arc::new(receiver),
            log: Arc::default(),
        }
    }

    fn source(&self) -> Box<dyn EventSource> {
        Box::new(PipeSource {
            receiver: Arc::clone(&self.receiver),
            log: Arc::clone(&self.log),
            refuse: false,
        })
    }

    fn write(&self) {
        (&self.sender).write_all(b"x").unwrap();
    }

    fn log(&self) -> Vec<&'static str> {
        self.log.lock().unwrap().clone()
    }
}

/// Reads `receiver` until it would block, as a device must on an edge.
fn drain(receiver: &pipe::Receiver) {
    let mut buf = [0u8; 64];
    loop {
        match (&*receiver).read(&mut buf) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return,
            Err(error) => panic!("reading the pipe failed: {error}"),
        }
    }
}

#[test]
fn a_kick_runs_on_event_on_the_worker_thread() {
    let rig = Rig::new();
    let dev = rig.device("probe", ok());
    dev.start();

    dev.worker.kick(1);

    assert_eq!(dev.seen.wait_for(1), [kick(1)]);
    let threads = dev.seen.threads();
    assert_eq!(threads[0].1.as_deref(), Some("virtio-worker"));
    assert_ne!(threads[0].0, thread::current().id());
}

#[test]
fn queue_notify_reaches_on_event_through_the_transport() {
    let rig = Rig::new();
    let dev = rig.device("probe", ok());
    let mut transport = transport(&dev);

    bring_up(&mut transport);
    write(&mut transport, 0x050, 2);

    assert_eq!(dev.seen.wait_for(1), [kick(2)]);
    assert_eq!(dev.seen.threads()[0].1.as_deref(), Some("virtio-worker"));
}

#[test]
fn kicks_during_an_event_run_once_in_the_next_pass() {
    let rig = Rig::new();
    let gate = Arc::new(Gate::default());
    let first = Arc::new(AtomicBool::new(true));
    let device_gate = Arc::clone(&gate);
    let dev = rig.device(
        "probe",
        Box::new(move |_, _| {
            if first.swap(false, Ordering::SeqCst) {
                device_gate.pass();
            }
            Ok(())
        }),
    );
    dev.start();
    dev.worker.kick(0);
    gate.wait_entered(1);

    for index in [0, 0, 0, 1, 1] {
        dev.worker.kick(index);
    }
    gate.open();

    assert_eq!(dev.seen.wait_for(3), [kick(0), kick(0), kick(1)]);
    // Two marker rounds on queue 2: a duplicate of the coalesced kicks would
    // arrive before the second marker.
    dev.worker.kick(2);
    dev.seen.wait_for(4);
    dev.worker.kick(2);
    assert_eq!(
        dev.seen.wait_for(5),
        [kick(0), kick(0), kick(1), kick(2), kick(2)]
    );
}

#[test]
fn cancel_prepare_closes_the_generation_and_drops_its_kicks() {
    let rig = Rig::new();
    let dev = rig.device("probe", ok());
    let pipe = Pipe::new();
    let ctx = dev.worker.prepare().unwrap();
    let events = Arc::clone(&ctx.events);
    events.register(pipe.source()).unwrap();
    dev.worker.kick(0);
    pipe.write();

    dev.worker.cancel_prepare().unwrap();

    assert_eq!(pipe.log(), ["register", "deregister", "drop"]);
    assert_eq!(
        events.register(Pipe::new().source()),
        Err(EventError::Closed)
    );
    dev.start();
    dev.worker.kick(1);
    assert_eq!(dev.seen.wait_for(1), [kick(1)]);
    dev.worker.kick(1);
    assert_eq!(dev.seen.wait_for(2), [kick(1), kick(1)]);
}

#[test]
fn a_failed_activation_retries_on_a_fresh_generation() {
    let rig = Rig::new();
    let dev = rig.device("probe", ok());
    dev.device
        .lock()
        .unwrap()
        .activations
        .push_back(Err(DeviceError::NeedsReset("test")));
    let mut transport = transport(&dev);

    bring_up(&mut transport);
    assert_ne!(status(&mut transport) & NEEDS_RESET, 0);
    write(&mut transport, 0x050, 0);
    write(&mut transport, 0x070, 0);
    bring_up(&mut transport);
    write(&mut transport, 0x050, 0);

    assert_eq!(dev.seen.wait_for(1), [kick(0)]);
}

#[test]
fn status_zero_waits_for_the_event_then_restarts_on_the_same_thread() {
    let rig = Rig::new();
    let gate = Arc::new(Gate::default());
    let device_gate = Arc::clone(&gate);
    let dev = rig.device(
        "probe",
        Box::new(move |_, event| {
            if event == kick(0) {
                device_gate.pass();
            }
            Ok(())
        }),
    );
    dev.start();
    dev.worker.kick(0);
    gate.wait_entered(1);

    let worker = Arc::clone(&dev.worker);
    let stopped = spawn(move || worker.stop());
    assert!(
        stopped.recv_timeout(BLOCKED).is_err(),
        "stop returned while an event was in flight"
    );
    gate.open();
    assert_eq!(stopped.recv_timeout(WAIT).unwrap(), Ok(()));

    dev.worker.kick(1);
    dev.start();
    dev.worker.kick(2);
    assert_eq!(dev.seen.wait_for(2), [kick(0), kick(2)]);
    let threads = dev.seen.threads();
    assert_eq!(threads[0].0, threads[1].0);
}

#[test]
fn every_device_shares_the_one_thread() {
    let rig = Rig::new();
    let first = rig.device("first", ok());
    let second = rig.device("second", ok());
    first.start();
    second.start();

    first.worker.kick(0);
    second.worker.kick(0);

    first.seen.wait_for(1);
    second.seen.wait_for(1);
    assert_eq!(first.seen.threads()[0].0, second.seen.threads()[0].0);
}

#[test]
fn slots_are_isolated() {
    let mut rig = Rig::new();
    let first = rig.device("first", ok());
    let second = rig.device(
        "second",
        Box::new(|_, event| match event {
            DeviceEvent::QueueKick(2) => Err(DeviceError::Fatal("second failed")),
            _ => Ok(()),
        }),
    );
    first.start();
    second.start();

    first.worker.kick(0);
    second.worker.kick(1);
    assert_eq!(first.seen.wait_for(1), [kick(0)]);
    assert_eq!(second.seen.wait_for(1), [kick(1)]);

    assert_eq!(first.worker.stop(), Ok(()));
    second.worker.kick(0);
    assert_eq!(second.seen.wait_for(2), [kick(1), kick(0)]);

    second.worker.kick(2);
    match rig.failure() {
        Event::DeviceFailed(Error::VirtioDevice { device, reason }) => {
            assert_eq!(device, "second");
            assert_eq!(reason, "second failed");
        }
        other => panic!("unexpected event: {other:?}"),
    }
    first.start();
    first.worker.kick(1);
    assert_eq!(first.seen.wait_for(2), [kick(0), kick(1)]);
    assert_eq!(first.seen.events().len(), 2);
    rig.no_failure();
}

#[test]
fn a_source_ready_before_start_is_reported_once() {
    let rig = Rig::new();
    // Another running device keeps the thread polling while the probe is only
    // prepared, so the readiness edge arrives before the probe starts.
    let other = rig.device("other", ok());
    other.start();
    let pipe = Pipe::new();
    let receiver = Arc::clone(&pipe.receiver);
    let dev = rig.device(
        "probe",
        Box::new(move |_, event| {
            if matches!(event, DeviceEvent::BackendReady(_)) {
                drain(&receiver);
            }
            Ok(())
        }),
    );
    let ctx = dev.worker.prepare().unwrap();
    let id = ctx.events.register(pipe.source()).unwrap();
    pipe.write();
    other.worker.kick(0);
    other.seen.wait_for(1);
    other.worker.kick(0);
    other.seen.wait_for(2);

    dev.activate(ctx);
    dev.worker.start().unwrap();

    assert_eq!(dev.seen.wait_for(1), [DeviceEvent::BackendReady(id)]);
    dev.worker.kick(0);
    assert_eq!(
        dev.seen.wait_for(2),
        [DeviceEvent::BackendReady(id), kick(0)]
    );
}

#[test]
fn sources_registered_in_on_event_report_until_deregistered() {
    let rig = Rig::new();
    let pipe = Arc::new(Pipe::new());
    let registered = Arc::new(Mutex::new(None));
    let device_pipe = Arc::clone(&pipe);
    let device_registered = Arc::clone(&registered);
    let dev = rig.device(
        "probe",
        Box::new(move |ctx, event| {
            match event {
                DeviceEvent::QueueKick(0) => {
                    let id = ctx.events.register(device_pipe.source()).unwrap();
                    *device_registered.lock().unwrap() = Some(id);
                }
                DeviceEvent::QueueKick(1) => {
                    let id = device_registered.lock().unwrap().expect("registered");
                    ctx.events.deregister(id);
                }
                DeviceEvent::BackendReady(_) => drain(&device_pipe.receiver),
                DeviceEvent::QueueKick(_) => {}
            }
            Ok(())
        }),
    );
    dev.start();
    dev.worker.kick(0);
    dev.seen.wait_for(1);
    let id = registered.lock().unwrap().expect("registered");

    pipe.write();
    assert_eq!(
        dev.seen.wait_for(2),
        [kick(0), DeviceEvent::BackendReady(id)]
    );
    dev.worker.kick(1);
    dev.seen.wait_for(3);
    assert_eq!(pipe.log(), ["register", "deregister", "drop"]);
    pipe.write();
    dev.worker.kick(2);
    dev.seen.wait_for(4);
    dev.worker.kick(2);
    assert_eq!(
        dev.seen.wait_for(5),
        [
            kick(0),
            DeviceEvent::BackendReady(id),
            kick(1),
            kick(2),
            kick(2)
        ]
    );
}

#[test]
fn a_stale_registrar_is_closed() {
    let rig = Rig::new();
    let dev = rig.device("probe", ok());
    let stale = dev.start();
    let pipe = Pipe::new();
    stale.register(pipe.source()).unwrap();

    assert_eq!(dev.worker.stop(), Ok(()));

    assert_eq!(pipe.log(), ["register", "deregister", "drop"]);
    assert_eq!(
        stale.register(Pipe::new().source()),
        Err(EventError::Closed)
    );
    let fresh = dev.start();
    assert_eq!(
        stale.register(Pipe::new().source()),
        Err(EventError::Closed)
    );
    assert!(fresh.register(Pipe::new().source()).is_ok());
    rig.runtime.shutdown().unwrap();
    assert_eq!(
        fresh.register(Pipe::new().source()),
        Err(EventError::Closed)
    );
}

#[test]
fn a_refused_source_leaves_nothing_behind() {
    let rig = Rig::new();
    let pipe = Arc::new(Pipe::new());
    let device_pipe = Arc::clone(&pipe);
    let dev = rig.device(
        "probe",
        Box::new(move |_, event| {
            if matches!(event, DeviceEvent::BackendReady(_)) {
                drain(&device_pipe.receiver);
            }
            Ok(())
        }),
    );
    let events = dev.start();
    let refused = Pipe::new();

    let result = events.register(Box::new(PipeSource {
        receiver: Arc::clone(&refused.receiver),
        log: Arc::clone(&refused.log),
        refuse: true,
    }));

    assert_eq!(
        result,
        Err(EventError::Register(io::ErrorKind::PermissionDenied))
    );
    assert_eq!(refused.log(), ["drop"]);
    let id = events.register(pipe.source()).unwrap();
    pipe.write();
    assert_eq!(dev.seen.wait_for(1), [DeviceEvent::BackendReady(id)]);
}

#[test]
fn a_registration_after_stop_closes_admission_is_refused() {
    let rig = Rig::new();
    let gate = Arc::new(Gate::default());
    let pipe = Arc::new(Pipe::new());
    let result = Arc::new(Mutex::new(None));
    let (device_gate, device_pipe, device_result) =
        (Arc::clone(&gate), Arc::clone(&pipe), Arc::clone(&result));
    let dev = rig.device(
        "probe",
        Box::new(move |ctx, _| {
            device_gate.pass();
            *device_result.lock().unwrap() = Some(ctx.events.register(device_pipe.source()));
            Ok(())
        }),
    );
    dev.start();
    dev.worker.kick(0);
    gate.wait_entered(1);

    let worker = Arc::clone(&dev.worker);
    let stopped = spawn(move || worker.stop());
    assert!(stopped.recv_timeout(BLOCKED).is_err());
    gate.open();

    assert_eq!(stopped.recv_timeout(WAIT).unwrap(), Ok(()));
    assert!(matches!(
        *result.lock().unwrap(),
        Some(Err(EventError::Closed))
    ));
    assert_eq!(pipe.log(), ["drop"]);
}

#[test]
fn needs_reset_halts_the_slot_until_status_zero() {
    let rig = Rig::new();
    let dev = rig.device(
        "probe",
        Box::new(|_, event| match event {
            DeviceEvent::QueueKick(0) => Err(DeviceError::NeedsReset("test")),
            _ => Ok(()),
        }),
    );
    let marker = rig.device("marker", ok());
    marker.start();
    dev.start();

    dev.worker.kick(0);
    dev.seen.wait_for(1);
    dev.worker.kick(1);
    marker.worker.kick(0);
    marker.seen.wait_for(1);
    marker.worker.kick(0);
    marker.seen.wait_for(2);

    assert_eq!(dev.seen.events(), [kick(0)]);
    assert_ne!(dev.interrupt.device_status() & NEEDS_RESET, 0);
    assert_ne!(dev.interrupt.interrupt_status() & 0x2, 0);
    assert_eq!(dev.interrupt.config_generation(), 1);
    assert_eq!(dev.worker.stop(), Ok(()));
    dev.start();
    dev.worker.kick(1);
    assert_eq!(dev.seen.wait_for(2), [kick(0), kick(1)]);
}

#[test]
fn a_driver_status_write_cannot_clear_needs_reset() {
    let events = EventLoop::new().unwrap();
    let workers = VirtioWorkers::new(events.sender()).unwrap();
    let seen = Arc::new(Seen::default());
    let interrupt = Arc::new(RaceInterrupt::default());
    let device = Arc::new(Mutex::new(Probe {
        spec: spec("race"),
        seen: Arc::clone(&seen),
        hook: Box::new(|_, _| Err(DeviceError::NeedsReset("race"))),
        ctx: None,
        activations: VecDeque::new(),
        resets: 0,
        quiesces: 0,
    }));
    let shared: Arc<Mutex<dyn VirtioDevice>> = device.clone();
    let worker = workers.add(shared, Arc::clone(&interrupt) as Arc<dyn VirtioInterrupt>);
    let context = worker.prepare().expect("prepare a generation");
    let activation = activation(
        context,
        Arc::clone(&interrupt) as Arc<dyn VirtioInterrupt>,
        events.sender(),
    );
    device.lock().unwrap().activate(activation).unwrap();
    worker.start().expect("start the generation");
    worker.kick(0);
    seen.wait_for(1);
    worker.stop().expect("stop the generation");

    assert_eq!(
        interrupt.raw() & DRIVER_BIT,
        DRIVER_BIT,
        "the worker overwrote the driver's status bit"
    );
    assert_eq!(interrupt.raw() & NEEDS_RESET, NEEDS_RESET);
    workers.shutdown().unwrap();
}

#[test]
fn a_fatal_error_a_panic_or_a_poisoned_lock_fails_the_device_once() {
    let mut rig = Rig::new();
    let fatal = rig.device("fatal", Box::new(|_, _| Err(DeviceError::Fatal("broken"))));
    let panics = rig.device("panics", Box::new(|_, _| panic!("device bug")));
    let poisoned = rig.device("poisoned", ok());
    for dev in [&fatal, &panics, &poisoned] {
        dev.start();
    }
    let device = Arc::clone(&poisoned.device);
    let _ = thread::spawn(move || {
        let _guard = device.lock().unwrap();
        panic!("poison the device lock");
    })
    .join();

    let mut reasons = Vec::new();
    for dev in [&fatal, &panics, &poisoned] {
        dev.worker.kick(0);
        match rig.failure() {
            Event::DeviceFailed(Error::VirtioDevice { device, reason }) => {
                reasons.push((device, reason));
            }
            other => panic!("unexpected event: {other:?}"),
        }
        dev.worker.kick(1);
    }

    assert_eq!(
        reasons,
        [
            ("fatal", "broken"),
            ("panics", "on_event panicked"),
            ("poisoned", "device lock is poisoned")
        ]
    );
    assert!(panics.device.is_poisoned());
    assert_eq!(fatal.seen.events(), [kick(0)]);
    // The panicking hook never returns, and a poisoned device is not called.
    assert!(panics.seen.events().is_empty());
    assert!(poisoned.seen.events().is_empty());
    for dev in [&fatal, &panics, &poisoned] {
        assert!(matches!(dev.worker.stop(), Err(DeviceError::Fatal(_))));
        assert!(matches!(dev.worker.prepare(), Err(DeviceError::Fatal(_))));
    }
    let quiesces = |dev: &Dev| match dev.device.lock() {
        Ok(device) => device.quiesces,
        Err(poisoned) => poisoned.into_inner().quiesces,
    };
    assert_eq!(
        quiesces(&fatal) + quiesces(&panics) + quiesces(&poisoned),
        0
    );
    rig.no_failure();
}

#[test]
fn a_stop_that_outlives_its_timeout_fails_without_reset() {
    let mut rig = Rig::new();
    let gate = Arc::new(Gate::default());
    let device_gate = Arc::clone(&gate);
    let dev = rig.device(
        "probe",
        Box::new(move |_, _| {
            device_gate.pass();
            Ok(())
        }),
    );
    let mut transport = transport(&dev);
    bring_up(&mut transport);
    write(&mut transport, 0x050, 0);
    gate.wait_entered(1);

    write(&mut transport, 0x070, 0);

    match rig.failure() {
        Event::DeviceFailed(Error::VirtioDevice { device, reason }) => {
            assert_eq!(device, "probe");
            assert_eq!(reason, "virtio worker stop timed out");
        }
        other => panic!("unexpected event: {other:?}"),
    }
    gate.open();
    assert_eq!(dev.device.lock().unwrap().resets, 0);
    assert!(matches!(dev.worker.stop(), Err(DeviceError::Fatal(_))));
    assert!(matches!(dev.worker.prepare(), Err(DeviceError::Fatal(_))));
}

#[test]
fn a_shutdown_that_outlives_its_timeout_reports_it_and_retries() {
    let rig = Rig::new();
    let gate = Arc::new(Gate::default());
    let device_gate = Arc::clone(&gate);
    let dev = rig.device(
        "probe",
        Box::new(move |_, _| {
            device_gate.pass();
            Ok(())
        }),
    );
    dev.start();
    dev.worker.kick(0);
    gate.wait_entered(1);

    let error = rig.workers.shutdown().unwrap_err();
    match &error {
        Error::VirtioWorker(source) => assert_eq!(source.kind(), io::ErrorKind::TimedOut),
        other => panic!("unexpected error: {other:?}"),
    }
    gate.open();
    rig.workers.shutdown().unwrap();
}

#[test]
fn shutdown_joins_the_thread_once_and_closes_everything() {
    thread_local! {
        static HELD: std::cell::RefCell<Option<Arc<()>>> = const { std::cell::RefCell::new(None) };
    }
    let rig = Rig::new();
    let token = Arc::new(());
    let thread_token = Arc::clone(&token);
    let dev = rig.device(
        "probe",
        Box::new(move |_, _| {
            HELD.with(|held| *held.borrow_mut() = Some(Arc::clone(&thread_token)));
            Ok(())
        }),
    );
    let events = dev.start();
    let pipe = Pipe::new();
    events.register(pipe.source()).unwrap();
    dev.worker.kick(0);
    dev.seen.wait_for(1);

    rig.workers.shutdown().unwrap();

    // The thread-local copy dies with the thread, so the join completed.
    assert_eq!(Arc::strong_count(&token), 2);
    assert_eq!(pipe.log(), ["register", "deregister", "drop"]);
    rig.workers.shutdown().unwrap();
    assert!(matches!(dev.worker.prepare(), Err(DeviceError::Fatal(_))));
    assert_eq!(
        events.register(Pipe::new().source()),
        Err(EventError::Closed)
    );
}

#[test]
fn the_workers_keep_no_device_alive() {
    let rig = Rig::new();
    let dev = rig.device("probe", ok());
    // The probe keeps its activation context, and with it the registrar.
    dev.start();
    dev.worker.kick(0);
    dev.seen.wait_for(1);
    let device = Arc::downgrade(&dev.device);

    drop(dev);
    drop(rig);

    assert!(device.upgrade().is_none());
}

/// A runtime that records what its handles ask of it.
#[derive(Default)]
struct FakeRuntime {
    calls: Mutex<Vec<String>>,
    shutdown_error: Mutex<Option<io::ErrorKind>>,
}

impl FakeRuntime {
    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

impl WorkerRuntime for FakeRuntime {
    fn add(
        &self,
        name: &'static str,
        _device: Arc<Mutex<dyn VirtioDevice>>,
        _interrupt: Arc<dyn VirtioInterrupt>,
    ) -> SlotId {
        self.record(format!("add {name}"));
        SlotId(7)
    }

    fn prepare(&self, slot: SlotId) -> Result<WorkerContext, DeviceError> {
        self.record(format!("prepare {}", slot.0));
        Ok(WorkerContext {
            events: Arc::new(NoRegistrar),
            waker: Arc::new(|| {}),
            requeue: Arc::new(|_| {}),
        })
    }

    fn start(&self, slot: SlotId) -> Result<(), DeviceError> {
        self.record(format!("start {}", slot.0));
        Ok(())
    }

    fn kick(&self, slot: SlotId, index: u16) {
        self.record(format!("kick {} {index}", slot.0));
    }

    fn stop(&self, slot: SlotId) -> Result<(), DeviceError> {
        self.record(format!("stop {}", slot.0));
        Ok(())
    }

    fn cancel_prepare(&self, slot: SlotId) -> Result<(), DeviceError> {
        self.record(format!("cancel {}", slot.0));
        Ok(())
    }

    fn shutdown(&self) -> io::Result<()> {
        self.record("shutdown".to_owned());
        match *self.shutdown_error.lock().unwrap() {
            Some(kind) => Err(io::Error::from(kind)),
            None => Ok(()),
        }
    }
}

struct NoRegistrar;

impl EventRegistrar for NoRegistrar {
    fn register(&self, _source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        Err(EventError::Closed)
    }

    fn deregister(&self, _id: SourceId) {}
}

#[test]
fn a_fake_runtime_drives_the_transport() {
    let fake = Arc::new(FakeRuntime::default());
    let workers = VirtioWorkers::with_runtime(fake.clone());
    let events = EventLoop::new().unwrap();
    let seen = Arc::new(Seen::default());
    let device = Arc::new(Mutex::new(Probe {
        spec: spec("probe"),
        seen,
        hook: ok(),
        ctx: None,
        activations: VecDeque::new(),
        resets: 0,
        quiesces: 0,
    }));
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    let shared: Arc<Mutex<dyn VirtioDevice>> = device.clone();
    let worker = workers.add(
        Arc::clone(&shared),
        Arc::clone(&interrupt) as Arc<dyn VirtioInterrupt>,
    );
    let mut transport = MmioTransport::new(
        shared,
        interrupt,
        MmioResources {
            memory: Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap()),
            sender: events.sender(),
            worker,
        },
    )
    .unwrap();

    bring_up(&mut transport);
    write(&mut transport, 0x050, 1);
    write(&mut transport, 0x070, 0);
    workers.shutdown().unwrap();
    *fake.shutdown_error.lock().unwrap() = Some(io::ErrorKind::TimedOut);
    let error = workers.shutdown().unwrap_err();

    assert_eq!(
        *fake.calls.lock().unwrap(),
        [
            "add probe",
            "prepare 7",
            "start 7",
            "kick 7 1",
            "stop 7",
            "shutdown",
            "shutdown"
        ]
    );
    assert_eq!(device.lock().unwrap().resets, 1);
    assert!(
        matches!(error, Error::VirtioWorker(source) if source.kind() == io::ErrorKind::TimedOut)
    );
}

/// A transport for `dev` on the real workers slot `dev.worker` holds.
fn transport(dev: &Dev) -> MmioTransport {
    let device: Arc<Mutex<dyn VirtioDevice>> = dev.device.clone();
    MmioTransport::new(
        device,
        Arc::clone(&dev.interrupt),
        MmioResources {
            memory: Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap()),
            sender: dev.sender.clone(),
            worker: Arc::clone(&dev.worker),
        },
    )
    .unwrap()
}

fn write(transport: &mut MmioTransport, offset: u64, value: u32) {
    transport.write(offset, &value.to_le_bytes());
}

fn status(transport: &mut MmioTransport) -> u8 {
    let mut data = [0u8; 4];
    transport.read(0x070, &mut data);
    data[0]
}

/// Negotiates VERSION_1 and writes DRIVER_OK, leaving every queue unready.
fn bring_up(transport: &mut MmioTransport) {
    for (offset, value) in [
        (0x070, 1),
        (0x070, 3),
        (0x024, 1),
        (0x020, 1),
        (0x070, 0xb),
        (0x070, 0xf),
    ] {
        write(transport, offset, value);
    }
}
