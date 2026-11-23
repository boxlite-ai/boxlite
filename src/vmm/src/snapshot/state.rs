// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use boxlite_hypervisor::{X86VcpuState, X86VmState};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct MachineState {
    pub(crate) vcpus: Vec<VcpuRecord>,
    pub(crate) platform: X86VmState,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct VcpuRecord {
    pub(crate) id: u8,
    pub(crate) state: X86VcpuState,
}

impl MachineState {
    pub(crate) fn encode(&self) -> Result<Vec<u8>> {
        postcard::to_allocvec(self).map_err(|error| Error::Snapshot(std::io::Error::other(error)))
    }
}
