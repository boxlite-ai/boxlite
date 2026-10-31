// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Sharing one device: exclusive access, waiters that are woken when the
//! holder releases it, a blocking worker acquire, and a poisoned device that
//! fails instead of looking busy forever.

use std::{
    panic::{self, AssertUnwindSafe},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use super::SharedDevice;
use crate::{
    io::{ConfigBytes, Waker},
    virtio::{
        DeviceEvent, DeviceOp, DeviceSpec, EventContext, FeatureError, SnapshotSupport,
        VirtioDevice,
    },
};

struct TestDevice {
    spec: DeviceSpec,
}

impl VirtioDevice for TestDevice {
    fn spec(&self) -> &DeviceSpec {
        &self.spec
    }

    fn set_features(&mut self, _negotiated: u64) -> Result<(), FeatureError> {
        Ok(())
    }

    fn read_config(&mut self, _offset: u64, len: usize) -> DeviceOp<ConfigBytes> {
        DeviceOp::Ready(Ok(ConfigBytes::new(len)))
    }

    fn write_config(&mut self, _offset: u64, _value: ConfigBytes) -> DeviceOp<()> {
        DeviceOp::Ready(Ok(()))
    }

    fn on_event(
        &mut self,
        _event: DeviceEvent,
        _cx: &mut EventContext<'_>,
    ) -> Result<(), crate::virtio::DeviceError> {
        Ok(())
    }
}

fn shared() -> SharedDevice {
    SharedDevice::new(TestDevice {
        spec: DeviceSpec {
            device_id: 4,
            name: "test",
            features: 0,
            config_len: 0,
            queue_max: &[],
            snapshot: SnapshotSupport::Unsupported,
        },
    })
}

fn counting_waker(calls: &Arc<AtomicUsize>) -> Waker {
    let calls = Arc::clone(calls);
    Arc::new(move || {
        calls.fetch_add(1, Ordering::SeqCst);
    })
}

#[test]
fn the_spec_is_cached_when_the_device_wraps() {
    let shared = shared();
    assert_eq!(shared.spec().name, "test");
    assert_eq!(shared.spec().device_id, 4);
}

#[test]
fn a_held_device_cannot_be_taken_again_until_its_guard_drops() {
    let shared = shared();
    let guard = shared.try_acquire().expect("the device is free");

    assert!(shared.try_acquire().is_none());
    drop(guard);
    assert!(shared.try_acquire().is_some());
}

#[test]
fn releasing_the_device_wakes_every_registered_waiter() {
    let shared = shared();
    let first = Arc::new(AtomicUsize::new(0));
    let second = Arc::new(AtomicUsize::new(0));
    let guard = shared.try_acquire().expect("the device is free");

    assert!(
        shared
            .try_acquire_or_register(counting_waker(&first))
            .is_none()
    );
    assert!(
        shared
            .try_acquire_or_register(counting_waker(&second))
            .is_none()
    );
    assert_eq!(first.load(Ordering::SeqCst), 0);

    drop(guard);

    assert_eq!(first.load(Ordering::SeqCst), 1);
    assert_eq!(second.load(Ordering::SeqCst), 1);
    assert!(
        shared.try_acquire().is_some(),
        "a woken waiter can take the device"
    );
}

#[test]
fn the_worker_blocks_until_the_control_side_releases_the_device() {
    let shared = Arc::new(shared());
    let guard = shared.try_acquire().expect("the device is free");
    let (acquired, waiting) = mpsc::channel();
    let worker = {
        let shared = Arc::clone(&shared);
        thread::spawn(move || {
            let _guard = shared.acquire();
            let _ = acquired.send(());
        })
    };

    assert!(
        waiting.recv_timeout(Duration::from_millis(50)).is_err(),
        "the worker acquired a held device"
    );
    drop(guard);
    waiting
        .recv_timeout(Duration::from_secs(5))
        .expect("the worker acquires once the control side releases");
    worker.join().unwrap();
}

/// A holder acquired by the worker never registers a waker, yet its release
/// must wake a control path that registered while it held the device.
#[test]
fn a_worker_holders_release_wakes_a_registered_waiter() {
    let shared = Arc::new(shared());
    let (held, holds) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let holder = {
        let shared = Arc::clone(&shared);
        thread::spawn(move || {
            let guard = shared.acquire();
            let _ = held.send(());
            let _ = released.recv_timeout(Duration::from_secs(5));
            drop(guard);
        })
    };
    holds
        .recv_timeout(Duration::from_secs(5))
        .expect("the worker takes the device");
    let woke = Arc::new(AtomicUsize::new(0));
    assert!(
        shared
            .try_acquire_or_register(counting_waker(&woke))
            .is_none()
    );
    assert_eq!(woke.load(Ordering::SeqCst), 0);

    release.send(()).unwrap();
    holder.join().unwrap();

    assert_eq!(
        woke.load(Ordering::SeqCst),
        1,
        "the worker's release must wake the registered waiter"
    );
}

/// Control paths that keep registering against worker releases never lose
/// their wake: every failed registration is woken by a later release.
#[test]
fn concurrent_registrations_against_worker_releases_are_all_woken() {
    const WAITERS: usize = 4;
    const ROUNDS: usize = 500;
    let shared = Arc::new(shared());
    let done = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicUsize::new(0));

    thread::scope(|scope| {
        let holder = {
            let shared = Arc::clone(&shared);
            let stop = Arc::clone(&stop);
            scope.spawn(move || {
                while stop.load(Ordering::SeqCst) == 0 {
                    drop(shared.acquire());
                }
            })
        };
        let waiters: Vec<_> = (0..WAITERS)
            .map(|_| {
                let shared = Arc::clone(&shared);
                let done = Arc::clone(&done);
                scope.spawn(move || {
                    for _ in 0..ROUNDS {
                        let woke = Arc::new(AtomicUsize::new(0));
                        if shared
                            .try_acquire_or_register(counting_waker(&woke))
                            .is_none()
                        {
                            // The holder releases in a tight loop, so the
                            // wake arrives within the deadline.
                            let deadline = std::time::Instant::now() + Duration::from_secs(10);
                            while woke.load(Ordering::SeqCst) == 0 {
                                assert!(
                                    std::time::Instant::now() < deadline,
                                    "a registered waiter lost its wake"
                                );
                                std::hint::spin_loop();
                            }
                        }
                        done.fetch_add(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for waiter in waiters {
            waiter.join().unwrap();
        }
        stop.store(1, Ordering::SeqCst);
        holder.join().unwrap();
    });

    assert_eq!(done.load(Ordering::SeqCst), WAITERS * ROUNDS);
}

#[test]
fn a_poisoned_device_fails_instead_of_waiting_forever() {
    let shared = Arc::new(shared());
    let poisoned = Arc::clone(&shared);
    let panicked = panic::catch_unwind(AssertUnwindSafe(move || {
        let _guard = poisoned.acquire();
        panic!("the device panics under its lock");
    }));
    assert!(panicked.is_err());

    let taken = panic::catch_unwind(AssertUnwindSafe(|| shared.try_acquire().is_some()));
    assert!(taken.is_err(), "a poisoned device must not look busy");
}
