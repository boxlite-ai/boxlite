// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest CPUID from synthetic supported tables that carry the gaps KVM leaves:
//! the host APIC ID and CPU count in leaf 1, a zeroed 0xB and 0x1F subleaf 0,
//! a zero 0x8000_001E and host core counts in 0x8000_0008.

use std::{error::Error as _, io};

use boxlite_hypervisor::X86CpuidEntry;

use super::{X86MemoryCaps, preflight_x86, vcpu_cpuid};
use crate::{error::Error, x86_boot_layout::PageSize};

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
fn masks_shadow_stack_only_on_leaf_7_subleaf_0() {
    let indexed_subleaf_1 = X86CpuidEntry {
        subleaf: 1,
        subleaf_required: true,
        ..entry(7, [0x11, 0x22, 0x180, 0x44])
    };
    for (subleaf_required, subleaf) in [(true, 0), (false, 1)] {
        let subleaf_0 = X86CpuidEntry {
            subleaf,
            subleaf_required,
            ..entry(7, [0x11, 0x22, 0x1c0, 0x44])
        };
        let cpuid = vcpu_cpuid(&[subleaf_0, indexed_subleaf_1], 0, 1);
        assert_eq!(
            subleaves(&cpuid, 7),
            [
                X86CpuidEntry {
                    ecx: 0x140,
                    ..subleaf_0
                },
                indexed_subleaf_1
            ]
        );
    }
}

#[test]
fn amd_reports_the_apic_id_in_its_extended_topology_leaves() {
    let mut supported = amd();
    let features = supported
        .iter_mut()
        .find(|entry| entry.leaf == 0x8000_0001)
        .unwrap();
    features.edx |= 1 << 26;
    let cpuid = vcpu_cpuid(&supported, 3, 5);

    let [sizes] = subleaves(&cpuid, 0x8000_0008)[..] else {
        panic!("one 0x8000_0008")
    };
    // ApicIdSize 6 and four more cores; PerfTscSize in bit 16 kept.
    assert_eq!(sizes.ecx, 0x1_6004);
    assert_eq!(
        sizes.eax, 0x3030,
        "keep address sizes when setting AMD topology"
    );
    assert_eq!(
        subleaves(&cpuid, 0x8000_0001),
        subleaves(&supported, 0x8000_0001)
    );
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

fn address_sizes(physical: u32, virtual_bits: u32, guest: u32) -> X86CpuidEntry {
    entry(
        0x8000_0008,
        [physical | (virtual_bits << 8) | (guest << 16), 0, 0, 0],
    )
}

#[test]
fn decodes_kvm_address_widths() {
    for (physical_bits, guest_bits) in [(48, 36), (36, 0), (36, 48)] {
        let entries = [
            X86CpuidEntry {
                subleaf: 1,
                ..address_sizes(32, 48, 32)
            },
            entry(0x8000_0009, [52, 0, 0, 0]),
            address_sizes(physical_bits, 57, guest_bits),
            entry(1, [31, 0, 0, 0]),
        ];
        let caps = X86MemoryCaps::from_cpuid(&entries).unwrap();
        assert_eq!(caps.physical_end, 1 << 36);
        assert!(!caps.pdpe1gb);
        assert!(preflight_x86(64512, &entries, PageSize::Mib).is_ok());
        let error = preflight_x86(64513, &entries, PageSize::Mib).unwrap_err();
        assert!(matches!(
            error,
            Error::GuestMemoryAddressLimit {
                memory_mib: 64513,
                end: 0x10_0010_0000,
                limit_end: 0x10_0000_0000,
                limit: "KVM GPA",
            }
        ));
        assert_eq!(
            error.to_string(),
            "guest RAM request of 64513 MiB ends at GPA 0x1000100000, beyond KVM GPA exclusive limit 0x1000000000"
        );
    }
}

fn assert_unsupported(error: Error, reason: &str) {
    assert!(matches!(error, Error::HostMemoryCapability(_)), "{error:?}");
    let cause = error.source().unwrap().downcast_ref::<io::Error>().unwrap();
    assert_eq!(cause.kind(), io::ErrorKind::Unsupported);
    assert_eq!(cause.to_string(), reason);
    assert_eq!(
        error.to_string(),
        format!("guest memory capability check failed: {reason}")
    );
}

#[test]
fn rejects_missing_or_invalid_width() {
    let missing = "missing CPUID address sizes leaf 0x80000008";
    let bad_physical = "CPUID physical address width must be in 32..=52";
    let bad_guest = "CPUID guest physical address width must be in 32..=52";
    for (entries, reason) in [
        (vec![entry(0x8000_0001, [0; 4])], missing),
        (
            vec![X86CpuidEntry {
                subleaf: 1,
                ..address_sizes(48, 57, 36)
            }],
            missing,
        ),
        (vec![address_sizes(0, 57, 36)], bad_physical),
        (vec![address_sizes(31, 57, 0)], bad_physical),
        (vec![address_sizes(53, 57, 36)], bad_physical),
        (vec![address_sizes(48, 57, 31)], bad_guest),
        (vec![address_sizes(48, 57, 53)], bad_guest),
    ] {
        assert_unsupported(
            preflight_x86(1, &entries, PageSize::Mib).unwrap_err(),
            reason,
        );
    }
}

#[test]
fn gib_request_requires_extended_edx_bit_26() {
    let sizes = address_sizes(48, 57, 0);
    let gib_edx = entry(0x8000_0001, [0, 0, 0, 1 << 26]);
    for unsupported in [
        vec![sizes],
        vec![entry(1, [0, 0, 0, 1 << 26]), sizes],
        vec![
            X86CpuidEntry {
                subleaf: 1,
                ..gib_edx
            },
            sizes,
        ],
        vec![entry(0x8000_0001, [0, 0, 1 << 26, 0]), sizes],
        vec![entry(0x8000_0001, [0, 0, 0, 1 << 25 | 1 << 27]), sizes],
    ] {
        assert_unsupported(
            preflight_x86(1, &unsupported, PageSize::Gib).unwrap_err(),
            "1 GiB boot pages require CPUID pdpe1gb",
        );
        for leaf in [PageSize::Mib, PageSize::Kib] {
            assert_eq!(
                preflight_x86(1, &unsupported, leaf).unwrap().page_size(),
                leaf
            );
        }
    }
    assert_eq!(
        preflight_x86(1, &[gib_edx, sizes], PageSize::Gib)
            .unwrap()
            .page_size(),
        PageSize::Gib
    );
}

#[test]
fn preflight_checks_identity_end_before_allocation() {
    let entries = [address_sizes(52, 57, 0)];
    assert!(preflight_x86(134216704, &entries, PageSize::Mib).is_ok());
    for (entries, expected) in [
        (entries, "four-level identity map"),
        ([address_sizes(47, 57, 0)], "KVM GPA"),
    ] {
        let error = preflight_x86(134216705, &entries, PageSize::Mib).unwrap_err();
        assert!(
            matches!(error, Error::GuestMemoryAddressLimit {
            memory_mib: 134216705, end: 0x8000_0010_0000, limit_end: 0x8000_0000_0000, limit,
        } if limit == expected),
            "{error:?}"
        );
    }
}
