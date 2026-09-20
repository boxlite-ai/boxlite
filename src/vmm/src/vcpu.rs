// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use boxlite_hypervisor::VcpuExit;

use crate::{error::Result, vm::VmExit};

pub(crate) struct Vcpu;

impl Vcpu {
    #[expect(unreachable_code, clippy::diverging_sub_expression)]
    pub(crate) fn run(&mut self) -> Result<VmExit> {
        loop {
            let _stop_requested: bool = todo!("check the stop request");
            if _stop_requested {
                let _completion: boxlite_hypervisor::Result<()> =
                    todo!("call backend.complete_pending_io() before stopping");
                _completion?;
                return Ok(VmExit::StopRequested);
            }
            let exit: boxlite_hypervisor::Result<VcpuExit<'_>> =
                todo!("finish pending I/O and enter the guest");
            match exit? {
                VcpuExit::MmioRead { .. } => todo!("read device bytes into the MMIO buffer"),
                VcpuExit::MmioWrite { .. } => todo!("write MMIO buffer bytes to the device"),
                #[cfg(target_arch = "x86_64")]
                VcpuExit::IoIn { .. } => todo!("read device bytes into the port buffer"),
                #[cfg(target_arch = "x86_64")]
                VcpuExit::IoOut { .. } => todo!("write port buffer bytes to the device"),
                VcpuExit::Interrupted => continue,
                VcpuExit::Halted => {
                    todo!("park until the guest timer deadline, an interrupt, or a stop request")
                }
                VcpuExit::Shutdown => return Ok(VmExit::GuestShutdown),
                VcpuExit::Reset => return Ok(VmExit::GuestReset),
            }
        }
    }
}
