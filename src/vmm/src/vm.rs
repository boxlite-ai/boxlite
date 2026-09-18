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
    pub(crate) fn run(&mut self) -> VmResult<VmExit> {
        todo!("run the VM event loop")
    }
}
