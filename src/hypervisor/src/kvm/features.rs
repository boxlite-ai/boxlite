// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io;

use kvm_bindings::{
    CpuId, KVM_CPUID_FLAG_SIGNIFCANT_INDEX, KVM_MAX_CPUID_ENTRIES, Msrs, kvm_cpuid_entry2,
    kvm_msr_entry,
};
use kvm_ioctls::Kvm;

use super::KvmVcpu;
use crate::{Error, Result, X86CpuidEntry, X86Msr};

pub(super) fn supported_cpuid(kvm: &Kvm) -> io::Result<Vec<X86CpuidEntry>> {
    kvm.get_supported_cpuid(KVM_MAX_CPUID_ENTRIES)
        .map_err(io::Error::from)?
        .as_slice()
        .iter()
        .map(|entry| {
            if entry.flags & !KVM_CPUID_FLAG_SIGNIFCANT_INDEX != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!("stateful CPUID leaf {:#x} is unsupported", entry.function),
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

fn check_written(msrs: &Msrs, written: usize) -> io::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
