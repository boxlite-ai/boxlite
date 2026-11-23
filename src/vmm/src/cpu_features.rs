// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The CPU features each x86_64 vCPU sees. KVM reports supported guest CPUID
//! and leaves the APIC ID and topology to the VMM (`Documentation/virt/kvm/api.rst`,
//! `KVM_GET_SUPPORTED_CPUID`); Linux reads its APIC ID from leaf 1, then from
//! leaf 0x1F or 0xB, then from 0x8000_001E on AMD.

#[cfg(any(test, target_os = "linux"))]
use std::io;

use boxlite_hypervisor::{X86CpuidEntry, X86Msr};

use crate::config::MAX_VCPUS;
#[cfg(any(test, target_os = "linux"))]
use crate::{
    error::{Error, Result},
    memory::{check_ram_end, ram_ranges},
    x86_boot_layout::{CheckedBootLeaf, IDENTITY_END, PageSize},
};

const LEAF_VENDOR: u32 = 0;
const LEAF_FEATURES: u32 = 1;
const LEAF_TOPOLOGY: u32 = 0xb;
const LEAF_TOPOLOGY_V2: u32 = 0x1f;
const LEAF_AMD_ADDRESS_SIZES: u32 = 0x8000_0008;
const LEAF_AMD_TOPOLOGY: u32 = 0x8000_001e;

/// Leaf 1 ECX: a hypervisor is present, which Linux checks before it looks
/// for KVM and kvmclock.
const HYPERVISOR: u32 = 1 << 31;
/// Leaf 1 ECX: the TSC-deadline timer, which the in-kernel local APIC
/// emulates and which spares Linux its APIC timer calibration.
const TSC_DEADLINE: u32 = 1 << 24;
/// Leaf 1 EDX: more than one logical processor per package.
const HTT: u32 = 1 << 28;
/// Leaf 1 EBX[15:8]: the CLFLUSH line in 8-byte units, 64 bytes, the same on
/// every host.
const CLFLUSH_LINE: u32 = 8;
/// Topology level types in ECX[15:8] of leaves 0xB and 0x1F.
const LEVEL_SMT: u32 = 1;
const LEVEL_CORE: u32 = 2;
/// APIC ID bits below the package: every ID up to `MAX_VCPUS` is one package.
const CORE_SHIFT: u32 = MAX_VCPUS.next_power_of_two().trailing_zeros();

const MSR_MISC_ENABLE: u32 = 0x1a0;
const MISC_ENABLE_FAST_STRING: u64 = 1;
/// KVM's reset value: branch trace store and PEBS unavailable.
const MISC_ENABLE_KVM_RESET: u64 = (1 << 11) | (1 << 12);
const MSR_MTRR_DEF_TYPE: u32 = 0x2ff;
const MTRR_ENABLE: u64 = 1 << 11;
const MTRR_WRITE_BACK: u64 = 6;

/// MSRs every vCPU gets before its first entry. Without FAST_STRING an Intel
/// guest turns fast string operations off; MTRRs on with a write-back default
/// is the state firmware leaves. KVM already creates the other boot MSRs as
/// zero, with the TSC synchronized across vCPUs.
pub(crate) const BOOT_MSRS: [X86Msr; 2] = [
    X86Msr {
        index: MSR_MISC_ENABLE,
        value: MISC_ENABLE_KVM_RESET | MISC_ENABLE_FAST_STRING,
    },
    X86Msr {
        index: MSR_MTRR_DEF_TYPE,
        value: MTRR_ENABLE | MTRR_WRITE_BACK,
    },
];

/// Memory capabilities from the CPUID KVM supports for guests.
#[cfg(any(test, target_os = "linux"))]
#[derive(Debug)]
pub(crate) struct X86MemoryCaps {
    pub(crate) physical_end: u64,
    pub(crate) pdpe1gb: bool,
}

#[cfg(any(test, target_os = "linux"))]
impl X86MemoryCaps {
    pub(crate) fn from_cpuid(entries: &[X86CpuidEntry]) -> io::Result<Self> {
        let leaf = |leaf| {
            entries
                .iter()
                .find(|entry| entry.leaf == leaf && entry.subleaf == 0)
        };
        let unsupported = |message| io::Error::new(io::ErrorKind::Unsupported, message);
        let sizes = leaf(LEAF_AMD_ADDRESS_SIZES)
            .ok_or_else(|| unsupported("missing CPUID address sizes leaf 0x80000008"))?;
        let physical_bits = sizes.eax & 0xff;
        // EAX[15:8] is the virtual width; EAX[23:16] is an optional GPA limit.
        let guest_bits = (sizes.eax >> 16) & 0xff;
        if !(32..=52).contains(&physical_bits) {
            return Err(unsupported(
                "CPUID physical address width must be in 32..=52",
            ));
        }
        if guest_bits != 0 && !(32..=52).contains(&guest_bits) {
            return Err(unsupported(
                "CPUID guest physical address width must be in 32..=52",
            ));
        }
        let bits = if guest_bits == 0 {
            physical_bits
        } else {
            physical_bits.min(guest_bits)
        };
        // Extended features leaf EDX[26]: 1 GiB pages in long mode.
        let pdpe1gb = leaf(0x8000_0001).is_some_and(|entry| entry.edx & (1 << 26) != 0);
        Ok(Self {
            physical_end: 1u64 << bits,
            pdpe1gb,
        })
    }
}

/// Checks backed GPAs and the requested boot leaf before allocating RAM.
#[cfg(any(test, target_os = "linux"))]
pub(crate) fn preflight_x86(
    memory_mib: u32,
    entries: &[X86CpuidEntry],
    requested_leaf: PageSize,
) -> Result<CheckedBootLeaf> {
    let caps = X86MemoryCaps::from_cpuid(entries).map_err(Error::HostMemoryCapability)?;
    let ranges = ram_ranges(memory_mib);
    let mut limits = [
        (caps.physical_end, "KVM GPA"),
        (IDENTITY_END, "four-level identity map"),
    ];
    // Report the tighter limit, keeping KVM first if the limits are equal.
    limits.sort_by_key(|&(end, _)| end);
    for (end, name) in limits {
        check_ram_end(memory_mib, &ranges, end, name)?;
    }
    requested_leaf
        .checked(caps.pdpe1gb)
        .map_err(Error::HostMemoryCapability)
}

/// The CPUID of vCPU `index` of `count`: `supported` with APIC ID `index`, one
/// package of `count` single-thread cores, a 64-byte CLFLUSH line, and the
/// hypervisor and TSC-deadline bits. Every other entry is kept, so all vCPUs
/// differ only in the APIC ID.
pub(crate) fn vcpu_cpuid(supported: &[X86CpuidEntry], index: u8, count: u8) -> Vec<X86CpuidEntry> {
    debug_assert!(index < count && count <= MAX_VCPUS);
    let apic_id = u32::from(index);
    let amd = is_amd(supported);
    let lists_v2_topology = supported.iter().any(|entry| entry.leaf == LEAF_TOPOLOGY_V2);
    let mut cpuid: Vec<X86CpuidEntry> = supported
        .iter()
        .filter(|entry| !matches!(entry.leaf, LEAF_TOPOLOGY | LEAF_TOPOLOGY_V2))
        .copied()
        .collect();
    for entry in &mut cpuid {
        match entry.leaf {
            LEAF_FEATURES => {
                // Keep the brand index in EBX[7:0].
                let logical = u32::from(count.next_power_of_two());
                entry.ebx =
                    (entry.ebx & 0xff) | (CLFLUSH_LINE << 8) | (logical << 16) | (apic_id << 24);
                entry.ecx |= HYPERVISOR | TSC_DEADLINE;
                entry.edx = if count > 1 {
                    entry.edx | HTT
                } else {
                    entry.edx & !HTT
                };
            }
            // ApicIdSize in ECX[15:12] and the core count minus one in ECX[7:0].
            LEAF_AMD_ADDRESS_SIZES if amd => {
                entry.ecx = (entry.ecx & !0xf0ff) | (CORE_SHIFT << 12) | (u32::from(count) - 1);
            }
            // Extended APIC ID, core ID and node 0 of one node.
            LEAF_AMD_TOPOLOGY if amd => {
                (entry.eax, entry.ebx, entry.ecx, entry.edx) = (apic_id, apic_id, 0, 0);
            }
            _ => {}
        }
    }
    cpuid.extend(topology(LEAF_TOPOLOGY, apic_id, count));
    if lists_v2_topology {
        cpuid.extend(topology(LEAF_TOPOLOGY_V2, apic_id, count));
    }
    cpuid
}

/// An SMT level with one thread per core, then a core level with `count`
/// cores. Without the core level, Linux would take the SMT shift as the
/// package shift and give every vCPU its own package.
fn topology(leaf: u32, apic_id: u32, count: u8) -> [X86CpuidEntry; 2] {
    let level = |subleaf: u32, shift: u32, processors: u32, kind: u32| X86CpuidEntry {
        leaf,
        subleaf,
        subleaf_required: true,
        eax: shift,
        ebx: processors,
        ecx: (kind << 8) | subleaf,
        edx: apic_id,
    };
    [
        level(0, 0, 1, LEVEL_SMT),
        level(1, CORE_SHIFT, u32::from(count), LEVEL_CORE),
    ]
}

/// AMD and Hygon CPUs, whose topology Linux reads from leaves 0x8000_0008 and
/// 0x8000_001E.
fn is_amd(supported: &[X86CpuidEntry]) -> bool {
    supported
        .iter()
        .find(|entry| entry.leaf == LEAF_VENDOR)
        .is_some_and(|vendor| {
            let name = [vendor.ebx, vendor.edx, vendor.ecx].map(u32::to_le_bytes);
            matches!(name.as_flattened(), b"AuthenticAMD" | b"HygonGenuine")
        })
}

// Unit tests live under `tests/`, like the crate's other test modules.
#[cfg(test)]
#[path = "../tests/cpu_features/mod.rs"]
mod tests;
