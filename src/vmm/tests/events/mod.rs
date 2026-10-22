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
    let started = Instant::now();
    let sending = thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        sender.send(Event::GuestReset);
    });

    let event = events.wait(Some(TIMEOUT)).unwrap();

    // Without the wake the poll would sleep a whole recheck interval.
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "{:?}",
        started.elapsed()
    );
    assert!(matches!(event, Some(Event::GuestReset)), "{event:?}");
    sending.join().unwrap();
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
    thread::spawn(move || {
        let _ = returned.send(events.wait(None).map_err(|error| error.kind()));
    });
    // Let the wait enter the poller before the event arrives.
    thread::sleep(Duration::from_millis(50));

    queue.send(Event::GuestReset).unwrap();

    let event = wait_returned
        .recv_timeout(TIMEOUT)
        .expect("the wait slept through an event whose wake-up was lost");
    assert!(matches!(event, Ok(Some(Event::GuestReset))), "{event:?}");
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
