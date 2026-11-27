// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io;

use boxlite_hypervisor::{X86VcpuState, X86VmState};
use serde::{Deserialize, Serialize};

use crate::{Error, Result, config::MAX_VCPUS};

const CR0_PG: u64 = 1 << 31;
const CR4_PAE: u64 = 1 << 5;
const EFER_LMA: u64 = 1 << 10;

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

    pub(crate) fn decode(bytes: &[u8], expected: u32) -> Result<Self> {
        let invalid = |reason| Error::Snapshot(io::Error::new(io::ErrorKind::InvalidData, reason));
        let decode_error =
            |error| Error::Snapshot(io::Error::new(io::ErrorKind::InvalidData, error));
        // Read the leading sequence length before deserializing its records.
        let (count, _) = postcard::take_from_bytes::<usize>(bytes).map_err(decode_error)?;
        if !(1..=usize::from(MAX_VCPUS)).contains(&count) || count != expected as usize {
            return Err(invalid("invalid machine vCPU count"));
        }
        let (state, trailing) = postcard::take_from_bytes::<Self>(bytes).map_err(decode_error)?;
        if !trailing.is_empty() {
            return Err(invalid("trailing bytes in machine state"));
        }
        for (id, record) in state.vcpus.iter().enumerate() {
            if usize::from(record.id) != id {
                return Err(invalid("vCPU records must be contiguous and ordered by id"));
            }
            let sregs = &record.state.sregs;
            if sregs.cr0 & CR0_PG != 0 && sregs.cr4 & CR4_PAE != 0 && sregs.efer & EFER_LMA == 0 {
                return Err(invalid("32-bit paged PAE vCPU state is unsupported"));
            }
        }
        let irqchip_ids = state
            .platform
            .irqchips
            .each_ref()
            .map(|chip| chip.as_kvm().chip_id);
        if irqchip_ids != [0, 1, 2] {
            return Err(invalid("IRQ chip IDs must be 0, 1, and 2 in order"));
        }
        if state.platform.pit.is_none() {
            return Err(invalid("missing PIT state"));
        }
        Ok(state)
    }
}
