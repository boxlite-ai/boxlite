// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The split-virtqueue adapter.
//!
//! `ActivationContext::queues` is dense: one [`Queue`] per
//! `DeviceSpec::queue_max` entry, in queue-number order. The transport passes
//! every queue, including unready ones, and never filters or renumbers; a
//! device checks the readiness of the queues it needs.
//!
//! `virtio_queue::QueueState` does not carry `num_added`, so [`save`] must run
//! after quiescing the device and acting on the last notification decision.
//! [`drain`] implements the disable/drain/enable loop that prevents a lost
//! kick. A device completes a chain inline with [`Completion::Used`] or takes
//! it with [`Completion::Deferred`]: a deferred chain has already left the
//! available ring and has no used entry, and the device calls [`complete`]
//! with its head and length when its backend finishes. Quiesce must complete
//! every deferred chain and act on the returned interrupt decision before
//! [`save`] runs.

use std::{fmt, mem::size_of};

use virtio_queue::{
    DescriptorChain, Queue, QueueOwnedT, QueueState, QueueT, desc::split::Descriptor,
};
use vm_memory::{Address, Bytes, GuestAddress};

use super::DeviceError;
use crate::memory::GuestMemoryMmap;

/// `VIRTIO_F_INDIRECT_DESC`: the driver may point a chain at an indirect table.
pub(crate) const VIRTIO_F_INDIRECT_DESC: u64 = 1 << 28;
/// `VIRTIO_F_EVENT_IDX`: `used_event` and `avail_event` drive notifications.
pub(crate) const VIRTIO_F_EVENT_IDX: u64 = 1 << 29;

/// A queue the transport cannot prepare or restore.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueueError {
    /// The queue's maximum differs from the declared slot.
    MaxSize {
        /// The declared maximum.
        expected: u16,
        /// The queue's actual maximum.
        actual: u16,
    },
    /// The activation vector has the wrong number of queue slots.
    Count {
        /// The declared queue count.
        expected: usize,
        /// The actual queue count.
        actual: usize,
    },
    /// The size, address, or saved state is invalid.
    Invalid,
    /// The rings do not fit in guest memory.
    Memory,
}

impl QueueError {
    fn reason(self) -> &'static str {
        match self {
            Self::MaxSize { .. } => "virtio queue maximum size",
            Self::Count { .. } => "virtio queue count",
            Self::Invalid => "virtio queue state",
            Self::Memory => "virtio queue memory",
        }
    }
}

impl fmt::Display for QueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MaxSize { expected, actual } => {
                write!(f, "queue maximum size is {actual}, expected {expected}")
            }
            Self::Count { expected, actual } => {
                write!(f, "queue count is {actual}, expected {expected}")
            }
            Self::Invalid => f.write_str("the queue state is invalid"),
            Self::Memory => f.write_str("the queue rings are outside guest memory"),
        }
    }
}

impl std::error::Error for QueueError {}

impl From<QueueError> for DeviceError {
    fn from(error: QueueError) -> Self {
        Self::NeedsReset(error.reason())
    }
}

/// Validates every declared queue and applies the negotiated EVENT_IDX.
///
/// `queues` must hold exactly one queue per `queue_max` slot, in queue-number
/// order. Unready queues are kept after their maximum-size check; the device
/// decides whether it needs them. A ready queue must have a valid size, a
/// non-zero available ring, and rings inside `memory`.
pub(crate) fn prepare_all(
    queues: &mut [Queue],
    queue_max: &[u16],
    event_idx: bool,
    memory: &GuestMemoryMmap,
) -> Result<(), QueueError> {
    if queues.len() != queue_max.len() {
        return Err(QueueError::Count {
            expected: queue_max.len(),
            actual: queues.len(),
        });
    }
    for (queue, &max_size) in queues.iter().zip(queue_max) {
        let actual = queue.max_size();
        if actual != max_size {
            return Err(QueueError::MaxSize {
                expected: max_size,
                actual,
            });
        }
        if queue.ready() {
            let size = queue.size();
            if size == 0 || size > max_size || !size.is_power_of_two() {
                return Err(QueueError::Invalid);
            }
            if queue.avail_ring() == 0 {
                return Err(QueueError::Invalid);
            }
            if !queue.is_valid(memory) {
                return Err(QueueError::Memory);
            }
        }
    }
    for queue in queues.iter_mut() {
        queue.set_event_idx(event_idx);
    }
    Ok(())
}

/// Returns the saved state for every queue, in queue-number order.
///
/// Call after `quiesce` has completed every deferred chain and after the last
/// [`QueueT::needs_notification`] decision: `QueueState` omits `num_added`, so
/// an unresolved notification decision and an in-flight deferred chain are
/// not preserved.
pub(crate) fn save(queues: &[Queue]) -> Vec<QueueState> {
    queues.iter().map(|queue| queue.state()).collect()
}

/// Restores the dense queue vector from saved state.
///
/// The negotiated `event_idx` replaces the saved flag. A ready queue must still
/// have a non-zero available ring and pass `is_valid` against `memory`.
pub(crate) fn restore(
    states: &[QueueState],
    queue_max: &[u16],
    event_idx: bool,
    memory: &GuestMemoryMmap,
) -> Result<Vec<Queue>, QueueError> {
    if states.len() != queue_max.len() {
        return Err(QueueError::Count {
            expected: queue_max.len(),
            actual: states.len(),
        });
    }
    let mut queues = Vec::with_capacity(states.len());
    for (state, &max_size) in states.iter().zip(queue_max) {
        if state.max_size != max_size {
            return Err(QueueError::MaxSize {
                expected: max_size,
                actual: state.max_size,
            });
        }
        let mut queue = Queue::try_from(*state).map_err(|_| QueueError::Invalid)?;
        queue.set_event_idx(event_idx);
        if queue.ready() {
            if queue.avail_ring() == 0 {
                return Err(QueueError::Invalid);
            }
            if !queue.is_valid(memory) {
                return Err(QueueError::Memory);
            }
        }
        queues.push(queue);
    }
    Ok(queues)
}

/// How [`drain`] finished with one descriptor chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Completion {
    /// The chain is complete; drain adds its used entry with this length now.
    Used(u32),
    /// The device took the chain for later completion.
    ///
    /// The chain has already left the available ring and has no used entry.
    /// Consume it before returning and keep its head index and buffer metadata;
    /// the adapter retains nothing. Call [`complete`] exactly once later.
    Deferred,
}

/// Completes a chain that [`drain`] deferred.
///
/// Adds the used entry for `head` with `len` and returns whether the guest
/// should be interrupted now; the caller raises the interrupt when this
/// returns `true`. Call exactly once per deferred chain, on the queue that
/// produced it. `needs_notification` has side effects, so this decision must
/// be the last one acted on before [`save`]: a device with a deferred chain
/// still outstanding must not save.
pub(crate) fn complete(
    queue: &mut Queue,
    memory: &GuestMemoryMmap,
    head: u16,
    len: u32,
) -> Result<bool, DeviceError> {
    add_used(queue, memory, head, len)?;
    queue.needs_notification(memory).map_err(queue_error)
}

/// Adds one used entry without resolving the notification decision.
///
/// [`drain`] resolves the decision once per batch; [`complete`] resolves it
/// per deferred chain.
fn add_used(
    queue: &mut Queue,
    memory: &GuestMemoryMmap,
    head: u16,
    len: u32,
) -> Result<(), DeviceError> {
    queue.add_used(memory, head, len).map_err(queue_error)
}

/// Drains every chain the driver made available and reports whether the guest
/// should be interrupted for chains completed synchronously.
///
/// Notifications are disabled while draining; if `enable_notification` reports
/// work that arrived in the meantime, the drain repeats, so a kick cannot be
/// lost. `process` either completes a chain with [`Completion::Used`] or takes
/// it with [`Completion::Deferred`]. A deferred chain is already consumed from
/// the available ring but has no used entry; the device calls [`complete`]
/// later. The notification decision is resolved once per batch, after every
/// synchronous completion; `process` only classifies the chain, and drain
/// writes the used entry. An empty drain, or one that defers every chain,
/// returns `false`.
///
/// The drain consumes every available chain; a device that needs to stop early
/// and put a chain back (rate limiting or backpressure) must not use it.
///
/// `indirect` is the negotiated `VIRTIO_F_INDIRECT_DESC` state. When it is
/// false, a chain containing an indirect descriptor is a guest error; the
/// check runs before `process`, so deferred chains get the same rejection.
pub(crate) fn drain<'a, F>(
    queue: &mut Queue,
    memory: &'a GuestMemoryMmap,
    indirect: bool,
    mut process: F,
) -> Result<bool, DeviceError>
where
    F: FnMut(DescriptorChain<&'a GuestMemoryMmap>) -> Result<Completion, DeviceError>,
{
    let mut completed = false;
    loop {
        queue.disable_notification(memory).map_err(queue_error)?;
        let desc_table = GuestAddress(queue.desc_table());
        let size = queue.size();
        while let Some(chain) = queue.iter(memory).map_err(queue_error)?.next() {
            let head = chain.head_index();
            if !indirect && has_indirect(memory, desc_table, size, head)? {
                return Err(DeviceError::NeedsReset("indirect descriptor"));
            }
            match process(chain)? {
                Completion::Used(len) => {
                    add_used(queue, memory, head, len)?;
                    completed = true;
                }
                Completion::Deferred => {}
            }
        }
        if !queue.enable_notification(memory).map_err(queue_error)? {
            break;
        }
    }
    if completed {
        queue.needs_notification(memory).map_err(queue_error)
    } else {
        Ok(false)
    }
}

/// Returns whether the direct chain starting at `head` contains an indirect
/// descriptor.
///
/// The crate's chain iterator follows an indirect table before yielding the
/// descriptor that refers to it, so the flag is invisible to `complete`; scan
/// the raw table instead. The scan is bounded by the queue size and rejects
/// out-of-range indices and cycles.
fn has_indirect(
    memory: &GuestMemoryMmap,
    desc_table: GuestAddress,
    size: u16,
    head: u16,
) -> Result<bool, DeviceError> {
    let mut index = head;
    let mut seen = 0u16;
    while seen < size {
        if index >= size {
            return Err(DeviceError::NeedsReset("virtio descriptor"));
        }
        let addr = desc_table
            .checked_add(u64::from(index) * size_of::<Descriptor>() as u64)
            .ok_or(DeviceError::NeedsReset("virtio descriptor"))?;
        let descriptor: Descriptor = memory
            .read_obj(addr)
            .map_err(|_| DeviceError::NeedsReset("virtio descriptor"))?;
        if descriptor.refers_to_indirect_table() {
            return Ok(true);
        }
        if !descriptor.has_next() {
            return Ok(false);
        }
        index = descriptor.next();
        seen += 1;
    }
    Err(DeviceError::NeedsReset("virtio descriptor"))
}

fn queue_error(_: virtio_queue::Error) -> DeviceError {
    DeviceError::NeedsReset("virtio queue")
}
