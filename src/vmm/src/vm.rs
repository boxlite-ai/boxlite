// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use crate::error::VmResult;

pub(crate) enum VmExit {
    StopRequested,
    GuestShutdown,
    GuestReset,
}

pub(crate) struct Vm;

impl Vm {
    #[expect(unreachable_code, unused_variables, clippy::diverging_sub_expression)]
    pub(crate) fn run(&mut self) -> VmResult<VmExit> {
        enum Event {
            DeviceReady,
            StopRequested,
            VcpuExited(VmResult<VmExit>),
        }

        let outcome = loop {
            let event: VmResult<Event> = todo!("wait for a VM event");
            match event {
                Ok(Event::DeviceReady) => {
                    let result: VmResult<()> = todo!("process the ready device");
                    if let Err(error) = result {
                        break Err(error);
                    }
                }
                Ok(Event::StopRequested) => break Ok(VmExit::StopRequested),
                Ok(Event::VcpuExited(outcome)) => break outcome,
                Err(error) => break Err(error),
            }
        };
        let joined: VmResult<()> = todo!("stop and join all vCPU workers");
        outcome.and_then(|exit| joined.map(|()| exit))
    }
}
