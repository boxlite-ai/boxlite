// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio device contract.
//!
//! One [`VirtioDevice`] owns a device's configuration, queues and backend.
//! The transport calls the configuration methods synchronously; the worker
//! calls [`VirtioDevice::on_event`]. The transport and worker share the device
//! through `Arc<Mutex<dyn VirtioDevice>>`; the worker never holds the lock
//! across blocking I/O.
//!
//! A device processes the descriptors available in its queues; the virtqueue
//! size bounds one event call. The queue adapter validates, saves and restores
//! queues and runs the notification drain; queue start and stop arrive with the
//! worker. Every device needs the methods here first.

use std::{fmt, sync::Arc};

use virtio_queue::Queue;

use crate::{events::EventSender, memory::GuestMemoryMmap};

pub(crate) mod blk;
pub(crate) mod queue;

/// The largest number of queues a device may declare.
pub(crate) const MAX_QUEUES: usize = 16;
/// The largest configuration space a device may declare.
pub(crate) const MAX_CONFIG_LEN: usize = 0xF00;

/// A callback that wakes the worker's poller.
pub(crate) type Waker = Arc<dyn Fn() + Send + Sync>;

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

/// What the worker asks a device to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeviceEvent {
    /// The guest notified queue `index`.
    QueueKick(u16),
    /// A background source registered by the device is ready.
    BackendReady(SourceId),
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

/// The transport's interrupt and status handle, shared with the worker.
pub(crate) trait VirtioInterrupt: Send + Sync {
    /// Raises the queue interrupt.
    fn raise(&self);

    /// Reads the interrupt status.
    fn interrupt_status(&self) -> u8;

    /// Acknowledges the `bits` in the interrupt status.
    fn ack_interrupt(&self, bits: u8);

    /// The configuration generation.
    fn config_generation(&self) -> u8;

    /// Raises the configuration interrupt.
    fn raise_config(&self);

    /// Reads the device status register.
    fn device_status(&self) -> u8;

    /// Writes the device status register; the worker sets DEVICE_NEEDS_RESET
    /// through this handle.
    fn set_device_status(&self, status: u8);
}

/// The resources a transport gives a device when the driver activates it.
pub(crate) struct ActivationContext {
    /// The guest memory the queues address.
    pub(crate) memory: Arc<GuestMemoryMmap>,
    /// One queue per `DeviceSpec::queue_max` entry, in queue-number order.
    ///
    /// The transport passes every queue, including unready ones, and never
    /// filters or renumbers. Readiness stays inside each queue; the device
    /// rejects a required-but-unready queue with [`DeviceError::NeedsReset`].
    /// The device owns the queues after activation.
    pub(crate) queues: Vec<Queue>,
    /// The transport's interrupt and status handle.
    pub(crate) interrupt: Arc<dyn VirtioInterrupt>,
    /// The worker's event registrar for backend sources; the device stores it.
    pub(crate) events: Arc<dyn EventRegistrar>,
    /// The worker's poller waker; the device stores it.
    pub(crate) waker: Waker,
    /// The run thread's sender for fatal device failures.
    pub(crate) sender: EventSender,
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

    /// Reads the configuration space at `offset` into `data`.
    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError>;

    /// Writes the configuration space at `offset`.
    fn write_config(&mut self, offset: u64, data: &[u8]) -> Result<(), DeviceError>;

    /// Takes the queues, guest memory, interrupt and event registrar once the
    /// driver writes DRIVER_OK.
    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError>;

    /// Clears features, queues, backend and in-flight work for a driver reset.
    fn reset(&mut self) -> Result<(), DeviceError>;

    /// Handles one worker event. `Ok(())` means this call finished; it does
    /// not mean every submitted request completed. The device uses the event
    /// registrar and waker stored from [`ActivationContext`].
    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError>;

    /// Stops accepting new work and drains requests the device already took.
    fn quiesce(&mut self) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("quiesce"))
    }

    /// Returns a stable state; only valid after [`Self::quiesce`].
    fn save_state(&self) -> Result<DeviceSnapshot, SnapshotError> {
        Err(SnapshotError::Unsupported)
    }

    /// Restores a device built for this state.
    fn restore_state(
        &mut self,
        _state: DeviceSnapshot,
        _ctx: RestoreContext,
    ) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("restore_state"))
    }

    /// Re-arms notification sources after a pause or restore.
    fn resume(&mut self) -> Result<(), DeviceError> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "../../tests/virtio/mod.rs"]
mod tests;
