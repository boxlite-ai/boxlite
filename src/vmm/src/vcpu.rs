// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! vCPU workers. Each runs on its own thread: it creates and configures its
//! vCPU, waits until every vCPU is configured, then runs the guest and
//! dispatches its exits until the VM ends. Every way a worker ends sends one
//! event, except a stop it observed, which some other sender already caused.
//!
//! On arm64 only vCPU 0 starts at the kernel; each other vCPU waits powered
//! off until the guest names it in a PSCI `CPU_ON` (`booting.rst`), which HVF
//! leaves to the VMM.

use std::{
    panic::{self, AssertUnwindSafe},
    sync::{Condvar, Mutex, PoisonError},
};

#[cfg(target_arch = "aarch64")]
use boxlite_hypervisor::{Arm64BootRegisters, Arm64Vcpu, CpuOnResult};
use boxlite_hypervisor::{Vcpu, VcpuExit, Vm as HostVm};
#[cfg(target_arch = "x86_64")]
use boxlite_hypervisor::{X86Vcpu, X86Vm};

#[cfg(target_arch = "x86_64")]
use crate::cpu_features::{BOOT_MSRS, vcpu_cpuid};
use crate::{
    chipset::Chipset,
    error::{Error, Result},
    events::{Event, EventSender},
    vm::BootRegisters,
};

/// PSTATE at kernel entry: EL1h with D, A, I and F masked (`booting.rst`).
#[cfg(target_arch = "aarch64")]
pub(crate) const PSTATE_EL1H_DAIF: u64 = 0x3c5;

/// The MPIDR_EL1 of vCPU `id`, as KVM resets it and QEMU sets it: 16 vCPUs
/// per Aff1 cluster, so a GICv3 SGI target list reaches each of them.
#[cfg(target_arch = "aarch64")]
pub(crate) fn mpidr(id: u8) -> u64 {
    u64::from(id % 16) | (u64::from(id / 16) << 8)
}

/// A host VM whose vCPUs this architecture's boot path can configure.
pub(crate) trait BootableVm: HostVm {
    /// Configures vCPU `id` of `count` before the start gate; only vCPU 0
    /// gets `boot_regs`.
    fn configure(
        &self,
        vcpu: &mut Self::Vcpu,
        id: u8,
        count: u8,
        boot_regs: &BootRegisters,
    ) -> boxlite_hypervisor::Result<()>;

    /// Points a secondary vCPU that `CPU_ON` started at its entry.
    #[cfg(target_arch = "aarch64")]
    fn start(
        &self,
        vcpu: &mut Self::Vcpu,
        regs: &Arm64BootRegisters,
    ) -> boxlite_hypervisor::Result<()>;
}

#[cfg(target_arch = "x86_64")]
impl<H: X86Vm> BootableVm for H {
    fn configure(
        &self,
        vcpu: &mut Self::Vcpu,
        id: u8,
        count: u8,
        boot_regs: &BootRegisters,
    ) -> boxlite_hypervisor::Result<()> {
        let cpuid = vcpu_cpuid(self.supported_cpuid(), id, count);
        vcpu.set_cpu_features(&cpuid, &BOOT_MSRS)?;
        // The other vCPUs wait in their reset state for INIT and SIPI.
        if id == 0 {
            vcpu.set_boot_registers(boot_regs)?;
        }
        Ok(())
    }
}

#[cfg(target_arch = "aarch64")]
impl<H: HostVm<Vcpu: Arm64Vcpu>> BootableVm for H {
    fn configure(
        &self,
        vcpu: &mut Self::Vcpu,
        id: u8,
        _count: u8,
        boot_regs: &BootRegisters,
    ) -> boxlite_hypervisor::Result<()> {
        vcpu.set_mpidr(mpidr(id))?;
        // The other vCPUs wait powered off for the guest's CPU_ON.
        if id == 0 {
            vcpu.set_boot_registers(boot_regs)?;
        }
        Ok(())
    }

    fn start(
        &self,
        vcpu: &mut Self::Vcpu,
        regs: &Arm64BootRegisters,
    ) -> boxlite_hypervisor::Result<()> {
        vcpu.set_boot_registers(regs)
    }
}

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

/// Where one vCPU is in its power-up.
#[cfg(target_arch = "aarch64")]
enum Power {
    Off,
    /// A `CPU_ON` named it; its worker has not picked the entry up yet.
    Starting(Arm64BootRegisters),
    On,
}

/// Which vCPUs the guest has started with PSCI `CPU_ON`: vCPU 0 starts on,
/// the others off until the guest starts them, once each.
#[cfg(target_arch = "aarch64")]
pub(crate) struct PowerStates {
    vcpus: Mutex<Vec<Power>>,
    changed: Condvar,
}

#[cfg(target_arch = "aarch64")]
impl PowerStates {
    pub(crate) fn new(count: u8) -> Self {
        let vcpus = (0..count)
            .map(|id| if id == 0 { Power::On } else { Power::Off })
            .collect();
        Self {
            vcpus: Mutex::new(vcpus),
            changed: Condvar::new(),
        }
    }

    /// Answers a `CPU_ON` for the vCPU whose MPIDR is `target`: a powered-off
    /// vCPU starts at `entry` with `context_id` in X0.
    fn start(&self, target: u64, entry: u64, context_id: u64) -> CpuOnResult {
        // AArch64 instructions are four-byte aligned (QEMU arm-powerctl.c).
        if !entry.is_multiple_of(4) {
            return CpuOnResult::InvalidParameters;
        }
        let mut vcpus = self.vcpus.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(power) = (0..=u8::MAX)
            .zip(vcpus.iter_mut())
            .find_map(|(id, power)| (mpidr(id) == target).then_some(power))
        else {
            return CpuOnResult::InvalidParameters;
        };
        if !matches!(power, Power::Off) {
            return CpuOnResult::AlreadyOn;
        }
        *power = Power::Starting(Arm64BootRegisters {
            pc: entry,
            x0: context_id,
            pstate: PSTATE_EL1H_DAIF,
        });
        self.changed.notify_all();
        CpuOnResult::Success
    }

    /// Waits until vCPU `id` is started and returns its entry registers, or
    /// returns `None` once the VM is stopping.
    fn wait_for_start(&self, id: u8, sender: &EventSender) -> Option<Arm64BootRegisters> {
        let vcpus = self.vcpus.lock().unwrap_or_else(PoisonError::into_inner);
        let mut vcpus = self
            .changed
            .wait_while(vcpus, |vcpus| {
                matches!(vcpus[usize::from(id)], Power::Off) && !sender.is_stopping()
            })
            .unwrap_or_else(PoisonError::into_inner);
        if sender.is_stopping() {
            return None;
        }
        match std::mem::replace(&mut vcpus[usize::from(id)], Power::On) {
            Power::Starting(regs) => Some(regs),
            Power::Off | Power::On => unreachable!("only a started vCPU leaves the wait"),
        }
    }

    /// Wakes every waiting vCPU so it sees the VM stopping. Taking the lock
    /// orders this after any waiter's check of the stop latch.
    pub(crate) fn wake_all(&self) {
        let _vcpus = self.vcpus.lock().unwrap_or_else(PoisonError::into_inner);
        self.changed.notify_all();
    }
}

/// What every worker of one VM shares.
pub(crate) struct Workers<'a, H: BootableVm> {
    pub(crate) host_vm: &'a H,
    pub(crate) vcpu_count: u8,
    pub(crate) boot_regs: &'a BootRegisters,
    pub(crate) chipset: &'a Chipset,
    pub(crate) sender: &'a EventSender,
    /// The kick handle of every configured vCPU, for the thread that stops them.
    pub(crate) kicks: &'a Mutex<Vec<<H::Vcpu as Vcpu>::Handle>>,
    pub(crate) gate: &'a StartGate,
    #[cfg(target_arch = "aarch64")]
    pub(crate) power: &'a PowerStates,
}

impl<H: BootableVm> Workers<'_, H> {
    /// The body of the thread of vCPU `id`. A panic in it, such as a device
    /// whose lock an earlier panic poisoned, ends the VM with
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
        self.gate.arrive_and_wait(self.vcpu_count);
        let Some(mut vcpu) = vcpu else {
            return;
        };
        match catch_panic(id, || self.run_guest(&mut vcpu, id)) {
            Ok(Some(event)) => self.sender.send(event),
            Ok(None) => {}
            Err(error) => self.sender.send(Event::VcpuFailed(error)),
        }
    }

    fn configure(&self, id: u8) -> Result<H::Vcpu> {
        let mut vcpu = self.host_vm.create_vcpu(id.into())?;
        self.host_vm
            .configure(&mut vcpu, id, self.vcpu_count, self.boot_regs)?;
        self.kicks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(vcpu.handle());
        Ok(vcpu)
    }

    /// Runs the guest until it asks to end, which returns the event, or until
    /// another sender ends the VM, which returns `None` after completing the
    /// pending access.
    fn run_guest(&self, vcpu: &mut H::Vcpu, id: u8) -> Result<Option<Event>> {
        // A secondary waits powered off, outside the guest, for its CPU_ON.
        #[cfg(target_arch = "aarch64")]
        if id != 0 {
            let Some(regs) = self.power.wait_for_start(id, self.sender) else {
                return Ok(None);
            };
            self.host_vm.start(vcpu, &regs)?;
        }
        loop {
            // Checked before every entry: a stop that lands earlier still
            // returns from the next entry at once, since its kick is pending.
            if self.sender.is_stopping() {
                vcpu.complete_pending_io()?;
                return Ok(None);
            }
            match self.chipset.dispatch(vcpu.run()?) {
                None | Some(VcpuExit::Interrupted) => {}
                Some(VcpuExit::Shutdown) => return Ok(Some(Event::GuestShutdown)),
                Some(VcpuExit::Reset) => return Ok(Some(Event::GuestReset)),
                // The next entry hands the answer back to the guest.
                #[cfg(target_arch = "aarch64")]
                Some(VcpuExit::CpuOn {
                    target,
                    entry,
                    context_id,
                    result,
                }) => *result = self.power.start(target, entry, context_id),
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

#[cfg(all(test, target_arch = "aarch64"))]
#[path = "../tests/vcpu/mod.rs"]
mod tests;
