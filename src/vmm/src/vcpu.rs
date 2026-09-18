// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use crate::{error::VmResult, vm::VmExit};

pub(crate) struct Vcpu;

impl Vcpu {
    pub(crate) fn run(&mut self) -> VmResult<VmExit> {
        todo!("run the vCPU loop")
    }
}
