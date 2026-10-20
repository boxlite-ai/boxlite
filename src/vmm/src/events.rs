// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The events that end a VM, and the loop the `run()` thread waits on.
//!
//! Devices and vCPU threads send an [`Event`] through an [`EventSender`]. The
//! [`EventLoop`] owns the mio poller: a sender queues the event and then wakes
//! the poller, so the loop can later watch file descriptors as well.

use std::{
    io,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use mio::{Events, Poll, Token, Waker};

use crate::error::Error;

/// Something that ends the VM.
#[derive(Debug)]
pub(crate) enum Event {
    /// The guest asked for a reset.
    GuestReset,
    /// A device can no longer serve the guest.
    DeviceFailed(Error),
}

/// The poller token of the waker.
const WAKE: Token = Token(0);

/// Sends events to an [`EventLoop`] from any thread.
#[derive(Clone)]
pub(crate) struct EventSender {
    events: mpsc::Sender<Event>,
    waker: Arc<Waker>,
}

impl EventSender {
    /// Queues `event` and wakes the loop. An event sent after the loop is
    /// dropped is discarded: the VM has already ended.
    ///
    /// # Panics
    ///
    /// If waking the poller fails, since the loop would then sleep through
    /// the event. mio retries a full eventfd itself, so a failure means a
    /// broken poller.
    pub(crate) fn send(&self, event: Event) {
        if self.events.send(event).is_ok() {
            self.waker.wake().expect("wake the event loop");
        }
    }
}

/// The poller the `run()` thread waits on.
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
        let (events, receiver) = mpsc::channel();
        Ok(Self {
            poll,
            // Only the waker is registered; the events themselves queue in
            // the channel.
            readiness: Events::with_capacity(1),
            events: receiver,
            sender: EventSender { events, waker },
        })
    }

    pub(crate) fn sender(&self) -> EventSender {
        self.sender.clone()
    }

    /// The oldest queued event, waiting up to `timeout`, or forever with
    /// `None`. Returns `Ok(None)` once the timeout passes; a zero timeout
    /// never enters the poller.
    pub(crate) fn wait(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        // A timeout too long to add counts as forever.
        let deadline = timeout.and_then(|timeout| Instant::now().checked_add(timeout));
        loop {
            if let Ok(event) = self.events.try_recv() {
                return Ok(Some(event));
            }
            let remaining = match deadline {
                Some(deadline) => match deadline.checked_duration_since(Instant::now()) {
                    Some(remaining) if !remaining.is_zero() => Some(remaining),
                    _ => return Ok(None),
                },
                None => None,
            };
            match self.poll.poll(&mut self.readiness, remaining) {
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
