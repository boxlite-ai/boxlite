// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The event loop: order, a wake from another thread, timeouts, a send after
//! the loop is gone, and a lost wake-up.

use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use super::{Event, EventLoop};
use crate::error::Error;

#[test]
fn returns_queued_events_in_order() {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    sender.send(Event::GuestReset);
    sender.send(Event::DeviceFailed(Error::InvalidVcpuCount(0)));

    // A timeout too long to add to the clock waits forever.
    let first = events.wait(Some(Duration::MAX)).unwrap();
    let second = events.wait(None).unwrap();

    assert!(matches!(first, Some(Event::GuestReset)), "{first:?}");
    assert!(
        matches!(
            second,
            Some(Event::DeviceFailed(Error::InvalidVcpuCount(0)))
        ),
        "{second:?}"
    );
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn a_send_from_another_thread_ends_the_wait() {
    const TIMEOUT: Duration = Duration::from_secs(10);
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let (ready, release) = PollGate::install(&mut events);
    thread::scope(|scope| {
        let waiting = scope.spawn(|| events.wait(Some(TIMEOUT)));
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        sender.send(Event::GuestReset);
        release.send(()).unwrap();
        let event = waiting.join().unwrap().unwrap();
        assert!(matches!(event, Some(Event::GuestReset)), "{event:?}");
    });
    assert_eq!(events.wake_polls, 1);
    assert_eq!(events.poll_calls, 1);
}

#[test]
fn a_wait_without_events_ends_at_its_timeout() {
    const TIMEOUT: Duration = Duration::from_millis(20);
    let mut events = EventLoop::new().unwrap();

    let started = Instant::now();
    let event = events.wait(Some(TIMEOUT)).unwrap();

    assert!(event.is_none(), "{event:?}");
    assert!(started.elapsed() >= TIMEOUT, "{:?}", started.elapsed());
}

#[test]
fn a_send_after_the_loop_is_gone_is_dropped_without_panicking() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    drop(events);

    sender.send(Event::GuestReset);
}

/// An event whose wake-up never arrives still ends a wait without a
/// timeout. Queuing it straight into the channel leaves the poller asleep,
/// as a failed `Waker::wake` would; sleeping through it would hang the VM.
#[test]
fn a_wait_finds_an_event_whose_wake_up_was_lost() {
    const TIMEOUT: Duration = Duration::from_secs(10);
    let mut events = EventLoop::new().unwrap();
    let queue = events.sender.events.clone();
    let (returned, wait_returned) = mpsc::channel();
    let (ready, release) = PollGate::install(&mut events);
    let waiting = thread::spawn(move || {
        let _ = returned.send(events.wait(None).map_err(|error| error.kind()));
    });
    ready.recv_timeout(Duration::from_secs(1)).unwrap();
    queue.send(Event::GuestReset).unwrap();
    release.send(()).unwrap();

    let event = wait_returned
        .recv_timeout(TIMEOUT)
        .expect("the wait slept through an event whose wake-up was lost");
    assert!(matches!(event, Ok(Some(Event::GuestReset))), "{event:?}");
    waiting.join().unwrap();
}

/// A send latches the stop for every sender before it returns, so the vCPU
/// that sent never re-enters the guest while the loop is still asleep.
#[test]
fn a_send_latches_the_stop_for_every_sender_before_it_returns() {
    let events = EventLoop::new().unwrap();
    let (device, vcpu) = (events.sender(), events.sender());
    assert!(!vcpu.is_stopping());

    device.send(Event::GuestReset);

    assert!(vcpu.is_stopping());
    drop(events);
    // With the loop gone the event is dropped, but the latch still holds.
    device.send(Event::GuestShutdown);
    assert!(vcpu.is_stopping());
}

/// Stops after the empty queue check and before the actual mio poll.
pub(crate) struct PollGate {
    reached: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}
impl PollGate {
    pub(crate) fn install(events: &mut EventLoop) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (reached, ready) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        events.poll_gate = Some(Self {
            reached,
            release: gate,
        });
        (ready, release)
    }

    pub(crate) fn enter(self) {
        self.reached.send(()).unwrap();
        self.release.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}

#[test]
fn pure_wake_returns_none_without_stopping_or_an_event() {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let (ready, release) = PollGate::install(&mut events);
    thread::scope(|scope| {
        let waiter = scope.spawn(|| events.wait(Some(super::RECHECK)));
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        sender.wake();
        assert!(!sender.is_stopping());
        release.send(()).unwrap();
        assert!(waiter.join().unwrap().unwrap().is_none());
    });
    assert_eq!(events.wake_polls, 1, "poll did not see WAKE");
    assert_eq!(events.poll_calls, 1, "wait swallowed the nonterminal wake");
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn wake_before_wait_is_retained_by_the_poller() {
    let mut events = EventLoop::new().unwrap();
    events.sender().wake();
    assert!(events.wait(Some(super::RECHECK)).unwrap().is_none());
    assert_eq!(events.wake_polls, 1);
    assert_eq!(events.poll_calls, 1, "wait swallowed the nonterminal wake");
    assert!(!events.sender().is_stopping());
    assert!(events.events.try_recv().is_err());
}
