// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    io,
    marker::PhantomData,
    ptr::{self, NonNull},
    rc::Rc,
    sync::{Arc, Mutex, PoisonError},
};

use super::{
    check,
    ffi::{self, hv_vcpu_exit_t, hv_vcpu_t},
    psci::{self, PsciCall},
    syndrome::{MmioAccess, Syndrome, SysRegAccess},
};
use crate::{Arm64BootRegisters, CpuOnResult, Error, Result, VcpuExit};

/// An HVF vCPU, bound to the thread that created it.
///
/// `run` answers PSCI queries and the system registers it emulates itself,
/// and returns only the exits the VMM handles. A vCPU waiting in WFI waits
/// inside HVF, which wakes it for its timer and the GIC's interrupts.
#[derive(Debug)]
pub struct HvfVcpu {
    id: u32,
    /// The HVF vCPU ID.
    pub(super) vcpu: hv_vcpu_t,
    /// HVF's exit record for this vCPU, valid until the vCPU is destroyed.
    exit: NonNull<hv_vcpu_exit_t>,
    /// The exited instruction to finish before the guest runs again.
    pending: Option<Pending>,
    /// An MMIO access's data, little endian.
    data: [u8; 8],
    /// The VMM's answer to a `CPU_ON`.
    cpu_on: CpuOnResult,
    /// The OS lock OSLAR_EL1 sets and OSLSR_EL1 reports.
    os_lock: bool,
    /// The ID kicks reach, cleared before HVF can reuse it.
    kick_target: Arc<Mutex<Option<hv_vcpu_t>>>,
    _thread_bound: PhantomData<Rc<()>>,
}

/// An exited instruction the VMM has handled but the guest has not finished.
#[derive(Clone, Copy, Debug)]
enum Pending {
    /// A read fills its register from `data`; either access moves PC past it.
    Mmio(MmioAccess),
    /// X0 returns the VMM's answer; HVC already moved PC.
    CpuOn,
}

impl HvfVcpu {
    pub(super) fn new(id: u32) -> Result<Self> {
        let create_failed = |source| Error::CreateVcpu { id, source };
        let mut vcpu = 0;
        let mut exit = ptr::null();
        // SAFETY: HVF writes the ID and its exit record's address through the
        // pointers; a null configuration selects HVF's defaults.
        check(unsafe { ffi::hv_vcpu_create(&mut vcpu, &mut exit, ptr::null_mut()) })
            .map_err(create_failed)?;
        let Some(exit) = NonNull::new(exit.cast_mut()) else {
            // SAFETY: the vCPU was created on this thread and is unused.
            let _ = unsafe { ffi::hv_vcpu_destroy(vcpu) };
            return Err(create_failed(io::Error::other(
                "HVF returned no exit record",
            )));
        };
        Ok(Self {
            id,
            vcpu,
            exit,
            pending: None,
            data: [0; 8],
            cpu_on: CpuOnResult::InternalFailure,
            os_lock: false,
            kick_target: Arc::new(Mutex::new(Some(vcpu))),
            _thread_bound: PhantomData,
        })
    }

    /// Returns a handle that interrupts this vCPU from any thread.
    pub fn handle(&self) -> HvfVcpuHandle {
        HvfVcpuHandle {
            id: self.id,
            target: Arc::clone(&self.kick_target),
        }
    }

    /// Runs until the next exit the VMM handles; handle borrowed device bytes
    /// before re-entry.
    pub fn run(&mut self) -> Result<VcpuExit<'_>> {
        let id = self.id;
        let failed = move |source| Error::RunVcpu { id, source };
        self.finish_pending().map_err(failed)?;
        loop {
            // SAFETY: the type is `!Send`, so this is the owning thread.
            check(unsafe { ffi::hv_vcpu_run(self.vcpu) }).map_err(failed)?;
            // SAFETY: HVF writes the record only inside `hv_vcpu_run`, and
            // keeps it until the vCPU is destroyed.
            let exit = unsafe { self.exit.as_ref() };
            let (reason, esr, address) = (
                exit.reason,
                exit.exception.syndrome,
                exit.exception.physical_address,
            );
            match reason {
                ffi::HV_EXIT_REASON_CANCELED => return Ok(VcpuExit::Interrupted),
                ffi::HV_EXIT_REASON_EXCEPTION => {}
                // The in-kernel GIC owns the vtimer, so HVF never asks the
                // VMM to deliver it.
                reason => return Err(self.unhandled(format!("exit reason {reason}"))),
            }
            match Syndrome::decode(esr) {
                Syndrome::Mmio(access) => return self.mmio(access, address).map_err(failed),
                Syndrome::Hvc => match PsciCall::decode(self.psci_arguments().map_err(failed)?) {
                    PsciCall::Version => self.set_x(0, psci::VERSION_0_2).map_err(failed)?,
                    PsciCall::MigrateInfoType => {
                        self.set_x(0, psci::TRUSTED_OS_NOT_PRESENT)
                            .map_err(failed)?;
                    }
                    PsciCall::NotSupported => self.set_x(0, psci::NOT_SUPPORTED).map_err(failed)?,
                    PsciCall::SystemOff => return Ok(VcpuExit::Shutdown),
                    PsciCall::SystemReset => return Ok(VcpuExit::Reset),
                    PsciCall::CpuOn {
                        target,
                        entry,
                        context_id,
                    } => {
                        self.cpu_on = CpuOnResult::InternalFailure;
                        self.pending = Some(Pending::CpuOn);
                        return Ok(VcpuExit::CpuOn {
                            target,
                            entry,
                            context_id,
                            result: &mut self.cpu_on,
                        });
                    }
                },
                Syndrome::SysReg(access) => self.system_register(access)?,
                // With the in-kernel GIC, HVF waits out WFI itself, so a trap
                // is a spurious wake; cache maintenance on a device does nothing.
                Syndrome::Wfx | Syndrome::CacheMaintenance => self.advance_pc().map_err(failed)?,
                Syndrome::Smc => {
                    return Err(self.unhandled("smc, while the PSCI conduit is hvc".into()));
                }
                Syndrome::Unhandled(reason) => return Err(self.unhandled(reason)),
            }
        }
    }

    /// Finishes a handled access without executing another guest instruction.
    /// A second completion is a no-op; a failure keeps the access pending.
    pub fn complete_pending_io(&mut self) -> Result<()> {
        self.finish_pending()
            .map_err(|source| Error::CompletePendingIo {
                id: self.id,
                source,
            })
    }

    /// Sets MPIDR_EL1. Call it before the first entry.
    pub fn set_mpidr(&mut self, mpidr: u64) -> Result<()> {
        // SAFETY: the type is `!Send`, so this is the owning thread.
        let code = unsafe { ffi::hv_vcpu_set_sys_reg(self.vcpu, ffi::HV_SYS_REG_MPIDR_EL1, mpidr) };
        check(code).map_err(|source| self.configure_failed("set MPIDR_EL1", source))
    }

    /// Installs the entry registers. Call it before the first entry.
    pub fn set_boot_registers(&mut self, regs: &Arm64BootRegisters) -> Result<()> {
        for (reg, value, operation) in [
            (ffi::HV_REG_CPSR, regs.pstate, "set PSTATE"),
            (ffi::HV_REG_PC, regs.pc, "set PC"),
            (ffi::HV_REG_X0, regs.x0, "set X0"),
        ] {
            self.set_reg(reg, value)
                .map_err(|source| self.configure_failed(operation, source))?;
        }
        Ok(())
    }

    /// Writes a read's value or the `CPU_ON` answer, and moves PC past an
    /// MMIO access, once per exit.
    fn finish_pending(&mut self) -> io::Result<()> {
        match self.pending {
            None => return Ok(()),
            Some(Pending::Mmio(access)) => {
                if !access.write {
                    let raw = u64::from_le_bytes(self.data);
                    self.set_x(access.register, access.extend(raw))?;
                }
                self.advance_pc()?;
            }
            Some(Pending::CpuOn) => self.set_x(0, psci::cpu_on_return(self.cpu_on))?,
        }
        self.pending = None;
        Ok(())
    }

    /// Lends the VMM the access's bytes: a write's from its register, a
    /// read's zeroed for the device to fill.
    fn mmio(&mut self, access: MmioAccess, guest_addr: u64) -> io::Result<VcpuExit<'_>> {
        self.data = if access.write {
            self.x(access.register)?.to_le_bytes()
        } else {
            [0; 8]
        };
        self.pending = Some(Pending::Mmio(access));
        let bytes = &mut self.data[..access.len];
        Ok(if access.write {
            VcpuExit::MmioWrite { guest_addr, bytes }
        } else {
            VcpuExit::MmioRead { guest_addr, bytes }
        })
    }

    fn system_register(&mut self, access: SysRegAccess) -> Result<()> {
        let failed = |source| Error::RunVcpu {
            id: self.id,
            source,
        };
        let written = if access.read {
            0
        } else {
            self.x(access.register).map_err(failed)?
        };
        let Some(value) = access.emulate(&mut self.os_lock, written) else {
            return Err(self.unhandled(format!("system register access {access:?}")));
        };
        if access.read {
            self.set_x(access.register, value).map_err(failed)?;
        }
        self.advance_pc().map_err(failed)
    }

    fn psci_arguments(&self) -> io::Result<[u64; 4]> {
        Ok([self.x(0)?, self.x(1)?, self.x(2)?, self.x(3)?])
    }

    /// Xn, where 31 is XZR: HVF numbers PC as register 31.
    fn x(&self, n: u8) -> io::Result<u64> {
        if n == 31 {
            return Ok(0);
        }
        self.reg(ffi::HV_REG_X0 + u32::from(n))
    }

    /// Writes Xn; a write to XZR is discarded.
    fn set_x(&self, n: u8, value: u64) -> io::Result<()> {
        if n == 31 {
            return Ok(());
        }
        self.set_reg(ffi::HV_REG_X0 + u32::from(n), value)
    }

    fn advance_pc(&self) -> io::Result<()> {
        let pc = self.reg(ffi::HV_REG_PC)?;
        self.set_reg(ffi::HV_REG_PC, pc.wrapping_add(4))
    }

    fn reg(&self, reg: u32) -> io::Result<u64> {
        let mut value = 0;
        // SAFETY: the type is `!Send`, so this is the owning thread.
        check(unsafe { ffi::hv_vcpu_get_reg(self.vcpu, reg, &mut value) })?;
        Ok(value)
    }

    fn set_reg(&self, reg: u32, value: u64) -> io::Result<()> {
        // SAFETY: the type is `!Send`, so this is the owning thread.
        check(unsafe { ffi::hv_vcpu_set_reg(self.vcpu, reg, value) })
    }

    fn configure_failed(&self, operation: &'static str, source: io::Error) -> Error {
        Error::ConfigureVcpu {
            id: self.id,
            operation,
            source,
        }
    }

    /// An exit the backend does not resolve, at the guest's PC.
    fn unhandled(&self, reason: String) -> Error {
        let at = match self.reg(ffi::HV_REG_PC) {
            Ok(pc) => format!(" at PC {pc:#x}"),
            Err(_) => String::new(),
        };
        Error::UnhandledExit {
            id: self.id,
            reason: format!("{reason}{at}"),
        }
    }
}

impl Drop for HvfVcpu {
    fn drop(&mut self) {
        // Clearing the target first means no kick reaches an ID that HVF
        // may hand to the next vCPU.
        *self
            .kick_target
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
        // A failure leaves the VM unable to be destroyed, which the next VM
        // creation reports.
        // SAFETY: the owning thread destroys its vCPU once.
        let _ = check(unsafe { ffi::hv_vcpu_destroy(self.vcpu) });
    }
}

impl crate::Vcpu for HvfVcpu {
    type Handle = HvfVcpuHandle;

    fn run(&mut self) -> Result<VcpuExit<'_>> {
        Self::run(self)
    }

    fn complete_pending_io(&mut self) -> Result<()> {
        Self::complete_pending_io(self)
    }

    fn handle(&self) -> Self::Handle {
        Self::handle(self)
    }
}

impl crate::Arm64Vcpu for HvfVcpu {
    fn set_mpidr(&mut self, mpidr: u64) -> Result<()> {
        Self::set_mpidr(self, mpidr)
    }

    fn set_boot_registers(&mut self, regs: &Arm64BootRegisters) -> Result<()> {
        Self::set_boot_registers(self, regs)
    }
}

/// Kicks one HVF vCPU from any thread. HVF holds a kick that lands outside
/// the guest until the next run (`hv_vcpu.h`); a kick after the vCPU is
/// dropped does nothing.
#[derive(Clone, Debug)]
pub struct HvfVcpuHandle {
    id: u32,
    target: Arc<Mutex<Option<hv_vcpu_t>>>,
}

impl crate::VcpuHandle for HvfVcpuHandle {
    fn kick(&self) -> Result<()> {
        let target = self.target.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(vcpu) = *target else {
            return Ok(());
        };
        // SAFETY: the vCPU exists while the lock holds its ID, and HVF
        // accepts exits from any thread.
        check(unsafe { ffi::hv_vcpus_exit(&vcpu, 1) }).map_err(|source| Error::KickVcpu {
            id: self.id,
            source,
        })
    }
}
