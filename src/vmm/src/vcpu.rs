// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use crate::{error::VmResult, vm::VmExit};

pub(crate) struct Vcpu;

impl Vcpu {
    #[expect(unreachable_code, clippy::diverging_sub_expression)]
    pub(crate) fn run(&mut self) -> VmResult<VmExit> {
        enum Exit {
            Mmio,
            Interrupted,
            Halted,
            Shutdown,
            Reset,
        }

        loop {
            let _stop_requested: bool = todo!("check the stop request");
            if _stop_requested {
                return Ok(VmExit::StopRequested);
            }
            let exit: VmResult<Exit> = todo!("enter the guest");
            match exit? {
                Exit::Mmio => todo!("dispatch MMIO and complete backend I/O"),
                Exit::Interrupted => continue,
                Exit::Halted => todo!("wait for an interrupt or stop request"),
                Exit::Shutdown => return Ok(VmExit::GuestShutdown),
                Exit::Reset => return Ok(VmExit::GuestReset),
            }
        }
    }
}
