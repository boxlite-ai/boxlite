// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use crate::error::{Error, Result};

pub(crate) enum VmExit {
    StopRequested,
    GuestShutdown,
    GuestReset,
}

pub(crate) struct Vm;

impl Vm {
    #[expect(unreachable_code, clippy::diverging_sub_expression)]
    pub(crate) fn run(&mut self) -> Result<VmExit> {
        // Device workers process their own queues, so every event that
        // reaches this thread ends the VM.
        enum Event {
            StopRequested,
            VcpuExited(Result<VmExit>),
            DeviceFailed(Error),
        }

        let _event: Result<Event> = todo!("wait for the first terminal VM event");
        let _outcome = match _event {
            Ok(Event::StopRequested) => Ok(VmExit::StopRequested),
            Ok(Event::VcpuExited(outcome)) => outcome,
            Ok(Event::DeviceFailed(error)) | Err(error) => Err(error),
        };
        let joined: Result<()> = todo!("stop and join the vCPU and device worker threads");
        _outcome.and_then(|exit| joined.map(|()| exit))
    }
}
