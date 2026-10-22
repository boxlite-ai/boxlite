// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The events that end a VM, and the loop that waits for them.
//!
//! Every [`Event`] is terminal: the first one decides how the VM ended, and
//! the VMM never restarts a guest. Devices send one through an
//! [`EventSender`], which queues it and wakes the [`EventLoop`]'s mio
//! poller, so the loop can later wait on file descriptors as well. Sending
//! never panics and never blocks, since a device sends from a vCPU thread
//! under its own lock.
//!
//! Sending also sets a stop latch before it queues, and every vCPU checks the
//! latch before each guest entry. The vCPU that sends, such as the one whose
//! write reset the i8042, therefore never enters the guest again, whether or
//! not the loop has woken yet.

use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use mio::{Events, Poll, Token, Waker};

use crate::error::Error;

/// Something that ends the VM.
#[derive(Debug)]
pub(crate) enum Event {
    /// The host asked the VM to stop.
    StopRequested,
    /// The guest asked for a reset, which on x86_64 arrives through the i8042.
    GuestReset,
    /// The guest asked to power off.
    GuestShutdown,
    /// A vCPU failed, panicked or exited in a way the VMM does not handle.
    VcpuFailed(Error),
    /// A device can no longer serve the guest.
    DeviceFailed(Error),
}

/// The poller token of the waker.
const WAKE: Token = Token(0);

/// How often [`EventLoop::wait`] looks at the queue without a wake-up, so an
/// event whose wake-up was lost ends the VM late instead of never.
const RECHECK: Duration = Duration::from_secs(1);

/// Sends events to an [`EventLoop`] from any thread.
#[derive(Clone, Debug)]
pub(crate) struct EventSender {
    events: mpsc::Sender<Event>,
    waker: Arc<Waker>,
    stopping: Arc<AtomicBool>,
}

impl EventSender {
    /// Sets the stop latch, then queues `event` and wakes the loop. An event
    /// sent after the loop is dropped is logged and discarded: the VM has
    /// already ended. Only a broken host fails the wake-up; the failure is
    /// logged, and [`EventLoop::wait`] still finds the event at its next
    /// recheck.
    pub(crate) fn send(&self, event: Event) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Err(mpsc::SendError(event)) = self.events.send(event) {
            tracing::debug!(?event, "event sent after the VM ended; discarded");
        } else if let Err(error) = self.waker.wake() {
            tracing::warn!(%error, "event loop wake-up failed; the event waits for the next recheck");
        }
    }

    /// Whether any event has been sent, so the VM is ending.
    pub(crate) fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
}

/// The poller the thread that owns the VM waits on.
pub(crate) struct EventLoop {
    poll: Poll,
    readiness: Events,
    events: mpsc::Receiver<Event>,
    sender: EventSender,
}

impl EventLoop {
    pub(crate) fn new() -> io::Result<Self> {
        let poll = Poll::new()?;
        let waker = Arc::new(Waker::new(poll.registry(), WAKE)?);
        let (tx, rx) = mpsc::channel();
        Ok(Self {
            poll,
            // Only the waker is registered; the events themselves queue in
            // the channel.
            readiness: Events::with_capacity(1),
            events: rx,
            sender: EventSender {
                events: tx,
                waker,
                stopping: Arc::new(AtomicBool::new(false)),
            },
        })
    }

    pub(crate) fn sender(&self) -> EventSender {
        self.sender.clone()
    }

    /// The oldest queued event, waiting up to `timeout`, or forever with
    /// `None`. Returns `Ok(None)` once the timeout passes; a zero timeout
    /// never enters the poller. The poller is re-entered every [`RECHECK`],
    /// so an event whose wake-up failed is still found.
    pub(crate) fn wait(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        // A timeout too long to add counts as forever.
        let deadline = timeout.and_then(|timeout| Instant::now().checked_add(timeout));
        loop {
            if let Ok(event) = self.events.try_recv() {
                return Ok(Some(event));
            }
            let slice = match deadline {
                Some(deadline) => match deadline.checked_duration_since(Instant::now()) {
                    Some(remaining) if !remaining.is_zero() => remaining.min(RECHECK),
                    _ => return Ok(None),
                },
                None => RECHECK,
            };
            match self.poll.poll(&mut self.readiness, Some(slice)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(test)]
#[path = "../tests/events/mod.rs"]
mod tests;
