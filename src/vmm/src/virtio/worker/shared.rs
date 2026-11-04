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
//! `stop` closes admission and waits for callbacks and host registrations, then
//! retires the generation's sources. It never joins the shared thread. Slot
//! locks are never held across device code or host registration. Registrars and
//! continuations hold weak references, so devices cannot keep their own slots
//! and guest memory alive through those handles.

use std::{
    collections::BTreeMap,
    io,
    panic::{self, AssertUnwindSafe},
    sync::{
        Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread::{self, JoinHandle},
    time::Instant,
};

use mio::{Events, Interest, Poll, Registry, Token};

use super::{SlotId, Timeouts, WorkerRuntime};
use crate::{
    error::Error,
    events::{Event, EventSender, RECHECK},
    virtio::{
        DeviceError, DeviceEvent, EventError, EventRegistrar, EventSource, MAX_QUEUES, SourceId,
        VirtioDevice, VirtioInterrupt, WorkerContext,
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
    retired: bool,
    delivering: Option<thread::ThreadId>,
}

/// A slot's state, behind its lock.
struct SlotState {
    phase: Phase,
    generation: u64,
    /// Admitted callbacks and host registrations that have not returned.
    in_flight: usize,
    next_source: u32,
}

impl SlotState {
    /// Whether `generation` is open for registrations.
    fn is_open(&self, generation: u64) -> bool {
        self.generation == generation && matches!(self.phase, Phase::Prepared | Phase::Running)
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
    sources: Mutex<BTreeMap<SourceId, Registered>>,
    sources_idle: Condvar,
    /// Signalled when the event in flight returns.
    idle: Condvar,
}

impl Slot {
    fn lock(&self) -> MutexGuard<'_, SlotState> {
        lock(&self.state)
    }

    /// Drops sources only after the generation's admission barrier is idle.
    fn close_sources(&self, registry: &Registry) {
        for (_, mut registered) in std::mem::take(&mut *lock(&self.sources)) {
            if !registered.retired
                && let Err(error) = registry.deregister(registered.source.as_source())
            {
                tracing::debug!(device = self.name, %error, "deregistering a virtio source failed");
            }
        }
    }

    fn wait_idle(&self, deadline: Instant) -> io::Result<()> {
        let mut state = self.lock();
        while state.in_flight != 0 {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "a virtio worker did not stop in time",
                    )
                })?;
            state = self
                .idle
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        Ok(())
    }

    fn finish_source(&self, id: SourceId) {
        let mut sources = lock(&self.sources);
        if let Some(registered) = sources.get_mut(&id) {
            registered.delivering = None;
            if registered.retired {
                sources.remove(&id);
            }
        }
        self.sources_idle.notify_all();
    }

    /// Claims the slot for one event of `generation`, from `source` if set.
    fn begin(&self, shared: &Shared, generation: u64, source: Option<SourceId>) -> Begin {
        let mut sources = source.map(|_| lock(&self.sources));
        let mut state = self.lock();
        if shared.closed.load(Ordering::SeqCst)
            || state.phase != Phase::Running
            || state.generation != generation
        {
            return Begin::Stopped;
        }
        if let (Some(id), Some(sources)) = (source, sources.as_mut()) {
            match sources.get_mut(&id) {
                Some(registered) if !registered.retired => {
                    registered.delivering = Some(thread::current().id());
                }
                _ => return Begin::SourceGone,
            }
        }
        state.in_flight += 1;
        Begin::Deliver
    }

    /// Releases the slot after one event of `generation` and applies the
    /// device's result. Returns whether the slot takes more events this pass.
    fn end(
        &self,
        shared: &Shared,
        generation: u64,
        source: Option<SourceId>,
        result: Result<(), DeviceError>,
    ) -> bool {
        // The status bit is set while the event still counts as in flight, so
        // a `stop` waiting for it, and the device reset after that, come later.
        if let Err(DeviceError::NeedsReset(reason)) = result {
            tracing::warn!(device = self.name, reason, "virtio device needs a reset");
            self.interrupt.set_needs_reset();
            self.interrupt.raise_config();
        }
        if let Some(id) = source {
            self.finish_source(id);
        }
        let mut state = self.lock();
        state.in_flight -= 1;
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
                    state.phase = Phase::Failed;
                    self.kicks.store(0, Ordering::SeqCst);
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

/// A registration remains admitted until insertion or rollback is complete.
struct Registration<'a>(&'a Slot);

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.0.lock().in_flight -= 1;
        self.0.idle.notify_all();
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
    #[cfg(test)]
    before_device_lock: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Shared {
    fn slots(&self) -> Vec<Arc<Slot>> {
        lock(&self.slots).clone()
    }

    /// Coalesces a kick under the generation admission lock.
    fn enqueue(&self, slot: &Slot, index: u16) {
        if usize::from(index) >= MAX_QUEUES {
            tracing::debug!(index, "ignoring a kick past the last queue");
            return;
        }
        let state = slot.lock();
        if self.closed.load(Ordering::SeqCst)
            || !matches!(state.phase, Phase::Prepared | Phase::Running)
        {
            return;
        }
        let bit = 1_u32 << index;
        let notify = slot.kicks.fetch_or(bit, Ordering::SeqCst) & bit == 0;
        drop(state);
        if notify {
            wake(&self.waker);
        }
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
                #[cfg(test)]
                before_device_lock: Mutex::new(None),
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
                in_flight: 0,
                next_source: 0,
            }),
            sources: Mutex::new(BTreeMap::new()),
            sources_idle: Condvar::new(),
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
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or(DeviceError::Fatal("virtio worker generation exhausted"))?;
        state.phase = Phase::Prepared;
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
        self.shared.enqueue(&self.slot(slot), index);
    }

    fn stop(&self, slot: SlotId) -> Result<(), DeviceError> {
        let slot = self.slot(slot);
        let mut state = slot.lock();
        match state.phase {
            Phase::Stopped => return Ok(()),
            Phase::Failed => return Err(FAILED),
            _ => state.phase = Phase::Stopping,
        }
        slot.kicks.store(0, Ordering::SeqCst);
        drop(state);
        if slot
            .wait_idle(Instant::now() + self.shared.timeouts.stop)
            .is_err()
        {
            slot.lock().phase = Phase::Failed;
            return Err(DeviceError::Fatal("virtio worker stop timed out"));
        }
        if slot.lock().phase == Phase::Failed {
            return Err(FAILED);
        }
        // Admission stays closed through source destruction.
        slot.close_sources(&self.shared.registry);
        slot.lock().phase = Phase::Stopped;
        Ok(())
    }

    fn cancel_prepare(&self, slot: SlotId) -> Result<(), DeviceError> {
        let slot = self.slot(slot);
        let mut state = slot.lock();
        if !matches!(state.phase, Phase::Prepared | Phase::Failed) {
            return Ok(());
        }
        let failed = state.phase == Phase::Failed;
        if !failed {
            state.phase = Phase::Stopping;
        }
        slot.kicks.store(0, Ordering::SeqCst);
        drop(state);
        if slot
            .wait_idle(Instant::now() + self.shared.timeouts.stop)
            .is_err()
        {
            slot.lock().phase = Phase::Failed;
            return Err(DeviceError::Fatal("virtio prepare cancellation timed out"));
        }
        slot.close_sources(&self.shared.registry);
        slot.lock().phase = if failed {
            Phase::Failed
        } else {
            Phase::Stopped
        };
        Ok(())
    }

    fn shutdown(&self) -> io::Result<()> {
        let mut thread = lock(&self.thread);
        self.shared.closed.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + self.shared.timeouts.shutdown;
        let slots = self.shared.slots();
        for slot in &slots {
            let mut state = slot.lock();
            if state.phase != Phase::Failed {
                state.phase = Phase::Stopping;
            }
            slot.kicks.store(0, Ordering::SeqCst);
        }
        wake(&self.shared.waker);
        for slot in &slots {
            slot.wait_idle(deadline)?;
            slot.close_sources(&self.shared.registry);
            let mut state = slot.lock();
            if state.phase != Phase::Failed {
                state.phase = Phase::Stopped;
            }
        }
        match std::mem::replace(&mut *thread, Thread::Joined) {
            Thread::Idle | Thread::Joined => Ok(()),
            Thread::Running { handle, exited } => {
                wake(&self.shared.waker);
                let remaining = deadline.saturating_duration_since(Instant::now());
                match exited.recv_timeout(remaining) {
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
    fn register(&self, source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        let (Some(shared), Some(slot)) = (self.shared.upgrade(), self.slot.upgrade()) else {
            return Err(EventError::Closed);
        };
        let id = {
            let mut state = slot.lock();
            if shared.closed.load(Ordering::SeqCst) || !state.is_open(self.generation) {
                return Err(EventError::Closed);
            }
            let id = SourceId(state.next_source);
            state.next_source =
                id.0.checked_add(1)
                    .ok_or(EventError::Register(io::ErrorKind::OutOfMemory))?;
            state.in_flight += 1;
            id
        };
        let _registration = Registration(&slot);
        // Insert before registering, so an immediate readiness edge cannot
        // race ahead of its source. No slot lock spans host registration.
        let mut sources = lock(&slot.sources);
        sources.insert(
            id,
            Registered {
                source,
                ready: false,
                retired: false,
                delivering: None,
            },
        );
        let result = shared.registry.register(
            sources
                .get_mut(&id)
                .expect("the inserted source")
                .source
                .as_source(),
            token(slot.id, id),
            Interest::READABLE,
        );
        if let Err(error) = result {
            sources.remove(&id);
            return Err(EventError::Register(error.kind()));
        }
        Ok(id)
    }

    fn deregister(&self, id: SourceId) {
        let (Some(shared), Some(slot)) = (self.shared.upgrade(), self.slot.upgrade()) else {
            return;
        };
        // Source retirement and callback admission use the same lock. A
        // configuration callback already holds the device lock; dispatch
        // takes that lock before admission, so retirement cannot invert it.
        let mut sources = lock(&slot.sources);
        if slot.lock().generation != self.generation {
            return;
        }
        let Some(registered) = sources.get_mut(&id) else {
            return;
        };
        if !registered.retired {
            registered.retired = true;
            if let Err(error) = shared.registry.deregister(registered.source.as_source()) {
                tracing::debug!(device = slot.name, %error, "deregistering a virtio source failed");
            }
        }
        let caller = thread::current().id();
        while let Some(registered) = sources.get(&id) {
            match registered.delivering {
                Some(owner) if owner == caller => return,
                Some(_) => {
                    sources = slot
                        .sources_idle
                        .wait(sources)
                        .unwrap_or_else(PoisonError::into_inner)
                }
                None => break,
            }
        }
        sources.remove(&id);
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
        state.phase = Phase::Failed;
        slot.kicks.store(0, Ordering::SeqCst);
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
    let mut slots = Vec::new();
    let mut pending = Vec::new();
    let mut ready = Vec::new();
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
        {
            let current = lock(&shared.slots);
            slots.extend(current[slots.len()..].iter().cloned());
            pending.resize(slots.len(), (0, 0));
        }
        for event in &events {
            if event.token() == WAKE {
                continue;
            }
            let (index, id) = source_of(event.token());
            if let Some(slot) = slots.get(index)
                && let Some(registered) = lock(&slot.sources).get_mut(&id)
            {
                registered.ready = true;
            }
        }
        ready.clear();
        // Snapshot all work before calling a device. Continuations cannot
        // overtake another queue or backend source ready in this pass.
        for (index, (slot, pending)) in slots.iter().zip(&mut pending).enumerate() {
            let mut sources = lock(&slot.sources);
            let state = slot.lock();
            *pending = (state.generation, 0);
            if state.phase == Phase::Running {
                pending.1 = slot.kicks.swap(0, Ordering::SeqCst);
                for (&id, registered) in sources.iter_mut() {
                    if registered.ready && !registered.retired {
                        ready.push((index, state.generation, id));
                        registered.ready = false;
                    }
                }
            }
        }
        for (slot, &(generation, kicks)) in slots.iter().zip(&pending) {
            for index in 0..MAX_QUEUES as u16 {
                if kicks & (1_u32 << index) != 0
                    && !dispatch(
                        shared,
                        slot,
                        generation,
                        DeviceEvent::QueueKick(index),
                        None,
                    )
                {
                    break;
                }
            }
        }
        for &(index, generation, id) in &ready {
            dispatch(
                shared,
                &slots[index],
                generation,
                DeviceEvent::BackendReady(id),
                Some(id),
            );
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
    #[cfg(test)]
    if let Some(gate) = lock(&shared.before_device_lock).take() {
        gate();
    }
    // The device lock is taken inside `catch_unwind`, so a panic in `on_event`
    // unwinds through the guard and poisons it.
    let caught = panic::catch_unwind(AssertUnwindSafe(|| {
        let (mut device, poisoned) = match slot.device.lock() {
            Ok(device) => (device, false),
            Err(error) => (error.into_inner(), true),
        };
        match slot.begin(shared, generation, source) {
            Begin::Deliver if poisoned => {
                Delivery::Ran(Err(DeviceError::Fatal("device lock is poisoned")))
            }
            Begin::Deliver => Delivery::Ran(device.on_event(event)),
            Begin::Stopped => Delivery::Skipped { more: false },
            Begin::SourceGone => Delivery::Skipped { more: true },
        }
    }));
    match caught {
        Ok(Delivery::Ran(result)) => slot.end(shared, generation, source, result),
        Ok(Delivery::Skipped { more }) => more,
        Err(_) => slot.end(
            shared,
            generation,
            source,
            Err(DeviceError::Fatal("on_event panicked")),
        ),
    }
}

#[cfg(all(test, unix))]
#[path = "../../../tests/virtio/executor.rs"]
mod tests;
