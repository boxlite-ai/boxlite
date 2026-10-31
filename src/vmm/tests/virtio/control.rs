// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The run thread's control queue: a deferred access completes with the
//! device's bytes, one that is not ready parks and wakes on the device's
//! readiness, a close cancels what is queued, and a defer after the close
//! cancels at once.

use std::{
    panic::{self, AssertUnwindSafe},
    sync::{Arc, Mutex},
};

use mio::{Poll, Token, Waker as MioWaker};

use super::ControlQueue;
use crate::{
    bus::{Bus, BusDevice, BusIo, BusRange, BusRead, BusWrite, DeferredIo, PendingIo},
    io::{Cancelled, Completer, Completion, ConfigBytes, Waker},
};

/// A device whose reads and writes defer until `ready`; completing an access
/// answers a read with `reply`.
struct Deferred {
    reply: u8,
    ready: bool,
    /// The readiness of the pending access. Reusing it across progress calls
    /// keeps an unready device from waking the run thread every round.
    readiness: Option<(Completion<()>, Completer<()>)>,
}

impl Deferred {
    fn new(reply: u8, ready: bool) -> Self {
        Self {
            reply,
            ready,
            readiness: None,
        }
    }

    fn readiness(&mut self) -> Completion<()> {
        let (completion, completer) = Completion::new();
        self.readiness = Some((completion.clone(), completer));
        completion
    }
}

impl BusDevice for Deferred {
    fn read(&mut self, _offset: u64, _len: usize) -> BusIo<ConfigBytes> {
        BusIo::Deferred(self.readiness())
    }

    fn write(&mut self, _offset: u64, _data: &[u8]) -> BusIo<()> {
        BusIo::Deferred(self.readiness())
    }

    fn progress(&mut self, request: &mut PendingIo) -> BusIo<()> {
        if !self.ready {
            let (completion, _) = self.readiness.get_or_insert_with(Completion::new);
            return BusIo::Deferred(completion.clone());
        }
        if let PendingIo::Read { bytes, .. } = request {
            *bytes = Some(ConfigBytes::from_slice(&[self.reply]));
        }
        BusIo::Complete(())
    }
}

fn bus_with(device: &Arc<Mutex<Deferred>>) -> Bus {
    let mut bus = Bus::default();
    let device: Arc<Mutex<dyn BusDevice>> = Arc::clone(device) as _;
    bus.insert(
        BusRange::new(0x1000, 0x10).expect("a valid range"),
        "deferred",
        Some((device, 0)),
    )
    .unwrap();
    bus
}

fn waker() -> Waker {
    Arc::new(|| {})
}

/// A queue whose wake handle writes to a poller no test polls.
fn queue() -> ControlQueue {
    let poll = Box::leak(Box::new(Poll::new().unwrap()));
    let waker = MioWaker::new(poll.registry(), Token(0)).unwrap();
    ControlQueue::new(Arc::new(waker))
}

fn deferred_read(bus: &Bus) -> (DeferredIo, Completion<ConfigBytes>) {
    let BusRead::Deferred(io) = bus.read(0x1000, 1) else {
        panic!("the test device always defers reads");
    };
    let completion = io.completion();
    (DeferredIo::Read(io), completion)
}

#[test]
fn the_run_thread_completes_a_deferred_read_with_the_devices_bytes() {
    let device = Arc::new(Mutex::new(Deferred::new(0xab, true)));
    let bus = bus_with(&device);
    let queue = queue();
    let (io, completion) = deferred_read(&bus);

    queue.handle().defer(io);
    queue.pump(&waker());

    assert_eq!(completion.wait().unwrap().as_slice(), [0xab]);
    assert!(queue.is_empty());
}

#[test]
fn an_unready_device_parks_until_its_readiness_wakes_the_run_thread() {
    let device = Arc::new(Mutex::new(Deferred::new(0x5a, false)));
    let bus = bus_with(&device);
    let queue = queue();
    let (io, completion) = deferred_read(&bus);

    queue.handle().defer(io);
    queue.pump(&waker());
    assert!(!completion.is_done(), "the device is not ready yet");
    assert!(!queue.is_empty(), "the access waits in the queue");

    {
        let mut device = device.lock().unwrap();
        device.ready = true;
        let (_, completer) = device.readiness.take().expect("a pending readiness");
        assert!(completer.complete(()));
    }
    queue.pump(&waker());

    assert_eq!(completion.wait().unwrap().as_slice(), [0x5a]);
    assert!(queue.is_empty());
}

#[test]
fn the_run_thread_completes_a_deferred_write() {
    let device = Arc::new(Mutex::new(Deferred::new(0, true)));
    let bus = bus_with(&device);
    let queue = queue();
    let BusWrite::Deferred(io) = bus.write(0x1000, &[7]) else {
        panic!("the test device always defers writes");
    };
    let completion = io.completion();

    queue.handle().defer(DeferredIo::Write(io));
    queue.pump(&waker());

    assert_eq!(completion.wait(), Ok(()));
}

#[test]
fn a_close_cancels_a_parked_access() {
    let device = Arc::new(Mutex::new(Deferred::new(0, false)));
    let bus = bus_with(&device);
    let queue = queue();
    let (io, completion) = deferred_read(&bus);

    queue.handle().defer(io);
    queue.pump(&waker());
    queue.cancel_all();

    assert_eq!(completion.wait(), Err(Cancelled));
    assert!(queue.is_empty());
}

#[test]
fn a_defer_after_the_close_cancels_at_once() {
    let device = Arc::new(Mutex::new(Deferred::new(0, true)));
    let bus = bus_with(&device);
    let queue = queue();
    queue.cancel_all();

    let (io, completion) = deferred_read(&bus);
    queue.handle().defer(io);

    assert_eq!(completion.wait(), Err(Cancelled));
    assert!(queue.is_empty(), "the access never entered the queue");
}

/// A device whose lock an earlier panic poisoned can never finish the
/// access; the run thread cancels it instead of panicking itself.
#[test]
fn a_poisoned_device_cancels_the_access_instead_of_stopping_its_thread() {
    let device = Arc::new(Mutex::new(Deferred::new(0, true)));
    let bus = bus_with(&device);
    let queue = queue();
    let (io, completion) = deferred_read(&bus);

    let poisoned = Arc::clone(&device);
    let panicked = panic::catch_unwind(AssertUnwindSafe(move || {
        let _guard = poisoned.lock().unwrap();
        panic!("the device panics under its lock");
    }));
    assert!(panicked.is_err());
    assert!(device.is_poisoned());

    queue.handle().defer(io);
    queue.pump(&waker());

    assert_eq!(completion.wait(), Err(Cancelled));
    assert!(queue.is_empty());
}
