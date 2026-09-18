// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use crate::{error::VmResult, vm::VmExit};

enum VcpuExit {
    Mmio,
    Interrupted,
    Halted,
    Shutdown,
    Reset,
}

pub(crate) struct Vcpu;

impl Vcpu {
    pub(crate) fn run(&mut self) -> VmResult<VmExit> {
        loop {
            if self.stop_requested() {
                return Ok(VmExit::StopRequested);
            }
            match self.enter_guest()? {
                VcpuExit::Mmio => self.service_mmio()?,
                VcpuExit::Interrupted => continue,
                VcpuExit::Halted => self.wait_for_irq_or_stop()?,
                VcpuExit::Shutdown => return Ok(VmExit::GuestShutdown),
                VcpuExit::Reset => return Ok(VmExit::GuestReset),
            }
        }
    }

    fn stop_requested(&self) -> bool {
        todo!("check the shared stop request")
    }

    fn enter_guest(&mut self) -> VmResult<VcpuExit> {
        todo!("enter the guest through boxlite-hypervisor")
    }

    fn service_mmio(&mut self) -> VmResult<()> {
        todo!("dispatch the pending MMIO through the bus, then complete backend I/O")
    }

    fn wait_for_irq_or_stop(&mut self) -> VmResult<()> {
        todo!("wait for an interrupt or stop request")
    }
}
