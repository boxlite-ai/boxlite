// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Completion hand-offs and configuration buffers.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};

use crate::io::{Cancelled, Completion, ConfigBytes};

#[test]
fn a_completion_delivers_its_value_once() {
    let (completion, completer) = Completion::new();
    assert!(!completion.is_done());
    assert!(completer.complete(ConfigBytes::from_slice(b"ok")));
    assert!(completion.is_done());
    assert_eq!(completion.wait().unwrap().as_slice(), b"ok");
    assert_eq!(completion.wait(), Err(Cancelled));
}

#[test]
fn a_cancelled_completion_wakes_its_waiter() {
    let (completion, completer) = Completion::<()>::new();
    let waiter = completion.clone();
    let handle = thread::spawn(move || waiter.wait());
    assert!(completer.cancel());
    assert_eq!(handle.join().unwrap(), Err(Cancelled));
}

/// A producer that disappears without answering wakes its waiter instead of
/// leaving it blocked on a result that can never arrive.
#[test]
fn a_dropped_producer_cancels_the_completion() {
    let (completion, completer) = Completion::<()>::new();
    let waiter = completion.clone();
    let handle = thread::spawn(move || waiter.wait());

    drop(completer);

    assert_eq!(handle.join().unwrap(), Err(Cancelled));
    assert!(completion.is_done());
}

/// Dropping a producer that already completed leaves the value for its
/// waiter.
#[test]
fn a_dropped_producer_keeps_a_delivered_value() {
    let (completion, completer) = Completion::new();
    assert!(completer.complete(7_u8));

    assert_eq!(completion.wait(), Ok(7));
}

#[test]
fn arming_before_the_value_wakes_the_control_thread() {
    let (completion, completer) = Completion::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    completion.arm(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    assert!(completer.complete(()));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn arming_after_the_value_wakes_the_control_thread_at_once() {
    let (completion, completer) = Completion::new();
    assert!(completer.complete(()));
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    completion.arm(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn config_bytes_keep_their_length() {
    let bytes = ConfigBytes::fill(0xff, 3);
    assert_eq!(bytes.len(), 3);
    assert_eq!(bytes.as_slice(), &[0xff, 0xff, 0xff]);
    assert!(!bytes.is_empty());
    assert!(ConfigBytes::new(0).is_empty());
    assert_eq!(ConfigBytes::from_slice(b"ab").as_slice(), b"ab");
}

#[test]
fn a_cancellation_names_its_cause() {
    assert_eq!(Cancelled.to_string(), "the completion was cancelled");
}
