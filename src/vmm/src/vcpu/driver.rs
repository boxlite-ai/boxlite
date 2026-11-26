// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    io::ErrorKind,
    mem,
    panic::{self, AssertUnwindSafe},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, Builder, Scope, ScopedJoinHandle},
    time::{Duration, Instant},
};

use boxlite_hypervisor::{VcpuHandle, X86Vm};

use super::{Detached, Kick, Startup, WorkerOutput, Workers};
use crate::{
    ControlReason, Error, Result,
    control::{CPU_RESIZE, CpuRequest, CpuRequests},
    events::{Event, RECHECK},
    lifecycle::VmStatus,
};

const WORKER_DEADLINE: Duration = Duration::from_secs(5);
const KICK_RETRY: Duration = Duration::from_millis(10);

enum Slot<'scope, H: X86Vm> {
    Detached(Detached<H>),
    Attached(Worker<'scope, H>),
    Unavailable,
}

struct Worker<'scope, H: X86Vm> {
    thread: ScopedJoinHandle<'scope, WorkerOutput<H>>,
    ready: Option<Receiver<Kick<H>>>,
    kick: Option<Kick<H>>,
    retire: Arc<AtomicBool>,
}

impl<H: X86Vm> Worker<'_, H> {
    fn register_kick(&mut self) {
        if let Some(ready) = &self.ready
            && let Ok(kick) = ready.try_recv()
        {
            self.kick = Some(kick);
            self.ready = None;
        }
    }

    fn join(self, id: u8) -> Result<WorkerOutput<H>> {
        self.thread
            .join()
            .map_err(|_| Error::VcpuPanicked { vcpu: id.into() })
    }
}

struct Resize {
    request: CpuRequest,
    original: u64,
    grant_failure: Option<Error>,
}

struct Transfer<'scope, H: X86Vm> {
    id: u8,
    worker: Worker<'scope, H>,
    kind: TransferKind,
    started: Instant,
}

enum TransferKind {
    Grant(Option<SyncSender<()>>),
    Revoke { kick_pending: bool },
}

impl<H: X86Vm> Transfer<'_, H> {
    fn cancel(&mut self) {
        if let TransferKind::Grant(authorize) = &mut self.kind {
            authorize.take();
        }
    }
}

/// Owns the workers and CPU transfers on the VM run thread.
pub(crate) struct VcpuRun<'scope, 'env: 'scope, H: X86Vm> {
    vcpus: &'env Workers<'env, H>,
    slots: Vec<Slot<'scope, H>>,
    requests: Option<CpuRequests>,
    next_request: Option<CpuRequest>,
    active: Option<Resize>,
    transfer: Option<Transfer<'scope, H>>,
    boot_kicked: u64,
    pending_pause_kicks: u64,
}

impl<'scope, 'env: 'scope, H: X86Vm> VcpuRun<'scope, 'env, H> {
    pub(crate) fn new(vcpus: &'env Workers<'env, H>, requests: Option<CpuRequests>) -> Self {
        Self {
            vcpus,
            slots: (0..vcpus.max_vcpus).map(|_| Slot::Unavailable).collect(),
            requests,
            next_request: None,
            active: None,
            transfer: None,
            boot_kicked: 0,
            pending_pause_kicks: 0,
        }
    }

    pub(crate) fn spawn_boot(&mut self, scope: &'scope Scope<'scope, 'env>) -> Result<()> {
        for id in 0..self.vcpus.max_vcpus {
            let vcpus = self.vcpus;
            let retire = Arc::new(AtomicBool::new(false));
            let worker_retire = Arc::clone(&retire);
            let (ready, notification) = mpsc::sync_channel(1);
            let thread = spawn(scope, id, move || vcpus.boot(id, ready, &worker_retire))?;
            self.slots[usize::from(id)] = Slot::Attached(Worker {
                thread,
                ready: Some(notification),
                kick: None,
                retire,
            });
        }
        Ok(())
    }

    pub(crate) fn interval(&self) -> Duration {
        if self.vcpus.gate.phase() != Startup::Checkpoint
            || self.active.is_some()
            || self.next_request.is_some()
            || self.pending_pause_kicks != 0
        {
            KICK_RETRY
        } else {
            RECHECK
        }
    }

    pub(crate) fn drive(&mut self, scope: &'scope Scope<'scope, 'env>) {
        if self.vcpus.sender.is_stopping() {
            return;
        }
        if self.vcpus.gate.phase() != Startup::Checkpoint {
            if let Err(error) = self.drive_startup() {
                self.vcpus.sender.send(Event::VcpuFailed(error));
            }
            return;
        }

        self.drive_resize(scope);
        let lifecycle = self.vcpus.lifecycle;
        let participants = self.attached_mask();
        // Check the queue while pause reservation holds the admission lock.
        if lifecycle.drive_workers(participants, || {
            if self.active.is_none() && self.next_request.is_none() {
                self.next_request = self.receive_request();
            }
            self.active.is_none() && self.next_request.is_none() && self.transfer.is_none()
        }) {
            self.pending_pause_kicks = participants;
        }
        if lifecycle.status() == VmStatus::Pausing && !self.vcpus.sender.is_stopping() {
            self.pending_pause_kicks = self.kick_mask(self.pending_pause_kicks);
        } else {
            self.pending_pause_kicks = 0;
        }
    }

    fn drive_startup(&mut self) -> Result<()> {
        for slot in &mut self.slots {
            if let Slot::Attached(worker) = slot {
                worker.register_kick();
            }
        }
        if self.vcpus.lifecycle.startup_pause_requested() {
            let to_kick =
                self.attached_mask() & !self.boot_kicked & cpu_mask(self.vcpus.boot_count);
            self.boot_kicked |= to_kick & !self.kick_mask(to_kick);
        }
        if self.vcpus.gate.phase() == Startup::Configuring {
            if self.attached_mask() != cpu_mask(self.vcpus.max_vcpus) {
                return Ok(());
            }
            self.vcpus.gate.release(Startup::Detaching);
        }

        for id in self.vcpus.boot_count..self.vcpus.max_vcpus {
            let slot = &mut self.slots[usize::from(id)];
            if matches!(slot, Slot::Attached(worker) if worker.thread.is_finished()) {
                let Slot::Attached(worker) = mem::replace(slot, Slot::Unavailable) else {
                    unreachable!("the finished worker is attached");
                };
                match worker.join(id)? {
                    WorkerOutput::Detached(detached, result) => {
                        *slot = Slot::Detached(detached);
                        result?;
                    }
                    WorkerOutput::GrantFailed(_, error) => return Err(error),
                    WorkerOutput::Stopped if self.vcpus.sender.is_stopping() => return Ok(()),
                    WorkerOutput::Stopped => return Err(Error::VcpuNotParked { vcpu: id.into() }),
                }
            }
        }

        if self.slots[usize::from(self.vcpus.boot_count)..]
            .iter()
            .all(|slot| matches!(slot, Slot::Detached(_)))
        {
            self.vcpus
                .lifecycle
                .finish_startup(|| self.vcpus.gate.release(Startup::Checkpoint));
        }
        Ok(())
    }

    fn receive_request(&self) -> Option<CpuRequest> {
        self.requests.as_ref()?.try_recv().ok()
    }

    fn drive_resize(&mut self, scope: &'scope Scope<'scope, 'env>) {
        if self.active.is_none() {
            let Some(request) = self.next_request.take().or_else(|| self.receive_request()) else {
                return;
            };
            self.active = Some(Resize {
                request,
                original: self.attached_mask(),
                grant_failure: None,
            });
            if !self.vcpus.host_vm.supports_vcpu_parking() {
                self.finish(Err(Error::VcpuParkingUnsupported));
                return;
            }
        }
        if self.vcpus.sender.is_stopping() {
            return;
        }
        if self.transfer.is_some() {
            match self.poll_transfer() {
                None => return,
                Some(Ok(())) => {}
                Some(Err(error @ Error::VcpuResizeUnsettled(_))) => {
                    self.finish(Err(error));
                    return;
                }
                Some(Err(error)) => {
                    self.active.as_mut().expect("active resize").grant_failure = Some(error)
                }
            }
        }
        let resize = self.active.as_ref().expect("active resize");
        let running = self.attached_mask();
        let count = resize.request.target;
        let target = if resize.grant_failure.is_some() {
            resize.original
        } else {
            cpu_mask(count)
        };
        if running == target {
            let result = self
                .active
                .as_mut()
                .expect("active resize")
                .grant_failure
                .take()
                .map_or(Ok(count), Err);
            self.finish(result);
        } else if running & !target != 0 {
            let id = (u64::BITS - 1 - (running & !target).leading_zeros()) as u8;
            self.revoke(id);
        } else if resize.grant_failure.is_some() {
            let id = (target & !running).trailing_zeros();
            self.finish(Err(unsettled(Error::VcpuNotRunning { vcpu: id })));
        } else {
            let id = (target & !running).trailing_zeros() as u8;
            if let Err(error) = self.grant(scope, id) {
                self.active.as_mut().expect("active resize").grant_failure = Some(error);
                self.vcpus.sender.wake();
            }
        }
    }

    fn grant(&mut self, scope: &'scope Scope<'scope, 'env>, id: u8) -> Result<()> {
        let slot = &mut self.slots[usize::from(id)];
        if !matches!(slot, Slot::Detached(_)) {
            return Err(Error::VcpuNotParked { vcpu: id.into() });
        }
        let (handoff, receive_vcpu) = mpsc::sync_channel(1);
        let (ready, notification) = mpsc::sync_channel(1);
        let (authorize, permit) = mpsc::sync_channel(1);
        let retire = Arc::new(AtomicBool::new(false));
        let worker_retire = Arc::clone(&retire);
        let vcpus = self.vcpus;
        let thread = spawn(scope, id, move || {
            vcpus.grant(id, receive_vcpu, ready, permit, &worker_retire)
        })?;

        let Slot::Detached(detached) = mem::replace(slot, Slot::Unavailable) else {
            unreachable!("the vCPU is detached");
        };
        self.transfer = Some(Transfer {
            id,
            worker: Worker {
                thread,
                ready: Some(notification),
                kick: None,
                retire,
            },
            kind: TransferKind::Grant(Some(authorize)),
            started: Instant::now(),
        });
        if let Err(mpsc::SendError(detached)) = handoff.send(detached) {
            *slot = Slot::Detached(detached);
        }
        Ok(())
    }

    fn revoke(&mut self, id: u8) {
        let slot = &mut self.slots[usize::from(id)];
        let Slot::Attached(worker) = mem::replace(slot, Slot::Unavailable) else {
            unreachable!("the worker is attached");
        };
        worker.retire.store(true, Ordering::SeqCst);
        self.transfer = Some(Transfer {
            id,
            worker,
            kind: TransferKind::Revoke { kick_pending: true },
            started: Instant::now(),
        });
        self.vcpus.sender.wake();
    }

    fn poll_transfer(&mut self) -> Option<Result<()>> {
        let transfer = self.transfer.as_mut()?;
        let id = transfer.id;
        if !transfer.worker.thread.is_finished() && transfer.started.elapsed() >= WORKER_DEADLINE {
            return Some(Err(unsettled(Error::Control {
                operation: CPU_RESIZE,
                reason: ControlReason::DeadlineTimeout,
            })));
        }
        if transfer.worker.thread.is_finished() {
            let transfer = self.transfer.take().expect("finished transfer");
            let slot = &mut self.slots[usize::from(id)];
            let result = match transfer.worker.join(id) {
                Ok(WorkerOutput::Detached(detached, result)) => {
                    *slot = Slot::Detached(detached);
                    result
                }
                Ok(WorkerOutput::GrantFailed(reusable, error)) => {
                    if let Some(detached) = reusable {
                        *slot = Slot::Detached(detached);
                    }
                    Err(error)
                }
                Ok(WorkerOutput::Stopped) => Err(Error::VcpuNotRunning { vcpu: id.into() }),
                Err(error) => Err(error),
            };
            return Some(match transfer.kind {
                TransferKind::Grant(_) => {
                    result.and(Err(Error::VcpuNotRunning { vcpu: id.into() }))
                }
                TransferKind::Revoke { .. } => result.map_err(unsettled),
            });
        }

        match &mut transfer.kind {
            TransferKind::Grant(authorize) => {
                transfer.worker.register_kick();
                transfer.worker.kick.as_ref()?;
                if !self.vcpus.sender.try_commit_control() {
                    return None;
                }
                let permit = authorize.take().expect("one grant authorization");
                if permit.try_send(()).is_err() {
                    return Some(Err(unsettled(Error::VcpuNotRunning { vcpu: id.into() })));
                }
                let transfer = self.transfer.take().expect("authorized transfer");
                self.slots[usize::from(id)] = Slot::Attached(transfer.worker);
                Some(Ok(()))
            }
            TransferKind::Revoke { kick_pending } => {
                if *kick_pending {
                    let kick = transfer.worker.kick.as_ref().expect("attached worker kick");
                    match kick.kick() {
                        Ok(()) => *kick_pending = false,
                        Err(error) if retryable_kick(&error) => {}
                        Err(error) => return Some(Err(unsettled(error.into()))),
                    }
                }
                None
            }
        }
    }

    fn finish(&mut self, result: Result<u8>) {
        if self.vcpus.sender.is_stopping()
            || (result.is_ok() && !self.vcpus.sender.try_commit_control())
        {
            return;
        }
        if matches!(result, Err(Error::VcpuResizeUnsettled(_))) {
            self.vcpus
                .lifecycle
                .close_cpu_resize(self.transfer.is_some());
            if let Some(transfer) = &mut self.transfer {
                transfer.cancel();
            }
            self.close_requests(|| Error::Control {
                operation: CPU_RESIZE,
                reason: ControlReason::InvalidState,
            });
        }
        let resize = self.active.take().expect("active resize");
        let _ = resize.request.reply.try_send(result);
        self.vcpus.sender.wake();
    }

    fn close_requests(&mut self, error: impl Fn() -> Error) {
        let requests = self.requests.take();
        for request in self
            .next_request
            .take()
            .into_iter()
            .chain(requests.iter().flat_map(Receiver::try_iter))
        {
            let _ = request.reply.try_send(Err(error()));
        }
    }

    fn attached_mask(&self) -> u64 {
        self.slots.iter().enumerate().fold(0, |mask, (id, slot)| {
            if matches!(slot, Slot::Attached(Worker { kick: Some(_), .. })) {
                mask | (1 << id)
            } else {
                mask
            }
        })
    }

    fn kick_mask(&self, mask: u64) -> u64 {
        let mut pending = 0;
        for (id, slot) in self.slots.iter().enumerate() {
            if mask & (1 << id) == 0 {
                continue;
            }
            if let Slot::Attached(Worker {
                kick: Some(kick), ..
            }) = slot
            {
                match kick.kick() {
                    Ok(()) => {}
                    Err(error) if retryable_kick(&error) => pending |= 1 << id,
                    Err(error) => {
                        self.vcpus.sender.send(Event::VcpuFailed(error.into()));
                        break;
                    }
                }
            }
        }
        pending
    }
}

impl<'scope, 'env: 'scope, H: X86Vm> Drop for VcpuRun<'scope, 'env, H> {
    fn drop(&mut self) {
        self.vcpus.lifecycle.mark_stopping();
        self.vcpus.gate.release(Startup::Aborted);
        self.close_requests(|| Error::VmNotRunning);
        if let Some(resize) = self.active.take() {
            let _ = resize.request.reply.try_send(Err(Error::VmNotRunning));
        }

        let mut pending: Vec<_> = self
            .slots
            .iter_mut()
            .filter_map(|slot| match slot {
                Slot::Attached(worker) => worker.kick.take(),
                _ => None,
            })
            .collect();
        if let Some(transfer) = &mut self.transfer {
            transfer.cancel();
            pending.extend(transfer.worker.kick.take());
        }
        // Scope joins run after this guard, even when the poller fails or a kick panics.
        while !pending.is_empty() {
            pending.retain(
                |kick| match panic::catch_unwind(AssertUnwindSafe(|| kick.kick())) {
                    Ok(Ok(())) => false,
                    Ok(Err(error)) if retryable_kick(&error) => true,
                    Ok(Err(error)) => {
                        tracing::warn!(%error, "failed to kick a vCPU");
                        false
                    }
                    Err(_) => {
                        tracing::warn!("vCPU kick panicked during shutdown");
                        false
                    }
                },
            );
            if !pending.is_empty() {
                thread::sleep(KICK_RETRY);
            }
        }
    }
}

fn spawn<'scope, 'env, T: Send + 'scope>(
    scope: &'scope Scope<'scope, 'env>,
    id: u8,
    worker: impl FnOnce() -> T + Send + 'scope,
) -> Result<ScopedJoinHandle<'scope, T>> {
    Builder::new()
        .name(format!("vcpu{id}"))
        .spawn_scoped(scope, worker)
        .map_err(|source| Error::SpawnVcpu {
            vcpu: id.into(),
            source,
        })
}

fn retryable_kick(error: &boxlite_hypervisor::Error) -> bool {
    matches!(error, boxlite_hypervisor::Error::KickVcpu { source, .. }
        if matches!(source.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted))
}

fn cpu_mask(count: u8) -> u64 {
    u64::MAX >> (u64::BITS - u32::from(count))
}

fn unsettled(error: Error) -> Error {
    Error::VcpuResizeUnsettled(Box::new(error))
}
