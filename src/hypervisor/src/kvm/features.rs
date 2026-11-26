// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashSet, io, os::fd::AsRawFd, sync::Arc};

use kvm_bindings::{
    CpuId, KVM_CPUID_FLAG_SIGNIFCANT_INDEX, KVM_CPUID_FLAG_STATE_READ_NEXT,
    KVM_CPUID_FLAG_STATEFUL_FUNC, KVM_MAX_CPUID_ENTRIES, KVM_MAX_MSR_ENTRIES, Msrs,
    kvm_cpuid_entry2, kvm_msr_entry,
};
use kvm_ioctls::Kvm;

use super::KvmVcpu;
use crate::x86::MAX_SNAPSHOT_MSR_ENTRIES;
use crate::{Error, Result, X86CpuidEntry, X86Msr};

pub(super) const MSR_IA32_TSC: u32 = 0x10;
const MSR_IA32_FEAT_CTL: u32 = 0x3a;
const MSR_IA32_TSC_ADJUST: u32 = 0x3b;
const MSR_MTRR_CAP: u32 = 0xfe;
const MSR_IA32_PERF_CAPABILITIES: u32 = 0x345;
const MSR_IA32_RTIT_CTL: u32 = 0x570;
pub(super) const MSR_IA32_TSC_DEADLINE: u32 = 0x6e0;
const MSR_IA32_DEBUGCTLMSR: u32 = 0x1d9;
const MSR_IA32_XSS: u32 = 0xda0;
const MSR_KVM_ASYNC_PF_EN: u32 = 0x4b56_4d02;
const MSR_KVM_ASYNC_PF_INT: u32 = 0x4b56_4d06;
const SGX_LC_MSRS: &[u32] = &[0x8c, 0x8d, 0x8e, 0x8f];

// Linux x86_64 _IOWR(KVMIO, 0x02, struct kvm_msr_list).
const KVM_GET_MSR_INDEX_LIST: libc::c_ulong = 0xc004_ae02;

pub(super) fn kvm_msr_index_list(kvm: &Kvm) -> io::Result<Vec<u32>> {
    query_msr_index_list_with(MAX_SNAPSHOT_MSR_ENTRIES, |buf| {
        // SAFETY: the aligned buffer holds the u32 header and the number of
        // u32 indices advertised by the header for the synchronous ioctl.
        if unsafe {
            libc::ioctl(
                kvm.as_raw_fd(),
                KVM_GET_MSR_INDEX_LIST as _,
                buf.as_mut_ptr(),
            )
        } == 0
        {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    })
}

fn query_msr_index_list_with(
    max_entries: usize,
    mut ioctl: impl FnMut(&mut [u32]) -> io::Result<()>,
) -> io::Result<Vec<u32>> {
    let max_entries = max_entries.min(MAX_SNAPSHOT_MSR_ENTRIES);
    let mut cap = KVM_MAX_MSR_ENTRIES.min(max_entries);
    let mut retries = 4;
    loop {
        let mut buf = vec![0; 1 + cap];
        buf[0] = cap as u32;
        match ioctl(&mut buf) {
            Ok(()) => {
                let count = buf[0] as usize;
                if count > cap {
                    return Err(io::Error::other("KVM returned an invalid MSR index count"));
                }
                buf.copy_within(1..1 + count, 0);
                buf.truncate(count);
                return Ok(buf);
            }
            Err(error) => {
                let needed = buf[0] as usize;
                if error.raw_os_error() != Some(libc::E2BIG)
                    || needed <= cap
                    || needed > max_entries
                    || retries == 0
                {
                    return Err(error);
                }
                retries -= 1;
                cap = needed;
            }
        }
    }
}

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

pub(super) fn validate_restore_msrs(
    entries: &[kvm_msr_entry],
    cpuid: &[kvm_cpuid_entry2],
) -> io::Result<()> {
    if let Some(entry) = entries.iter().find(|entry| is_excluded_msr(entry.index)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("MSR index {:#x} is excluded from snapshots", entry.index),
        ));
    }
    if let Some(entry) = entries.iter().find(|entry| match entry.index {
        MSR_IA32_PERF_CAPABILITIES => !cpuid_supports_perf_capabilities(cpuid),
        index => SGX_LC_MSRS.contains(&index) && !cpuid_supports_sgx_lc(cpuid),
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "MSR index {:#x} is incompatible with snapshot CPUID",
                entry.index
            ),
        ));
    }
    Ok(())
}

pub(super) fn build_snapshot_msr_indices(kvm_advertised: &[u32]) -> Arc<[u32]> {
    let mut seen = HashSet::new();
    kvm_advertised
        .iter()
        .chain(SUPPLEMENTAL_SNAPSHOT_MSRS)
        .copied()
        .filter(|&index| {
            !is_excluded_msr(index)
                && !SGX_LC_MSRS.contains(&index)
                && index != MSR_IA32_PERF_CAPABILITIES
                && seen.insert(index)
        })
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
    let mut ordinary = Vec::new();
    let mut feature_controls = Vec::new();
    let mut deadlines = Vec::new();
    let mut trace_controls = Vec::new();
    for &entry in entries {
        match entry.index {
            MSR_IA32_TSC_ADJUST => plan.before_tsc.push(entry),
            MSR_IA32_TSC => plan.tsc = Some(entry),
            // PERF_CAPABILITIES can refresh the masks used to validate PMU MSRs.
            MSR_IA32_PERF_CAPABILITIES => plan.after_tsc.push(entry),
            MSR_KVM_ASYNC_PF_INT => plan.after_tsc.push(entry),
            // The interrupt vector must be installed before the enable bit.
            MSR_KVM_ASYNC_PF_EN => ordinary.push(entry),
            MSR_IA32_FEAT_CTL => feature_controls.push(entry),
            MSR_IA32_TSC_DEADLINE => deadlines.push(entry),
            MSR_IA32_RTIT_CTL => trace_controls.push(entry),
            _ => ordinary.push(entry),
        }
    }
    plan.after_tsc.extend(ordinary);
    plan.after_tsc.extend(feature_controls);
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

pub(super) fn validate_cpuid_count(len: usize) -> io::Result<()> {
    if !(1..=KVM_MAX_CPUID_ENTRIES).contains(&len) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid CPUID count",
        ));
    }
    Ok(())
}

pub(super) fn snapshot_cpuid(entries: &[kvm_cpuid_entry2]) -> io::Result<CpuId> {
    validate_cpuid_count(entries.len())?;
    CpuId::from_entries(entries).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

fn cpuid_leaf_subleaf0(entries: &[kvm_cpuid_entry2], leaf: u32) -> Option<&kvm_cpuid_entry2> {
    entries.iter().find(|entry| {
        entry.function == leaf
            && (entry.flags & KVM_CPUID_FLAG_SIGNIFCANT_INDEX == 0 || entry.index == 0)
    })
}

pub(super) fn validate_snapshot_cpuid_features(entries: &[kvm_cpuid_entry2]) -> io::Result<()> {
    if cpuid_leaf_subleaf0(entries, 7).is_some_and(|entry| entry.ecx & (1 << 7) != 0) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "CET shadow stack (SHSTK) state cannot be snapshotted",
        ));
    }
    Ok(())
}

fn cpuid_supports_sgx_lc(cpuid: &[kvm_cpuid_entry2]) -> bool {
    cpuid_leaf_subleaf0(cpuid, 7).is_some_and(|entry| entry.ecx & (1 << 30) != 0)
}

fn cpuid_supports_perf_capabilities(cpuid: &[kvm_cpuid_entry2]) -> bool {
    // KVM can return the host value even when the guest lacks PDCM or a PMU.
    // Require both PDCM and a nonzero architectural PMU version for restore.
    cpuid_leaf_subleaf0(cpuid, 1).is_some_and(|entry| entry.ecx & (1 << 15) != 0)
        && cpuid_leaf_subleaf0(cpuid, 0xa).is_some_and(|entry| entry.eax & 0xff != 0)
}

pub(super) fn extra_cpuid_gated_msr_indices(cpuid: &[kvm_cpuid_entry2]) -> Vec<u32> {
    let mut indices = Vec::new();
    if cpuid_supports_sgx_lc(cpuid) {
        indices.extend_from_slice(SGX_LC_MSRS);
    }
    if cpuid_supports_perf_capabilities(cpuid) {
        indices.push(MSR_IA32_PERF_CAPABILITIES);
    }
    indices
}

#[cfg(test)]
mod tests {
    use super::*;
    use kvm_bindings::{KVM_CPUID_FLAG_STATE_READ_NEXT, KVM_CPUID_FLAG_STATEFUL_FUNC};

    #[test]
    fn msr_index_list_ioctl_number_matches_kvm_abi() {
        assert_eq!(size_of::<kvm_bindings::kvm_msr_list>(), 4);
        assert_eq!(KVM_GET_MSR_INDEX_LIST, 0xc004_ae02);
    }

    #[test]
    fn msr_index_list_retries_with_the_kernel_count() {
        for count in [0, 1, 256, 257, MAX_SNAPSHOT_MSR_ENTRIES] {
            let mut caps = Vec::new();
            let indices = query_msr_index_list_with(MAX_SNAPSHOT_MSR_ENTRIES, |buf| {
                let cap = buf[0] as usize;
                assert_eq!(buf.len(), cap + 1);
                caps.push(cap);
                buf[0] = count as u32;
                if count > cap {
                    return Err(io::Error::from_raw_os_error(libc::E2BIG));
                }
                for (i, index) in buf[1..=count].iter_mut().enumerate() {
                    *index = i as u32 + 0x10;
                }
                Ok(())
            })
            .unwrap();
            assert_eq!(indices, (0x10..0x10 + count as u32).collect::<Vec<_>>());
            let mut expected = vec![KVM_MAX_MSR_ENTRIES];
            if count > KVM_MAX_MSR_ENTRIES {
                expected.push(count);
            }
            assert_eq!(caps, expected);
        }
    }

    #[test]
    fn msr_index_list_rejects_bad_counts_and_preserves_errno() {
        for (max_entries, count, errno) in [
            (
                MAX_SNAPSHOT_MSR_ENTRIES + 1,
                MAX_SNAPSHOT_MSR_ENTRIES + 1,
                libc::E2BIG,
            ),
            (MAX_SNAPSHOT_MSR_ENTRIES, KVM_MAX_MSR_ENTRIES, libc::E2BIG),
            (MAX_SNAPSHOT_MSR_ENTRIES, 0, libc::E2BIG),
            (8, 9, libc::E2BIG),
            (MAX_SNAPSHOT_MSR_ENTRIES, 257, libc::EPERM),
        ] {
            let mut calls = 0;
            let error = query_msr_index_list_with(max_entries, |buf| {
                calls += 1;
                assert_eq!(buf[0] as usize, KVM_MAX_MSR_ENTRIES.min(max_entries));
                buf[0] = count as u32;
                Err(io::Error::from_raw_os_error(errno))
            })
            .unwrap_err();
            assert_eq!(calls, 1);
            assert_eq!(error.raw_os_error(), Some(errno));
        }
        let error = query_msr_index_list_with(0, |buf| {
            assert_eq!(buf, [0]);
            buf[0] = 1;
            Ok(())
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "KVM returned an invalid MSR index count");
    }

    #[test]
    fn msr_index_list_stops_after_four_resizes() {
        let mut caps = Vec::new();
        let error = query_msr_index_list_with(MAX_SNAPSHOT_MSR_ENTRIES, |buf| {
            caps.push(buf[0] as usize);
            buf[0] += 1;
            Err(io::Error::from_raw_os_error(libc::E2BIG))
        })
        .unwrap_err();
        assert_eq!(
            caps,
            (KVM_MAX_MSR_ENTRIES..=KVM_MAX_MSR_ENTRIES + 4).collect::<Vec<_>>()
        );
        assert_eq!(error.raw_os_error(), Some(libc::E2BIG));
    }

    #[test]
    fn restore_rejects_excluded_msrs() {
        for index in [0xfe, 0x800, 0xbff, 0x4000_0000, 0x4000_01ff] {
            assert_eq!(
                validate_restore_msrs(
                    &[kvm_msr_entry {
                        index,
                        ..Default::default()
                    }],
                    &[],
                )
                .unwrap_err()
                .kind(),
                io::ErrorKind::InvalidInput
            );
        }
        let allowed = [0x7ff, 0xc00, 0x3fff_ffff, 0x4000_0200].map(|index| kvm_msr_entry {
            index,
            ..Default::default()
        });
        assert!(validate_restore_msrs(&allowed, &[]).is_ok());
    }

    #[test]
    fn restore_validates_cpuid_gated_msrs() {
        let cpuid = [
            kvm_cpuid_entry2 {
                function: 1,
                ecx: 1 << 15,
                ..Default::default()
            },
            kvm_cpuid_entry2 {
                function: 0xa,
                eax: 1,
                ..Default::default()
            },
            kvm_cpuid_entry2 {
                function: 7,
                ecx: 1 << 30,
                ..Default::default()
            },
        ];
        let perf_cases = [&cpuid[2..], &cpuid[..1], &cpuid[1..2]]
            .map(|unsupported| (0x345, &cpuid[..2], unsupported));
        let sgx_cases = SGX_LC_MSRS
            .iter()
            .map(|&index| (index, &cpuid[2..], &cpuid[..2]));
        for (index, supported, unsupported) in perf_cases.into_iter().chain(sgx_cases) {
            let msrs = [kvm_msr_entry {
                index,
                ..Default::default()
            }];
            assert!(validate_restore_msrs(&msrs, supported).is_ok());
            assert_eq!(
                validate_restore_msrs(&msrs, unsupported)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput,
                "MSR index {index:#x}"
            );
        }
    }

    #[test]
    fn cpuid_count_requires_at_least_one_leaf_and_respects_the_kvm_limit() {
        for count in [0, KVM_MAX_CPUID_ENTRIES + 1] {
            assert_eq!(
                validate_cpuid_count(count).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
        assert!(validate_cpuid_count(1).is_ok());
        assert!(validate_cpuid_count(KVM_MAX_CPUID_ENTRIES).is_ok());
    }

    #[test]
    fn shstk_is_rejected_for_leaf_seven_subleaf_zero() {
        let mut entry = kvm_cpuid_entry2 {
            function: 7,
            flags: KVM_CPUID_FLAG_SIGNIFCANT_INDEX,
            ecx: 1 << 7,
            ..Default::default()
        };
        assert_eq!(
            validate_snapshot_cpuid_features(&[entry])
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
        );
        entry.index = 1;
        assert!(validate_snapshot_cpuid_features(&[entry]).is_ok());
        entry.flags = 0;
        assert_eq!(
            validate_snapshot_cpuid_features(&[entry])
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
        );
        assert!(validate_snapshot_cpuid_features(&[]).is_ok());
    }

    #[test]
    fn sgx_launch_hashes_follow_sgx_lc() {
        let mut entry = kvm_cpuid_entry2 {
            function: 7,
            flags: KVM_CPUID_FLAG_SIGNIFCANT_INDEX,
            ebx: 1 << 2,
            ..Default::default()
        };
        assert!(extra_cpuid_gated_msr_indices(&[entry]).is_empty());
        entry.ecx = 1 << 30;
        assert_eq!(extra_cpuid_gated_msr_indices(&[entry]), SGX_LC_MSRS);
        entry.index = 1;
        assert!(extra_cpuid_gated_msr_indices(&[entry]).is_empty());
    }

    #[test]
    fn perf_capabilities_requires_pdcm_and_a_nonzero_pmu_version() {
        for pdcm in [false, true] {
            for pmu_version in [None, Some(0), Some(1)] {
                let mut cpuid = vec![kvm_cpuid_entry2 {
                    function: 1,
                    ecx: u32::from(pdcm) << 15,
                    ..Default::default()
                }];
                if let Some(version) = pmu_version {
                    cpuid.push(kvm_cpuid_entry2 {
                        function: 0xa,
                        eax: (1 << 8) | version,
                        ..Default::default()
                    });
                }
                let expected: &[u32] = if pdcm && pmu_version == Some(1) {
                    &[0x345]
                } else {
                    &[]
                };
                assert_eq!(extra_cpuid_gated_msr_indices(&cpuid), expected);
            }
        }
    }

    #[test]
    fn perf_capabilities_and_sgx_launch_hashes_follow_cpuid_index_flags() {
        let mut cpuid = [
            kvm_cpuid_entry2 {
                function: 1,
                ecx: 1 << 15,
                ..Default::default()
            },
            kvm_cpuid_entry2 {
                function: 0xa,
                eax: 1,
                ..Default::default()
            },
            kvm_cpuid_entry2 {
                function: 7,
                ecx: 1 << 30,
                ..Default::default()
            },
        ];
        let combined = [0x8c, 0x8d, 0x8e, 0x8f, 0x345];
        for leaf in [0, 1] {
            cpuid[leaf].flags = KVM_CPUID_FLAG_SIGNIFCANT_INDEX;
            assert_eq!(extra_cpuid_gated_msr_indices(&cpuid), combined);
            cpuid[leaf].index = 1;
            assert_eq!(extra_cpuid_gated_msr_indices(&cpuid), SGX_LC_MSRS);
            cpuid[leaf].flags = 0;
            assert_eq!(extra_cpuid_gated_msr_indices(&cpuid), combined);
        }
    }

    #[test]
    fn restore_orders_async_pf_and_sgx_dependencies() {
        let ordered = [
            MSR_KVM_ASYNC_PF_INT,
            MSR_KVM_ASYNC_PF_INT,
            MSR_KVM_ASYNC_PF_EN,
            0x4b56_4d07,
            0x8c,
            0x8d,
            0x8e,
            0x8f,
            MSR_IA32_FEAT_CTL,
            MSR_IA32_TSC_DEADLINE,
            MSR_IA32_RTIT_CTL,
        ];
        let entries = ordered.map(|index| kvm_msr_entry {
            index,
            ..Default::default()
        });
        for msrs in [
            entries,
            [10, 9, 8, 2, 3, 4, 5, 6, 7, 0, 1].map(|i| entries[i]),
        ] {
            assert_eq!(order_msrs_for_restore(&msrs).after_tsc, entries);
        }
        for entry in entries {
            assert_eq!(order_msrs_for_restore(&[entry]).after_tsc, [entry]);
        }
        let mut duplicate_vectors = [entries[0], entries[0]];
        duplicate_vectors[1].data = 42;
        let plan =
            order_msrs_for_restore(&[entries[2], duplicate_vectors[0], duplicate_vectors[1]]);
        assert_eq!(
            plan.after_tsc,
            [duplicate_vectors[0], duplicate_vectors[1], entries[2]]
        );
    }

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
    fn build_snapshot_msr_indices_excludes_cpuid_gated_msrs() {
        let advertised = [0x8c, 0x8d, 0x8e, 0x8f, 0x345];
        let indices = build_snapshot_msr_indices(&advertised);
        for index in advertised {
            assert!(!indices.contains(&index), "shared MSR index {index:#x}");
        }
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
    fn restore_orders_perf_capabilities_before_pmu_msrs() {
        let entries = [0x38f, 0x3f1, 0x186, 0x345].map(|index| kvm_msr_entry {
            index,
            ..Default::default()
        });
        let plan = order_msrs_for_restore(&entries);
        assert!(plan.before_tsc.is_empty());
        assert_eq!(plan.after_tsc, [3, 0, 1, 2].map(|pos| entries[pos]));
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
