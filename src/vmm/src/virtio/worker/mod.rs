// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio workers: the runtime that delivers every device's events.
//!
//! A VM's [`VirtioWorkers`] serves every virtio device. A transport sees only
//! the [`WorkerControl`] handle [`VirtioWorkers::add`] returns, which forwards
//! to a [`WorkerRuntime`]. The one runtime is [`SharedRuntime`]: one poller and
//! one thread for every device, as Firecracker and libkrun run their devices.
//! A slow `on_event` therefore delays every other device. A per-device runtime
//! can replace it behind the same trait without changing the transport, the
//! devices or `Vm`.

use std::{
    io,
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
    /// device ends the VM within seconds.
    pub(crate) const DEFAULT: Self = Self {
        stop: Duration::from_secs(5),
        shutdown: Duration::from_secs(5),
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
    /// threads. Nothing opens afterwards. A call after a success does nothing;
    /// a call after a failure retries the join.
    fn shutdown(&self) -> io::Result<()>;
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
    pub(crate) fn shutdown(&self) -> crate::error::Result<()> {
        self.runtime.shutdown().map_err(Error::VirtioWorker)
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
