// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! vCPU workers. At boot one thread per possible vCPU creates and configures
//! its vCPU, and all wait until every vCPU is configured. The first
//! `online_count` then run the guest; the rest park and their threads exit, so
//! no thread can enter the guest for a vCPU the host has not granted.
//!
//! A grant resets a parked vCPU and resumes it on a new thread; a revoke asks
//! a running vCPU to park and waits until it has. Every way a worker ends
//! sends one event, except a stop it observed, which some other sender
//! already caused, and a park, which the VM thread asked for.

use std::{
    panic::{self, AssertUnwindSafe},
    sync::{Condvar, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use boxlite_hypervisor::{
    Vcpu, VcpuExit, VcpuHandle as _, X86BootRegisters, X86ParkVcpu, X86ParkedVcpu, X86Vcpu, X86Vm,
};

use crate::{
    chipset::Chipset,
    cpu_features::{BOOT_MSRS, vcpu_cpuid},
    error::{Error, Result},
    events::{Event, EventSender},
};

/// How long a revoke waits for the vCPU's thread to park after its kick.
const PARK_TIMEOUT: Duration = Duration::from_secs(5);

/// The parked form of backend `H`'s vCPUs.
pub(crate) type Parked<H> = <<H as boxlite_hypervisor::Vm>::Vcpu as X86ParkVcpu>::Parked;
/// The kick handle of backend `H`'s vCPUs.
type Kick<H> = <<H as boxlite_hypervisor::Vm>::Vcpu as Vcpu>::Handle;

/// Holds the workers until every vCPU is configured, so no vCPU runs before
/// all exist. Unlike `std::sync::Barrier`, [`abort`](Self::abort) releases
/// them when a worker thread fails to start.
#[derive(Default)]
pub(crate) struct StartGate {
    /// Workers that arrived, and whether the gate was aborted.
    state: Mutex<(u8, bool)>,
    changed: Condvar,
}

impl StartGate {
    fn arrive_and_wait(&self, count: u8) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.0 += 1;
        self.changed.notify_all();
        drop(
            self.changed
                .wait_while(state, |(arrived, aborted)| *arrived < count && !*aborted)
                .unwrap_or_else(PoisonError::into_inner),
        );
    }

    pub(crate) fn abort(&self) {
        self.state.lock().unwrap_or_else(PoisonError::into_inner).1 = true;
        self.changed.notify_all();
    }
}

/// Where one vCPU is.
enum Slot<H: X86Vm> {
    /// Not configured yet, or its thread ended without parking.
    Absent,
    /// A grant took it; the thread it started has not taken ownership yet.
    Starting,
    /// A thread owns the vCPU; `park` asks it to park at its next exit.
    Running { kick: Kick<H>, park: bool },
    /// No thread owns the vCPU.
    Parked(Parked<H>),
}

/// Every vCPU's [`Slot`], by ID, shared by the workers and the VM thread.
pub(crate) struct Slots<H: X86Vm> {
    slots: Mutex<Vec<Slot<H>>>,
    changed: Condvar,
}

impl<H: X86Vm> Slots<H> {
    pub(crate) fn new(count: u8) -> Self {
        Self {
            slots: Mutex::new((0..count).map(|_| Slot::Absent).collect()),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Slot<H>>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, id: u8, slot: Slot<H>) {
        self.lock()[usize::from(id)] = slot;
        self.changed.notify_all();
    }

    fn park_requested(&self, id: u8) -> bool {
        matches!(
            self.lock()[usize::from(id)],
            Slot::Running { park: true, .. }
        )
    }

    /// The IDs of the vCPUs a thread owns, in order.
    pub(crate) fn running(&self) -> Vec<u8> {
        (0..)
            .zip(self.lock().iter())
            .filter_map(|(id, slot)| matches!(slot, Slot::Running { .. }).then_some(id))
            .collect()
    }

    /// The IDs of the parked vCPUs, in order.
    pub(crate) fn parked(&self) -> Vec<u8> {
        (0..)
            .zip(self.lock().iter())
            .filter_map(|(id, slot)| matches!(slot, Slot::Parked(_)).then_some(id))
            .collect()
    }

    /// Kicks every vCPU a thread owns; the stop path calls it once the latch
    /// is set, so a vCPU not yet registered sees the latch before its entry.
    pub(crate) fn kick_running(&self) {
        for slot in self.lock().iter() {
            if let Slot::Running { kick, .. } = slot
                && let Err(error) = kick.kick()
            {
                tracing::warn!(%error, "failed to kick a vCPU");
            }
        }
    }

    /// Takes parked vCPU `id` and drops any INIT and SIPI the guest sent it
    /// while parked, so its new thread starts it as a CPU that never ran.
    pub(crate) fn take_for_grant(&self, id: u8) -> Result<Parked<H>> {
        let mut slots = self.lock();
        let slot = std::mem::replace(&mut slots[usize::from(id)], Slot::Starting);
        let Slot::Parked(mut parked) = slot else {
            slots[usize::from(id)] = slot;
            return Err(Error::VcpuNotParked { vcpu: id.into() });
        };
        drop(slots);
        if let Err(error) = parked.reset() {
            // The vCPU is dropped: its state is unknown, so it never runs again.
            self.set(id, Slot::Absent);
            return Err(error.into());
        }
        Ok(parked)
    }

    /// Waits until every boot thread runs its vCPU or has parked it, so a
    /// control request sees the settled set. Stops waiting once the VM ends,
    /// since a failed thread leaves its slot absent.
    pub(crate) fn wait_settled(&self, sender: &EventSender) {
        let mut slots = self.lock();
        while !sender.is_stopping()
            && slots
                .iter()
                .any(|slot| matches!(slot, Slot::Absent | Slot::Running { park: true, .. }))
        {
            slots = self
                .changed
                .wait_timeout(slots, Duration::from_millis(100))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// Waits until the thread a grant started for vCPU `id` owns it, or has
    /// failed and ended the VM.
    pub(crate) fn wait_started(&self, id: u8) {
        let index = usize::from(id);
        drop(
            self.changed
                .wait_while(self.lock(), |slots| matches!(slots[index], Slot::Starting))
                .unwrap_or_else(PoisonError::into_inner),
        );
    }

    /// Asks running vCPU `id` to park and waits until its thread has. A guest
    /// that has not offlined the CPU is parked anyway, so it cannot keep a
    /// vCPU the host revoked; only the guest itself then stalls.
    pub(crate) fn revoke(&self, id: u8) -> Result<()> {
        let index = usize::from(id);
        let mut slots = self.lock();
        match &mut slots[index] {
            Slot::Running { kick, park } => {
                *park = true;
                kick.kick()?;
            }
            _ => return Err(Error::VcpuNotRunning { vcpu: id.into() }),
        }
        let (slots, timeout) = self
            .changed
            .wait_timeout_while(slots, PARK_TIMEOUT, |slots| {
                matches!(slots[index], Slot::Running { .. })
            })
            .unwrap_or_else(PoisonError::into_inner);
        if timeout.timed_out() {
            return Err(Error::ParkTimedOut { vcpu: id.into() });
        }
        // A thread that failed instead of parking has already ended the VM.
        let Slot::Parked(parked) = &slots[index] else {
            return Err(Error::VcpuNotParked { vcpu: id.into() });
        };
        if !parked.is_halted()? {
            tracing::warn!(vcpu = id, "parked a vCPU the guest had not offlined");
        }
        Ok(())
    }
}

/// How a worker's guest loop ended.
enum Outcome {
    /// The guest or a failure ends the VM.
    Event(Event),
    /// Another sender ended the VM.
    Stopped,
    /// The VM thread revoked this vCPU.
    Park,
}

/// What every worker of one VM shares.
pub(crate) struct Workers<'a, H: X86Vm> {
    pub(crate) host_vm: &'a H,
    /// Every possible vCPU, which the guest sees in its CPU topology.
    pub(crate) max_vcpus: u8,
    /// The vCPUs that run from boot; the others park once configured.
    pub(crate) online_count: u8,
    pub(crate) boot_regs: &'a X86BootRegisters,
    pub(crate) chipset: &'a Chipset,
    pub(crate) sender: &'a EventSender,
    pub(crate) slots: &'a Slots<H>,
    pub(crate) gate: &'a StartGate,
}

impl<H: X86Vm> Workers<'_, H> {
    /// The body of boot thread `id`. A panic in it, such as a device whose
    /// lock an earlier panic poisoned, ends the VM with
    /// [`Error::VcpuPanicked`] instead of leaving the thread.
    pub(crate) fn run(&self, id: u8) {
        let vcpu = match catch_panic(id, || self.configure(id)) {
            Ok(vcpu) => Some(vcpu),
            Err(error) => {
                // Sent before arriving, so the latch is set before any vCPU
                // leaves the gate and none enters the guest.
                self.sender.send(Event::VcpuFailed(error));
                None
            }
        };
        // A failed vCPU still arrives, so the others are never left waiting.
        self.gate.arrive_and_wait(self.max_vcpus);
        let Some(vcpu) = vcpu else {
            return;
        };
        if id < self.online_count {
            self.run_until_end(vcpu, id);
        } else {
            self.park(vcpu, id);
        }
    }

    /// The body of a thread a grant started for parked vCPU `id`.
    pub(crate) fn resume(&self, parked: Parked<H>, id: u8) {
        match catch_panic(id, || Ok(parked.resume()?)) {
            Ok(vcpu) => {
                self.slots.set(
                    id,
                    Slot::Running {
                        kick: vcpu.handle(),
                        park: false,
                    },
                );
                self.run_until_end(vcpu, id);
            }
            Err(error) => {
                self.slots.set(id, Slot::Absent);
                self.sender.send(Event::VcpuFailed(error));
            }
        }
    }

    fn run_until_end(&self, mut vcpu: H::Vcpu, id: u8) {
        match catch_panic(id, || self.run_guest(&mut vcpu, id)) {
            Ok(Outcome::Event(event)) => self.sender.send(event),
            Ok(Outcome::Stopped) => {}
            Ok(Outcome::Park) => self.park(vcpu, id),
            Err(error) => self.sender.send(Event::VcpuFailed(error)),
        }
    }

    /// Parks `vcpu`, ending its thread's ownership; a failure ends the VM.
    fn park(&self, vcpu: H::Vcpu, id: u8) {
        match catch_panic(id, || Ok(vcpu.park()?)) {
            Ok(parked) => self.slots.set(id, Slot::Parked(parked)),
            Err(error) => {
                self.slots.set(id, Slot::Absent);
                self.sender.send(Event::VcpuFailed(error));
            }
        }
    }

    fn configure(&self, id: u8) -> Result<H::Vcpu> {
        let mut vcpu = self.host_vm.create_vcpu(id.into())?;
        let cpuid = vcpu_cpuid(self.host_vm.supported_cpuid(), id, self.max_vcpus);
        vcpu.set_cpu_features(&cpuid, &BOOT_MSRS)?;
        // The other vCPUs wait in their reset state for INIT and SIPI.
        if id == 0 {
            vcpu.set_boot_registers(self.boot_regs)?;
        }
        // A vCPU that starts parked is marked for parking, so neither a
        // request nor the guest finds it running.
        self.slots.set(
            id,
            Slot::Running {
                kick: vcpu.handle(),
                park: id >= self.online_count,
            },
        );
        Ok(vcpu)
    }

    /// Runs the guest until it asks to end, another sender ends the VM, or the
    /// VM thread revokes this vCPU. Stopping and parking first complete the
    /// pending access.
    fn run_guest(&self, vcpu: &mut H::Vcpu, id: u8) -> Result<Outcome> {
        loop {
            // Checked before every entry: a stop or revoke that lands earlier
            // still returns from the next entry at once, since its kick is
            // pending.
            if self.sender.is_stopping() {
                vcpu.complete_pending_io()?;
                return Ok(Outcome::Stopped);
            }
            if self.slots.park_requested(id) {
                return Ok(Outcome::Park);
            }
            match self.chipset.dispatch(vcpu.run()?) {
                None | Some(VcpuExit::Interrupted) => {}
                Some(VcpuExit::Shutdown) => return Ok(Outcome::Event(Event::GuestShutdown)),
                Some(VcpuExit::Reset) => return Ok(Outcome::Event(Event::GuestReset)),
                Some(exit) => {
                    return Err(Error::UnexpectedExit {
                        vcpu: id.into(),
                        exit: format!("{exit:?}"),
                    });
                }
            }
        }
    }
}

fn catch_panic<T>(id: u8, f: impl FnOnce() -> Result<T>) -> Result<T> {
    panic::catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err(Error::VcpuPanicked { vcpu: id.into() }))
}
