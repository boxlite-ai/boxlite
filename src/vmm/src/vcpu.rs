// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use boxlite_hypervisor::VcpuExit;

use crate::{error::VmResult, vm::VmExit};

pub(crate) struct Vcpu;

impl Vcpu {
    #[expect(unreachable_code, clippy::diverging_sub_expression)]
    pub(crate) fn run(&mut self) -> VmResult<VmExit> {
        loop {
            let _stop_requested: bool = todo!("check the stop request");
            if _stop_requested {
                let _completion: VmResult<()> =
                    todo!("finish pending I/O without executing another guest instruction");
                _completion?;
                return Ok(VmExit::StopRequested);
            }
            let exit: VmResult<VcpuExit<'_>> = todo!("finish pending I/O and enter the guest");
            match exit? {
                VcpuExit::MmioRead { .. } => todo!("read device bytes into the MMIO buffer"),
                VcpuExit::MmioWrite { .. } => todo!("write MMIO buffer bytes to the device"),
                VcpuExit::Interrupted => continue,
                VcpuExit::Halted => todo!("wait for an interrupt or stop request"),
                VcpuExit::Shutdown => return Ok(VmExit::GuestShutdown),
                VcpuExit::Reset => return Ok(VmExit::GuestReset),
            }
        }
    }
}
