// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Deferred completions shared by the bus and virtio devices.
//!
//! A [`Completion`] is a one-shot hand-off from a device or worker to the
//! thread waiting for it. The producer holds the single-use [`Completer`]; the
//! consumer holds any clone of the [`Completion`]. A [`Waker`] lets a control
//! thread learn that a pending operation finished without polling.

use std::{
    fmt,
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
};

/// A callback that wakes the thread that owns a control queue.
pub(crate) type Waker = Arc<dyn Fn() + Send + Sync>;

/// A self-owned byte buffer returned by a deferred configuration read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConfigBytes {
    bytes: Vec<u8>,
}

impl ConfigBytes {
    /// `len` zero bytes.
    pub(crate) fn new(len: usize) -> Self {
        Self {
            bytes: vec![0; len],
        }
    }

    /// A copy of `bytes`.
    pub(crate) fn from_slice(bytes: &[u8]) -> Self {
        Self {
            bytes: bytes.to_vec(),
        }
    }

    /// `len` bytes, each `value`.
    pub(crate) fn fill(value: u8, len: usize) -> Self {
        Self {
            bytes: vec![value; len],
        }
    }

    /// The bytes.
    pub(crate) fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    /// The number of bytes.
    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Whether the buffer is empty.
    pub(crate) fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// The consumer end of a one-shot completion.
pub(crate) struct Completion<T> {
    inner: Arc<Inner<T>>,
}

/// The producer end of a one-shot completion.
pub(crate) struct Completer<T> {
    inner: Arc<Inner<T>>,
}

struct Inner<T> {
    state: Mutex<State<T>>,
    ready: Condvar,
}

enum State<T> {
    Pending(Option<Waker>),
    Done(Option<T>),
    Cancelled,
}

impl<T> Completion<T> {
    /// A pending completion and its single-use producer.
    pub(crate) fn new() -> (Self, Completer<T>) {
        let inner = Arc::new(Inner {
            state: Mutex::new(State::Pending(None)),
            ready: Condvar::new(),
        });
        (
            Self {
                inner: Arc::clone(&inner),
            },
            Completer { inner },
        )
    }

    /// Calls `waker` when the completion finishes. Arming an already finished
    /// completion calls it at once, so a control thread cannot miss a result
    /// that arrived before it registered.
    pub(crate) fn arm(&self, waker: Waker) {
        let wake = {
            let mut state = self.lock();
            match &mut *state {
                State::Pending(slot) => {
                    *slot = Some(waker);
                    None
                }
                State::Done(_) | State::Cancelled => Some(waker),
            }
        };
        if let Some(waker) = wake {
            waker();
        }
    }

    /// Whether the completion finished or was cancelled.
    pub(crate) fn is_done(&self) -> bool {
        !matches!(&*self.lock(), State::Pending(_))
    }

    /// Waits for the value; returns [`Cancelled`] after a cancellation or a
    /// second wait on the same result.
    pub(crate) fn wait(&self) -> Result<T, Cancelled> {
        let mut state = self.lock();
        loop {
            match &mut *state {
                State::Pending(_) => {}
                State::Done(value) => return value.take().ok_or(Cancelled),
                State::Cancelled => return Err(Cancelled),
            }
            state = self
                .inner
                .ready
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn lock(&self) -> MutexGuard<'_, State<T>> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl<T> Clone for Completion<T> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<T> fmt::Debug for Completion<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Completion")
            .field("done", &self.is_done())
            .finish()
    }
}

impl<T> Completer<T> {
    /// Delivers `value`; returns `false` after a previous completion or
    /// cancellation.
    pub(crate) fn complete(self, value: T) -> bool {
        let waker = {
            let mut state = self.lock();
            let waker = match &mut *state {
                State::Pending(waker) => waker.take(),
                State::Done(_) | State::Cancelled => return false,
            };
            *state = State::Done(Some(value));
            waker
        };
        self.inner.ready.notify_all();
        if let Some(waker) = waker {
            waker();
        }
        true
    }

    /// Cancels the completion and wakes its waiter.
    pub(crate) fn cancel(self) -> bool {
        let waker = {
            let mut state = self.lock();
            let waker = match &mut *state {
                State::Pending(waker) => waker.take(),
                State::Done(_) | State::Cancelled => return false,
            };
            *state = State::Cancelled;
            waker
        };
        self.inner.ready.notify_all();
        if let Some(waker) = waker {
            waker();
        }
        true
    }

    fn lock(&self) -> MutexGuard<'_, State<T>> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl<T> fmt::Debug for Completer<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Completer").finish_non_exhaustive()
    }
}

impl<T> Drop for Completer<T> {
    /// A producer dropped without completing cancels the completion, so a
    /// waiter never blocks on a result that can no longer arrive.
    fn drop(&mut self) {
        let waker = {
            let mut state = self.lock();
            let waker = match &mut *state {
                State::Pending(waker) => waker.take(),
                State::Done(_) | State::Cancelled => return,
            };
            *state = State::Cancelled;
            waker
        };
        self.inner.ready.notify_all();
        if let Some(waker) = waker {
            waker();
        }
    }
}

/// The completion was cancelled before it delivered a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Cancelled;

impl fmt::Display for Cancelled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the completion was cancelled")
    }
}

impl std::error::Error for Cancelled {}

#[cfg(test)]
#[path = "../tests/io/mod.rs"]
mod tests;
