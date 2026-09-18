// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use crate::error::VmResult;

pub(crate) enum VmExit {
    StopRequested,
    GuestShutdown,
    GuestReset,
}

enum VmEvent {
    DeviceReady(usize),
    StopRequested,
    VcpuExited(VmResult<VmExit>),
}

pub(crate) struct Vm;

impl Vm {
    pub(crate) fn run(&mut self) -> VmResult<VmExit> {
        let outcome = loop {
            match self.wait_event() {
                Ok(VmEvent::DeviceReady(id)) => {
                    if let Err(error) = self.process_device(id) {
                        break Err(error);
                    }
                }
                Ok(VmEvent::StopRequested) => break Ok(VmExit::StopRequested),
                Ok(VmEvent::VcpuExited(outcome)) => break outcome,
                Err(error) => break Err(error),
            }
        };
        let joined = self.stop_and_join_vcpus();
        outcome.and_then(|exit| joined.map(|()| exit))
    }

    fn wait_event(&mut self) -> VmResult<VmEvent> {
        todo!("wait for device events, stop requests, or worker results")
    }

    fn process_device(&mut self, _id: usize) -> VmResult<()> {
        todo!("dispatch the ready device")
    }

    fn stop_and_join_vcpus(&mut self) -> VmResult<()> {
        todo!("request stop, kick blocked vCPUs, and join every worker even if one fails")
    }
}
