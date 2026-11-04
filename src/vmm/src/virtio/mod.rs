// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio device contract.
//!
//! One [`VirtioDevice`] owns a device's configuration, queues and backend.
//! The transport calls configuration methods synchronously; the [`worker`]
//! runtime calls [`VirtioDevice::on_event`]. Both share
//! `Arc<Mutex<dyn VirtioDevice>>`. A queue callback admits at most one complete
//! chain. Synchronous device I/O may finish that chain before a generation stop
//! barrier returns; the bound continuation schedules any backlog after other
//! work in the current pass. A slow callback delays every device on the shared
//! thread.
//!
//! [`VirtQueues`] validates the dense queue set and tracks deferred chains.
//! Snapshots remain unsupported until M8. DRIVER_OK starts a generation and
//! Status=0 stops it before resetting device state or queue configuration.

use std::{fmt, io, sync::Arc};

use self::queue::VirtQueues;
use crate::{events::EventSender, memory::GuestMemoryMmap};

pub(crate) mod interrupt;
pub(crate) mod mmio;
pub(crate) mod queue;
pub(crate) mod worker;

/// The largest number of queues a device may declare.
pub(crate) const MAX_QUEUES: usize = 16;
/// The largest configuration space a device may declare.
pub(crate) const MAX_CONFIG_LEN: usize = 0xF00;

/// `DEVICE_NEEDS_RESET`: the device status bit a device sets when it cannot
/// continue until the driver resets it.
pub(crate) const NEEDS_RESET: u8 = 0x40;

/// A callback that wakes the workers' poller. It carries no event: a device
/// that needs a later callback registers an [`EventSource`].
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

/// What the workers ask a device to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeviceEvent {
    /// The guest notified queue `index`.
    QueueKick(u16),
    /// The source registered as this id became readable. Readiness is
    /// edge-triggered: the device reads the source until it would block.
    BackendReady(SourceId),
}

/// The id the workers give a registered background source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct SourceId(pub(crate) u32);

/// A file descriptor or similar object the workers poll.
pub(crate) trait EventSource: Send {
    /// The source the workers register with their poller.
    fn as_source(&mut self) -> &mut dyn mio::event::Source;
}

/// The interface a device uses to register background sources with the
/// workers.
///
/// A registrar belongs to one worker generation. Once Status=0 stops that
/// generation, or the workers shut down, their sources are closed and
/// `register` returns [`EventError::Closed`].
pub(crate) trait EventRegistrar: Send + Sync {
    /// Registers `source` for readability and returns its id; each readiness
    /// edge reaches the device as [`DeviceEvent::BackendReady`] with that id.
    fn register(&self, source: Box<dyn EventSource>) -> Result<SourceId, EventError>;

    /// Retires `id` and waits for an admitted delivery on another thread.
    /// A callback may retire its own source without waiting for itself.
    fn deregister(&self, id: SourceId);
}

/// The handles one worker generation gives the device it activates.
pub(crate) struct WorkerContext {
    /// Registers background sources for this generation.
    pub(crate) events: Arc<dyn EventRegistrar>,
    /// Wakes the workers' poller.
    pub(crate) waker: Waker,
}

/// Drives one device's generation in the [`worker::WorkerRuntime`]. The transport
/// calls it from a vCPU thread, never while it holds the device lock.
pub(crate) trait WorkerControl: Send + Sync {
    /// Opens a new generation for the next activation and returns its handles.
    /// Kicks and sources of an earlier generation never reach this one.
    fn prepare(&self) -> Result<WorkerContext, DeviceError>;

    /// Starts delivering the prepared generation's events. On error nothing is
    /// delivered and the generation stays prepared until
    /// [`cancel_prepare`](Self::cancel_prepare).
    fn start(&self) -> Result<(), DeviceError>;

    /// Records a notification of queue `index` and wakes the workers. Kicks of
    /// one queue that arrive before its event runs coalesce.
    fn kick(&self, index: u16);

    /// Stops admission and waits for callbacks and registrations in flight,
    /// then closes the generation's sources. It never joins the workers'
    /// thread. On error the device must not be reset.
    fn stop(&self) -> Result<(), DeviceError>;

    /// Closes a prepared generation that will not start. On error the device
    /// and its backing must remain intact until a barrier succeeds.
    fn cancel_prepare(&self) -> Result<(), DeviceError>;
}

/// The transport's interrupt and status handle, shared with the device and
/// the workers.
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

    /// Replaces the device status register while dispatch is stopped.
    fn set_device_status(&self, status: u8);

    /// Atomically sets [`NEEDS_RESET`] without clearing driver status bits.
    fn set_needs_reset(&self);
}

/// The resources a transport gives a device when the driver activates it.
pub(crate) struct ActivationContext {
    /// The guest memory the queues address.
    pub(crate) memory: Arc<GuestMemoryMmap>,
    /// The prepared queues, one slot per `DeviceSpec::queue_max` entry, in
    /// queue-number order.
    ///
    /// The transport passes every queue, including unready ones, and never
    /// filters or renumbers. The device checks [`VirtQueues::is_ready`] for the
    /// queues it needs and rejects a required-but-unready queue with
    /// [`DeviceError::NeedsReset`]. The device owns the facade after activation.
    pub(crate) queues: VirtQueues,
    /// The transport's interrupt and status handle.
    pub(crate) interrupt: Arc<dyn VirtioInterrupt>,
    /// The generation's registrar for backend sources; the device stores it.
    pub(crate) events: Arc<dyn EventRegistrar>,
    /// The workers' poller waker; the device stores it.
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

/// A device could not register a background source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventError {
    /// The registrar's generation is stopped, or the workers are shutting down.
    Closed,
    /// The host poller refused the source.
    Register(io::ErrorKind),
}

impl fmt::Display for EventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str("the worker generation is closed"),
            Self::Register(kind) => write!(f, "the poller refused the source: {kind}"),
        }
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

    /// Stores the features the driver accepted. The transport offers
    /// `VIRTIO_F_VERSION_1` itself and calls this once with the transport-owned
    /// bits removed, when the driver sets FEATURES_OK. A device may receive
    /// configuration reads before this call; feature-dependent fields return a
    /// default until then.
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
    /// registrar and waker stored from [`ActivationContext`]. The call runs on
    /// the workers' shared thread, so a callback that blocks or performs slow
    /// synchronous I/O (the balloon's `madvise`, for example) delays every
    /// other device on that thread; see the one-chain budget in [`worker`].
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
