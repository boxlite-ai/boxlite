// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Changing how many vCPUs may run while the VM runs.
//!
//! A [`VcpuControl`] queues a request and wakes the VM's event loop; the
//! thread inside [`Vm::run`](crate::Vm::run) serves it, because only that
//! thread can start vCPU threads in the run's scope.

use std::sync::{Mutex, PoisonError, mpsc};

use crate::{
    error::{Error, Result},
    events::EventSender,
};

/// One request to let `count` vCPUs run, and where its answer goes.
#[cfg_attr(
    not(target_arch = "x86_64"),
    expect(
        dead_code,
        reason = "Only the x86_64 Vm::run serves vCPU control requests yet."
    )
)]
pub(crate) struct Request {
    pub(crate) count: u8,
    pub(crate) reply: mpsc::SyncSender<Result<u8>>,
}

/// Where requests wait for [`Vm::run`](crate::Vm::run). Dropping the
/// receiver once the run ends answers every waiting caller.
pub(crate) struct Requests {
    sender: mpsc::Sender<Request>,
    #[cfg_attr(
        not(target_arch = "x86_64"),
        expect(
            dead_code,
            reason = "Only the x86_64 Vm::run serves vCPU control requests yet."
        )
    )]
    receiver: Mutex<Option<mpsc::Receiver<Request>>>,
}

impl Requests {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        Self {
            sender,
            receiver: Mutex::new(Some(receiver)),
        }
    }

    /// The next waiting request, if the run still serves them.
    #[cfg_attr(
        not(target_arch = "x86_64"),
        expect(
            dead_code,
            reason = "Only the x86_64 Vm::run serves vCPU control requests yet."
        )
    )]
    pub(crate) fn try_next(&self) -> Option<Request> {
        let receiver = self.receiver.lock().unwrap_or_else(PoisonError::into_inner);
        receiver.as_ref()?.try_recv().ok()
    }

    /// Stops serving: waiting and later callers get [`Error::VmNotRunning`].
    #[cfg_attr(
        not(target_arch = "x86_64"),
        expect(
            dead_code,
            reason = "Only the x86_64 Vm::run serves vCPU control requests yet."
        )
    )]
    pub(crate) fn close(&self) {
        *self.receiver.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

/// Changes how many vCPUs may run, from any thread.
///
/// The guest still decides which CPUs it uses: grow the count before the
/// guest onlines CPUs, and shrink it only after the guest offlined them.
#[derive(Clone, Debug)]
pub struct VcpuControl {
    requests: mpsc::Sender<Request>,
    events: EventSender,
    max_vcpus: u8,
}

impl VcpuControl {
    pub(crate) fn new(requests: &Requests, events: EventSender, max_vcpus: u8) -> Self {
        Self {
            requests: requests.sender.clone(),
            events,
            max_vcpus,
        }
    }

    /// Lets exactly `count` vCPUs run, the lowest IDs, and returns the count
    /// once every grant and revoke is done.
    ///
    /// A grant resets a parked vCPU and starts its thread; a revoke parks a
    /// running one and ends its thread. A CPU the guest still uses is parked
    /// anyway, so only the guest stalls. The call waits until
    /// [`Vm::run`](crate::Vm::run) serves it, and fails with
    /// [`Error::InvalidVcpuCount`] outside `1..=max_vcpus` or with
    /// [`Error::VmNotRunning`] once the VM has ended.
    pub fn set_online_vcpus(&self, count: u8) -> Result<u8> {
        if !(1..=self.max_vcpus).contains(&count) {
            return Err(Error::InvalidVcpuCount(count));
        }
        let (reply, answer) = mpsc::sync_channel(1);
        self.requests
            .send(Request { count, reply })
            .map_err(|_| Error::VmNotRunning)?;
        self.events.wake();
        answer.recv().map_err(|_| Error::VmNotRunning)?
    }
}
