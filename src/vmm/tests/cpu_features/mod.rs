// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest CPUID from synthetic supported tables that carry the gaps KVM leaves:
//! the host APIC ID and CPU count in leaf 1, a zeroed 0xB and 0x1F subleaf 0,
//! a zero 0x8000_001E and host core counts in 0x8000_0008.

use boxlite_hypervisor::X86CpuidEntry;

use super::vcpu_cpuid;

fn entry(leaf: u32, [eax, ebx, ecx, edx]: [u32; 4]) -> X86CpuidEntry {
    X86CpuidEntry {
        leaf,
        subleaf: 0,
        subleaf_required: matches!(leaf, 0xb | 0x1f),
        eax,
        ebx,
        ecx,
        edx,
    }
}

fn vendor(name: &[u8; 12]) -> X86CpuidEntry {
    let word = |at: usize| u32::from_le_bytes(name[at..at + 4].try_into().unwrap());
    entry(0, [0x20, word(0), word(8), word(4)])
}

/// Host APIC ID 0x2a, 128 logical CPUs, a 128-byte CLFLUSH line, brand index
/// 5, no hypervisor bit.
const HOST_LEAF_1: [u32; 4] = [0x000a_06a4, 0x2a80_1005, 0x76da_3203, 0x078b_fbff];

fn intel() -> Vec<X86CpuidEntry> {
    vec![
        vendor(b"GenuineIntel"),
        entry(1, HOST_LEAF_1),
        entry(7, [0, 0x1234, 0, 0]),
        entry(0xb, [0, 0, 0, 0x2a]),
        entry(0x1f, [0, 0, 0, 0x2a]),
        entry(0x4000_0001, [0x0100_7afb, 0, 0, 0]),
        entry(0x8000_0008, [0x3030, 0, 0x707f, 0]),
    ]
}

fn amd() -> Vec<X86CpuidEntry> {
    vec![
        vendor(b"AuthenticAMD"),
        entry(1, HOST_LEAF_1),
        entry(0xb, [0, 0, 0, 0x2a]),
        entry(0x8000_0001, [0, 0, 1 << 22, 0]),
        entry(0x8000_0008, [0x3030, 0, 0x1_707f, 0]),
        entry(0x8000_001e, [0, 0, 0, 0]),
    ]
}

fn subleaves(cpuid: &[X86CpuidEntry], leaf: u32) -> Vec<X86CpuidEntry> {
    let mut entries: Vec<_> = cpuid
        .iter()
        .filter(|entry| entry.leaf == leaf)
        .copied()
        .collect();
    entries.sort_by_key(|entry| entry.subleaf);
    entries
}

/// SMT level (shift 0, one thread), then core level (shift 6, `count` cores).
fn topology(leaf: u32, apic_id: u32, count: u32) -> Vec<X86CpuidEntry> {
    [(0, 0, 1, 0x100), (1, 6, count, 0x201)]
        .map(|(subleaf, eax, ebx, ecx)| X86CpuidEntry {
            leaf,
            subleaf,
            subleaf_required: true,
            eax,
            ebx,
            ecx,
            edx: apic_id,
        })
        .to_vec()
}

#[test]
fn places_each_vcpu_by_apic_id_in_one_package_of_cores() {
    let supported = intel();
    let cpuid = vcpu_cpuid(&supported, 3, 5);

    let [leaf_1] = subleaves(&cpuid, 1)[..] else {
        panic!("one leaf 1")
    };
    // APIC ID 3, five CPUs rounded up to 8, a 64-byte CLFLUSH line, brand
    // index kept.
    assert_eq!(leaf_1.ebx, 0x0308_0805);
    assert_eq!(leaf_1.ecx, HOST_LEAF_1[2] | (1 << 31) | (1 << 24));
    assert_eq!(leaf_1.edx, HOST_LEAF_1[3] | (1 << 28));
    assert_eq!(subleaves(&cpuid, 0xb), topology(0xb, 3, 5));
    assert_eq!(subleaves(&cpuid, 0x1f), topology(0x1f, 3, 5));
    let others = |table: &[X86CpuidEntry]| -> Vec<X86CpuidEntry> {
        let mut kept: Vec<_> = table
            .iter()
            .filter(|entry| !matches!(entry.leaf, 1 | 0xb | 0x1f))
            .copied()
            .collect();
        kept.sort_by_key(|entry| entry.leaf);
        kept
    };
    // Including 0x8000_0008, which only AMD uses for topology.
    assert_eq!(others(&cpuid), others(&supported));
}

#[test]
fn amd_reports_the_apic_id_in_its_extended_topology_leaves() {
    let cpuid = vcpu_cpuid(&amd(), 3, 5);

    let [sizes] = subleaves(&cpuid, 0x8000_0008)[..] else {
        panic!("one 0x8000_0008")
    };
    // ApicIdSize 6 and four more cores; PerfTscSize in bit 16 kept.
    assert_eq!(sizes.ecx, 0x1_6004);
    let [extended] = subleaves(&cpuid, 0x8000_001e)[..] else {
        panic!("one 0x8000_001e")
    };
    assert_eq!(
        (extended.eax, extended.ebx, extended.ecx, extended.edx),
        (3, 3, 0, 0)
    );
    assert_eq!(subleaves(&cpuid, 0xb), topology(0xb, 3, 5));
    assert!(subleaves(&cpuid, 0x1f).is_empty(), "0x1F is not listed");
}

#[test]
fn a_single_vcpu_is_one_core_without_htt() {
    let mut supported = intel();
    supported[1].edx |= 1 << 28;

    let cpuid = vcpu_cpuid(&supported, 0, 1);

    let [leaf_1] = subleaves(&cpuid, 1)[..] else {
        panic!("one leaf 1")
    };
    assert_eq!(leaf_1.ebx, 0x0001_0805);
    assert_eq!(leaf_1.edx & (1 << 28), 0);
    assert_eq!(subleaves(&cpuid, 0xb), topology(0xb, 0, 1));
}
