// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Shared access to one virtio device.
//!
//! The transport and the worker hold the same [`SharedDevice`]. Control paths
//! use [`SharedDevice::try_acquire`]; the worker uses
//! [`SharedDevice::acquire`]. A guard releases the device lock before waking
//! waiters, and the contended flag and the waiter list change under one
//! mutex, so a control path that registers a waker and retries cannot lose
//! the wake even against a release by a holder that never registered.

use std::{
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError},
};

use crate::{
    io::Waker,
    virtio::{DeviceSpec, VirtioDevice},
};

/// One device shared by its transport and its worker.
pub(crate) struct SharedDevice {
    inner: Arc<DeviceCell>,
}

struct DeviceCell {
    device: Box<Mutex<dyn VirtioDevice + 'static>>,
    spec: DeviceSpec,
    waiters: Mutex<Waiters>,
}

/// The control-side waiters and whether any may still need a wake.
#[derive(Default)]
struct Waiters {
    /// Wakers of control paths whose try-acquire failed.
    wakers: Vec<Waker>,
    /// Set when a waiter registers and cleared when a release drains the
    /// list, so a release after the drain still wakes the next registrant.
    contended: bool,
}

/// Exclusive access to the device; dropping it wakes registered waiters.
pub(crate) struct DeviceGuard<'a> {
    guard: Option<MutexGuard<'a, dyn VirtioDevice + 'static>>,
    cell: &'a DeviceCell,
}

impl SharedDevice {
    /// Wraps `device`, caching its immutable spec.
    pub(crate) fn new<D: VirtioDevice + 'static>(device: D) -> Self {
        let spec = *device.spec();
        Self {
            inner: Arc::new(DeviceCell {
                device: Box::new(Mutex::new(device)),
                spec,
                waiters: Mutex::new(Waiters::default()),
            }),
        }
    }

    /// The device's immutable description.
    pub(crate) fn spec(&self) -> &DeviceSpec {
        &self.inner.spec
    }

    /// Tries to take the device without blocking.
    pub(crate) fn try_acquire(&self) -> Option<DeviceGuard<'_>> {
        match self.inner.device.try_lock() {
            Ok(guard) => Some(DeviceGuard {
                guard: Some(guard),
                cell: &self.inner,
            }),
            Err(TryLockError::WouldBlock) => None,
            Err(TryLockError::Poisoned(_)) => {
                panic!("a virtio device panicked during an earlier access")
            }
        }
    }

    /// Registers `waker`, then tries the device; the caller retries after the
    /// wake. Registering and the release drain share one lock, so whichever
    /// runs second sees the other: no release can drain an empty list and
    /// leave a registered waker asleep.
    pub(crate) fn try_acquire_or_register(&self, waker: Waker) -> Option<DeviceGuard<'_>> {
        {
            let mut waiters = self.inner.lock_waiters();
            waiters.contended = true;
            waiters.wakers.push(waker);
        }
        self.try_acquire()
    }

    /// Blocks until the device is free; the worker uses this.
    pub(crate) fn acquire(&self) -> DeviceGuard<'_> {
        let guard = self
            .inner
            .device
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        DeviceGuard {
            guard: Some(guard),
            cell: &self.inner,
        }
    }
}

impl DeviceCell {
    fn lock_waiters(&self) -> MutexGuard<'_, Waiters> {
        self.waiters.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Deref for DeviceGuard<'_> {
    type Target = dyn VirtioDevice;

    fn deref(&self) -> &Self::Target {
        self.guard
            .as_deref()
            .expect("a device guard is held until it drops")
    }
}

impl DerefMut for DeviceGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.guard
            .as_deref_mut()
            .expect("a device guard is held until it drops")
    }
}

impl Drop for DeviceGuard<'_> {
    fn drop(&mut self) {
        // The device is released first, so a woken waiter can take it.
        drop(self.guard.take());
        let wakers = {
            let mut waiters = self.cell.lock_waiters();
            if waiters.contended {
                waiters.contended = false;
                std::mem::take(&mut waiters.wakers)
            } else {
                Vec::new()
            }
        };
        for waker in wakers {
            waker();
        }
    }
}

#[cfg(test)]
#[path = "../../tests/virtio/cell.rs"]
mod tests;
