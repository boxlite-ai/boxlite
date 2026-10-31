// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The run thread's queue of deferred bus accesses.
//!
//! A vCPU hands a [`DeferredIo`] to the [`ControlHandle`] and waits on its
//! completion. The run thread drains the queue, calls the device's
//! [`BusDevice::progress`](crate::bus::BusDevice::progress), and either
//! completes the access or parks it until the device's readiness wake fires.
//! The queue signals the run thread through the event loop's own
//! [`mio::Waker`], which works on every host this crate compiles for; the
//! loop reports a wake with no queued terminal event as
//! [`LoopEvent::Control`](crate::events::LoopEvent::Control).
//!
//! A close is final: once the run thread closes the queue, an access queued
//! afterwards is cancelled at once instead of waiting for a drain that never
//! comes, so a vCPU that defers while the VM stops still wakes.

use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{
    bus::{BusIo, DeferredIo},
    io::Waker,
};

/// The run thread's queue and the wake handle it shares with the event loop.
pub(crate) struct ControlQueue {
    waker: Arc<mio::Waker>,
    pending: Arc<Mutex<VecDeque<DeferredIo>>>,
    closed: Arc<AtomicBool>,
}

/// A cloneable handle the vCPUs use to defer work.
#[derive(Clone)]
pub(crate) struct ControlHandle {
    waker: Arc<mio::Waker>,
    pending: Arc<Mutex<VecDeque<DeferredIo>>>,
    closed: Arc<AtomicBool>,
}

impl ControlQueue {
    /// A queue that signals the event loop through `waker`.
    pub(crate) fn new(waker: Arc<mio::Waker>) -> Self {
        Self {
            waker,
            pending: Arc::new(Mutex::new(VecDeque::new())),
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// A handle that defers work to this queue.
    pub(crate) fn handle(&self) -> ControlHandle {
        ControlHandle {
            waker: Arc::clone(&self.waker),
            pending: Arc::clone(&self.pending),
            closed: Arc::clone(&self.closed),
        }
    }

    /// Advances every queued access once. An access the device cannot finish
    /// yet stays queued until its readiness wake.
    pub(crate) fn pump(&self, waker: &Waker) {
        for io in self.drain() {
            if let Some(io) = progress(io, Arc::clone(waker)) {
                self.park(io);
            }
        }
    }

    /// Takes every deferred access.
    fn drain(&self) -> Vec<DeferredIo> {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain(..)
            .collect()
    }

    /// Keeps `io` for a later readiness wake without signalling.
    fn park(&self, io: DeferredIo) {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(io);
    }

    /// Closes the queue and cancels every queued access, waking its vCPU.
    /// Later [`ControlHandle::defer`] calls cancel at once.
    pub(crate) fn cancel_all(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for io in self.drain() {
            io.cancel();
        }
    }

    /// Whether no access waits in the queue.
    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }
}

impl ControlHandle {
    /// Queues `io` and wakes the run thread, or cancels it if the queue is
    /// already closed.
    pub(crate) fn defer(&self, io: DeferredIo) {
        let mut io = Some(io);
        {
            let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            if !self.closed.load(Ordering::SeqCst) {
                pending.push_back(io.take().expect("the access is queued once"));
            }
        }
        match io {
            // `cancel_all` marks the queue closed before it drains, so an
            // access either lands before the drain or is cancelled here.
            Some(io) => {
                io.cancel();
            }
            None => self.signal(),
        }
    }

    /// A waker that wakes the run thread.
    pub(crate) fn waker(&self) -> Waker {
        let handle = self.clone();
        Arc::new(move || handle.signal())
    }

    fn signal(&self) {
        // A failed wake means the poller is gone, and the VM is ending.
        let _ = self.waker.wake();
    }
}

/// Advances one deferred access. Returns it for another wait when the device
/// is not ready yet.
pub(crate) fn progress(io: DeferredIo, waker: Waker) -> Option<DeferredIo> {
    let mut request = io.request();
    io.readiness().arm(Arc::clone(&waker));
    // The device lock is released before the access moves, so a completion
    // never runs with the device lock held.
    let result = io
        .lock_target()
        .map(|mut target| target.progress(&mut request));
    let Some(result) = result else {
        // The device panicked under an earlier access and can never finish
        // this one; cancel it instead of stopping the run thread.
        io.cancel();
        return None;
    };
    match result {
        BusIo::Complete(()) => {
            io.complete(request);
            None
        }
        BusIo::Deferred(next) => {
            next.arm(waker);
            Some(io)
        }
    }
}

#[cfg(test)]
#[path = "../../tests/virtio/control.rs"]
mod tests;
