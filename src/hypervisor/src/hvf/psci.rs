// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The PSCI 0.2 calls the backend serves over HVC
//! (`include/uapi/linux/psci.h`). Linux on a 0.2 firmware calls only these at
//! boot and shutdown, and asks for no feature PSCI 1.0 added
//! (`drivers/firmware/psci/psci.c`).

use crate::CpuOnResult;

const FN_VERSION: u32 = 0x8400_0000;
const FN_MIGRATE_INFO_TYPE: u32 = 0x8400_0006;
const FN_SYSTEM_OFF: u32 = 0x8400_0008;
const FN_SYSTEM_RESET: u32 = 0x8400_0009;
const FN64_CPU_ON: u32 = 0xc400_0003;

/// `PSCI_VERSION`: major 0, minor 2.
pub(super) const VERSION_0_2: u64 = 2;
/// `MIGRATE_INFO_TYPE`: no Trusted OS needs migrating.
pub(super) const TRUSTED_OS_NOT_PRESENT: u64 = 2;
pub(super) const NOT_SUPPORTED: u64 = -1_i64 as u64;

/// A guest's PSCI call, from X0 to X3.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum PsciCall {
    Version,
    MigrateInfoType,
    SystemOff,
    SystemReset,
    CpuOn {
        target: u64,
        entry: u64,
        context_id: u64,
    },
    /// Any other function, which returns `NOT_SUPPORTED`.
    NotSupported,
}

impl PsciCall {
    pub(super) fn decode([function, x1, x2, x3]: [u64; 4]) -> Self {
        // The function ID is W0; the upper half of X0 carries nothing.
        match function as u32 {
            FN_VERSION => Self::Version,
            FN_MIGRATE_INFO_TYPE => Self::MigrateInfoType,
            FN_SYSTEM_OFF => Self::SystemOff,
            FN_SYSTEM_RESET => Self::SystemReset,
            FN64_CPU_ON => Self::CpuOn {
                target: x1,
                entry: x2,
                context_id: x3,
            },
            _ => Self::NotSupported,
        }
    }
}

/// The value X0 returns for `result`.
pub(super) fn cpu_on_return(result: CpuOnResult) -> u64 {
    let code: i64 = match result {
        CpuOnResult::Success => 0,
        CpuOnResult::InvalidParameters => -2,
        CpuOnResult::AlreadyOn => -4,
        CpuOnResult::InternalFailure => -6,
    };
    code as u64
}
