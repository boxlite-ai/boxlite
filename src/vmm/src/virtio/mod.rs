// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio device contract.
//!
//! One [`VirtioDevice`] owns a device's configuration, queues and backend.
//! The transport calls configuration methods synchronously; the shared worker
//! calls [`VirtioDevice::on_event`]. Both share `Arc<Mutex<dyn VirtioDevice>>`.
//! A queue callback admits at most one complete chain. Synchronous device I/O
//! may finish that chain before a generation stop barrier returns; the bound
//! continuation schedules any backlog after other work in the current pass.
//!
//! [`VirtQueues`] validates the dense queue set and tracks deferred chains.
//! Snapshots remain unsupported until M8. DRIVER_OK starts a generation and
//! Status=0 stops it before resetting device state or queue configuration.

use std::{fmt, sync::Arc};

use self::queue::VirtQueues;
use crate::{events::EventSender, memory::GuestMemoryMmap};

pub(crate) mod executor;
pub(crate) mod interrupt;
pub(crate) mod mmio;
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
    /// Registers `source`, reported as `BackendReady` with the returned ID.
    fn register(&self, source: Box<dyn EventSource>) -> Result<SourceId, EventError>;

    /// Retires `id` and waits for an admitted delivery on another thread.
    /// A callback may retire its own source without waiting for itself.
    fn deregister(&self, id: SourceId);
}

/// Resources bound to one prepared worker generation.
pub(crate) struct WorkerContext {
    pub(crate) events: Arc<dyn EventRegistrar>,
    pub(crate) waker: Waker,
    /// Requeues backlog only while this generation is running.
    pub(crate) requeue: Arc<dyn Fn(u16) + Send + Sync>,
}

/// Controls one device generation independently of the runtime's thread model.
pub(crate) trait WorkerControl: Send + Sync {
    /// Opens a fresh generation before device activation.
    fn prepare(&self) -> Result<WorkerContext, DeviceError>;

    /// Starts dispatch after activation. On error no dispatch can begin.
    fn start(&self) -> Result<(), DeviceError>;

    /// Coalesces a notification while retaining its queue number.
    fn kick(&self, index: u16);

    /// Prevents dispatch and waits for in-flight calls before closing sources.
    /// On error the device must not be reset. This never joins a shared thread.
    fn stop(&self) -> Result<(), DeviceError>;

    /// Closes sources from an activation that never started.
    fn cancel_prepare(&self) -> Result<(), DeviceError>;
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

    /// Replaces the device status while dispatch is stopped, for negotiation
    /// and reset. Concurrent cumulative updates use [`Self::add_device_status`].
    fn set_device_status(&self, status: u8);

    /// Atomically adds bits without losing concurrent driver or worker updates.
    fn add_device_status(&self, bits: u8);
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
    /// The worker's event registrar for backend sources; the device stores it.
    pub(crate) events: Arc<dyn EventRegistrar>,
    /// The worker's poller waker; the device stores it.
    #[cfg_attr(
        test,
        expect(
            dead_code,
            reason = "Reporting completes synchronously; backend devices use this wake handle."
        )
    )]
    pub(crate) waker: Waker,
    /// The run thread's sender for fatal device failures.
    #[cfg_attr(
        test,
        expect(
            dead_code,
            reason = "The reporting callback returns failures to its executor."
        )
    )]
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
#[derive(Debug)]
pub(crate) enum EventError {
    /// The worker is shutting down.
    Closed,
    /// Registering the backend source with the host poller failed.
    Io(std::io::Error),
}

impl fmt::Display for EventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str("the event worker is closed"),
            Self::Io(error) => write!(f, "registering a backend event source: {error}"),
        }
    }
}

impl std::error::Error for EventError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Closed => None,
        }
    }
}

/// A self-owned, versioned device state.
#[cfg_attr(
    all(test, target_arch = "x86_64"),
    expect(dead_code, reason = "Device snapshots remain unsupported until M8.")
)]
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
#[cfg_attr(
    all(test, target_arch = "x86_64"),
    expect(dead_code, reason = "Device restore remains unsupported until M8.")
)]
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
    /// registrar and waker stored from [`ActivationContext`].
    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError>;

    /// Stops accepting new work and drains requests the device already took.
    #[cfg_attr(
        test,
        expect(
            dead_code,
            reason = "The existing pause contract has no transport consumer yet."
        )
    )]
    fn quiesce(&mut self) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("quiesce"))
    }

    /// Returns a stable state; only valid after [`Self::quiesce`].
    #[cfg_attr(
        test,
        expect(dead_code, reason = "Device snapshots remain unsupported until M8.")
    )]
    fn save_state(&self) -> Result<DeviceSnapshot, SnapshotError> {
        Err(SnapshotError::Unsupported)
    }

    /// Restores a device built for this state.
    #[cfg_attr(
        test,
        expect(dead_code, reason = "Device restore remains unsupported until M8.")
    )]
    fn restore_state(
        &mut self,
        _state: DeviceSnapshot,
        _ctx: RestoreContext,
    ) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("restore_state"))
    }

    /// Re-arms notification sources after a pause or restore.
    #[cfg_attr(
        test,
        expect(
            dead_code,
            reason = "The existing resume contract has no transport consumer yet."
        )
    )]
    fn resume(&mut self) -> Result<(), DeviceError> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "../../tests/virtio/mod.rs"]
mod tests;
