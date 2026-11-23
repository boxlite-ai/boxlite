// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio workers: the runtime that delivers every device's events.
//!
//! A worker is one device's slot: its generation, its kicks and its sources.
//! Threads are the runtime's choice, not the worker's. A VM's
//! [`VirtioWorkers`] holds every device's worker. A transport sees only the
//! [`WorkerControl`] handle [`VirtioWorkers::add`] returns, which forwards to
//! a [`WorkerRuntime`]. The one runtime is [`SharedRuntime`]: one poller and
//! one `virtio-worker` thread run every worker, as Firecracker and libkrun run
//! their devices. A slow `on_event` therefore delays every other device. A
//! per-device runtime can replace it behind the same trait without changing
//! the transport, the devices or `Vm`.

use std::{
    fmt, io,
    sync::{Arc, Mutex},
    time::Duration,
};

use super::{DeviceError, VirtioDevice, VirtioInterrupt, WorkerContext, WorkerControl};
use crate::{error::Error, events::EventSender};

mod shared;

pub(crate) use self::shared::SharedRuntime;

/// One device's place in a runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SlotId(pub(crate) u32);

/// Whether shutdown failed before or after every device callback stopped.
#[derive(Debug)]
pub(crate) enum ShutdownError {
    /// A worker may still access guest RAM; joining can be retried.
    Join(io::Error),
    /// All workers joined, but a device's final cleanup failed.
    Quiesce {
        device: &'static str,
        reason: &'static str,
    },
}

impl fmt::Display for ShutdownError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Join(error) => write!(f, "joining virtio workers: {error}"),
            Self::Quiesce { device, reason } => write!(f, "quiescing {device}: {reason}"),
        }
    }
}

impl From<ShutdownError> for Error {
    fn from(error: ShutdownError) -> Self {
        match error {
            ShutdownError::Join(error) => Self::VirtioWorker(error),
            ShutdownError::Quiesce { device, reason } => Self::VirtioDevice { device, reason },
        }
    }
}

/// How long the workers wait for an event in flight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Timeouts {
    /// How long `stop` waits before it fails the device.
    pub(crate) stop: Duration,
    /// How long `shutdown` waits for the worker thread to exit.
    pub(crate) shutdown: Duration,
}

impl Timeouts {
    /// Long enough for a slow synchronous request, short enough that a stuck
    /// device still ends the VM within minutes.
    pub(crate) const DEFAULT: Self = Self {
        stop: Duration::from_secs(300),
        shutdown: Duration::from_secs(300),
    };
}

/// A runtime that delivers device events; [`WorkerControl`] describes each
/// per-slot operation.
pub(crate) trait WorkerRuntime: Send + Sync {
    /// Adds a stopped device.
    fn add(
        &self,
        name: &'static str,
        device: Arc<Mutex<dyn VirtioDevice>>,
        interrupt: Arc<dyn VirtioInterrupt>,
    ) -> SlotId;

    /// [`WorkerControl::prepare`] for `slot`.
    fn prepare(&self, slot: SlotId) -> Result<WorkerContext, DeviceError>;

    /// [`WorkerControl::start`] for `slot`.
    fn start(&self, slot: SlotId) -> Result<(), DeviceError>;

    /// [`WorkerControl::kick`] for `slot`.
    fn kick(&self, slot: SlotId, index: u16);

    /// [`WorkerControl::stop`] for `slot`.
    fn stop(&self, slot: SlotId) -> Result<(), DeviceError>;

    /// [`WorkerControl::cancel_prepare`] for `slot`.
    fn cancel_prepare(&self, slot: SlotId);

    /// Stops delivering events, closes every source and joins the runtime's
    /// threads, then quiesces every device while RAM is still registered. The
    /// caller must first stop vCPUs. Nothing opens afterwards. Join failure
    /// retries on the next call; quiesce failures are cached without retrying
    /// hooks. A quiesce failure still permits RAM unmapping.
    fn shutdown(&self) -> Result<(), ShutdownError>;
}

/// The virtio workers of one VM.
pub(crate) struct VirtioWorkers {
    runtime: Arc<dyn WorkerRuntime>,
}

impl VirtioWorkers {
    /// The workers of one VM on a [`SharedRuntime`] that ends the VM through
    /// `sender` when a device or the runtime fails. No thread starts until a
    /// device does.
    pub(crate) fn new(sender: EventSender) -> io::Result<Self> {
        let runtime = SharedRuntime::new(sender, Timeouts::DEFAULT)?;
        Ok(Self::with_runtime(Arc::new(runtime)))
    }

    /// The workers of one VM on `runtime`.
    pub(crate) fn with_runtime(runtime: Arc<dyn WorkerRuntime>) -> Self {
        Self { runtime }
    }

    /// Adds `device`, which raises `interrupt`, and returns the handle its
    /// transport drives.
    pub(crate) fn add(
        &self,
        device: Arc<Mutex<dyn VirtioDevice>>,
        interrupt: Arc<dyn VirtioInterrupt>,
    ) -> Arc<dyn WorkerControl> {
        let name = device
            .lock()
            .expect("a virtio device lock is poisoned")
            .spec()
            .name;
        let slot = self.runtime.add(name, device, interrupt);
        Arc::new(DeviceHandle {
            runtime: Arc::clone(&self.runtime),
            slot,
        })
    }

    /// Stops every device and joins the worker thread; see
    /// [`WorkerRuntime::shutdown`].
    pub(crate) fn shutdown(&self) -> Result<(), ShutdownError> {
        self.runtime.shutdown()
    }
}

/// The [`WorkerControl`] a transport holds: its device's slot in the runtime.
struct DeviceHandle {
    runtime: Arc<dyn WorkerRuntime>,
    slot: SlotId,
}

impl WorkerControl for DeviceHandle {
    fn prepare(&self) -> Result<WorkerContext, DeviceError> {
        self.runtime.prepare(self.slot)
    }

    fn start(&self) -> Result<(), DeviceError> {
        self.runtime.start(self.slot)
    }

    fn kick(&self, index: u16) {
        self.runtime.kick(self.slot, index);
    }

    fn stop(&self) -> Result<(), DeviceError> {
        self.runtime.stop(self.slot)
    }

    fn cancel_prepare(&self) {
        self.runtime.cancel_prepare(self.slot);
    }
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../../../tests/virtio/worker.rs"]
mod tests;
