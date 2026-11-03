// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The shared virtio runtime: one poller and one thread for every device.
//!
//! Each device has a [`Slot`]: a phase, a generation, a kick bitmap and the
//! background sources its open generation registered. The transport opens a
//! generation before DRIVER_OK and Status=0 closes it; kicks and sources never
//! cross generations.
//!
//! The `virtio-worker` thread starts with the first device. Each pass marks the
//! sources the poller reported, then, for each running slot, delivers one
//! `QueueKick` per kicked queue and one `BackendReady` per ready source. It
//! calls `on_event` under the device lock inside `catch_unwind`, so a panic
//! poisons that lock, as a panicking bus access does. Readiness is
//! edge-triggered, so a ready mark stays until its event is delivered or the
//! source closes: an edge that arrives before the device starts is not lost.
//!
//! `stop` takes only the slot's lock and waits on its condition variable for
//! the event in flight; it never waits for the thread, which only
//! [`SharedRuntime::shutdown`] joins. Registrars hold weak references, so a
//! device that keeps its registrar does not keep its slot, and with it the
//! device and the guest memory, alive.

use std::{
    collections::HashMap,
    io,
    panic::{self, AssertUnwindSafe},
    sync::{
        Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread::{self, JoinHandle},
};

use mio::{Events, Interest, Poll, Registry, Token};

use super::{SlotId, Timeouts, WorkerRuntime};
use crate::{
    error::Error,
    events::{Event, EventSender, RECHECK},
    virtio::{
        DeviceError, DeviceEvent, EventError, EventRegistrar, EventSource, MAX_QUEUES, NEEDS_RESET,
        SourceId, VirtioDevice, VirtioInterrupt, WorkerContext,
    },
};

/// The waker's poller token; source tokens never reach it.
const WAKE: Token = Token(usize::MAX);
/// How many readiness events one poll returns; the rest wait for the next.
const EVENT_CAPACITY: usize = 64;

// A source token packs the slot and the source id into one `usize`.
const _: () = assert!(usize::BITS >= 64);
// Each queue has one kick bit.
const _: () = assert!(MAX_QUEUES <= 32);

/// Every operation fails once the runtime is shut down.
const SHUT_DOWN: DeviceError = DeviceError::Fatal("virtio workers are shut down");
/// A failed slot refuses every operation; the VM is ending.
const FAILED: DeviceError = DeviceError::Fatal("virtio worker failed");

/// Where one device's worker generation is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// No generation is open.
    Stopped,
    /// A generation is open for activation; nothing is delivered yet.
    Prepared,
    /// Events are delivered.
    Running,
    /// The device asked for a reset; nothing is delivered until Status=0.
    Halted,
    /// `stop` waits for the event in flight.
    Stopping,
    /// The device or the runtime failed; the VM is ending.
    Failed,
}

/// A background source of the open generation.
struct Registered {
    source: Box<dyn EventSource>,
    /// The poller reported readiness that has not been delivered yet.
    ready: bool,
}

/// A slot's state, behind its lock.
struct SlotState {
    phase: Phase,
    generation: u64,
    /// `on_event` runs for this slot.
    in_flight: bool,
    next_source: u32,
    sources: HashMap<SourceId, Registered>,
}

impl SlotState {
    /// Whether `generation` is open for registrations.
    fn is_open(&self, generation: u64) -> bool {
        self.generation == generation
            && matches!(
                self.phase,
                Phase::Prepared | Phase::Running | Phase::Halted | Phase::Stopping
            )
    }
}

/// Whether an event may run.
enum Begin {
    /// Deliver it.
    Deliver,
    /// The generation no longer runs; skip the rest of the pass.
    Stopped,
    /// The source closed or has nothing to report; skip only this event.
    SourceGone,
}

/// What became of one event.
enum Delivery {
    /// `on_event` ran and returned this.
    Ran(Result<(), DeviceError>),
    /// The event was not delivered; `more` says whether the slot still runs.
    Skipped { more: bool },
}

/// One device in the runtime.
struct Slot {
    id: u32,
    name: &'static str,
    device: Arc<Mutex<dyn VirtioDevice>>,
    interrupt: Arc<dyn VirtioInterrupt>,
    /// One bit per kicked queue, taken by the next pass.
    kicks: AtomicU32,
    state: Mutex<SlotState>,
    /// Signalled when the event in flight returns.
    idle: Condvar,
}

impl Slot {
    fn lock(&self) -> MutexGuard<'_, SlotState> {
        lock(&self.state)
    }

    /// Ends the open generation: drops its kicks, deregisters and drops its
    /// sources, and moves to `phase`.
    fn close(&self, state: &mut SlotState, registry: &Registry, phase: Phase) {
        state.phase = phase;
        self.kicks.store(0, Ordering::SeqCst);
        for (_, mut registered) in state.sources.drain() {
            if let Err(error) = registry.deregister(registered.source.as_source()) {
                tracing::debug!(device = self.name, %error, "deregistering a virtio source failed");
            }
        }
    }

    /// Claims the slot for one event of `generation`, from `source` if set.
    fn begin(&self, generation: u64, source: Option<SourceId>) -> Begin {
        let mut state = self.lock();
        if state.phase != Phase::Running || state.generation != generation {
            return Begin::Stopped;
        }
        if let Some(id) = source {
            match state.sources.get_mut(&id) {
                Some(registered) if registered.ready => registered.ready = false,
                _ => return Begin::SourceGone,
            }
        }
        state.in_flight = true;
        Begin::Deliver
    }

    /// Releases the slot after one event of `generation` and applies the
    /// device's result. Returns whether the slot takes more events this pass.
    fn end(&self, shared: &Shared, generation: u64, result: Result<(), DeviceError>) -> bool {
        // The status bit is set while the event still counts as in flight, so
        // a `stop` waiting for it, and the device reset after that, come later.
        if let Err(DeviceError::NeedsReset(reason)) = result {
            tracing::warn!(device = self.name, reason, "virtio device needs a reset");
            let status = self.interrupt.device_status();
            self.interrupt.set_device_status(status | NEEDS_RESET);
            self.interrupt.raise_config();
        }
        let mut state = self.lock();
        state.in_flight = false;
        let current = state.generation == generation;
        let mut failed = None;
        match result {
            Ok(()) => {}
            Err(DeviceError::Unsupported(reason)) => {
                tracing::warn!(
                    device = self.name,
                    reason,
                    "unsupported virtio device event"
                );
            }
            Err(DeviceError::NeedsReset(_)) => {
                if current && state.phase == Phase::Running {
                    state.phase = Phase::Halted;
                }
            }
            Err(DeviceError::Fatal(reason)) => {
                if current && state.phase != Phase::Failed {
                    self.close(&mut state, &shared.registry, Phase::Failed);
                    failed = Some(reason);
                }
            }
        }
        let more = state.phase == Phase::Running;
        drop(state);
        self.idle.notify_all();
        if let Some(reason) = failed {
            tracing::warn!(device = self.name, reason, "virtio device failed");
            shared.sender.send(Event::DeviceFailed(Error::VirtioDevice {
                device: self.name,
                reason,
            }));
        }
        more
    }
}

/// What the runtime, its thread and its registrars share.
struct Shared {
    registry: Registry,
    waker: Arc<mio::Waker>,
    sender: EventSender,
    timeouts: Timeouts,
    /// Set by `shutdown` or a runtime failure; no generation opens afterwards.
    closed: AtomicBool,
    slots: Mutex<Vec<Arc<Slot>>>,
    /// The poller, until the thread takes it.
    poll: Mutex<Option<Poll>>,
}

impl Shared {
    fn slots(&self) -> Vec<Arc<Slot>> {
        lock(&self.slots).clone()
    }
}

/// The worker thread's life.
enum Thread {
    /// No device has started yet.
    Idle,
    /// The thread runs; `exited` disconnects once it returns or unwinds.
    Running {
        handle: JoinHandle<()>,
        exited: mpsc::Receiver<()>,
    },
    /// The runtime is shut down and the thread, if any, joined.
    Joined,
}

/// One poller and one thread for every device.
pub(crate) struct SharedRuntime {
    shared: Arc<Shared>,
    thread: Mutex<Thread>,
}

impl SharedRuntime {
    /// Creates the poller and its waker; the thread starts with the first
    /// device. A device or runtime failure ends the VM through `sender`.
    pub(crate) fn new(sender: EventSender, timeouts: Timeouts) -> io::Result<Self> {
        let poll = Poll::new()?;
        let registry = poll.registry().try_clone()?;
        let waker = Arc::new(mio::Waker::new(poll.registry(), WAKE)?);
        Ok(Self {
            shared: Arc::new(Shared {
                registry,
                waker,
                sender,
                timeouts,
                closed: AtomicBool::new(false),
                slots: Mutex::new(Vec::new()),
                poll: Mutex::new(Some(poll)),
            }),
            thread: Mutex::new(Thread::Idle),
        })
    }

    fn slot(&self, slot: SlotId) -> Arc<Slot> {
        let slots = lock(&self.shared.slots);
        Arc::clone(
            slots
                .get(slot.0 as usize)
                .expect("a slot id from this runtime"),
        )
    }

    /// Starts the worker thread unless it runs already.
    fn ensure_thread(&self) -> Result<(), DeviceError> {
        let mut thread = lock(&self.thread);
        match *thread {
            Thread::Running { .. } => return Ok(()),
            Thread::Joined => return Err(SHUT_DOWN),
            Thread::Idle => {}
        }
        let shared = Arc::clone(&self.shared);
        let (exit, exited) = mpsc::channel::<()>();
        let spawned = thread::Builder::new()
            .name("virtio-worker".into())
            .spawn(move || {
                // Dropped when the thread returns or unwinds, which tells
                // `shutdown` that it exited.
                let _exit = exit;
                run(&shared);
            });
        match spawned {
            Ok(handle) => {
                *thread = Thread::Running { handle, exited };
                Ok(())
            }
            Err(error) => {
                tracing::warn!(%error, "starting the virtio worker thread failed");
                // The device error carries no cause, so send the OS error first.
                self.shared
                    .sender
                    .send(Event::DeviceFailed(Error::VirtioWorker(error)));
                Err(DeviceError::Fatal("virtio workers start"))
            }
        }
    }
}

impl WorkerRuntime for SharedRuntime {
    fn add(
        &self,
        name: &'static str,
        device: Arc<Mutex<dyn VirtioDevice>>,
        interrupt: Arc<dyn VirtioInterrupt>,
    ) -> SlotId {
        let mut slots = lock(&self.shared.slots);
        let id = u32::try_from(slots.len()).expect("fewer than 2^32 virtio devices");
        slots.push(Arc::new(Slot {
            id,
            name,
            device,
            interrupt,
            kicks: AtomicU32::new(0),
            state: Mutex::new(SlotState {
                phase: Phase::Stopped,
                generation: 0,
                in_flight: false,
                next_source: 0,
                sources: HashMap::new(),
            }),
            idle: Condvar::new(),
        }));
        SlotId(id)
    }

    fn prepare(&self, slot: SlotId) -> Result<WorkerContext, DeviceError> {
        let slot = self.slot(slot);
        let mut state = slot.lock();
        // `shutdown` sets the flag before it sweeps the slots under their locks.
        if self.shared.closed.load(Ordering::SeqCst) {
            return Err(SHUT_DOWN);
        }
        match state.phase {
            Phase::Stopped => {}
            Phase::Failed => return Err(FAILED),
            _ => return Err(DeviceError::Fatal("virtio worker is already open")),
        }
        state.phase = Phase::Prepared;
        state.generation += 1;
        slot.kicks.store(0, Ordering::SeqCst);
        let events = Arc::new(Registrar {
            shared: Arc::downgrade(&self.shared),
            slot: Arc::downgrade(&slot),
            generation: state.generation,
        });
        let waker = Arc::clone(&self.shared.waker);
        Ok(WorkerContext {
            events,
            waker: Arc::new(move || wake(&waker)),
        })
    }

    fn start(&self, slot: SlotId) -> Result<(), DeviceError> {
        let slot = self.slot(slot);
        self.ensure_thread()?;
        let mut state = slot.lock();
        if self.shared.closed.load(Ordering::SeqCst) {
            return Err(SHUT_DOWN);
        }
        if state.phase != Phase::Prepared {
            return Err(DeviceError::Fatal("virtio worker is not prepared"));
        }
        state.phase = Phase::Running;
        drop(state);
        // Readiness marked while the slot was prepared runs in the next pass.
        wake(&self.shared.waker);
        Ok(())
    }

    fn kick(&self, slot: SlotId, index: u16) {
        if usize::from(index) >= MAX_QUEUES {
            tracing::debug!(index, "ignoring a kick past the last queue");
            return;
        }
        let bit = 1_u32 << index;
        if self.slot(slot).kicks.fetch_or(bit, Ordering::SeqCst) & bit == 0 {
            wake(&self.shared.waker);
        }
    }

    fn stop(&self, slot: SlotId) -> Result<(), DeviceError> {
        let slot = self.slot(slot);
        let mut state = slot.lock();
        match state.phase {
            Phase::Stopped => return Ok(()),
            Phase::Failed => return Err(FAILED),
            Phase::Prepared | Phase::Halted => {
                slot.close(&mut state, &self.shared.registry, Phase::Stopped);
                return Ok(());
            }
            Phase::Running | Phase::Stopping => state.phase = Phase::Stopping,
        }
        let (mut state, wait) = slot
            .idle
            .wait_timeout_while(state, self.shared.timeouts.stop, |state| state.in_flight)
            .unwrap_or_else(PoisonError::into_inner);
        if wait.timed_out() {
            tracing::warn!(
                device = slot.name,
                "a virtio device event outlived the stop timeout"
            );
            slot.close(&mut state, &self.shared.registry, Phase::Failed);
            return Err(DeviceError::Fatal("virtio worker stop timed out"));
        }
        if state.phase == Phase::Failed {
            return Err(FAILED);
        }
        slot.close(&mut state, &self.shared.registry, Phase::Stopped);
        Ok(())
    }

    fn cancel_prepare(&self, slot: SlotId) {
        let slot = self.slot(slot);
        let mut state = slot.lock();
        if state.phase == Phase::Prepared {
            slot.close(&mut state, &self.shared.registry, Phase::Stopped);
        }
    }

    fn shutdown(&self) -> io::Result<()> {
        let mut thread = lock(&self.thread);
        self.shared.closed.store(true, Ordering::SeqCst);
        for slot in self.shared.slots() {
            let mut state = slot.lock();
            if state.phase != Phase::Failed {
                slot.close(&mut state, &self.shared.registry, Phase::Stopped);
            }
        }
        match std::mem::replace(&mut *thread, Thread::Joined) {
            Thread::Idle | Thread::Joined => Ok(()),
            Thread::Running { handle, exited } => {
                wake(&self.shared.waker);
                match exited.recv_timeout(self.shared.timeouts.shutdown) {
                    Err(RecvTimeoutError::Timeout) => {
                        *thread = Thread::Running { handle, exited };
                        Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "the virtio worker thread did not stop in time",
                        ))
                    }
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                        // A thread that panicked reported it before it ended.
                        let _ = handle.join();
                        Ok(())
                    }
                }
            }
        }
    }
}

impl Drop for SharedRuntime {
    fn drop(&mut self) {
        // `Vm` shuts its workers down itself; this stops the thread of a
        // runtime dropped without that.
        if let Err(error) = self.shutdown() {
            tracing::warn!(%error, "the virtio workers did not shut down");
        }
    }
}

/// One generation's registrar. It holds weak references, so a device that
/// keeps it keeps neither its slot nor the runtime alive.
struct Registrar {
    shared: Weak<Shared>,
    slot: Weak<Slot>,
    generation: u64,
}

impl EventRegistrar for Registrar {
    fn register(&self, mut source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        let (Some(shared), Some(slot)) = (self.shared.upgrade(), self.slot.upgrade()) else {
            return Err(EventError::Closed);
        };
        let mut state = slot.lock();
        if !state.is_open(self.generation) {
            return Err(EventError::Closed);
        }
        let id = SourceId(state.next_source);
        state.next_source =
            id.0.checked_add(1)
                .ok_or(EventError::Register(io::ErrorKind::OutOfMemory))?;
        // The slot lock is held across both steps, so the thread marks the
        // readiness only once the entry exists, and a refused source leaves
        // nothing behind.
        shared
            .registry
            .register(source.as_source(), token(slot.id, id), Interest::READABLE)
            .map_err(|error| EventError::Register(error.kind()))?;
        state.sources.insert(
            id,
            Registered {
                source,
                ready: false,
            },
        );
        Ok(id)
    }

    fn deregister(&self, id: SourceId) {
        let (Some(shared), Some(slot)) = (self.shared.upgrade(), self.slot.upgrade()) else {
            return;
        };
        let mut state = slot.lock();
        if !state.is_open(self.generation) {
            return;
        }
        if let Some(mut registered) = state.sources.remove(&id)
            && let Err(error) = shared.registry.deregister(registered.source.as_source())
        {
            tracing::debug!(device = slot.name, %error, "deregistering a virtio source failed");
        }
    }
}

/// Locks one of the runtime's own mutexes. Like the crate's other
/// coordination locks, it stays usable after a panic poisoned it.
fn lock<T: ?Sized>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The poller token of source `id` in slot `slot`.
fn token(slot: u32, id: SourceId) -> Token {
    Token(((slot as usize) << 32) | id.0 as usize)
}

/// The slot index and source id a source token packs.
fn source_of(token: Token) -> (usize, SourceId) {
    (token.0 >> 32, SourceId(token.0 as u32))
}

/// Wakes the worker thread. A failed wake-up is logged; the thread's recheck
/// still finds the work.
fn wake(waker: &mio::Waker) {
    if let Err(error) = waker.wake() {
        tracing::warn!(%error, "waking the virtio workers failed; the work waits for the recheck");
    }
}

/// The worker thread: serves until shutdown and turns a failure of its own
/// into one `DeviceFailed` event.
fn run(shared: &Shared) {
    let error = match panic::catch_unwind(AssertUnwindSafe(|| serve(shared))) {
        Ok(Ok(())) => return,
        Ok(Err(error)) => error,
        Err(_) => io::Error::other("the virtio worker thread panicked"),
    };
    tracing::warn!(%error, "the virtio workers failed");
    shared.closed.store(true, Ordering::SeqCst);
    for slot in shared.slots() {
        let mut state = slot.lock();
        state.in_flight = false;
        if state.phase != Phase::Failed {
            slot.close(&mut state, &shared.registry, Phase::Failed);
        }
        drop(state);
        slot.idle.notify_all();
    }
    shared
        .sender
        .send(Event::DeviceFailed(Error::VirtioWorker(error)));
}

/// Polls and delivers events until shutdown.
fn serve(shared: &Shared) -> io::Result<()> {
    let mut poll = lock(&shared.poll)
        .take()
        .ok_or_else(|| io::Error::other("the virtio workers poller is gone"))?;
    let mut events = Events::with_capacity(EVENT_CAPACITY);
    loop {
        // The recheck finds kicks whose wake-up failed.
        match poll.poll(&mut events, Some(RECHECK)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
        if shared.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        let slots = shared.slots();
        for event in &events {
            if event.token() == WAKE {
                continue;
            }
            let (index, id) = source_of(event.token());
            if let Some(slot) = slots.get(index)
                && let Some(registered) = slot.lock().sources.get_mut(&id)
            {
                registered.ready = true;
            }
        }
        for slot in &slots {
            if shared.closed.load(Ordering::SeqCst) {
                return Ok(());
            }
            serve_slot(shared, slot);
        }
    }
}

/// Delivers one slot's kicks, then its ready sources, while it keeps running.
fn serve_slot(shared: &Shared, slot: &Slot) {
    let (generation, kicks, ready) = {
        let state = slot.lock();
        if state.phase != Phase::Running {
            return;
        }
        let mut ready: Vec<SourceId> = state
            .sources
            .iter()
            .filter(|(_, registered)| registered.ready)
            .map(|(&id, _)| id)
            .collect();
        ready.sort_unstable_by_key(|id| id.0);
        // Taken under the lock, so the kicks belong to this generation.
        (
            state.generation,
            slot.kicks.swap(0, Ordering::SeqCst),
            ready,
        )
    };
    let queues = (0..MAX_QUEUES as u16).filter(|&index| kicks & (1_u32 << index) != 0);
    for index in queues {
        if !dispatch(
            shared,
            slot,
            generation,
            DeviceEvent::QueueKick(index),
            None,
        ) {
            return;
        }
    }
    for id in ready {
        if !dispatch(
            shared,
            slot,
            generation,
            DeviceEvent::BackendReady(id),
            Some(id),
        ) {
            return;
        }
    }
}

/// Delivers `event` of `generation`, from `source` if set. Returns whether the
/// slot takes more events this pass.
fn dispatch(
    shared: &Shared,
    slot: &Slot,
    generation: u64,
    event: DeviceEvent,
    source: Option<SourceId>,
) -> bool {
    // The device lock is taken inside `catch_unwind`, so a panic in `on_event`
    // unwinds through the guard and poisons it.
    let caught = panic::catch_unwind(AssertUnwindSafe(|| {
        let (mut device, poisoned) = match slot.device.lock() {
            Ok(device) => (device, false),
            Err(error) => (error.into_inner(), true),
        };
        match slot.begin(generation, source) {
            Begin::Deliver if poisoned => {
                Delivery::Ran(Err(DeviceError::Fatal("device lock is poisoned")))
            }
            Begin::Deliver => Delivery::Ran(device.on_event(event)),
            Begin::Stopped => Delivery::Skipped { more: false },
            Begin::SourceGone => Delivery::Skipped { more: true },
        }
    }));
    match caught {
        Ok(Delivery::Ran(result)) => slot.end(shared, generation, result),
        Ok(Delivery::Skipped { more }) => more,
        Err(_) => slot.end(
            shared,
            generation,
            Err(DeviceError::Fatal("on_event panicked")),
        ),
    }
}
