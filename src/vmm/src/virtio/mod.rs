// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio device contract.
//!
//! One [`VirtioDevice`] owns a device's configuration, queues and backend.
//! The transport calls the control methods; the worker calls
//! [`VirtioDevice::on_event`]. A control method returns a [`DeviceOp`] so a
//! slow operation can finish after the caller releases the device lock.
//!
//! Queue start and stop and the snapshot payload arrive with later slices;
//! every device needs the methods here first.

use std::fmt;

use crate::io::{Completer, Completion, ConfigBytes, Waker};

pub(crate) mod control;

/// The largest number of queues a device may declare.
pub(crate) const MAX_QUEUES: usize = 16;
/// The largest configuration space a device may declare.
pub(crate) const MAX_CONFIG_LEN: usize = 0xF00;

/// What a device offers, fixed when it is built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DeviceSpec {
    /// The virtio device type reported to the guest.
    pub(crate) device_id: u32,
    /// A short name for logs and errors.
    pub(crate) name: &'static str,
    /// The feature bits the device supports.
    pub(crate) features: u64,
    /// The length of the device configuration space.
    pub(crate) config_len: usize,
    /// The maximum size of each queue, indexed by queue number.
    pub(crate) queue_max: &'static [u16],
    /// Whether the host can save the device.
    pub(crate) snapshot: SnapshotSupport,
}

/// Host snapshot capability, not a guest virtio feature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SnapshotSupport {
    /// The device cannot be saved.
    Unsupported,
    /// The device can be saved after it is quiesced.
    Stopped,
}

/// A control operation that finishes now or after the caller releases the
/// device lock.
#[derive(Debug)]
pub(crate) enum DeviceOp<T> {
    /// The operation finished.
    Ready(Result<T, DeviceError>),
    /// The device finishes the operation through its completion.
    Pending(Completion<T>),
}

/// What the worker asks a device to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeviceEvent {
    /// The guest notified queue `index`.
    QueueKick(u16),
    /// A background source registered by the device is ready.
    BackendReady(SourceId),
    /// The device asked to be called again after its budget ran out.
    Continue,
}

/// The identity of a background event source registered with the worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct SourceId(pub(crate) u32);

/// A file descriptor or similar object the worker polls.
pub(crate) trait EventSource: Send {
    /// The source the worker registers with its poller.
    fn as_source(&mut self) -> &mut dyn mio::event::Source;
}

/// The worker interface a device uses to register background sources.
pub(crate) trait EventRegistrar: Send + Sync {
    /// Registers `source`, which is reported as `event`.
    fn register(
        &self,
        event: DeviceEvent,
        source: Box<dyn EventSource>,
    ) -> Result<SourceId, EventError>;

    /// Stops reporting `id`.
    fn deregister(&self, id: SourceId);
}

/// How much work a device may do in one worker call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Budget {
    remaining: usize,
}

impl Budget {
    /// A budget of `remaining` work units.
    pub(crate) fn new(remaining: usize) -> Self {
        Self { remaining }
    }

    /// Takes `work` units; returns `false` and leaves the budget at zero when
    /// there is not enough left.
    pub(crate) fn consume(&mut self, work: usize) -> bool {
        if self.remaining >= work {
            self.remaining -= work;
            true
        } else {
            self.remaining = 0;
            false
        }
    }

    /// The units left.
    pub(crate) fn remaining(&self) -> usize {
        self.remaining
    }
}

/// Per-event state the worker gives a device.
pub(crate) struct EventContext<'a> {
    registrar: &'a dyn EventRegistrar,
    budget: Budget,
    control: Waker,
    rescheduled: bool,
}

impl<'a> EventContext<'a> {
    /// A context with `budget` work units and the control waker.
    pub(crate) fn new(registrar: &'a dyn EventRegistrar, budget: usize, control: Waker) -> Self {
        Self {
            registrar,
            budget: Budget::new(budget),
            control,
            rescheduled: false,
        }
    }

    /// Registers a background source with the worker.
    pub(crate) fn register(
        &self,
        event: DeviceEvent,
        source: Box<dyn EventSource>,
    ) -> Result<SourceId, EventError> {
        self.registrar.register(event, source)
    }

    /// Stops reporting a background source.
    pub(crate) fn deregister(&self, id: SourceId) {
        self.registrar.deregister(id);
    }

    /// Takes `work` units from the budget.
    pub(crate) fn consume(&mut self, work: usize) -> bool {
        self.budget.consume(work)
    }

    /// Whether the budget is exhausted.
    pub(crate) fn exhausted(&self) -> bool {
        self.budget.remaining() == 0
    }

    /// Asks the worker to call the device again after this event.
    pub(crate) fn reschedule(&mut self) {
        self.rescheduled = true;
    }

    /// Whether the device asked for another call.
    pub(crate) fn rescheduled(&self) -> bool {
        self.rescheduled
    }

    /// The waker for the run thread's control queue.
    pub(crate) fn control(&self) -> &Waker {
        &self.control
    }
}

/// A single pending control operation owned by a device.
pub(crate) struct PendingControl<T> {
    slot: Option<Completer<T>>,
}

impl<T> PendingControl<T> {
    /// An empty slot.
    pub(crate) const fn new() -> Self {
        Self { slot: None }
    }

    /// Stores `completer`; returns `false` if another operation is pending.
    pub(crate) fn begin(&mut self, completer: Completer<T>) -> bool {
        if self.slot.is_some() {
            false
        } else {
            self.slot = Some(completer);
            true
        }
    }

    /// Whether an operation is pending.
    pub(crate) fn is_pending(&self) -> bool {
        self.slot.is_some()
    }

    /// Completes the pending operation; returns `false` if none is pending.
    pub(crate) fn complete(&mut self, value: T) -> bool {
        self.slot
            .take()
            .is_some_and(|completer| completer.complete(value))
    }

    /// Cancels the pending operation; returns `false` if none is pending.
    pub(crate) fn cancel(&mut self) -> bool {
        self.slot.take().is_some_and(Completer::cancel)
    }
}

impl<T> fmt::Debug for PendingControl<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingControl")
            .field("pending", &self.is_pending())
            .finish()
    }
}

/// The negotiated features are not a subset of the device features.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FeatureError {
    /// The bits the device does not support.
    pub(crate) unsupported: u64,
}

impl fmt::Display for FeatureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unsupported feature bits {:#x}", self.unsupported)
    }
}

impl std::error::Error for FeatureError {}

/// A device failure, classified for the transport.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeviceError {
    /// The operation is not implemented.
    Unsupported(&'static str),
    /// The device cannot continue; the guest must reset it.
    NeedsReset(&'static str),
    /// The device cannot continue and the VM must stop.
    Fatal(&'static str),
}

impl fmt::Display for DeviceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(what) => write!(f, "{what} is not supported"),
            Self::NeedsReset(what) => write!(f, "{what} requires a device reset"),
            Self::Fatal(what) => write!(f, "{what} failed"),
        }
    }
}

impl std::error::Error for DeviceError {}

/// A snapshot encoding failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SnapshotError {
    /// The device does not support snapshots.
    Unsupported,
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the device does not support snapshots")
    }
}

impl std::error::Error for SnapshotError {}

/// A device could not register or deregister a background source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventError {
    /// The worker is shutting down.
    Closed,
}

impl fmt::Display for EventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the event worker is closed")
    }
}

impl std::error::Error for EventError {}

/// A self-owned, versioned device state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeviceSnapshot {
    /// The state format identifier.
    pub(crate) format: u32,
    /// The state version within `format`.
    pub(crate) version: u32,
    /// The device-private payload.
    pub(crate) payload: Vec<u8>,
}

/// The resources a restored device receives from the transport.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RestoreContext;

/// One virtio device.
pub(crate) trait VirtioDevice: Send {
    /// The device's fixed description.
    fn spec(&self) -> &DeviceSpec;

    /// Stores the features the driver accepted. The transport calls this once,
    /// before any configuration read that depends on them.
    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError>;

    /// Reads `len` bytes of the configuration space at `offset`.
    fn read_config(&mut self, offset: u64, len: usize) -> DeviceOp<ConfigBytes>;

    /// Writes the configuration space at `offset`.
    fn write_config(&mut self, offset: u64, value: ConfigBytes) -> DeviceOp<()>;

    /// Handles one worker event. `Ok(())` means this call finished; it does
    /// not mean every submitted request completed.
    fn on_event(
        &mut self,
        event: DeviceEvent,
        cx: &mut EventContext<'_>,
    ) -> Result<(), DeviceError>;

    /// Stops accepting new work and drains requests the device already took.
    fn quiesce(&mut self) -> DeviceOp<()> {
        DeviceOp::Ready(Err(DeviceError::Unsupported("quiesce")))
    }

    /// Returns a stable state; only valid after [`Self::quiesce`].
    fn save_state(&self) -> Result<DeviceSnapshot, SnapshotError> {
        Err(SnapshotError::Unsupported)
    }

    /// Restores a device built for this state.
    fn restore_state(&mut self, _state: DeviceSnapshot, _ctx: RestoreContext) -> DeviceOp<()> {
        DeviceOp::Ready(Err(DeviceError::Unsupported("restore_state")))
    }

    /// Re-arms notification sources after a pause or restore.
    fn resume(&mut self) -> DeviceOp<()> {
        DeviceOp::Ready(Ok(()))
    }
}

#[cfg(test)]
#[path = "../../tests/virtio/mod.rs"]
mod tests;
