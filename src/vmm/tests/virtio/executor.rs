// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Exercise dispatch, host fd readiness and generation barriers through the
//! shared runtime, including callbacks that register sources themselves.

use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    os::{fd::AsRawFd, unix::net::UnixStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use mio::{Interest, Registry, Token, event::Source, unix::SourceFd};
use vm_memory::{Bytes, GuestAddress};

use super::{Phase, SharedRuntime, Thread};
use crate::virtio::worker::{Timeouts, VirtioWorkers, WorkerRuntime};
use crate::{
    bus::BusDevice,
    error::Error,
    events::{Event, EventLoop},
    irq::IrqLine,
    memory::GuestMemoryMmap,
    mock_vm::MockVm,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, EventError, EventRegistrar,
        EventSource, FeatureError, SnapshotSupport, VirtioDevice, VirtioInterrupt, WorkerControl,
        interrupt::MmioInterrupt,
        mmio::{MmioResources, MmioTransport},
        queue::Completion,
    },
};

const WAIT: Duration = Duration::from_secs(2);
const SPEC: DeviceSpec = DeviceSpec {
    device_id: 1,
    name: "worker-contract-test",
    features: 0,
    config_len: 0,
    queue_max: &[8; 5],
    snapshot: SnapshotSupport::Unsupported,
};

type Handler = Box<dyn FnMut(DeviceEvent) -> Result<(), DeviceError> + Send>;

struct Device {
    handler: Handler,
    events: mpsc::Sender<(DeviceEvent, thread::ThreadId)>,
    configuration: Option<Box<dyn FnMut() -> Result<(), DeviceError> + Send>>,
}

impl VirtioDevice for Device {
    fn spec(&self) -> &DeviceSpec {
        &SPEC
    }
    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        if negotiated == 0 {
            Ok(())
        } else {
            Err(FeatureError {
                unsupported: negotiated,
            })
        }
    }
    fn read_config(&mut self, _offset: u64, _data: &mut [u8]) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("configuration"))
    }
    fn write_config(&mut self, _offset: u64, _data: &[u8]) -> Result<(), DeviceError> {
        match &mut self.configuration {
            Some(configure) => configure(),
            None => Err(DeviceError::Unsupported("configuration")),
        }
    }
    fn activate(&mut self, _ctx: ActivationContext) -> Result<(), DeviceError> {
        Ok(())
    }
    fn reset(&mut self) -> Result<(), DeviceError> {
        Ok(())
    }
    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        let result = (self.handler)(event);
        self.events.send((event, thread::current().id())).unwrap();
        result
    }
}

struct RegisteredDevice {
    device: Arc<Mutex<dyn VirtioDevice>>,
    worker: Arc<dyn WorkerControl>,
    interrupt: Arc<MmioInterrupt>,
    events: mpsc::Receiver<(DeviceEvent, thread::ThreadId)>,
}

fn add(runtime: &Arc<SharedRuntime>, handler: Handler) -> RegisteredDevice {
    let (tx, rx) = mpsc::channel();
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(Device {
        handler,
        events: tx,
        configuration: None,
    }));
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    let worker =
        VirtioWorkers::with_runtime(runtime.clone()).add(device.clone(), interrupt.clone());
    RegisteredDevice {
        device,
        worker,
        interrupt,
        events: rx,
    }
}

fn next(device: &RegisteredDevice) -> (DeviceEvent, thread::ThreadId) {
    device.events.recv_timeout(WAIT).unwrap()
}

/// Own the descriptor until deregistration. SourceFd only borrows it during
/// each real host registration; no test-owned readiness dispatch is involved.
struct FdSource {
    stream: UnixStream,
    drops: Arc<AtomicUsize>,
    invalid: bool,
    registration_gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
}

impl Drop for FdSource {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

impl EventSource for FdSource {
    fn as_source(&mut self) -> &mut dyn Source {
        self
    }
}

impl Source for FdSource {
    fn register(
        &mut self,
        registry: &Registry,
        token: Token,
        interests: Interest,
    ) -> io::Result<()> {
        if let Some((entered, release)) = self.registration_gate.take() {
            entered.send(()).unwrap();
            release.recv_timeout(WAIT).unwrap();
        }
        let fd = if self.invalid {
            -1
        } else {
            self.stream.as_raw_fd()
        };
        SourceFd(&fd).register(registry, token, interests)
    }
    fn reregister(
        &mut self,
        registry: &Registry,
        token: Token,
        interests: Interest,
    ) -> io::Result<()> {
        SourceFd(&self.stream.as_raw_fd()).reregister(registry, token, interests)
    }
    fn deregister(&mut self, registry: &Registry) -> io::Result<()> {
        SourceFd(&self.stream.as_raw_fd()).deregister(registry)
    }
}

fn source(stream: UnixStream, drops: &Arc<AtomicUsize>) -> Box<FdSource> {
    stream.set_nonblocking(true).unwrap();
    Box::new(FdSource {
        stream,
        drops: Arc::clone(drops),
        invalid: false,
        registration_gate: None,
    })
}

fn drain(stream: &mut UnixStream) {
    let mut bytes = [0; 32];
    loop {
        match stream.read(&mut bytes) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("backend read failed: {error}"),
        }
    }
}

#[test]
fn one_lazy_thread_coalesces_queue_bits_and_preserves_kicks_during_a_pass() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let mut first = true;
    let a = add(
        &runtime,
        Box::new(move |_| {
            if first {
                first = false;
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
            }
            Ok(())
        }),
    );
    let b = add(&runtime, Box::new(|_| Ok(())));
    a.worker.prepare().unwrap();
    b.worker.prepare().unwrap();
    assert!(matches!(*runtime.thread.lock().unwrap(), Thread::Idle));
    a.worker.start().unwrap();
    b.worker.start().unwrap();
    a.worker.kick(2);
    entered_rx.recv_timeout(WAIT).unwrap();
    for _ in 0..10 {
        a.worker.kick(1);
    }
    a.worker.kick(2);
    b.worker.kick(4);
    release_tx.send(()).unwrap();
    let (event, thread) = next(&a);
    assert_eq!(event, DeviceEvent::QueueKick(2));
    assert_eq!(next(&a), (DeviceEvent::QueueKick(1), thread));
    assert_eq!(next(&a), (DeviceEvent::QueueKick(2), thread));
    assert_eq!(next(&b), (DeviceEvent::QueueKick(4), thread));
    a.worker.stop().unwrap();
    a.worker.kick(0);
    b.worker.kick(3);
    assert_eq!(next(&b), (DeviceEvent::QueueKick(3), thread));
    b.worker.stop().unwrap();
    assert!(a.events.try_recv().is_err());
    assert!(matches!(
        *runtime.thread.lock().unwrap(),
        Thread::Running { .. }
    ));
    runtime.shutdown().unwrap();
    runtime.shutdown().unwrap();
    assert!(matches!(*runtime.thread.lock().unwrap(), Thread::Joined));
}

#[test]
fn real_backend_fds_register_before_start_and_from_a_callback() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let registrar = Arc::new(Mutex::new(None::<Arc<dyn EventRegistrar>>));
    let readers = Arc::new(Mutex::new(BTreeMap::<u32, UnixStream>::new()));
    let drops = Arc::new(AtomicUsize::new(0));
    let (read_a, mut write_a) = UnixStream::pair().unwrap();
    let (read_b, mut write_b) = UnixStream::pair().unwrap();
    let mut second = Some(source(read_b.try_clone().unwrap(), &drops));
    let callback_registrar = Arc::clone(&registrar);
    let callback_readers = Arc::clone(&readers);
    let (id_tx, id_rx) = mpsc::channel();
    let device = add(
        &runtime,
        Box::new(move |event| {
            match event {
                DeviceEvent::QueueKick(_) => {
                    if let Some(source) = second.take() {
                        let id = callback_registrar
                            .lock()
                            .unwrap()
                            .as_ref()
                            .unwrap()
                            .register(source)
                            .unwrap();
                        callback_readers
                            .lock()
                            .unwrap()
                            .insert(id.0, read_b.try_clone().unwrap());
                        id_tx.send(id).unwrap();
                    }
                }
                DeviceEvent::BackendReady(id) => {
                    drain(callback_readers.lock().unwrap().get_mut(&id.0).unwrap());
                }
            }
            Ok(())
        }),
    );
    let ctx = device.worker.prepare().unwrap();
    *registrar.lock().unwrap() = Some(Arc::clone(&ctx.events));
    let a = ctx
        .events
        .register(source(read_a.try_clone().unwrap(), &drops))
        .unwrap();
    readers.lock().unwrap().insert(a.0, read_a);
    write_a.write_all(b"before start").unwrap();
    device.worker.start().unwrap();
    assert_eq!(next(&device).0, DeviceEvent::BackendReady(a));
    device.worker.kick(0);
    let b = id_rx.recv_timeout(WAIT).unwrap();
    assert_ne!(a, b);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(0));
    write_b.write_all(b"registered from on_event").unwrap();
    assert_eq!(next(&device).0, DeviceEvent::BackendReady(b));
    ctx.events.deregister(a);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    write_a.write_all(b"after deregister").unwrap();
    device.worker.kick(1);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(1));
    device.worker.stop().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 2);
    assert!(device.events.try_recv().is_err());
    let (read, _write) = UnixStream::pair().unwrap();
    assert!(matches!(
        ctx.events.register(source(read, &drops)),
        Err(EventError::Closed)
    ));
    let fresh = device.worker.prepare().unwrap();
    let (read, mut write) = UnixStream::pair().unwrap();
    let id = fresh
        .events
        .register(source(read.try_clone().unwrap(), &drops))
        .unwrap();
    readers.lock().unwrap().insert(id.0, read);
    device.worker.start().unwrap();
    write.write_all(b"new generation").unwrap();
    assert_eq!(next(&device).0, DeviceEvent::BackendReady(id));
    device.worker.stop().unwrap();
    runtime.shutdown().unwrap();
}

#[test]
fn failed_registration_rolls_back_and_cancel_closes_prepared_sources() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let device = add(&runtime, Box::new(|_| Ok(())));
    let ctx = device.worker.prepare().unwrap();
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, _write) = UnixStream::pair().unwrap();
    let mut invalid = source(read, &drops);
    invalid.invalid = true;
    assert!(matches!(
        ctx.events.register(invalid),
        Err(EventError::Register(_))
    ));
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert!(
        runtime.shared.slots.lock().unwrap()[0]
            .sources
            .lock()
            .unwrap()
            .is_empty()
    );
    let (read, _write) = UnixStream::pair().unwrap();
    ctx.events.register(source(read, &drops)).unwrap();
    device.worker.cancel_prepare().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 2);
    assert!(device.worker.start().is_err());
    let (read, _write) = UnixStream::pair().unwrap();
    assert!(matches!(
        ctx.events.register(source(read, &drops)),
        Err(EventError::Closed)
    ));
    device.worker.prepare().unwrap();
    device.worker.start().unwrap();
    device.worker.kick(3);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(3));
    device.worker.stop().unwrap();
    runtime.shutdown().unwrap();
}

#[test]
fn stop_waits_for_a_real_registration_without_holding_the_slot_lock() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let device = add(&runtime, Box::new(|_| Ok(())));
    let ctx = device.worker.prepare().unwrap();
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, _write) = UnixStream::pair().unwrap();
    let mut backend = source(read, &drops);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    backend.registration_gate = Some((entered_tx, release_rx));
    let register = thread::spawn(move || ctx.events.register(backend));
    entered_rx.recv_timeout(WAIT).unwrap();
    let slot = runtime.shared.slots.lock().unwrap()[0].clone();
    assert_eq!(slot.state.lock().unwrap().in_flight, 1);
    let worker = device.worker.clone();
    let (stopped_tx, stopped_rx) = mpsc::channel();
    let stop = thread::spawn(move || {
        stopped_tx.send(worker.stop()).unwrap();
    });
    assert!(stopped_rx.recv_timeout(Duration::from_millis(20)).is_err());
    release_tx.send(()).unwrap();
    register.join().unwrap().unwrap();
    stopped_rx.recv_timeout(WAIT).unwrap().unwrap();
    stop.join().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert!(slot.sources.lock().unwrap().is_empty());
    runtime.shutdown().unwrap();
}

#[test]
fn stop_is_a_barrier_and_a_fresh_generation_can_reactivate() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let mut first = true;
    let device = add(
        &runtime,
        Box::new(move |_| {
            if first {
                first = false;
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
            }
            Ok(())
        }),
    );
    let old = device.worker.prepare().unwrap();
    device.worker.start().unwrap();
    device.worker.kick(0);
    entered_rx.recv_timeout(WAIT).unwrap();
    let worker = device.worker.clone();
    let (stopped_tx, stopped_rx) = mpsc::channel();
    let stop = thread::spawn(move || {
        stopped_tx.send(worker.stop()).unwrap();
    });
    assert!(stopped_rx.recv_timeout(Duration::from_millis(20)).is_err());
    release_tx.send(()).unwrap();
    stopped_rx.recv_timeout(WAIT).unwrap().unwrap();
    stop.join().unwrap();
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(0));
    device.worker.kick(1);
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, _write) = UnixStream::pair().unwrap();
    assert!(matches!(
        old.events.register(source(read, &drops)),
        Err(EventError::Closed)
    ));
    device.worker.prepare().unwrap();
    device.worker.start().unwrap();
    device.worker.kick(2);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(2));
    device.worker.stop().unwrap();
    assert!(device.events.try_recv().is_err());
    runtime.shutdown().unwrap();
}

#[test]
fn stop_timeout_does_not_release_sources_or_active_memory_and_shutdown_can_retry() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(
        SharedRuntime::new(
            events.sender(),
            Timeouts {
                stop: Duration::from_millis(30),
                shutdown: Duration::from_millis(30),
            },
        )
        .unwrap(),
    );
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x1000)]).unwrap());
    let backing = Arc::downgrade(&memory);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let device = add(
        &runtime,
        Box::new(move |_| {
            let _keep_backing_live = &memory;
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(WAIT).unwrap();
            Ok(())
        }),
    );
    let ctx = device.worker.prepare().unwrap();
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, _write) = UnixStream::pair().unwrap();
    ctx.events.register(source(read, &drops)).unwrap();
    device.worker.start().unwrap();
    device.worker.kick(0);
    entered_rx.recv_timeout(WAIT).unwrap();
    assert!(matches!(device.worker.stop(), Err(DeviceError::Fatal(_))));
    assert_eq!(
        runtime.shutdown().unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(backing.upgrade().is_some());
    device.worker.kick(1);
    release_tx.send(()).unwrap();
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(0));
    runtime.shutdown().unwrap();
    runtime.shutdown().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert!(device.events.try_recv().is_err());
    assert!(device.worker.prepare().is_err());
    assert_eq!(
        runtime.shared.slots.lock().unwrap()[0]
            .state
            .lock()
            .unwrap()
            .in_flight,
        0
    );
}

#[test]
fn needs_reset_updates_status_and_interrupt_then_stops_dispatch_without_a_terminal_event() {
    let mut events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let device = add(
        &runtime,
        Box::new(|_| Err(DeviceError::NeedsReset("backend"))),
    );
    device.worker.prepare().unwrap();
    device.worker.start().unwrap();
    device.worker.kick(0);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(0));
    device.worker.stop().unwrap();
    assert_eq!(device.interrupt.device_status() & 0x40, 0x40);
    assert_eq!(device.interrupt.interrupt_status() & 2, 2);
    assert_eq!(device.interrupt.config_generation(), 1);
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
    runtime.shutdown().unwrap();
}

#[test]
fn fatal_panic_and_poison_report_one_terminal_failure_without_self_stop() {
    for mode in 0..3 {
        let mut events = EventLoop::new().unwrap();
        let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
        let device = add(
            &runtime,
            Box::new(move |_| {
                if mode == 1 {
                    panic!("device panic");
                }
                Err(DeviceError::Fatal("backend"))
            }),
        );
        if mode == 2 {
            let device = device.device.clone();
            assert!(
                thread::spawn(move || {
                    let _guard = device.lock().unwrap();
                    panic!("poison device mutex");
                })
                .join()
                .is_err()
            );
        }
        device.worker.prepare().unwrap();
        device.worker.start().unwrap();
        device.worker.kick(0);
        assert!(matches!(
            events.wait(Some(WAIT)).unwrap(),
            Some(Event::DeviceFailed(Error::VirtioDevice { .. }))
        ));
        device.worker.kick(1);
        assert!(matches!(device.worker.stop(), Err(DeviceError::Fatal(_))));
        runtime.shutdown().unwrap();
        assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
        assert!(
            runtime.shared.slots.lock().unwrap()[0]
                .state
                .lock()
                .unwrap()
                .phase
                == Phase::Failed
        );
    }
}

#[test]
fn shutdown_closes_a_prepared_generation_without_starting_a_thread() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let device = add(&runtime, Box::new(|_| Ok(())));
    let ctx = device.worker.prepare().unwrap();
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, mut write) = UnixStream::pair().unwrap();
    ctx.events.register(source(read, &drops)).unwrap();
    write.write_all(b"prepared readiness").unwrap();
    runtime.shutdown().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert!(device.events.try_recv().is_err());
    assert!(device.worker.start().is_err());
    let (read, _write) = UnixStream::pair().unwrap();
    assert!(matches!(
        ctx.events.register(source(read, &drops)),
        Err(EventError::Closed)
    ));
    assert!(matches!(*runtime.thread.lock().unwrap(), Thread::Joined));
}

#[test]
fn unsupported_events_do_not_disable_later_dispatch() {
    let mut events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let device = add(
        &runtime,
        Box::new(|_| Err(DeviceError::Unsupported("test event"))),
    );
    device.worker.prepare().unwrap();
    device.worker.start().unwrap();
    device.worker.kick(0);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(0));
    device.worker.kick(1);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(1));
    device.worker.stop().unwrap();
    assert_eq!(device.interrupt.device_status(), 0);
    assert_eq!(device.interrupt.interrupt_status(), 0);
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
    runtime.shutdown().unwrap();
}

#[test]
fn cross_thread_deregister_waits_for_admitted_backend_delivery() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let device = add(
        &runtime,
        Box::new(move |event| {
            if let DeviceEvent::BackendReady(_) = event {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
            }
            Ok(())
        }),
    );
    let ctx = device.worker.prepare().unwrap();
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, mut write) = UnixStream::pair().unwrap();
    let id = ctx.events.register(source(read, &drops)).unwrap();
    device.worker.start().unwrap();
    write.write_all(b"delivery").unwrap();
    entered_rx.recv_timeout(WAIT).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let retire = thread::spawn(move || {
        ctx.events.deregister(id);
        done_tx.send(()).unwrap();
    });
    let deadline = std::time::Instant::now() + WAIT;
    loop {
        if runtime.shared.slots.lock().unwrap()[0]
            .sources
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .retired
        {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        thread::yield_now();
    }
    assert!(done_rx.try_recv().is_err());
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    release_tx.send(()).unwrap();
    done_rx.recv_timeout(WAIT).unwrap();
    retire.join().unwrap();
    assert_eq!(next(&device).0, DeviceEvent::BackendReady(id));
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    device.worker.kick(1);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(1));
    device.worker.stop().unwrap();
    assert!(device.events.try_recv().is_err());
}

#[test]
fn deregister_between_ready_snapshot_and_admission_cancels_delivery() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let device = add(
        &runtime,
        Box::new(move |event| {
            if let DeviceEvent::QueueKick(index @ (0 | 1)) = event {
                entered_tx.send(index).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
            }
            Ok(())
        }),
    );
    let ctx = device.worker.prepare().unwrap();
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, mut write) = UnixStream::pair().unwrap();
    let id = ctx.events.register(source(read, &drops)).unwrap();
    device.worker.start().unwrap();
    device.worker.kick(0);
    assert_eq!(entered_rx.recv_timeout(WAIT).unwrap(), 0);
    write.write_all(b"ready for the next pass").unwrap();
    device.worker.kick(1);
    release_tx.send(()).unwrap();
    assert_eq!(entered_rx.recv_timeout(WAIT).unwrap(), 1);
    // Backend readiness was snapshotted before this pass's queue callback.
    assert!(
        !runtime.shared.slots.lock().unwrap()[0]
            .sources
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .ready
    );
    ctx.events.deregister(id);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    release_tx.send(()).unwrap();
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(0));
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(1));
    device.worker.kick(2);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(2));
    device.worker.stop().unwrap();
    assert!(device.events.try_recv().is_err());
}

#[test]
fn a_backend_callback_can_deregister_its_own_source() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let registrar = Arc::new(Mutex::new(None::<Arc<dyn EventRegistrar>>));
    let callback_registrar = registrar.clone();
    let device = add(
        &runtime,
        Box::new(move |event| {
            if let DeviceEvent::BackendReady(id) = event {
                callback_registrar
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .deregister(id);
            }
            Ok(())
        }),
    );
    let ctx = device.worker.prepare().unwrap();
    *registrar.lock().unwrap() = Some(ctx.events.clone());
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, mut write) = UnixStream::pair().unwrap();
    let id = ctx.events.register(source(read, &drops)).unwrap();
    device.worker.start().unwrap();
    write.write_all(b"self retirement").unwrap();
    assert_eq!(next(&device).0, DeviceEvent::BackendReady(id));
    device.worker.kick(2);
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(2));
    device.worker.stop().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert!(
        runtime.shared.slots.lock().unwrap()[0]
            .sources
            .lock()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn kicks_do_not_enter_a_stopped_or_closed_generation() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let device = add(&runtime, Box::new(|_| Ok(())));
    // A prepared generation takes kicks; a kick that arrives before `start` is
    // therefore delivered to the first pass rather than lost.
    device.worker.prepare().unwrap();
    device.worker.kick(0);
    device.worker.start().unwrap();
    assert_eq!(next(&device).0, DeviceEvent::QueueKick(0));
    device.worker.stop().unwrap();
    device.worker.kick(1);
    runtime.shutdown().unwrap();
    device.worker.kick(2);
    assert!(device.events.try_recv().is_err());
}

type RingObservation = (&'static str, DeviceEvent, u16);
type ChainHook = Box<dyn FnMut(u16, u16) + Send>;

struct RingDevice {
    name: &'static str,
    ctx: Option<ActivationContext>,
    backend: Option<UnixStream>,
    hook: ChainHook,
    observed: mpsc::Sender<RingObservation>,
}

const RING_SPEC: DeviceSpec = DeviceSpec {
    queue_max: &[8, 8],
    ..SPEC
};

impl VirtioDevice for RingDevice {
    fn spec(&self) -> &DeviceSpec {
        &RING_SPEC
    }
    fn set_features(&mut self, bits: u64) -> Result<(), FeatureError> {
        if bits == 0 {
            Ok(())
        } else {
            Err(FeatureError { unsupported: bits })
        }
    }
    fn read_config(&mut self, _: u64, _: &mut [u8]) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("configuration"))
    }
    fn write_config(&mut self, _: u64, _: &[u8]) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("configuration"))
    }
    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        if let Some(backend) = &self.backend {
            ctx.events
                .register(source(
                    backend.try_clone().unwrap(),
                    &Arc::new(AtomicUsize::new(0)),
                ))
                .map_err(|_| DeviceError::Fatal("backend registration"))?;
        }
        self.ctx = Some(ctx);
        Ok(())
    }
    fn reset(&mut self) -> Result<(), DeviceError> {
        self.ctx = None;
        Ok(())
    }
    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        match event {
            DeviceEvent::QueueKick(index) => {
                let ctx = self.ctx.as_mut().unwrap();
                let hook = &mut self.hook;
                let observed = &self.observed;
                let name = self.name;
                let memory = &ctx.memory;
                if ctx.queues.drain(usize::from(index), |chain| {
                    let head = chain.head_index();
                    let mut length = 0;
                    for descriptor in chain {
                        length += descriptor.len();
                        memory
                            .write_obj(u32::from(head).to_le(), descriptor.addr())
                            .unwrap();
                    }
                    hook(index, head);
                    observed.send((name, event, head)).unwrap();
                    Ok(Completion::Used(length))
                })? {
                    ctx.interrupt.raise();
                }
            }
            DeviceEvent::BackendReady(_) => {
                drain(self.backend.as_mut().unwrap());
                self.observed.send((self.name, event, u16::MAX)).unwrap();
            }
        }
        Ok(())
    }
}

fn ring_device(
    runtime: &Arc<SharedRuntime>,
    name: &'static str,
    memory: &Arc<GuestMemoryMmap>,
    backend: Option<UnixStream>,
    hook: ChainHook,
    observed: mpsc::Sender<RingObservation>,
) -> (MmioTransport, Arc<dyn WorkerControl>) {
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(RingDevice {
        name,
        ctx: None,
        backend,
        hook,
        observed,
    }));
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    let worker =
        VirtioWorkers::with_runtime(runtime.clone()).add(device.clone(), interrupt.clone());
    let transport = MmioTransport::new(
        device,
        interrupt,
        MmioResources {
            memory: memory.clone(),
            sender: runtime.shared.sender.clone(),
            worker: worker.clone(),
        },
    )
    .unwrap();
    (transport, worker)
}

fn ring_activate(transport: &mut MmioTransport) {
    let mut write = |offset, value: u32| transport.write(offset, &value.to_le_bytes());
    write(0x070, 1);
    write(0x070, 3);
    write(0x024, 1);
    write(0x020, 1);
    write(0x070, 11);
    for index in 0..2 {
        write(0x030, index);
        write(0x038, 8);
        write(0x080, 0x1000 + index * 0x1000);
        write(0x090, 0x8000 + index * 0x100);
        write(0x0a0, 0xa000 + index * 0x100);
        write(0x044, 1);
    }
    write(0x070, 15);
}

fn ring_publish(memory: &GuestMemoryMmap, index: u16, head: u16) {
    use virtio_queue::desc::split::Descriptor;
    let desc = 0x1000 + u64::from(index) * 0x1000;
    let avail = 0x8000 + u64::from(index) * 0x100;
    let data = 0x4000 + u64::from(index) * 0x100 + u64::from(head) * 4;
    memory
        .write_obj(
            Descriptor::new(data, 4, 2, 0),
            GuestAddress(desc + u64::from(head) * 16),
        )
        .unwrap();
    let next = u16::from_le(memory.read_obj(GuestAddress(avail + 2)).unwrap());
    memory
        .write_obj(
            head.to_le(),
            GuestAddress(avail + 4 + u64::from(next % 8) * 2),
        )
        .unwrap();
    memory
        .write_obj(next.wrapping_add(1).to_le(), GuestAddress(avail + 2))
        .unwrap();
}

fn ring_used(memory: &GuestMemoryMmap, index: u16) -> u16 {
    u16::from_le(
        memory
            .read_obj(GuestAddress(0xa002 + u64::from(index) * 0x100))
            .unwrap(),
    )
}

#[test]
fn real_ring_stop_waits_for_the_running_callback_then_admits_nothing() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (observed_tx, observed_rx) = mpsc::channel();
    let mut first = true;
    let (mut transport, worker) = ring_device(
        &runtime,
        "ring",
        &memory,
        None,
        Box::new(move |_, _| {
            if first {
                first = false;
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
            }
        }),
        observed_tx,
    );
    ring_activate(&mut transport);
    for head in 0..3 {
        ring_publish(&memory, 0, head);
    }
    transport.write(0x050, &0_u32.to_le_bytes());
    entered_rx.recv_timeout(WAIT).unwrap();
    let stop_worker = worker.clone();
    let stop = thread::spawn(move || stop_worker.stop());
    let slot = runtime.shared.slots.lock().unwrap()[0].clone();
    let deadline = std::time::Instant::now() + WAIT;
    while slot.state.lock().unwrap().phase != Phase::Stopping {
        assert!(std::time::Instant::now() < deadline);
        thread::yield_now();
    }
    assert_eq!(ring_used(&memory, 0), 0);
    ring_publish(&memory, 0, 3);
    release_tx.send(()).unwrap();
    stop.join().unwrap().unwrap();
    // The callback that was already running drained every chain it found,
    // including the one the guest published while the stop was waiting.
    let observed: Vec<u16> = (0..4)
        .map(|_| observed_rx.recv_timeout(WAIT).unwrap().2)
        .collect();
    assert_eq!(observed, [0, 1, 2, 3]);
    assert_eq!(ring_used(&memory, 0), 4);
    assert!(observed_rx.try_recv().is_err());
    transport.write(0x070, &0_u32.to_le_bytes());
    memory.write_obj(0_u16, GuestAddress(0x8002)).unwrap();
    memory.write_obj(0_u16, GuestAddress(0xa002)).unwrap();
    ring_activate(&mut transport);
    ring_publish(&memory, 0, 4);
    transport.write(0x050, &0_u32.to_le_bytes());
    assert_eq!(observed_rx.recv_timeout(WAIT).unwrap().2, 4);
    worker.stop().unwrap();
    assert_eq!(ring_used(&memory, 0), 1);
    assert!(observed_rx.try_recv().is_err());
}

struct PartialActivation {
    ctx: Option<ActivationContext>,
    source: Option<Box<FdSource>>,
    entered: mpsc::Receiver<()>,
    registered: mpsc::Sender<Result<crate::virtio::SourceId, EventError>>,
    resets: Arc<AtomicUsize>,
}

impl VirtioDevice for PartialActivation {
    fn spec(&self) -> &DeviceSpec {
        &RING_SPEC
    }
    fn set_features(&mut self, bits: u64) -> Result<(), FeatureError> {
        if bits == 0 {
            Ok(())
        } else {
            Err(FeatureError { unsupported: bits })
        }
    }
    fn read_config(&mut self, _: u64, _: &mut [u8]) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("configuration"))
    }
    fn write_config(&mut self, _: u64, _: &[u8]) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("configuration"))
    }
    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        let events = ctx.events.clone();
        let source = self.source.take().unwrap();
        let registered = self.registered.clone();
        self.ctx = Some(ctx);
        thread::spawn(move || registered.send(events.register(source)).unwrap());
        self.entered.recv_timeout(WAIT).unwrap();
        Err(DeviceError::NeedsReset(
            "activation after background registration",
        ))
    }
    fn reset(&mut self) -> Result<(), DeviceError> {
        self.resets.fetch_add(1, Ordering::SeqCst);
        self.ctx = None;
        Ok(())
    }
    fn on_event(&mut self, _: DeviceEvent) -> Result<(), DeviceError> {
        panic!("failed activation must never admit a callback")
    }
}

#[test]
fn failed_activation_keeps_device_state_when_cancelling_registration_times_out() {
    let mut events = EventLoop::new().unwrap();
    let runtime = Arc::new(
        SharedRuntime::new(
            events.sender(),
            Timeouts {
                stop: Duration::from_millis(30),
                shutdown: Duration::from_millis(30),
            },
        )
        .unwrap(),
    );
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap());
    let resets = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (registered_tx, registered_rx) = mpsc::channel();
    let (read, _write) = UnixStream::pair().unwrap();
    let mut backend = source(read, &drops);
    backend.registration_gate = Some((entered_tx, release_rx));
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(PartialActivation {
        ctx: None,
        source: Some(backend),
        entered: entered_rx,
        registered: registered_tx,
        resets: resets.clone(),
    }));
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    let worker =
        VirtioWorkers::with_runtime(runtime.clone()).add(device.clone(), interrupt.clone());
    let mut transport = MmioTransport::new(
        device,
        interrupt.clone(),
        MmioResources {
            memory,
            sender: events.sender(),
            worker,
        },
    )
    .unwrap();
    ring_activate(&mut transport);
    assert_ne!(interrupt.device_status() & 0x40, 0);
    assert_eq!(resets.load(Ordering::SeqCst), 0);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(matches!(
        events.wait(Some(Duration::ZERO)).unwrap(),
        Some(Event::DeviceFailed(_))
    ));
    assert_eq!(
        runtime.shutdown().unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    release_tx.send(()).unwrap();
    registered_rx.recv_timeout(WAIT).unwrap().unwrap();
    runtime.shutdown().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert_eq!(resets.load(Ordering::SeqCst), 0);
}

#[test]
fn configuration_callback_can_retire_a_source_queued_on_its_device_mutex() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let (locked_tx, locked_rx) = mpsc::channel();
    let (retire_tx, retire_rx) = mpsc::channel();
    let (retired_tx, retired_rx) = mpsc::channel();
    let (before_lock_tx, before_lock_rx) = mpsc::channel();
    let (lock_tx, lock_rx) = mpsc::channel();
    let registrar = Arc::new(Mutex::new(
        None::<(Arc<dyn EventRegistrar>, crate::virtio::SourceId)>,
    ));
    let callback_registrar = registrar.clone();
    let (event_tx, event_rx) = mpsc::channel();
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(Device {
        handler: Box::new(|_| panic!("retired backend must not be delivered")),
        events: event_tx,
        configuration: Some(Box::new(move || {
            locked_tx.send(()).unwrap();
            retire_rx.recv_timeout(WAIT).unwrap();
            let registration = callback_registrar.lock().unwrap();
            let (events, id) = registration.as_ref().unwrap();
            events.deregister(*id);
            retired_tx.send(()).unwrap();
            Ok(())
        })),
    }));
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    let worker = VirtioWorkers::with_runtime(runtime.clone()).add(device.clone(), interrupt);
    let ctx = worker.prepare().unwrap();
    let drops = Arc::new(AtomicUsize::new(0));
    let (read, mut write) = UnixStream::pair().unwrap();
    let id = ctx.events.register(source(read, &drops)).unwrap();
    *registrar.lock().unwrap() = Some((ctx.events, id));
    worker.start().unwrap();
    let configuring = thread::spawn(move || device.lock().unwrap().write_config(0, &[1]));
    locked_rx.recv_timeout(WAIT).unwrap();
    *runtime.shared.before_device_lock.lock().unwrap() = Some(Box::new(move || {
        before_lock_tx.send(()).unwrap();
        lock_rx.recv_timeout(WAIT).unwrap();
    }));
    write
        .write_all(b"source queued behind configuration")
        .unwrap();
    before_lock_rx.recv_timeout(WAIT).unwrap();
    retire_tx.send(()).unwrap();
    let retired = retired_rx.recv_timeout(WAIT);
    lock_tx.send(()).unwrap();
    assert!(
        retired.is_ok(),
        "source retirement waited for a callback queued on the caller's device mutex"
    );
    configuring.join().unwrap().unwrap();
    worker.stop().unwrap();
    runtime.shutdown().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert!(event_rx.try_recv().is_err());
}

struct StatusRaceInterrupt {
    inner: Arc<MmioInterrupt>,
    update_gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
}

impl StatusRaceInterrupt {
    fn pause_update(&self) {
        let gate = self.update_gate.lock().unwrap().take();
        if let Some((entered, release)) = gate {
            entered.send(()).unwrap();
            release.recv_timeout(WAIT).unwrap();
        }
    }
}

impl VirtioInterrupt for StatusRaceInterrupt {
    fn raise(&self) {
        self.inner.raise();
    }
    fn interrupt_status(&self) -> u8 {
        self.inner.interrupt_status()
    }
    fn ack_interrupt(&self, bits: u8) {
        self.inner.ack_interrupt(bits);
    }
    fn config_generation(&self) -> u8 {
        self.inner.config_generation()
    }
    fn raise_config(&self) {
        self.inner.raise_config();
    }
    fn device_status(&self) -> u8 {
        // With the old worker's read-modify-write, pause after its stale read.
        let status = self.inner.device_status();
        self.pause_update();
        status
    }
    fn set_device_status(&self, status: u8) {
        self.inner.set_device_status(status);
    }
    fn set_needs_reset(&self) {
        // Pause before the atomic update while the driver publishes FAILED.
        self.pause_update();
        self.inner.set_needs_reset();
    }
}

#[test]
fn concurrent_needs_reset_preserves_driver_failed_status() {
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(SharedRuntime::new(events.sender(), Timeouts::DEFAULT).unwrap());
    let inner = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    inner.set_device_status(0x0f);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let interrupt = Arc::new(StatusRaceInterrupt {
        inner: inner.clone(),
        update_gate: Mutex::new(Some((entered_tx, release_rx))),
    });
    let (callback_tx, _callback_rx) = mpsc::channel();
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(Device {
        handler: Box::new(|_| Err(DeviceError::NeedsReset("backend"))),
        events: callback_tx,
        configuration: None,
    }));
    let worker = VirtioWorkers::with_runtime(runtime.clone()).add(device, interrupt);
    worker.prepare().unwrap();
    worker.start().unwrap();
    worker.kick(0);
    entered_rx.recv_timeout(WAIT).unwrap();
    // The guest publishes FAILED while the worker's status update is paused.
    inner.set_device_status(0x8f);
    release_tx.send(()).unwrap();
    worker.stop().unwrap();
    assert_eq!(
        inner.device_status(),
        0xcf,
        "worker reset publication erased the concurrent driver FAILED bit"
    );
    runtime.shutdown().unwrap();
}
