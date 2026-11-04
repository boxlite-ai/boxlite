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
//! Snapshots require all consumed chains to have completed; the caller stops
//! guest/worker access and pairs queue state with the same guest RAM image.

use std::{
    fmt,
    mem::size_of,
    sync::{
        Arc,
        atomic::{Ordering, fence},
    },
};

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
/// The driver's ordinary used-buffer interrupt suppression flag.
const VIRTQ_AVAIL_F_NO_INTERRUPT: u16 = 1;

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
    /// Leave this chain available and stop the drain for backpressure.
    ///
    /// The callback must not consume or modify the chain. The device resumes
    /// when capacity returns, or schedules another call if its budget ran out.
    Retry,
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
    /// Validates queue configuration, negotiated features and ring cursors
    /// against RAM from the same stopped snapshot before returning the facade.
    /// Unready slots are retained without reading their rings. The caller must
    /// supply the saved indirect feature: QueueState does not record it.
    pub(crate) fn restore(
        states: &[QueueState],
        queue_max: &[u16],
        event_idx: bool,
        indirect: bool,
        memory: Arc<GuestMemoryMmap>,
    ) -> Result<Self, SnapshotError> {
        if states.len() != queue_max.len() {
            return Err(SnapshotError::Invalid("virtio queue count"));
        }
        let queues = states
            .iter()
            .map(|state| {
                if state.event_idx_enabled != event_idx || state.next_avail != state.next_used {
                    return Err(SnapshotError::Invalid("virtio queue features or cursors"));
                }
                Queue::try_from(*state).map_err(|_| SnapshotError::Invalid("virtio queue state"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let restored = Self::prepare(queues, queue_max, event_idx, indirect, memory)
            .map_err(|error| SnapshotError::Invalid(error.reason()))?;
        for queue in &restored.queues {
            if queue.ready() {
                let avail = queue
                    .avail_idx(&*restored.memory, Ordering::Acquire)
                    .map_err(|_| SnapshotError::Invalid("virtio available ring"))?
                    .0;
                let used = queue
                    .used_idx(&*restored.memory, Ordering::Acquire)
                    .map_err(|_| SnapshotError::Invalid("virtio used ring"))?
                    .0;
                if used != queue.next_used()
                    || avail.wrapping_sub(queue.next_avail()) > queue.size()
                {
                    return Err(SnapshotError::Invalid(
                        "virtio ring cursors do not match RAM",
                    ));
                }
            }
        }
        Ok(restored)
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

    /// Returns the configured size of queue `index`, if it exists.
    pub(crate) fn size(&self, index: usize) -> Option<u16> {
        self.queues.get(index).map(|queue| queue.size())
    }

    /// Takes at most one chain for a consumer that may stop for backpressure.
    /// The head is deferred until `complete`; guest kicks remain enabled.
    /// Bound a processing turn with [`Self::size`]; schedule another turn if
    /// work remains when its budget is exhausted.
    pub(crate) fn pop(
        &mut self,
        index: usize,
    ) -> Result<Option<DescriptorChain<Arc<GuestMemoryMmap>>>, DeviceError> {
        let queue = self
            .queues
            .get_mut(index)
            .ok_or(DeviceError::NeedsReset("virtio queue"))?;
        if !queue.ready() {
            return Err(DeviceError::NeedsReset("virtio queue"));
        }
        let memory = self.memory.as_ref();
        // Enable before the iterator's avail.idx read, so an empty return
        // cannot miss a racing kick. Refresh after consumption for EVENT_IDX.
        queue.enable_notification(memory).map_err(queue_error)?;
        let Some(chain) = queue
            .iter(Arc::clone(&self.memory))
            .map_err(queue_error)?
            .next()
        else {
            return Ok(None);
        };
        let head = chain.head_index();
        if !self.indirect
            && has_indirect(memory, GuestAddress(queue.desc_table()), queue.size(), head)?
        {
            return Err(DeviceError::NeedsReset("indirect descriptor"));
        }
        defer(&mut self.deferred[index], queue.size(), head)?;
        queue.enable_notification(memory).map_err(queue_error)?;
        Ok(Some(chain))
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
    /// Returning [`Completion::Retry`] rewinds the untouched chain and ends
    /// this drain with notifications enabled. Earlier synchronous completions
    /// still contribute to the interrupt decision. Use [`Self::pop`] when the
    /// device needs to own a chain across calls.
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
        let mut retry = false;
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
                    Completion::Retry => {
                        queue.go_to_previous_position();
                        retry = true;
                        break;
                    }
                }
            }
            let available = queue.enable_notification(memory).map_err(queue_error)?;
            if retry || !available {
                break;
            }
        }
        if completed {
            needs_notification(queue, memory)
        } else {
            Ok(false)
        }
    }

    /// Completes a chain that [`Self::drain`] deferred or [`Self::pop`] took.
    ///
    /// A stopped or unready queue is rejected before any ring access. Adds the
    /// used entry for `head` with `len` and returns whether the guest should be
    /// interrupted now; the caller raises the interrupt when this returns
    /// `true`. The head must belong to a chain this queue deferred and must not
    /// have been completed already. The caller may coalesce notifications, but
    /// must retain a true decision until the interrupt has been raised.
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
        needs_notification(queue, memory)
    }

    /// Returns the saved state for every queue, in queue-number order.
    ///
    /// The caller must stop guest and worker access before capturing state.
    /// Consumed requests must all be complete; host request metadata is not
    /// represented by QueueState and cannot be silently discarded.
    pub(crate) fn save(&self) -> Result<Vec<QueueState>, SnapshotError> {
        if self.deferred.iter().any(|heads| !heads.is_empty())
            || self
                .queues
                .iter()
                .any(|queue| queue.next_avail() != queue.next_used())
        {
            return Err(SnapshotError::Busy("incomplete virtio chains"));
        }
        Ok(self.queues.iter().map(Queue::state).collect())
    }

    /// Returns the current state of queue `index`, if it exists.
    #[cfg(test)]
    pub(crate) fn state(&self, index: usize) -> Option<QueueState> {
        self.queues.get(index).map(|queue| queue.state())
    }
}

fn needs_notification(queue: &mut Queue, memory: &GuestMemoryMmap) -> Result<bool, DeviceError> {
    if queue.event_idx_enabled() {
        return queue.needs_notification(memory).map_err(queue_error);
    }
    // virtio-queue 0.18 ignores NO_INTERRUPT. Publish used entries before
    // checking the driver's ordinary split-ring suppression flag.
    fence(Ordering::SeqCst);
    let flags: u16 = memory
        .read_obj(GuestAddress(queue.avail_ring()))
        .map_err(|_| DeviceError::NeedsReset("virtio interrupt suppression"))?;
    Ok(u16::from_le(flags) & VIRTQ_AVAIL_F_NO_INTERRUPT == 0)
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
/// [`VirtQueues::drain`] resolves the decision once per batch;
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
