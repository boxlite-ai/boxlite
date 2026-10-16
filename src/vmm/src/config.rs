// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Machine configuration and boundary validation.

use crate::{
    error::{Error, Result},
    memory::MAX_MEMORY_MIB,
};

/// Largest vCPU count a guest can use. The M1 guest kernel configuration sets
/// `CONFIG_NR_CPUS=64`, so further vCPUs would never run guest code; the
/// count also stays well under the 254 xAPIC ids an x86 MP table can list.
pub(crate) const MAX_VCPUS: u8 = 64;

/// The machine the VMM builds. The M2 engine adapter fills it from the
/// runtime's `InstanceSpec`, whose `memory_mib` field shares the name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct VmConfig {
    /// Number of vCPUs, `1..=MAX_VCPUS`.
    pub(crate) vcpu_count: u8,
    /// Guest RAM in MiB, `1..=MAX_MEMORY_MIB`.
    pub(crate) memory_mib: u32,
}

impl VmConfig {
    /// Rejects counts and sizes the layout cannot place, before any host call.
    pub(crate) fn validate(&self) -> Result<()> {
        if !(1..=MAX_VCPUS).contains(&self.vcpu_count) {
            return Err(Error::InvalidVcpuCount(self.vcpu_count));
        }
        if !(1..=MAX_MEMORY_MIB).contains(&self.memory_mib) {
            return Err(Error::InvalidMemorySize(self.memory_mib));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::error::Error as _;

    use super::{MAX_VCPUS, VmConfig};
    use crate::{error::Error, memory::MAX_MEMORY_MIB};

    fn config(vcpu_count: u8, memory_mib: u32) -> VmConfig {
        VmConfig {
            vcpu_count,
            memory_mib,
        }
    }

    #[test]
    fn rejects_counts_and_sizes_outside_the_layout_with_typed_errors() {
        for (config, message) in [
            (config(0, 1), "invalid vCPU count: 0"),
            (config(65, 1), "invalid vCPU count: 65"),
            (config(1, 0), "invalid memory size: 0 MiB"),
            (config(1, 3073), "invalid memory size: 3073 MiB"),
        ] {
            let error = config.validate().unwrap_err();
            assert_eq!(error.to_string(), message);
            assert!(matches!(
                error,
                Error::InvalidVcpuCount(_) | Error::InvalidMemorySize(_)
            ));
            assert!(error.source().is_none(), "{config:?}");
        }
        config(1, 1).validate().unwrap();
        config(MAX_VCPUS, MAX_MEMORY_MIB).validate().unwrap();
    }
}
