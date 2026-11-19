// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Owned execution and reversible, epoch-based vCPU parking. Terminal events
//! and the parking mailbox are separate; only the supervisor publishes Paused.

use std::{
    any::Any,
    collections::VecDeque,
    io::{self, Write},
    marker::PhantomData,
    path::Path,
    sync::{Arc, Condvar, Mutex, PoisonError, mpsc},
    thread::JoinHandle,
    time::Duration,
};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use boxlite_hypervisor::Vm as HostVm;

use crate::{
    ControlReason, Error, Result, StopHandle, VmExit, events::EventSender, snapshot::image,
};
#[cfg(target_arch = "x86_64")]
use crate::{Vm, events::Event};

/// The observable lifecycle of an owned VM execution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VmStatus {
    /// Starting or executing vCPUs.
    Running,
    /// A park request is admitted; vCPU acknowledgements are incomplete.
    Pausing,
    /// Every vCPU acknowledged the current parking epoch.
    Paused,
    /// Terminal stop or failure; teardown may still be joining workers.
    Stopping,
    /// The supervisor has joined workers and dropped the VM.
    Exited,
}

/// Caller patience for pause ACKs; expiry does not end state-machine parking.
const PAUSE_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
use boxlite_hypervisor::Vcpu as ParkVcpu;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use boxlite_hypervisor::X86Vcpu as ParkVcpu;

type ParkResult = std::result::Result<u64, ControlReason>;

trait SnapshotWriter: Write + Send + Any {}
impl<W: Write + Send + Any> SnapshotWriter for W {}

type ExportWriter = Box<dyn SnapshotWriter>;
type ExportReply = (Result<()>, ExportWriter);

enum ParkCommand {
    Export(ExportWriter, mpsc::Sender<ExportReply>),
    Park(Arc<()>, mpsc::Sender<ParkResult>),
    Resume(u64, mpsc::Sender<ParkResult>),
}

impl ParkCommand {
    fn reject(self, reason: ControlReason) {
        match self {
            Self::Park(_, reply) | Self::Resume(_, reply) => {
                let _ = reply.send(Err(reason));
            }
            Self::Export(writer, reply) => {
                let _ = reply.send((Err(reason.for_operation("export")), writer));
            }
        }
    }
}

struct PendingPark {
    generation: u64,
    seen: u64,
    reply: mpsc::Sender<ParkResult>,
}

impl PendingPark {
    fn acknowledge(&mut self, generation: u64, id: u8, count: u8) -> bool {
        if generation != self.generation || id >= count || self.seen & (1u64 << id) != 0 {
            return false;
        }
        self.seen |= 1u64 << id;
        true
    }
}

struct Mailbox {
    generation: u64,
    requested: bool,
    status: VmStatus,
    commands: VecDeque<ParkCommand>,
    acknowledgements: VecDeque<(u64, u8)>,
    pending: Option<PendingPark>,
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    captures: VecDeque<(u8, mpsc::Sender<Result<crate::snapshot::state::VcpuRecord>>)>,
    #[cfg(test)]
    accesses: VecDeque<(u8, Box<dyn FnOnce() + Send>)>,
}

/// One execution's mailbox. Backend objects stay on their owning vCPU thread.
pub(crate) struct Parking {
    mailbox: Mutex<Mailbox>,
    changed: Condvar,
    sender: EventSender,
    #[cfg(test)]
    broadcasts: AtomicUsize,
    #[cfg(all(test, target_arch = "x86_64"))]
    drive_wait: Mutex<Option<tests::execution::DriveWait>>,
    #[cfg(test)]
    paused_wait_ready: Mutex<Option<mpsc::Sender<()>>>,
    #[cfg(test)]
    pause_wait_gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
}

impl Parking {
    fn new(sender: EventSender) -> Self {
        Self {
            mailbox: Mutex::new(Mailbox {
                generation: 0,
                requested: false,
                status: VmStatus::Running,
                commands: VecDeque::new(),
                acknowledgements: VecDeque::new(),
                pending: None,
                #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
                captures: VecDeque::new(),
                #[cfg(test)]
                accesses: VecDeque::new(),
            }),
            changed: Condvar::new(),
            sender,
            #[cfg(test)]
            broadcasts: AtomicUsize::new(0),
            #[cfg(all(test, target_arch = "x86_64"))]
            drive_wait: Mutex::new(None),
            #[cfg(test)]
            paused_wait_ready: Mutex::new(None),
            #[cfg(test)]
            pause_wait_gate: Mutex::new(None),
        }
    }

    fn notify_all(&self) {
        #[cfg(test)]
        self.broadcasts.fetch_add(1, Ordering::Relaxed);
        self.changed.notify_all();
    }

    fn send(&self, command: ParkCommand) {
        let mut state = self.mailbox.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(state.status, VmStatus::Stopping | VmStatus::Exited) {
            command.reject(ControlReason::InvalidState);
        } else {
            state.commands.push_back(command);
            self.notify_all();
            self.sender.wake();
        }
    }

    /// Supervisor only: publish generations and validate all acknowledgements.
    fn supervise(&self, count: u8, sender: &EventSender) -> (bool, Duration) {
        let mut state = self.mailbox.lock().unwrap_or_else(PoisonError::into_inner);
        if sender.is_stopping() {
            Self::fail(&mut state, ControlReason::TerminalOutcome);
            self.notify_all();
            return (false, Duration::ZERO);
        }
        let mut kick = false;
        while let Some(command) = state.commands.pop_front() {
            match command {
                command @ ParkCommand::Export(..) => {
                    state.commands.push_front(command);
                    break;
                }
                ParkCommand::Park(_, reply) => {
                    let next = state.generation.checked_add(1);
                    if state.status != VmStatus::Running || state.requested || next.is_none() {
                        let _ = reply.send(Err(ControlReason::InvalidState));
                        continue;
                    }
                    let generation = next.unwrap();
                    state.generation = generation;
                    state.requested = true;
                    state.status = VmStatus::Pausing;
                    state.pending = Some(PendingPark {
                        generation,
                        seen: 0,
                        reply,
                    });
                    kick = true;
                    self.notify_all();
                }
                ParkCommand::Resume(generation, reply) => {
                    let result =
                        if state.status == VmStatus::Paused && generation == state.generation {
                            state.requested = false;
                            state.status = VmStatus::Running;
                            self.notify_all();
                            Ok(generation)
                        } else {
                            Err(ControlReason::InvalidState)
                        };
                    let _ = reply.send(result);
                }
            }
        }
        while let Some((generation, id)) = state.acknowledgements.pop_front() {
            if let Some(pending) = &mut state.pending {
                pending.acknowledge(generation, id, count);
            }
        }
        if sender.is_stopping() {
            Self::fail(&mut state, ControlReason::TerminalOutcome);
            self.notify_all();
        } else if state
            .pending
            .as_ref()
            .is_some_and(|p| p.seen == u64::MAX >> (64 - count))
        {
            let pending = state.pending.take().unwrap();
            state.status = VmStatus::Paused;
            let _ = pending.reply.send(Ok(pending.generation));
            self.notify_all();
        }
        let wait = if sender.is_stopping() || !state.commands.is_empty() {
            Duration::ZERO
        } else {
            crate::events::RECHECK
        };
        (kick, wait)
    }

    fn wait_paused(&self, timeout: Duration, sender: &EventSender) -> Result<u64> {
        let state = self.mailbox.lock().unwrap_or_else(PoisonError::into_inner);
        #[cfg(test)]
        if state.status == VmStatus::Pausing
            && let Some(ready) = self.paused_wait_ready.lock().unwrap().take()
        {
            // Acquiring the mailbox after this signal proves wait admission.
            ready.send(()).unwrap();
        }
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state.status == VmStatus::Pausing && !sender.is_stopping()
            })
            .unwrap_or_else(PoisonError::into_inner);
        let result = if sender.is_stopping() {
            Err(ControlReason::TerminalOutcome)
        } else {
            match state.status {
                VmStatus::Paused => Ok(state.generation),
                VmStatus::Pausing => Err(ControlReason::DeadlineTimeout),
                VmStatus::Running => Err(ControlReason::InvalidState),
                VmStatus::Stopping | VmStatus::Exited => Err(ControlReason::TerminalOutcome),
            }
        };
        result.map_err(|reason| reason.for_operation("wait_paused"))
    }

    fn fail(state: &mut Mailbox, reason: ControlReason) {
        if state.status == VmStatus::Exited {
            return;
        }
        state.status = VmStatus::Stopping;
        if let Some(pending) = state.pending.take() {
            let _ = pending.reply.send(Err(reason));
        }
        for command in state.commands.drain(..) {
            command.reject(reason);
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        state.captures.clear();
        #[cfg(test)]
        state.accesses.clear();
    }

    pub(crate) fn stop(&self) {
        Self::fail(
            &mut self.mailbox.lock().unwrap_or_else(PoisonError::into_inner),
            ControlReason::TerminalOutcome,
        );
        self.notify_all();
        self.sender.wake();
    }

    /// Called before EVERY guest entry. Complete I/O and notify the backend
    /// outside the lock, then ACK only the still-current epoch. The parked
    /// loop wakes to serve owning-thread commands without reopening entry.
    pub(crate) fn checkpoint(&self, id: u8, vcpu: &mut impl ParkVcpu) -> Result<()> {
        let mut state = self.mailbox.lock().unwrap_or_else(PoisonError::into_inner);
        while state.requested && !matches!(state.status, VmStatus::Stopping | VmStatus::Exited) {
            let generation = state.generation;
            drop(state);
            vcpu.complete_pending_io()?;
            match vcpu.notify_guest_stopped() {
                Err(boxlite_hypervisor::Error::ConfigureVcpu { source, .. })
                    if source.kind() == std::io::ErrorKind::Unsupported
                        && source.raw_os_error().is_none() => {}
                result => result?,
            }
            state = self.mailbox.lock().unwrap_or_else(PoisonError::into_inner);
            if state.status == VmStatus::Stopping {
                break;
            }
            state.acknowledgements.push_back((generation, id));
            self.notify_all();
            self.sender.wake();
            while state.requested
                && state.generation == generation
                && state.status != VmStatus::Stopping
            {
                #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
                if let Some(index) = state.captures.iter().position(|(owner, _)| *owner == id) {
                    let (_, reply) = state.captures.remove(index).unwrap();
                    drop(state);
                    let result = vcpu
                        .save_state()
                        .map(|state| crate::snapshot::state::VcpuRecord { id, state })
                        .map_err(Error::from);
                    let _ = reply.send(result);
                    state = self.mailbox.lock().unwrap_or_else(PoisonError::into_inner);
                    continue;
                }
                #[cfg(test)]
                if let Some(index) = state.accesses.iter().position(|(owner, _)| *owner == id) {
                    let (_, access) = state.accesses.remove(index).unwrap();
                    drop(state);
                    access();
                    state = self.mailbox.lock().unwrap_or_else(PoisonError::into_inner);
                    continue;
                }
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        }
        Ok(())
    }
}

/// Owns the supervisor and, through its scoped driver, every vCPU thread.
/// Not cloneable. Drop requests terminal stop, wakes parked workers, then joins
/// before the supervisor drops the VM and its registered RAM.
pub struct VmHandle<H: HostVm> {
    parking: Arc<Parking>,
    stop: StopHandle,
    supervisor: Option<JoinHandle<Result<VmExit>>>,
    devices: bool,
    backend: PhantomData<H>,
}

impl<H: HostVm> std::fmt::Debug for VmHandle<H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VmHandle")
            .field("status", &self.status())
            .finish_non_exhaustive()
    }
}

impl<H: HostVm> VmHandle<H> {
    /// Requests parking of every vCPU of a Running device-less VM.
    /// Waits up to five seconds; timeout withdraws an unadmitted request,
    /// or leaves an admitted park in progress.
    /// Repeated pause is InvalidState.
    pub fn pause(&mut self) -> Result<()> {
        self.request(true, PAUSE_TIMEOUT)
    }

    /// Reopens guest entry only from Paused; otherwise InvalidState.
    pub fn resume(&mut self) -> Result<()> {
        self.request(false, PAUSE_TIMEOUT)
    }

    fn request(&mut self, pause: bool, timeout: Duration) -> Result<()> {
        let operation = if pause { "pause" } else { "resume" };
        let state = self
            .parking
            .mailbox
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if self.stop.0.is_stopping()
            || state.status
                != if pause {
                    VmStatus::Running
                } else {
                    VmStatus::Paused
                }
        {
            return Err(ControlReason::InvalidState.for_operation(operation));
        }
        if pause && self.devices {
            return Err(ControlReason::UnsupportedDevice.for_operation(operation));
        }
        let generation = state.generation;
        drop(state);
        let (tx, rx) = mpsc::channel();
        let request = Arc::new(());
        self.parking.send(if pause {
            ParkCommand::Park(request.clone(), tx)
        } else {
            ParkCommand::Resume(generation, tx)
        });
        let result = if pause {
            #[cfg(test)]
            if let Some((ready, release)) = self.parking.pause_wait_gate.lock().unwrap().take() {
                ready.send(()).unwrap();
                release.recv().unwrap();
            }
            rx.recv_timeout(timeout).unwrap_or_else(|error| {
                if error == mpsc::RecvTimeoutError::Timeout {
                    let mut state = self
                        .parking
                        .mailbox
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    // Withdrawal and supervisor admission share the mailbox lock.
                    state.commands.retain(|command| {
                        !matches!(command, ParkCommand::Park(id, _) if Arc::ptr_eq(id, &request))
                    });
                }
                Err(match error {
                    mpsc::RecvTimeoutError::Timeout if !self.stop.0.is_stopping() => {
                        ControlReason::DeadlineTimeout
                    }
                    mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected => {
                        ControlReason::TerminalOutcome
                    }
                })
            })
        } else {
            rx.recv().unwrap_or(Err(ControlReason::TerminalOutcome))
        };
        result
            .and_then(|_| {
                if self.stop.0.is_stopping() {
                    Err(ControlReason::TerminalOutcome)
                } else {
                    Ok(())
                }
            })
            .map_err(|reason| reason.for_operation(operation))
    }

    /// Writes a Paused, device-less VM's snapshot and returns the flushed writer.
    /// State capture requires Linux x86_64. The VM stays parked on success or
    /// failure unless stopped concurrently. The caller cleans up partial output.
    ///
    /// The supervisor calls `Write` synchronously. A blocked pipe or socket
    /// delays subsequent control events, including stop, until the write returns.
    /// On error, dropping a caller-supplied `BufWriter` may flush buffered bytes.
    /// Streaming restore with `Vm::from_state` validates `X86_LAYOUT` and KVM's
    /// guest physical address limit before reading RAM bytes. That GPA cap is
    /// separate from the host's available memory budget.
    pub fn export<W: Write + Send + 'static>(&mut self, writer: W) -> Result<W> {
        self.check_export()?;
        let (tx, rx) = mpsc::channel();
        self.parking.send(ParkCommand::Export(Box::new(writer), tx));
        let (result, writer) = rx
            .recv()
            .map_err(|_| ControlReason::TerminalOutcome.for_operation("export"))?;
        result?;
        if self.status() != VmStatus::Paused {
            return Err(ControlReason::TerminalOutcome.for_operation("export"));
        }
        // The supervisor returns the same writer it received.
        let writer: Box<dyn Any> = writer;
        Ok(*writer.downcast::<W>().expect("export writer type changed"))
    }

    /// Exports to a new file with mode 0600, created on the first write.
    /// On failure, cleanup removes an incomplete file if the path still names it.
    /// The same admission checks as [Self::export] apply.
    pub fn export_to_file(&mut self, path: impl AsRef<Path>) -> Result<()> {
        self.check_export()?;
        if path.as_ref().symlink_metadata().is_ok() {
            return Err(Error::Snapshot(io::Error::from_raw_os_error(libc::EEXIST)));
        }
        let mut writer = self.export(image::NewFileWriter::new(path.as_ref()))?;
        writer.commit();
        Ok(())
    }

    fn check_export(&self) -> Result<()> {
        if self.status() != VmStatus::Paused {
            return Err(ControlReason::InvalidState.for_operation("export"));
        }
        if self.devices {
            return Err(ControlReason::UnsupportedDevice.for_operation("export"));
        }
        if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            return Err(Error::Snapshot(io::ErrorKind::Unsupported.into()));
        }
        Ok(())
    }

    /// Waits for an admitted park request without changing execution state.
    /// Timeout leaves parking in progress; Running is InvalidState.
    pub fn wait_paused(&self, timeout: Duration) -> Result<()> {
        self.parking.wait_paused(timeout, &self.stop.0).map(|_| ())
    }

    /// Current lifecycle; a terminal stop never reports Paused.
    pub fn status(&self) -> VmStatus {
        let status = self
            .parking
            .mailbox
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .status;
        if status != VmStatus::Exited && self.stop.0.is_stopping() {
            VmStatus::Stopping
        } else {
            status
        }
    }

    /// Requests irreversible terminal stop, without waiting for joins.
    pub fn stop(&self) {
        self.stop.stop();
        self.parking.stop();
    }

    /// A cloneable sender for terminal stop from another thread.
    pub fn stop_handle(&self) -> StopHandle {
        self.stop.clone()
    }

    /// Waits for execution and teardown, consuming this handle.
    pub fn join(mut self) -> Result<VmExit> {
        self.join_supervisor()
    }

    fn join_supervisor(&mut self) -> Result<VmExit> {
        self.supervisor
            .take()
            .ok_or(Error::AlreadyRan)?
            .join()
            .unwrap_or_else(|_| {
                Err(Error::EventLoop(std::io::Error::other(
                    "VM supervisor panicked",
                )))
            })
    }
}

impl<H: HostVm> Drop for VmHandle<H> {
    fn drop(&mut self) {
        if self.supervisor.is_some() {
            self.stop();
            if let Err(error) = self.join_supervisor() {
                tracing::warn!(%error, "VM handle teardown failed");
            }
        }
    }
}

#[cfg(test)]
#[path = "../tests/control/mod.rs"]
mod tests;

#[cfg(target_arch = "x86_64")]
impl<H: boxlite_hypervisor::X86Vm> Vm<H> {
    /// Runs every vCPU on its own thread until the first event ends the VM,
    /// stops and joins them all, shuts the virtio workers down, and returns
    /// how the VM ended. Workers that do not shut down fail a run that
    /// otherwise ended cleanly. A VM runs once; a second call fails with
    /// [`Error::AlreadyRan`].
    pub fn run(&mut self) -> Result<VmExit> {
        self.drive(&Parking::new(self.sender.clone()))
    }

    /// Moves the VM into an owned supervisor. Imported state is installed
    /// before returning Paused; boot startup runs asynchronously. Use `join`
    /// to collect terminal outcomes.
    pub fn spawn(mut self) -> Result<VmHandle<H>>
    where
        H: 'static,
    {
        if self.state != crate::vm::VmState::Created {
            return Err(Error::AlreadyRan);
        }
        let parking = Arc::new(Parking::new(self.sender.clone()));
        let stop = self.stop_handle();
        let chipset = self.chipset.as_ref().expect("live VM has a chipset");
        let devices = !chipset.is_empty();
        let shared = parking.clone();
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        let restored = if matches!(self.startup, crate::vm::Startup::Restore(_)) {
            let (ready, result) = mpsc::channel();
            parking.send(ParkCommand::Park(Arc::new(()), ready));
            Some(result)
        } else {
            None
        };
        let supervisor = std::thread::Builder::new()
            .name("vm-supervisor".into())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // Arm initial parking before even creating a worker: its
                    // first checkpoint must never see an open entry gate.
                    shared.supervise(self.vcpu_count, &self.sender);
                    self.drive(&shared)
                }));
                shared.stop();
                drop(self);
                shared
                    .mailbox
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .status = VmStatus::Exited;
                outcome.unwrap_or_else(|_| {
                    Err(Error::EventLoop(std::io::Error::other(
                        "VM supervisor panicked",
                    )))
                })
            })
            .map_err(Error::EventLoop)?;
        let handle = VmHandle {
            parking,
            stop,
            supervisor: Some(supervisor),
            devices,
            backend: PhantomData,
        };
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        if let Some(result) = restored
            && result
                .recv()
                .unwrap_or(Err(ControlReason::TerminalOutcome))
                .is_err()
        {
            handle.stop();
            // Join before exposing an error: workers and mappings belong
            // exclusively to the supervisor until teardown completes.
            return match handle.join() {
                Err(error) => Err(error),
                Ok(_) => Err(ControlReason::TerminalOutcome.for_operation("from_state")),
            };
        }
        Ok(handle)
    }

    fn export_pending(
        parking: &Parking,
        host_vm: &H,
        ram: &crate::memory::GuestRam,
        count: u8,
        devices: bool,
    ) {
        let command = {
            let mut state = parking
                .mailbox
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if !matches!(state.commands.front(), Some(ParkCommand::Export(..))) {
                return;
            }
            state.commands.pop_front().unwrap()
        };
        let ParkCommand::Export(mut writer, reply) = command else {
            unreachable!()
        };
        let result = if parking
            .mailbox
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .status
            != VmStatus::Paused
        {
            Err(ControlReason::InvalidState.for_operation("export"))
        } else if devices {
            Err(ControlReason::UnsupportedDevice.for_operation("export"))
        } else {
            Self::export_image(parking, host_vm, ram, count, &mut *writer)
        };
        let _ = reply.send((result, writer));
    }

    #[cfg(target_os = "linux")]
    fn export_image(
        parking: &Parking,
        host_vm: &H,
        ram: &crate::memory::GuestRam,
        count: u8,
        writer: &mut dyn Write,
    ) -> Result<()> {
        let receivers = {
            let mut state = parking
                .mailbox
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if state.status != VmStatus::Paused || !state.requested {
                return Err(ControlReason::InvalidState.for_operation("export"));
            }
            let mut receivers = Vec::new();
            for id in 0..count {
                let (tx, rx) = mpsc::channel();
                state.captures.push_back((id, tx));
                receivers.push(rx);
            }
            parking.notify_all();
            receivers
        };
        let mut vcpus = Vec::new();
        for rx in receivers {
            vcpus.push(
                rx.recv()
                    .map_err(|_| ControlReason::TerminalOutcome.for_operation("export"))??,
            );
        }
        let machine = crate::snapshot::state::MachineState {
            vcpus,
            platform: host_vm.save_state()?,
        }
        .encode()?;
        image::write_to_checked(writer, count.into(), &machine, ram, || {
            if parking.sender.is_stopping() {
                return Err(ControlReason::TerminalOutcome.for_operation("export"));
            }
            Ok(())
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn export_image(
        _: &Parking,
        _: &H,
        _: &crate::memory::GuestRam,
        _: u8,
        _: &mut dyn Write,
    ) -> Result<()> {
        Err(Error::Snapshot(io::ErrorKind::Unsupported.into()))
    }

    fn drive(&mut self, parking: &Parking) -> Result<VmExit> {
        use std::{sync::PoisonError, thread};

        use boxlite_hypervisor::VcpuHandle as _;

        use crate::vcpu::{StartGate, Workers};

        if self.state != crate::vm::VmState::Created {
            return Err(Error::AlreadyRan);
        }
        self.state = crate::vm::VmState::Exited;
        let host_vm = self.host_vm.as_deref().expect("live VM has a host VM");
        let chipset = self.chipset.as_ref().expect("live VM has a chipset");
        #[cfg(target_os = "linux")]
        if let crate::vm::Startup::Restore(machine) = &self.startup {
            host_vm.restore_state(&machine.platform)?;
        }
        let gate = StartGate::default();
        let kicks = Mutex::new(Vec::new());
        let vcpus = Workers {
            host_vm,
            vcpu_count: self.vcpu_count,
            startup: &self.startup,
            chipset,
            sender: &self.sender,
            kicks: &kicks,
            gate: &gate,
            parking,
        };
        let events = self
            .events
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        let event = thread::scope(|scope| {
            for id in 0..vcpus.vcpu_count {
                let vcpus = &vcpus;
                let spawned = thread::Builder::new()
                    .name(format!("vcpu{id}"))
                    .spawn_scoped(scope, move || vcpus.run(id));
                if let Err(source) = spawned {
                    let vcpu = id.into();
                    vcpus
                        .sender
                        .send(Event::VcpuFailed(Error::SpawnVcpu { vcpu, source }));
                    gate.abort();
                    break;
                }
            }
            let event = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                loop {
                    let (kick, wait) = parking.supervise(self.vcpu_count, &self.sender);
                    Self::export_pending(
                        parking,
                        host_vm,
                        &self.ram,
                        self.vcpu_count,
                        !chipset.is_empty(),
                    );
                    if kick {
                        for kick in kicks.lock().unwrap_or_else(PoisonError::into_inner).iter() {
                            if let Err(error) = kick.kick() {
                                self.sender.send(Event::VcpuFailed(error.into()));
                                parking.stop();
                                break;
                            }
                        }
                    }
                    let timeout = Some(wait);
                    #[cfg(test)]
                    let waited = match parking.drive_wait.lock().unwrap().as_mut() {
                        Some(stub) => stub.wait(timeout, &self.sender),
                        None => events.wait(timeout),
                    };
                    #[cfg(not(test))]
                    let waited = events.wait(timeout);
                    match waited {
                        Ok(None) => continue,
                        event => break event,
                    }
                }
            }))
            .unwrap_or_else(|_| Err(std::io::Error::other("VM supervisor panicked")));
            // Abort before joins, including startup and supervisor failures.
            gate.abort();
            parking.stop();
            if event.is_err() {
                // Without an event the stop latch is still open; close it so
                // the vCPUs stop and the scope can join them.
                vcpus.sender.send(Event::StopRequested);
            }
            // Wake every vCPU still in the guest; a vCPU still being
            // configured sees the latch before its first entry.
            for kick in kicks.lock().unwrap_or_else(PoisonError::into_inner).iter() {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| kick.kick())) {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => tracing::warn!(%error, "failed to kick a vCPU"),
                    Err(_) => tracing::warn!("vCPU kick panicked during teardown"),
                }
            }
            event
        });
        // No vCPU notifies a queue any more. Stop the virtio devices before the
        // console finishes, so a device's last output still reaches the sink.
        let workers = self.workers.as_ref().expect("live VM has virtio workers");
        let shutdown = workers.shutdown().map_err(Error::from);
        let console = self
            .console
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(console) = console {
            console.finish();
            let dropped = console.dropped_bytes();
            if dropped > 0 {
                tracing::warn!(dropped, "dropped guest console output");
            }
        }
        let ended = match event {
            Ok(Some(Event::StopRequested)) => Ok(VmExit::StopRequested),
            Ok(Some(Event::GuestShutdown)) => Ok(VmExit::GuestShutdown),
            Ok(Some(Event::GuestReset)) => Ok(VmExit::GuestReset),
            Ok(Some(Event::VcpuFailed(error) | Event::DeviceFailed(error))) => Err(error),
            Ok(None) => unreachable!("the supervisor retries every nonterminal wake"),
            Err(error) => Err(Error::EventLoop(error)),
        };
        // The error that ended the VM stays the one the caller sees.
        match (ended, shutdown) {
            (ended, Ok(())) => ended,
            (Ok(exit), Err(error)) => {
                tracing::warn!(?exit, "the VM ended, but virtio shutdown failed");
                Err(error)
            }
            (Err(ended), Err(error)) => {
                tracing::warn!(%error, "virtio shutdown failed");
                Err(ended)
            }
        }
    }
}
