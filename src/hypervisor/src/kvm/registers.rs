// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use kvm_bindings::{kvm_dtable, kvm_fpu, kvm_regs, kvm_segment};

use super::KvmVcpu;
use crate::{Error, Result, X86BootRegisters, X86Segment};

impl KvmVcpu {
    /// Installs caller-selected architectural state before the first guest entry.
    ///
    /// This is not transactional: discard the vCPU if any register write fails.
    /// CPUID and MSR configuration are separate from these entry registers.
    pub fn set_boot_registers(&mut self, state: &X86BootRegisters) -> Result<()> {
        let failure = |operation, source: kvm_ioctls::Error| Error::ConfigureVcpu {
            id: self.id,
            operation,
            source: source.into(),
        };
        // Start with KVM's APIC/TR/LDT state, which is not Linux boot policy.
        let mut special = self.fd.get_sregs().map_err(|e| failure("get sregs", e))?;
        special.cs = segment(state.code);
        special.ds = segment(state.data);
        special.es = special.ds;
        special.fs = special.ds;
        special.gs = special.ds;
        special.ss = special.ds;
        special.gdt = kvm_dtable {
            base: state.gdt_base,
            limit: state.gdt_limit,
            ..Default::default()
        };
        special.idt = kvm_dtable {
            base: state.idt_base,
            limit: state.idt_limit,
            ..Default::default()
        };
        special.cr0 = state.cr0;
        special.cr3 = state.cr3;
        special.cr4 = state.cr4;
        special.efer = state.efer;
        self.fd
            .set_sregs(&special)
            .map_err(|e| failure("set sregs", e))?;
        self.fd
            .set_fpu(&kvm_fpu {
                fcw: 0x37f,
                ..Default::default()
            })
            .map_err(|e| failure("set fpu", e))?;
        self.fd
            .set_regs(&kvm_regs {
                rip: state.rip,
                rsp: state.rsp,
                rsi: state.rsi,
                rflags: state.rflags,
                ..Default::default()
            })
            .map_err(|e| failure("set regs", e))
    }
}

fn segment(value: X86Segment) -> kvm_segment {
    let flags = value.attributes;
    kvm_segment {
        base: value.base,
        limit: value.limit,
        selector: value.selector,
        type_: (flags & 0xf) as u8,
        s: ((flags >> 4) & 1) as u8,
        dpl: ((flags >> 5) & 3) as u8,
        present: ((flags >> 7) & 1) as u8,
        avl: ((flags >> 12) & 1) as u8,
        l: ((flags >> 13) & 1) as u8,
        db: ((flags >> 14) & 1) as u8,
        g: ((flags >> 15) & 1) as u8,
        unusable: u8::from(flags & 0x80 == 0),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_access_and_mode_bits_are_decoded_independently() {
        let code = segment(X86Segment {
            base: 0x1234,
            limit: 0xffff_ffff,
            selector: 8,
            attributes: 0xa09b,
        });
        assert_eq!(
            (code.base, code.limit, code.selector),
            (0x1234, u32::MAX, 8)
        );
        assert_eq!((code.type_, code.s, code.dpl, code.present), (11, 1, 0, 1));
        assert_eq!(
            (code.l, code.db, code.g, code.avl, code.unusable),
            (1, 0, 1, 0, 0)
        );
        let data = segment(X86Segment {
            attributes: 0xd0f3,
            ..Default::default()
        });
        assert_eq!(
            (data.type_, data.dpl, data.db, data.avl, data.l),
            (3, 3, 1, 1, 0)
        );
        assert_eq!(segment(X86Segment::default()).unusable, 1);
    }
}
