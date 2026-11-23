// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashSet, io, sync::Arc};

use kvm_bindings::{
    CpuId, KVM_CPUID_FLAG_SIGNIFCANT_INDEX, KVM_CPUID_FLAG_STATE_READ_NEXT,
    KVM_CPUID_FLAG_STATEFUL_FUNC, KVM_MAX_CPUID_ENTRIES, Msrs, kvm_cpuid_entry2, kvm_msr_entry,
};
use kvm_ioctls::Kvm;

use super::KvmVcpu;
use crate::{Error, Result, X86CpuidEntry, X86Msr};

pub(super) const MSR_IA32_TSC: u32 = 0x10;
const MSR_IA32_TSC_ADJUST: u32 = 0x3b;
const MSR_MTRR_CAP: u32 = 0xfe;
const MSR_IA32_RTIT_CTL: u32 = 0x570;
pub(super) const MSR_IA32_TSC_DEADLINE: u32 = 0x6e0;
const MSR_IA32_DEBUGCTLMSR: u32 = 0x1d9;
const MSR_IA32_XSS: u32 = 0xda0;

const SUPPLEMENTAL_SNAPSHOT_MSRS: &[u32] = &[
    // MTRR_DEF_TYPE.
    0x2ff,
    // Fixed MTRRs.
    0x250,
    0x258,
    0x259,
    0x268,
    0x269,
    0x26a,
    0x26b,
    0x26c,
    0x26d,
    0x26e,
    0x26f,
    // Variable MTRRs.
    0x200,
    0x201,
    0x202,
    0x203,
    0x204,
    0x205,
    0x206,
    0x207,
    0x208,
    0x209,
    0x20a,
    0x20b,
    0x20c,
    0x20d,
    0x20e,
    0x20f,
    MSR_IA32_XSS,
    MSR_IA32_DEBUGCTLMSR,
];

fn is_excluded_msr(index: u32) -> bool {
    // MTRRcap is read-only. LAPIC ioctls carry x2APIC state. Hyper-V's
    // paravirtualized state has separate VM-wide and per-vCPU dependencies.
    matches!(index, MSR_MTRR_CAP | 0x800..=0xbff | 0x4000_0000..=0x4000_01ff)
}

pub(super) fn build_snapshot_msr_indices(kvm_advertised: &[u32]) -> Arc<[u32]> {
    let mut seen = HashSet::new();
    kvm_advertised
        .iter()
        .chain(SUPPLEMENTAL_SNAPSHOT_MSRS)
        .copied()
        .filter(|&index| !is_excluded_msr(index) && seen.insert(index))
        .collect()
}

#[derive(Debug, Default)]
pub(super) struct RestoreMsrPlan {
    pub(super) before_tsc: Vec<kvm_msr_entry>,
    pub(super) tsc: Option<kvm_msr_entry>,
    pub(super) after_tsc: Vec<kvm_msr_entry>,
}

pub(super) fn order_msrs_for_restore(entries: &[kvm_msr_entry]) -> RestoreMsrPlan {
    let mut plan = RestoreMsrPlan::default();
    let mut deadlines = Vec::new();
    let mut trace_controls = Vec::new();
    for &entry in entries {
        match entry.index {
            MSR_IA32_TSC_ADJUST => plan.before_tsc.push(entry),
            MSR_IA32_TSC => plan.tsc = Some(entry),
            MSR_IA32_TSC_DEADLINE => deadlines.push(entry),
            MSR_IA32_RTIT_CTL => trace_controls.push(entry),
            _ => plan.after_tsc.push(entry),
        }
    }
    plan.after_tsc.extend(deadlines);
    plan.after_tsc.extend(trace_controls);
    plan
}

pub(super) fn supported_cpuid(kvm: &Kvm) -> io::Result<Vec<X86CpuidEntry>> {
    let cpuid = kvm
        .get_supported_cpuid(KVM_MAX_CPUID_ENTRIES)
        .map_err(io::Error::from)?;
    convert_supported_cpuid(cpuid.as_slice())
}

fn convert_supported_cpuid(entries: &[kvm_cpuid_entry2]) -> io::Result<Vec<X86CpuidEntry>> {
    entries
        .iter()
        .filter(|entry| {
            entry.flags & (KVM_CPUID_FLAG_STATEFUL_FUNC | KVM_CPUID_FLAG_STATE_READ_NEXT) == 0
        })
        .map(|entry| {
            if entry.flags & !KVM_CPUID_FLAG_SIGNIFCANT_INDEX != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!(
                        "CPUID leaf {:#x} has unsupported flags {:#x}",
                        entry.function, entry.flags
                    ),
                ));
            }
            Ok(X86CpuidEntry {
                leaf: entry.function,
                subleaf: entry.index,
                subleaf_required: entry.flags & KVM_CPUID_FLAG_SIGNIFCANT_INDEX != 0,
                eax: entry.eax,
                ebx: entry.ebx,
                ecx: entry.ecx,
                edx: entry.edx,
            })
        })
        .collect()
}

impl KvmVcpu {
    /// Installs the machine's CPU feature policy before first entry.
    ///
    /// Begin with `KvmVm::supported_cpuid` and remove features or adjust topology;
    /// do not advertise instructions the host cannot execute. A failed write can
    /// leave partial state, so the caller must discard this vCPU on error.
    pub fn set_cpu_features(&mut self, cpuid: &[X86CpuidEntry], msrs: &[X86Msr]) -> Result<()> {
        let failure = |operation, source| Error::ConfigureVcpu {
            id: self.id,
            operation,
            source,
        };
        let cpuid = cpuid_buffer(cpuid).map_err(|e| failure("prepare CPUID", e))?;
        let msrs = msr_buffer(msrs).map_err(|e| failure("prepare MSRs", e))?;
        self.fd.clear_tsc_save_anchor();
        self.fd
            .set_cpuid2(&cpuid)
            .map_err(|e| failure("set CPUID", e.into()))?;
        let written = self
            .fd
            .set_msrs(&msrs)
            .map_err(|e| failure("set MSRs", e.into()))?;
        check_written(&msrs, written).map_err(|e| failure("set MSRs", e))
    }
}

pub(super) fn check_written(msrs: &Msrs, written: usize) -> io::Result<()> {
    match msrs.as_slice().get(written) {
        Some(rejected) => Err(io::Error::other(format!(
            "KVM wrote {written} of {} MSRs; first rejected index {:#x}",
            msrs.as_slice().len(),
            rejected.index,
        ))),
        None if written == msrs.as_slice().len() => Ok(()),
        None => Err(io::Error::other("KVM returned an invalid MSR write count")),
    }
}

fn cpuid_buffer(entries: &[X86CpuidEntry]) -> io::Result<CpuId> {
    if entries.is_empty() || entries.len() > KVM_MAX_CPUID_ENTRIES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "CPUID entry count is invalid",
        ));
    }
    let entries: Vec<_> = entries
        .iter()
        .map(|entry| kvm_cpuid_entry2 {
            function: entry.leaf,
            index: entry.subleaf,
            flags: if entry.subleaf_required {
                KVM_CPUID_FLAG_SIGNIFCANT_INDEX
            } else {
                0
            },
            eax: entry.eax,
            ebx: entry.ebx,
            ecx: entry.ecx,
            edx: entry.edx,
            ..Default::default()
        })
        .collect();
    CpuId::from_entries(&entries).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

fn msr_buffer(entries: &[X86Msr]) -> io::Result<Msrs> {
    // The flexible-array wrapper's limit is checked before allocating a copy.
    let mut buffer =
        Msrs::new(entries.len()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    for (target, source) in buffer.as_mut_slice().iter_mut().zip(entries) {
        *target = kvm_msr_entry {
            index: source.index,
            data: source.value,
            ..Default::default()
        };
    }
    Ok(buffer)
}

/// Probe one index at a time: a short batch read stops at the first unavailable
/// MSR and would lose every subsequent register (notably CPUID-gated PMU MSRs).
/// Probe the VM's filtered list of KVM-advertised and supplemental indices.
pub(super) fn snapshot_msrs(
    fd: &kvm_ioctls::VcpuFd,
    indices: &[u32],
) -> io::Result<Vec<kvm_msr_entry>> {
    let mut entries = Vec::new();
    for &index in indices {
        if is_excluded_msr(index) {
            continue;
        }
        let mut msr = Msrs::from_entries(&[kvm_msr_entry {
            index,
            ..Default::default()
        }])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        match fd.get_msrs(&mut msr).map_err(io::Error::from)? {
            0 => {} // Unavailable under this vCPU's CPUID/MCE configuration.
            1 => entries.push(msr.as_slice()[0]),
            _ => return Err(io::Error::other("invalid MSR read count")),
        }
    }
    Ok(entries)
}

pub(super) fn snapshot_cpuid(entries: &[kvm_cpuid_entry2]) -> io::Result<CpuId> {
    if entries.is_empty() || entries.len() > KVM_MAX_CPUID_ENTRIES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid CPUID count",
        ));
    }
    CpuId::from_entries(entries).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kvm_bindings::{KVM_CPUID_FLAG_STATE_READ_NEXT, KVM_CPUID_FLAG_STATEFUL_FUNC};

    #[test]
    fn build_snapshot_msr_indices_adds_all_writable_mtrrs_and_supplements() {
        let indices = build_snapshot_msr_indices(&[]);
        let expected: Vec<_> = [0x2ff, 0x250, 0x258, 0x259]
            .into_iter()
            .chain(0x268..=0x26f)
            .chain(0x200..=0x20f)
            .chain([0xda0, 0x1d9])
            .collect();
        assert_eq!(expected.len(), 28 + 2);
        assert_eq!(&*indices, expected);
    }

    #[test]
    fn build_snapshot_msr_indices_deduplicates_and_excludes_reserved_ranges() {
        let retained = [0x1d9, 0x7ff, 0xc00, 0xda0, 0x4000_0200, 0x250, 0x10];
        let indices = build_snapshot_msr_indices(&[
            0x1d9,
            0x7ff,
            0x800,
            0xbff,
            0xc00,
            0xda0,
            0x4000_0000,
            0x4000_01ff,
            0x4000_0200,
            0xfe,
            0x250,
            0x10,
            0x1d9,
            0xda0,
            0x10,
        ]);
        assert_eq!(&indices[..retained.len()], &retained);
        let expected: Vec<_> = retained
            .into_iter()
            .chain(
                SUPPLEMENTAL_SNAPSHOT_MSRS
                    .iter()
                    .copied()
                    .filter(|index| !retained.contains(index)),
            )
            .collect();
        assert_eq!(&*indices, expected);
    }

    #[test]
    fn order_msrs_for_restore_places_dependencies_and_keeps_the_last_tsc() {
        let entries = [
            0x570,
            0x6e0,
            0x10,
            0x2ff,
            0x3b,
            0x571,
            0xda0,
            0x10,
            0x1d9,
            0x11,
            0x4b56_4d00,
            0x560,
        ]
        .into_iter()
        .enumerate()
        .map(|(pos, index)| kvm_msr_entry {
            index,
            data: pos as u64,
            ..Default::default()
        })
        .collect::<Vec<_>>();
        let plan = order_msrs_for_restore(&entries);
        assert_eq!(plan.before_tsc, [entries[4]]);
        assert_eq!(plan.tsc, Some(entries[7]));
        assert_eq!(
            plan.after_tsc,
            [3, 5, 6, 8, 9, 10, 11, 1, 0].map(|pos| entries[pos])
        );
    }

    #[test]
    fn order_msrs_for_restore_accepts_empty_input() {
        let plan = order_msrs_for_restore(&[]);
        assert!(plan.before_tsc.is_empty());
        assert!(plan.tsc.is_none());
        assert!(plan.after_tsc.is_empty());
    }

    #[test]
    fn snapshot_cpuid_preserves_entries_and_only_checks_count() {
        let first = kvm_cpuid_entry2 {
            function: 7,
            ..Default::default()
        };
        let mut second = first;
        second.index = 1;
        second.flags = KVM_CPUID_FLAG_SIGNIFCANT_INDEX | (1 << 31);
        second.padding[0] = 1;
        let entries = [first, second, second];
        assert_eq!(snapshot_cpuid(&entries).unwrap().as_slice(), &entries);
        assert!(snapshot_cpuid(&[]).is_err());
        assert!(snapshot_cpuid(&vec![first; KVM_MAX_CPUID_ENTRIES + 1]).is_err());
    }

    #[test]
    fn snapshot_cpuid_accepts_counts_just_below_and_at_the_limit() {
        let entry = kvm_cpuid_entry2 {
            function: 7,
            eax: 42,
            ..Default::default()
        };
        for len in [1, KVM_MAX_CPUID_ENTRIES - 1, KVM_MAX_CPUID_ENTRIES] {
            let entries = vec![entry; len];
            assert_eq!(snapshot_cpuid(&entries).unwrap().as_slice(), entries);
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_msrs_skips_x2apic_and_unavailable_indices_without_losing_later_values() {
        let vm = super::super::KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(
            vm.supported_cpuid(),
            &[X86Msr {
                index: 0xc0000102,
                value: 0x12345678,
            }],
        )
        .unwrap();
        assert!(snapshot_msrs(&cpu.fd, &[]).unwrap().is_empty());
        let entries = snapshot_msrs(
            &cpu.fd,
            &[0x7ff, 0x800, 0xbff, 0xc00, 0x10, u32::MAX, 0xc0000102],
        )
        .unwrap();
        assert_eq!(
            entries.iter().map(|e| e.index).collect::<Vec<_>>(),
            [0x10, 0xc0000102]
        );
        assert_eq!(entries[1].data, 0x12345678);
    }

    #[test]
    fn supported_cpuid_omits_unrepresentable_stateful_entries() {
        let entries = [
            kvm_cpuid_entry2 {
                function: 2,
                flags: KVM_CPUID_FLAG_STATEFUL_FUNC | KVM_CPUID_FLAG_STATE_READ_NEXT,
                eax: 2,
                ..Default::default()
            },
            kvm_cpuid_entry2 {
                function: 2,
                flags: KVM_CPUID_FLAG_STATEFUL_FUNC,
                eax: 1,
                ..Default::default()
            },
            kvm_cpuid_entry2 {
                function: 3,
                flags: KVM_CPUID_FLAG_STATE_READ_NEXT,
                ..Default::default()
            },
            kvm_cpuid_entry2 {
                function: 0xb,
                index: 1,
                flags: KVM_CPUID_FLAG_SIGNIFCANT_INDEX,
                eax: 2,
                ebx: 4,
                ecx: 0x201,
                edx: 3,
                ..Default::default()
            },
        ];

        let cpuid = convert_supported_cpuid(&entries).unwrap();

        assert_eq!(
            cpuid,
            [X86CpuidEntry {
                leaf: 0xb,
                subleaf: 1,
                subleaf_required: true,
                eax: 2,
                ebx: 4,
                ecx: 0x201,
                edx: 3,
            }]
        );

        let unknown_flags = [kvm_cpuid_entry2 {
            function: 0xd,
            flags: 1 << 3,
            ..Default::default()
        }];
        assert_eq!(
            convert_supported_cpuid(&unknown_flags).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
    }

    #[test]
    fn feature_buffers_preserve_subleaf_semantics_and_register_values() {
        let entries = [
            X86CpuidEntry {
                leaf: 0xb,
                subleaf: 1,
                subleaf_required: true,
                eax: 2,
                ebx: 4,
                ecx: 0x201,
                edx: 3,
            },
            X86CpuidEntry {
                leaf: 1,
                ..Default::default()
            },
        ];
        let buffer = cpuid_buffer(&entries).unwrap();
        let first = buffer.as_slice()[0];
        assert_eq!((first.function, first.index, first.flags), (0xb, 1, 1));
        assert_eq!(
            (first.eax, first.ebx, first.ecx, first.edx),
            (2, 4, 0x201, 3)
        );
        assert_eq!(buffer.as_slice()[1].flags, 0);
        assert!(cpuid_buffer(&[]).is_err());
        assert!(cpuid_buffer(&vec![entries[0]; KVM_MAX_CPUID_ENTRIES + 1]).is_err());
        let msrs = msr_buffer(&[X86Msr {
            index: 0x174,
            value: 0x1234,
        }])
        .unwrap();
        assert_eq!(
            (msrs.as_slice()[0].index, msrs.as_slice()[0].data),
            (0x174, 0x1234)
        );
        assert!(msr_buffer(&[]).unwrap().as_slice().is_empty());
        assert!(check_written(&msrs, 1).is_ok());
        let rejected = check_written(&msrs, 0).unwrap_err();
        assert!(rejected.to_string().contains("first rejected index 0x174"));
        assert!(check_written(&msrs, 2).is_err());
    }
}
