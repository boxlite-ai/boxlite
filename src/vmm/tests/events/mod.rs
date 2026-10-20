// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The event loop: order, a wake from another thread, timeouts, and a send
//! after the loop is gone.

use std::{
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

    // Without the wake the poll would sleep the whole timeout and only then
    // find the event.
    assert!(started.elapsed() < TIMEOUT / 2, "{:?}", started.elapsed());
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
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn a_send_after_the_loop_is_gone_is_dropped() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    drop(events);

    sender.send(Event::GuestReset);
}
