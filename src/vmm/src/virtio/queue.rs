// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The split-virtqueue collection facade.
//!
//! [`VirtQueues`] owns the dense queue set one device receives on activation:
//! one [`Queue`] per `DeviceSpec::queue_max` entry, in queue-number order. The
//! transport builds it with [`VirtQueues::prepare`] and passes every queue,
//! including unready ones; a device checks [`VirtQueues::is_ready`] for the
//! queues it needs.
//!
//! `prepare` also stores the guest-memory `Arc` and the negotiated
//! `VIRTIO_F_INDIRECT_DESC` flag, so [`VirtQueues::drain`] and
//! [`VirtQueues::complete`] do not take them on every call.
//!
//! A device completes a chain inline with [`Completion::Used`] or takes it with
//! [`Completion::Deferred`]: a deferred chain has already left the available
//! ring and has no used entry. The facade records its head index; the device
//! keeps the request and buffer metadata and calls [`VirtQueues::complete`] with
//! that head and the used length when its backend finishes.
//!
//! Queue snapshots are deferred to M8: [`VirtQueues::save`] and
//! [`VirtQueues::restore`] keep their signatures but return
//! [`SnapshotError::Unsupported`].

use std::{fmt, mem::size_of, sync::Arc};

use virtio_queue::{
    DescriptorChain, Queue, QueueOwnedT, QueueState, QueueT, desc::split::Descriptor,
};
use vm_memory::{Address, Bytes, GuestAddress};

use super::{DeviceError, SnapshotError};
use crate::memory::GuestMemoryMmap;

/// `VIRTIO_F_INDIRECT_DESC`: the driver may point a chain at an indirect table.
pub(crate) const VIRTIO_F_INDIRECT_DESC: u64 = 1 << 28;
/// `VIRTIO_F_EVENT_IDX`: `used_event` and `avail_event` drive notifications.
pub(crate) const VIRTIO_F_EVENT_IDX: u64 = 1 << 29;

/// The error reported for deferred-chain bookkeeping violations.
const DEFERRED_CHAIN: &str = "virtio deferred chain";

/// A queue the transport cannot prepare.
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
    /// The queue size or ring address is invalid.
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

/// How [`VirtQueues::drain`] finished with one descriptor chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Completion {
    /// The chain is complete; drain adds its used entry with this length now.
    Used(u32),
    /// The device took the chain for later completion.
    ///
    /// The chain has already left the available ring and has no used entry.
    /// Consume it before returning and keep its request and buffer metadata;
    /// the facade records the head index. Call [`VirtQueues::complete`] exactly
    /// once later, on the queue that produced the chain.
    Deferred,
}

/// The dense queue set one device receives on activation.
#[derive(Debug)]
pub(crate) struct VirtQueues {
    queues: Vec<Queue>,
    deferred: Vec<Vec<u16>>,
    memory: Arc<GuestMemoryMmap>,
    indirect: bool,
}

impl VirtQueues {
    /// Validates every declared queue and applies the negotiated features.
    ///
    /// `queues` must hold exactly one queue per `queue_max` slot, in
    /// queue-number order. Unready queues are kept after their maximum-size
    /// check; the device decides whether it needs them. A ready queue must have
    /// a valid size, a non-zero available ring, and rings inside `memory`.
    ///
    /// The facade stores `memory` and `indirect` for later calls; the Arc is
    /// shared with the activation context, so guest RAM is not copied.
    pub(crate) fn prepare(
        mut queues: Vec<Queue>,
        queue_max: &[u16],
        event_idx: bool,
        indirect: bool,
        memory: Arc<GuestMemoryMmap>,
    ) -> Result<Self, QueueError> {
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
                if !queue.is_valid(memory.as_ref()) {
                    return Err(QueueError::Memory);
                }
            }
        }
        for queue in &mut queues {
            queue.set_event_idx(event_idx);
        }
        let deferred = vec![Vec::new(); queues.len()];
        Ok(Self {
            queues,
            deferred,
            memory,
            indirect,
        })
    }

    /// Restores the dense queue vector from saved state.
    ///
    /// Queue snapshots are deferred to M8, so this always returns
    /// [`SnapshotError::Unsupported`]. The parameters keep the signature the
    /// snapshot implementation will use.
    pub(crate) fn restore(
        _states: &[QueueState],
        _queue_max: &[u16],
        _event_idx: bool,
        _indirect: bool,
        _memory: Arc<GuestMemoryMmap>,
    ) -> Result<Self, SnapshotError> {
        Err(SnapshotError::Unsupported)
    }

    /// Returns the number of declared queue slots.
    pub(crate) fn len(&self) -> usize {
        self.queues.len()
    }

    /// Returns whether queue `index` is ready, or false when `index` is out of
    /// range.
    pub(crate) fn is_ready(&self, index: usize) -> bool {
        self.queues.get(index).is_some_and(|queue| queue.ready())
    }

    /// Returns the declared maximum size of queue `index`, if it exists.
    pub(crate) fn max_size(&self, index: usize) -> Option<u16> {
        self.queues.get(index).map(|queue| queue.max_size())
    }

    /// The control areas of every ready queue, including event fields even
    /// without EVENT_IDX. Devices snapshot these before destructive I/O.
    pub(crate) fn control_ranges(&self) -> impl Iterator<Item = (GuestAddress, usize)> + '_ {
        self.queues
            .iter()
            .filter(|queue| queue.ready())
            .flat_map(|queue| {
                let size = usize::from(queue.size());
                [
                    (GuestAddress(queue.desc_table()), 16 * size),
                    (GuestAddress(queue.avail_ring()), 6 + 2 * size),
                    (GuestAddress(queue.used_ring()), 6 + 8 * size),
                ]
            })
    }

    /// Drains every chain the driver made available and reports whether the
    /// guest should be interrupted for chains completed synchronously.
    ///
    /// A stopped or unready queue is rejected before any ring access.
    /// Notifications are disabled while draining; if `enable_notification`
    /// reports work that arrived in the meantime, the drain repeats, so a kick
    /// cannot be lost. `process` either completes a chain with
    /// [`Completion::Used`] or takes it with [`Completion::Deferred`]. A
    /// deferred chain is already consumed from the available ring but has no
    /// used entry; the facade records its head for [`Self::complete`]. The
    /// notification decision is resolved once per batch, after every synchronous
    /// completion; `process` only classifies the chain, and drain writes the
    /// used entry. An empty drain, or one that defers every chain, returns
    /// `false`.
    ///
    /// The drain consumes every available chain; a device that needs to stop
    /// early and put a chain back (rate limiting or backpressure) must not use
    /// it. A slow callback therefore delays every device sharing the worker
    /// thread for as long as the driver keeps refilling the ring.
    ///
    /// The stored `indirect` flag is the negotiated `VIRTIO_F_INDIRECT_DESC`
    /// state. When it is false, a chain containing an indirect descriptor is a
    /// guest error; the check runs before `process`, so deferred chains get the
    /// same rejection.
    pub(crate) fn drain<F>(&mut self, index: usize, mut process: F) -> Result<bool, DeviceError>
    where
        F: for<'a> FnMut(DescriptorChain<&'a GuestMemoryMmap>) -> Result<Completion, DeviceError>,
    {
        let Self {
            queues,
            deferred,
            memory,
            indirect,
        } = self;
        let memory = memory.as_ref();
        let queue = queues
            .get_mut(index)
            .ok_or(DeviceError::NeedsReset("virtio queue"))?;
        if !queue.ready() {
            return Err(DeviceError::NeedsReset("virtio queue"));
        }
        let deferred = deferred
            .get_mut(index)
            .ok_or(DeviceError::NeedsReset("virtio queue"))?;

        let mut completed = false;
        loop {
            queue.disable_notification(memory).map_err(queue_error)?;
            let desc_table = GuestAddress(queue.desc_table());
            let size = queue.size();
            while let Some(chain) = queue.iter(memory).map_err(queue_error)?.next() {
                let head = chain.head_index();
                if !*indirect && has_indirect(memory, desc_table, size, head)? {
                    return Err(DeviceError::NeedsReset("indirect descriptor"));
                }
                match process(chain)? {
                    Completion::Used(len) => {
                        add_used(queue, memory, head, len)?;
                        completed = true;
                    }
                    Completion::Deferred => defer(deferred, size, head)?,
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

    /// Completes a chain that [`Self::drain`] deferred.
    ///
    /// A stopped or unready queue is rejected before any ring access. Adds the
    /// used entry for `head` with `len` and returns whether the guest should be
    /// interrupted now; the caller raises the interrupt when this returns
    /// `true`. The head must belong to a chain this queue deferred and must not
    /// have been completed already. `needs_notification` has side effects, so
    /// the caller must act on this decision immediately.
    pub(crate) fn complete(
        &mut self,
        index: usize,
        head: u16,
        len: u32,
    ) -> Result<bool, DeviceError> {
        let Self {
            queues,
            deferred,
            memory,
            ..
        } = self;
        let memory = memory.as_ref();
        let queue = queues
            .get_mut(index)
            .ok_or(DeviceError::NeedsReset("virtio queue"))?;
        if !queue.ready() || head >= queue.size() {
            return Err(DeviceError::NeedsReset("virtio queue"));
        }
        let deferred = deferred
            .get_mut(index)
            .ok_or(DeviceError::NeedsReset("virtio queue"))?;
        let position = deferred
            .iter()
            .position(|&candidate| candidate == head)
            .ok_or(DeviceError::NeedsReset(DEFERRED_CHAIN))?;
        add_used(queue, memory, head, len)?;
        deferred.remove(position);
        queue.needs_notification(memory).map_err(queue_error)
    }

    /// Returns the saved state for every queue, in queue-number order.
    ///
    /// Queue snapshots are deferred to M8, so this always returns
    /// [`SnapshotError::Unsupported`]. Deferred-head tracking stays, so a later
    /// implementation can reject an outstanding chain.
    pub(crate) fn save(&self) -> Result<Vec<QueueState>, SnapshotError> {
        Err(SnapshotError::Unsupported)
    }

    /// Returns the current state of queue `index`, if it exists.
    #[cfg(test)]
    pub(crate) fn state(&self, index: usize) -> Option<QueueState> {
        self.queues.get(index).map(|queue| queue.state())
    }
}

fn defer(deferred: &mut Vec<u16>, size: u16, head: u16) -> Result<(), DeviceError> {
    if head >= size || deferred.contains(&head) {
        return Err(DeviceError::NeedsReset(DEFERRED_CHAIN));
    }
    deferred.push(head);
    Ok(())
}

/// Adds one used entry without resolving the notification decision.
///
/// [`VirtQueues::drain`] resolves the decision for its single admitted chain;
/// [`VirtQueues::complete`] resolves it per deferred chain.
fn add_used(
    queue: &mut Queue,
    memory: &GuestMemoryMmap,
    head: u16,
    len: u32,
) -> Result<(), DeviceError> {
    queue.add_used(memory, head, len).map_err(queue_error)
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
