// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Decodes the exception syndrome (`ESR_EL2`) of an HVF exit, and emulates
//! the system registers Linux touches at boot that HVF traps. Raw syndromes
//! stay inside the backend.

/// Exception classes (`ESR_EL2.EC`) the backend handles.
const EC_WFX: u64 = 0x01;
const EC_HVC64: u64 = 0x16;
const EC_SMC64: u64 = 0x17;
const EC_SYS64: u64 = 0x18;
const EC_DATA_ABORT_LOWER: u64 = 0x24;

/// Data abort ISS fields.
const ISV: u64 = 1 << 24;
const SSE: u64 = 1 << 21;
const SF: u64 = 1 << 15;
const CM: u64 = 1 << 8;
const S1PTW: u64 = 1 << 7;
const WNR: u64 = 1 << 6;

/// What a guest exception asks of the backend.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Syndrome {
    /// A load or store the VMM emulates.
    Mmio(MmioAccess),
    /// Cache maintenance on an address no RAM backs, which has no effect.
    CacheMaintenance,
    /// `hvc`, the PSCI conduit; PC is already past it.
    Hvc,
    /// `smc`, which traps with PC at it.
    Smc,
    /// `mrs` or `msr` on a register HVF does not handle.
    SysReg(SysRegAccess),
    /// `wfi` or `wfe`.
    Wfx,
    /// An exception the backend cannot resolve, described for diagnostics.
    Unhandled(String),
}

impl Syndrome {
    pub(super) fn decode(esr: u64) -> Self {
        let iss = esr & 0x1ff_ffff;
        match (esr >> 26) & 0x3f {
            EC_DATA_ABORT_LOWER => Self::data_abort(iss),
            EC_HVC64 => Self::Hvc,
            EC_SMC64 => Self::Smc,
            EC_SYS64 => Self::SysReg(SysRegAccess::decode(iss)),
            EC_WFX => Self::Wfx,
            ec => Self::Unhandled(format!("exception class {ec:#x}, syndrome {esr:#x}")),
        }
    }

    /// QEMU skips cache maintenance on a device address and needs ISV for an
    /// access (`target/arm/hvf/hvf.c`); a stage-1 walk into a hole is a guest
    /// fault no device can answer.
    fn data_abort(iss: u64) -> Self {
        if iss & CM != 0 {
            return Self::CacheMaintenance;
        }
        if iss & ISV == 0 || iss & S1PTW != 0 {
            return Self::Unhandled(format!("data abort with ISS {iss:#x} names no access"));
        }
        Self::Mmio(MmioAccess {
            len: 1 << ((iss >> 22) & 0b11),
            write: iss & WNR != 0,
            register: ((iss >> 16) & 0x1f) as u8,
            sign_extend: iss & SSE != 0,
            sixty_four: iss & SF != 0,
        })
    }
}

/// A data abort with a valid instruction syndrome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct MmioAccess {
    /// Bytes accessed: 1, 2, 4 or 8.
    pub(super) len: usize,
    pub(super) write: bool,
    /// The transfer register; 31 is XZR.
    pub(super) register: u8,
    /// A load sign-extends its value (SSE).
    pub(super) sign_extend: bool,
    /// The transfer register is 64 bits wide (SF); otherwise it is a W register.
    pub(super) sixty_four: bool,
}

impl MmioAccess {
    /// The register value for a load of `raw`, its bytes as a little-endian
    /// integer: sign- or zero-extended, and limited to 32 bits for a W register.
    pub(super) fn extend(&self, raw: u64) -> u64 {
        let unused = 64 - 8 * self.len as u32;
        let value = if self.sign_extend && unused > 0 {
            ((raw << unused) as i64 >> unused) as u64
        } else {
            raw
        };
        if self.sixty_four {
            value
        } else {
            value & u64::from(u32::MAX)
        }
    }
}

/// A trapped `mrs` or `msr`, by its encoding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SysRegAccess {
    pub(super) op0: u8,
    pub(super) op1: u8,
    pub(super) crn: u8,
    pub(super) crm: u8,
    pub(super) op2: u8,
    /// The transfer register; 31 is XZR.
    pub(super) register: u8,
    pub(super) read: bool,
}

impl SysRegAccess {
    fn decode(iss: u64) -> Self {
        let field = |shift: u32, width: u32| ((iss >> shift) & ((1 << width) - 1)) as u8;
        Self {
            op0: field(20, 2),
            op2: field(17, 3),
            op1: field(14, 3),
            crn: field(10, 4),
            register: field(5, 5),
            crm: field(1, 4),
            read: iss & 1 != 0,
        }
    }

    /// Emulates the access: the value a read returns, or 0 after a write, or
    /// `None` for a register the backend does not emulate. `os_lock` is the
    /// vCPU's OS lock; `written` is the value a write stores.
    ///
    /// HVF traps the debug registers (op0 2), which QEMU emulates as dummies,
    /// and may trap the reserved ID space, which reads as zero.
    pub(super) fn emulate(&self, os_lock: &mut bool, written: u64) -> Option<u64> {
        // OSLSR_EL1.OSLM = 0b10 (bit 3): the OS lock is implemented.
        const OSLM_IMPLEMENTED: u64 = 1 << 3;
        match (self.op0, self.op1, self.crn, self.crm, self.op2, self.read) {
            // OSLAR_EL1, which Linux clears at boot.
            (2, 0, 1, 0, 4, false) => {
                *os_lock = written & 1 != 0;
                Some(0)
            }
            // OSLSR_EL1: OSLK is bit 1.
            (2, 0, 1, 1, 4, true) => Some(OSLM_IMPLEMENTED | u64::from(*os_lock) << 1),
            (2, ..) => Some(0),
            (3, 0, 0, 1..=7, _, true) => Some(0),
            _ => None,
        }
    }
}
