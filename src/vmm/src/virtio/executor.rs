// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! One poller and lazy thread serve all virtio devices in a VM. Slot state is
//! locked only to admit work and publish completion, never across device code
//! or host registration. A generation's stop barrier includes registrations:
//! a source cannot be inserted after stop has finished closing that generation.

use std::{
    collections::BTreeMap,
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use mio::{Events, Interest, Poll, Registry, Token};

use super::{
    DeviceError, DeviceEvent, EventError, EventRegistrar, EventSource, MAX_QUEUES, SourceId,
    VirtioDevice, VirtioInterrupt, WorkerContext, WorkerControl,
};
use crate::{
    error::Error,
    events::{Event, EventSender},
};

const WAKE: Token = Token(0);
const RECHECK: Duration = Duration::from_secs(1);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const NEEDS_RESET: u8 = 0x40;

/// Per-VM owner. Only shutdown joins the runtime thread.
pub(crate) struct Executor {
    runtime: Arc<SharedRuntime>,
}

impl Executor {
    pub(crate) fn new(sender: EventSender) -> io::Result<Self> {
        Self::with_timeout(sender, STOP_TIMEOUT)
    }

    fn with_timeout(sender: EventSender, timeout: Duration) -> io::Result<Self> {
        let poll = Poll::new()?;
        let registry = poll.registry().try_clone()?;
        let waker = mio::Waker::new(poll.registry(), WAKE)?;
        Ok(Self {
            runtime: Arc::new(SharedRuntime {
                registry,
                waker,
                sender,
                slots: Mutex::new(Vec::new()),
                sources: Mutex::new(BTreeMap::new()),
                sources_idle: Condvar::new(),
                #[cfg(test)]
                before_device_lock: Mutex::new(None),
                next_source: AtomicU32::new(1),
                closed: AtomicBool::new(false),
                shutdown_complete: AtomicBool::new(false),
                failure_sent: AtomicBool::new(false),
                thread: Mutex::new(ThreadState {
                    poll: Some(poll),
                    handle: None,
                    exited: false,
                }),
                exited: Condvar::new(),
                timeout,
            }),
        })
    }

    pub(crate) fn register(
        &self,
        device: Arc<Mutex<dyn VirtioDevice>>,
        interrupt: Arc<dyn VirtioInterrupt>,
    ) -> Arc<dyn WorkerControl> {
        let name = device
            .lock()
            .map_or("poisoned virtio device", |device| device.spec().name);
        let mut slots = self.runtime.slots.lock().unwrap();
        let slot = Arc::new(Slot {
            index: slots.len(),
            name,
            device,
            interrupt,
            state: Mutex::new(SlotState {
                phase: Phase::Stopped,
                generation: 0,
                kicks: 0,
                inflight: 0,
                failure_sent: false,
            }),
            idle: Condvar::new(),
        });
        slots.push(Arc::clone(&slot));
        Arc::new(DeviceHandle {
            runtime: self.runtime.clone(),
            slot,
        })
    }

    /// On timeout the runtime retains its slots, devices and guest-memory Arcs.
    /// The VM must not unmap RAM until a later shutdown succeeds.
    pub(crate) fn shutdown(&self) -> io::Result<()> {
        self.runtime.shutdown()
    }
}

impl Drop for Executor {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            tracing::error!(%error, "virtio executor did not stop; retaining active device backing");
        }
    }
}

/// Transport-independent lifecycle seam; a per-device runtime can implement it
/// without changing WorkerControl, ActivationContext or transport call sites.
trait WorkerRuntime: Send + Sync {
    fn prepare(self: Arc<Self>, slot: &Arc<Slot>) -> Result<WorkerContext, DeviceError>;
    fn start(self: Arc<Self>, slot: &Arc<Slot>) -> Result<(), DeviceError>;
    fn kick(&self, slot: &Slot, index: u16);
    fn stop(&self, slot: &Slot) -> Result<(), DeviceError>;
    fn cancel_prepare(&self, slot: &Slot) -> Result<(), DeviceError>;
}

struct DeviceHandle {
    runtime: Arc<dyn WorkerRuntime>,
    slot: Arc<Slot>,
}

impl WorkerControl for DeviceHandle {
    fn prepare(&self) -> Result<WorkerContext, DeviceError> {
        self.runtime.clone().prepare(&self.slot)
    }

    fn start(&self) -> Result<(), DeviceError> {
        self.runtime.clone().start(&self.slot)
    }

    fn kick(&self, index: u16) {
        self.runtime.kick(&self.slot, index);
    }

    fn stop(&self) -> Result<(), DeviceError> {
        self.runtime.stop(&self.slot)
    }

    fn cancel_prepare(&self) -> Result<(), DeviceError> {
        self.runtime.cancel_prepare(&self.slot)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Stopped,
    Prepared,
    Running,
    Stopping,
    NeedsReset,
    Failed,
}

struct SlotState {
    phase: Phase,
    generation: u64,
    kicks: u16,
    // Includes direct Registry::register calls as well as on_event calls.
    inflight: usize,
    failure_sent: bool,
}

struct Slot {
    index: usize,
    name: &'static str,
    device: Arc<Mutex<dyn VirtioDevice>>,
    interrupt: Arc<dyn VirtioInterrupt>,
    state: Mutex<SlotState>,
    idle: Condvar,
}

struct InFlight<'a>(&'a Slot);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.inflight -= 1;
        self.0.idle.notify_all();
    }
}

struct RegisteredSource {
    slot: usize,
    generation: u64,
    id: SourceId,
    source: Box<dyn EventSource>,
    ready: bool,
    retired: bool,
    delivering: Option<thread::ThreadId>,
}

/// Retires an admitted backend delivery before the slot barrier becomes idle.
struct SourceDelivery<'a> {
    runtime: &'a SharedRuntime,
    id: Option<SourceId>,
}

impl Drop for SourceDelivery<'_> {
    fn drop(&mut self) {
        let Some(id) = self.id else { return };
        let mut sources = self.runtime.sources.lock().unwrap();
        if let Some(source) = sources.get_mut(&(id.0 as usize)) {
            source.delivering = None;
            if source.retired {
                sources.remove(&(id.0 as usize));
            }
        }
        self.runtime.sources_idle.notify_all();
    }
}

struct ThreadState {
    poll: Option<Poll>,
    handle: Option<JoinHandle<()>>,
    exited: bool,
}

struct SharedRuntime {
    registry: Registry,
    waker: mio::Waker,
    sender: EventSender,
    slots: Mutex<Vec<Arc<Slot>>>,
    sources: Mutex<BTreeMap<usize, RegisteredSource>>,
    sources_idle: Condvar,
    #[cfg(test)]
    before_device_lock: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    next_source: AtomicU32,
    closed: AtomicBool,
    shutdown_complete: AtomicBool,
    failure_sent: AtomicBool,
    thread: Mutex<ThreadState>,
    exited: Condvar,
    timeout: Duration,
}

impl SharedRuntime {
    fn enqueue(&self, slot: &Slot, index: u16, generation: Option<u64>) {
        if usize::from(index) >= MAX_QUEUES {
            return;
        }
        let mut state = slot.state.lock().unwrap();
        if self.closed.load(Ordering::SeqCst)
            || state.phase != Phase::Running
            || generation.is_some_and(|generation| generation != state.generation)
        {
            return;
        }
        let bit = 1 << index;
        let wake = state.kicks & bit == 0;
        state.kicks |= bit;
        drop(state);
        if wake {
            self.wake();
        }
    }

    fn wake(&self) {
        if let Err(error) = self.waker.wake() {
            self.fail(error);
        }
    }

    fn fail(&self, error: io::Error) {
        self.closed.store(true, Ordering::SeqCst);
        if !self.failure_sent.swap(true, Ordering::SeqCst) {
            self.sender
                .send(Event::DeviceFailed(Error::VirtioExecutor(error)));
        }
    }

    fn ensure_started(self: &Arc<Self>) -> Result<(), DeviceError> {
        let mut state = self.thread.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            return Err(DeviceError::Fatal("virtio executor is closed"));
        }
        if state.handle.is_some() {
            return Ok(());
        }
        let poll = state
            .poll
            .take()
            .ok_or(DeviceError::Fatal("virtio executor poller"))?;
        let runtime = Arc::clone(self);
        match thread::Builder::new()
            .name("virtio-exec".into())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| runtime.run(poll)));
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => runtime.fail(error),
                    Err(_) => runtime.fail(io::Error::other("virtio executor thread panicked")),
                }
                runtime.thread.lock().unwrap().exited = true;
                runtime.exited.notify_all();
            }) {
            Ok(handle) => {
                state.handle = Some(handle);
                Ok(())
            }
            Err(error) => {
                self.fail(error);
                Err(DeviceError::Fatal("starting the virtio executor"))
            }
        }
    }

    fn run(&self, mut poll: Poll) -> io::Result<()> {
        let mut events = Events::with_capacity(128);
        let mut slots = Vec::new();
        let mut ready = Vec::new();
        let mut kicks = Vec::new();
        while !self.closed.load(Ordering::SeqCst) {
            match poll.poll(&mut events, Some(RECHECK)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
            if self.closed.load(Ordering::SeqCst) {
                break;
            }
            {
                let current = self.slots.lock().unwrap();
                // Allocate only when devices are added, not on each dispatch.
                slots.extend(current[slots.len()..].iter().cloned());
                kicks.resize(slots.len(), (0, 0));
            }
            ready.clear();
            {
                let mut sources = self.sources.lock().unwrap();
                for event in &events {
                    if let Some(source) = sources.get_mut(&event.token().0) {
                        source.ready = true;
                    }
                }
                for source in sources.values_mut() {
                    if source.ready && !source.retired {
                        let Some(slot) = slots.get(source.slot) else {
                            continue;
                        };
                        let state = slot.state.lock().unwrap();
                        // Keep activation-time readiness until start: mio is
                        // edge-triggered, so discarding it could lose an event.
                        if state.phase == Phase::Running && state.generation == source.generation {
                            ready.push((source.slot, source.generation, source.id));
                            source.ready = false;
                        }
                    }
                }
            }
            // Snapshot every slot before invoking any device. A continuation
            // cannot jump ahead of this pass's other queues or backend events.
            for (slot, pending) in slots.iter().zip(&mut kicks) {
                let mut state = slot.state.lock().unwrap();
                *pending = if state.phase == Phase::Running {
                    (state.generation, std::mem::take(&mut state.kicks))
                } else {
                    (state.generation, 0)
                };
            }
            for (slot, &(generation, pending)) in slots.iter().zip(&kicks) {
                for index in 0..MAX_QUEUES {
                    if pending & (1 << index) != 0 {
                        self.dispatch(slot, generation, DeviceEvent::QueueKick(index as u16));
                    }
                }
            }
            for &(index, generation, id) in &ready {
                self.dispatch(&slots[index], generation, DeviceEvent::BackendReady(id));
            }
        }
        Ok(())
    }

    fn dispatch(&self, slot: &Slot, generation: u64, event: DeviceEvent) {
        #[cfg(test)]
        {
            let gate = self.before_device_lock.lock().unwrap().take();
            if let Some(gate) = gate {
                gate();
            }
        }
        // A configuration callback may retire a source while holding this
        // mutex. Wait for the mutex before admitting a delivery, otherwise
        // retirement would wait for a callback blocked on its own caller.
        // A queued callback rechecks all admission conditions after locking;
        // stop can retire it without allowing any subsequent guest access.
        let device = slot.device.lock();
        let source_id = match event {
            DeviceEvent::BackendReady(id) => Some(id),
            DeviceEvent::QueueKick(_) => None,
        };
        {
            // Source liveness and slot admission share this critical section.
            let mut sources = source_id.map(|_| self.sources.lock().unwrap());
            let source = match (source_id, sources.as_mut()) {
                (Some(id), Some(sources)) => match sources.get_mut(&(id.0 as usize)) {
                    Some(source)
                        if source.slot == slot.index
                            && source.generation == generation
                            && !source.retired =>
                    {
                        Some(source)
                    }
                    _ => return,
                },
                _ => None,
            };
            let mut state = slot.state.lock().unwrap();
            if self.closed.load(Ordering::SeqCst)
                || state.phase != Phase::Running
                || state.generation != generation
            {
                return;
            }
            if let Some(source) = source {
                source.delivering = Some(thread::current().id());
            }
            state.inflight += 1;
        }
        let flight = InFlight(slot);
        let delivery = SourceDelivery {
            runtime: self,
            id: source_id,
        };
        let result = catch_unwind(AssertUnwindSafe(|| match device {
            Ok(mut device) => device.on_event(event),
            Err(_) => Err(DeviceError::Fatal("virtio device lock poisoned")),
        }))
        .unwrap_or(Err(DeviceError::Fatal("virtio device callback panicked")));
        match result {
            Ok(()) => {}
            Err(DeviceError::Unsupported(reason)) => {
                tracing::warn!(
                    device = slot.name,
                    reason,
                    "unsupported virtio worker operation"
                );
            }
            Err(DeviceError::NeedsReset(reason)) => {
                {
                    let mut state = slot.state.lock().unwrap();
                    if state.phase == Phase::Running {
                        state.phase = Phase::NeedsReset;
                    }
                    state.kicks = 0;
                }
                slot.interrupt.add_device_status(NEEDS_RESET);
                slot.interrupt.raise_config();
                tracing::warn!(device = slot.name, reason, "virtio worker needs reset");
            }
            Err(DeviceError::Fatal(reason)) => {
                let send = {
                    let mut state = slot.state.lock().unwrap();
                    state.phase = Phase::Failed;
                    state.kicks = 0;
                    !std::mem::replace(&mut state.failure_sent, true)
                };
                if send {
                    self.sender.send(Event::DeviceFailed(Error::VirtioDevice {
                        device: slot.name,
                        reason,
                    }));
                }
            }
        }
        drop(delivery);
        drop(flight);
    }

    fn wait_idle(&self, slot: &Slot, deadline: Instant) -> io::Result<()> {
        let mut state = slot.state.lock().unwrap();
        while state.inflight != 0 {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "virtio device did not stop")
                })?;
            state = slot.idle.wait_timeout(state, remaining).unwrap().0;
        }
        Ok(())
    }

    fn close_sources(&self, slot: usize, generation: u64) {
        self.sources.lock().unwrap().retain(|_, source| {
            if source.slot != slot || source.generation != generation {
                return true;
            }
            if !source.retired
                && let Err(error) = self.registry.deregister(source.source.as_source())
            {
                self.fail(error);
            }
            false
        });
    }

    fn shutdown(&self) -> io::Result<()> {
        if self.shutdown_complete.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.closed.store(true, Ordering::SeqCst);
        self.wake();
        let deadline = Instant::now() + self.timeout;
        let slots = self.slots.lock().unwrap();
        for slot in slots.iter() {
            let mut state = slot.state.lock().unwrap();
            if state.phase != Phase::Failed {
                state.phase = Phase::Stopping;
            }
            state.kicks = 0;
        }
        for slot in slots.iter() {
            self.wait_idle(slot, deadline)?;
            let mut state = slot.state.lock().unwrap();
            let generation = state.generation;
            // Stopping prevents prepare/start/register until shutdown completes.
            state.phase = Phase::Stopped;
            drop(state);
            self.close_sources(slot.index, generation);
        }
        // The runtime may be waiting to refresh its slot list. Release the
        // list before joining it; callbacks never need this list lock.
        drop(slots);
        let mut state = self.thread.lock().unwrap();
        while state.handle.is_some() && !state.exited {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "virtio executor did not exit")
                })?;
            state = self.exited.wait_timeout(state, remaining).unwrap().0;
        }
        if let Some(handle) = state.handle.take() {
            handle
                .join()
                .map_err(|_| io::Error::other("virtio executor thread panicked"))?;
        }
        self.shutdown_complete.store(true, Ordering::SeqCst);
        Ok(())
    }
}

impl WorkerRuntime for SharedRuntime {
    fn prepare(self: Arc<Self>, slot: &Arc<Slot>) -> Result<WorkerContext, DeviceError> {
        let mut state = slot.state.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) || state.phase != Phase::Stopped {
            return Err(DeviceError::Fatal("preparing an unavailable virtio worker"));
        }
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or(DeviceError::Fatal("virtio worker generation exhausted"))?;
        state.phase = Phase::Prepared;
        state.kicks = 0;
        state.failure_sent = false;
        let events = Arc::new(Registrar {
            runtime: Arc::downgrade(&self),
            slot: Arc::downgrade(slot),
            generation: state.generation,
        });
        let runtime = Arc::downgrade(&self);
        let continuation_runtime = runtime.clone();
        let continuation_slot = Arc::downgrade(slot);
        let generation = state.generation;
        Ok(WorkerContext {
            events,
            waker: Arc::new(move || {
                if let Some(runtime) = runtime.upgrade() {
                    runtime.wake();
                }
            }),
            requeue: Arc::new(move |index| {
                if let (Some(runtime), Some(slot)) =
                    (continuation_runtime.upgrade(), continuation_slot.upgrade())
                {
                    runtime.enqueue(&slot, index, Some(generation));
                }
            }),
        })
    }

    fn start(self: Arc<Self>, slot: &Arc<Slot>) -> Result<(), DeviceError> {
        if slot.state.lock().unwrap().phase != Phase::Prepared {
            return Err(DeviceError::Fatal("starting an unprepared virtio worker"));
        }
        if let Err(error) = self.ensure_started() {
            slot.state.lock().unwrap().phase = Phase::Failed;
            return Err(error);
        }
        let mut state = slot.state.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) || state.phase != Phase::Prepared {
            return Err(DeviceError::Fatal("starting an unprepared virtio worker"));
        }
        state.phase = Phase::Running;
        drop(state);
        self.wake();
        if self.closed.load(Ordering::SeqCst) {
            slot.state.lock().unwrap().phase = Phase::Failed;
            return Err(DeviceError::Fatal("virtio executor wake-up"));
        }
        Ok(())
    }

    fn kick(&self, slot: &Slot, index: u16) {
        self.enqueue(slot, index, None);
    }

    fn stop(&self, slot: &Slot) -> Result<(), DeviceError> {
        let mut state = slot.state.lock().unwrap();
        if state.phase == Phase::Failed {
            return Err(DeviceError::Fatal("stopping a failed virtio worker"));
        }
        state.phase = Phase::Stopping;
        state.kicks = 0;
        let generation = state.generation;
        drop(state);
        self.wake();
        self.wait_idle(slot, Instant::now() + self.timeout)
            .map_err(|_| DeviceError::Fatal("virtio worker stop timed out"))?;
        self.close_sources(slot.index, generation);
        let mut state = slot.state.lock().unwrap();
        if state.phase == Phase::Failed {
            return Err(DeviceError::Fatal("stopping a failed virtio worker"));
        }
        state.phase = Phase::Stopped;
        if self.closed.load(Ordering::SeqCst) {
            return Err(DeviceError::Fatal("stopping a closed virtio executor"));
        }
        Ok(())
    }

    fn cancel_prepare(&self, slot: &Slot) -> Result<(), DeviceError> {
        let mut state = slot.state.lock().unwrap();
        if !matches!(state.phase, Phase::Prepared | Phase::Failed) {
            return Ok(());
        }
        let failed = state.phase == Phase::Failed;
        if !failed {
            state.phase = Phase::Stopping;
        }
        state.kicks = 0;
        let generation = state.generation;
        drop(state);
        // Activation registers synchronously; the barrier also covers a device
        // that handed its registrar to another thread during activation.
        if self.wait_idle(slot, Instant::now() + self.timeout).is_err() {
            self.fail(io::Error::new(
                io::ErrorKind::TimedOut,
                "virtio prepare cancellation timed out",
            ));
            return Err(DeviceError::Fatal("virtio prepare cancellation timed out"));
        }
        self.close_sources(slot.index, generation);
        slot.state.lock().unwrap().phase = if failed {
            Phase::Failed
        } else {
            Phase::Stopped
        };
        Ok(())
    }
}

struct Registrar {
    runtime: Weak<SharedRuntime>,
    slot: Weak<Slot>,
    generation: u64,
}

impl EventRegistrar for Registrar {
    fn register(&self, source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        let runtime = self.runtime.upgrade().ok_or(EventError::Closed)?;
        let slot = self.slot.upgrade().ok_or(EventError::Closed)?;
        {
            let mut state = slot.state.lock().unwrap();
            if runtime.closed.load(Ordering::SeqCst)
                || state.generation != self.generation
                || !matches!(state.phase, Phase::Prepared | Phase::Running)
            {
                return Err(EventError::Closed);
            }
            state.inflight += 1;
        }
        let _flight = InFlight(&slot);
        let mut current = runtime.next_source.load(Ordering::SeqCst);
        let id = loop {
            let next = current
                .checked_add(1)
                .ok_or_else(|| EventError::Io(io::Error::other("virtio source IDs exhausted")))?;
            match runtime.next_source.compare_exchange_weak(
                current,
                next,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(id) => break SourceId(id),
                Err(observed) => current = observed,
            }
        };
        let token = id.0 as usize;
        let mut sources = runtime.sources.lock().unwrap();
        sources.insert(
            token,
            RegisteredSource {
                slot: slot.index,
                generation: self.generation,
                id,
                source,
                ready: false,
                retired: false,
                delivering: None,
            },
        );
        let result = runtime.registry.register(
            sources.get_mut(&token).unwrap().source.as_source(),
            Token(token),
            Interest::READABLE,
        );
        if let Err(error) = result {
            sources.remove(&token);
            return Err(EventError::Io(error));
        }
        Ok(id)
    }

    fn deregister(&self, id: SourceId) {
        let (Some(runtime), Some(slot)) = (self.runtime.upgrade(), self.slot.upgrade()) else {
            return;
        };
        let mut sources = runtime.sources.lock().unwrap();
        let token = id.0 as usize;
        let Some(source) = sources.get_mut(&token) else {
            return;
        };
        if source.slot != slot.index || source.generation != self.generation {
            return;
        }
        if !source.retired {
            source.retired = true;
            if let Err(error) = runtime.registry.deregister(source.source.as_source()) {
                runtime.fail(error);
            }
        }
        // Self-retirement leaves destruction to the delivery guard. Other
        // callers wait until the admitted callback, including its IRQs, ends.
        let caller = thread::current().id();
        while let Some(source) = sources.get(&token) {
            match source.delivering {
                Some(owner) if owner == caller => return,
                Some(_) => sources = runtime.sources_idle.wait(sources).unwrap(),
                None => break,
            }
        }
        sources.remove(&token);
    }
}

#[cfg(all(test, unix))]
#[path = "../../tests/virtio/executor.rs"]
mod tests;
