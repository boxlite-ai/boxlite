// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Postcard coverage for the host-specific state images, without a VMM envelope.

use super::{X86IrqchipState, X86VcpuState, X86VmState};

fn cpu() -> X86VcpuState {
    let mut state = X86VcpuState {
        regs: Default::default(),
        sregs: Default::default(),
        fpu: Default::default(),
        xsave: vec![0, 1, 2, 3],
        cpuid: vec![],
        msrs: vec![],
        xcrs: Default::default(),
        debug_regs: Default::default(),
        events: Default::default(),
        mp_state: Default::default(),
        lapic: Default::default(),
        tsc_khz: 1234,
    };
    let s = &mut state;
    s.regs.rax = 0x123456789;
    s.regs.rip = 0x876543210;
    s.sregs.cs.selector = 16;
    s.sregs.cr3 = 0x5000;
    s.fpu.fpr[3] = [17; 16];
    s.fpu.xmm[15] = [42; 16];
    s.fpu.fcw = 0x37f;
    s.fpu.fsw = 0x1234;
    s.fpu.ftwx = 0x5a;
    s.fpu.last_opcode = 0xabcd;
    s.fpu.last_ip = 0x1234567887654321;
    s.fpu.last_dp = 0xfedcba9876543210;
    s.fpu.mxcsr = 0x1f80;
    s.fpu.pad1 = 1;
    s.fpu.pad2 = 2;
    s.xsave = vec![0x12345678; 1024];
    s.cpuid.resize(2, Default::default());
    s.cpuid[0].function = 7;
    s.cpuid[0].index = 1;
    s.cpuid[0].flags = 3;
    s.cpuid[0].eax = 5;
    s.cpuid[0].ebx = 7;
    s.cpuid[0].ecx = 9;
    s.cpuid[0].edx = 11;
    s.cpuid[0].padding = [13, 15, 17];
    s.cpuid[1].function = 0xd;
    s.cpuid[1].eax = 7;
    s.cpuid[1].ebx = 832;
    s.cpuid[1].ecx = 4096;
    s.msrs.resize(2, Default::default());
    s.msrs[0].index = 0x10;
    s.msrs[0].data = 0x123456789;
    s.msrs[0].reserved = 7;
    s.msrs[1].index = 0x1b;
    s.xcrs.nr_xcrs = 1;
    s.xcrs.xcrs[0].value = 7;
    s.debug_regs.dr7 = 0x400;
    s.events.exception.nr = 14;
    s.mp_state.mp_state = 3;
    s.lapic.regs[0] = 42;
    s.tsc_khz = 2345678;
    state
}

fn round_trip<T>(state: &T)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let bytes = postcard::to_allocvec(state).unwrap();
    assert_eq!(&postcard::from_bytes::<T>(&bytes).unwrap(), state);
    for end in 0..bytes.len() {
        assert!(
            postcard::from_bytes::<T>(&bytes[..end]).is_err(),
            "truncated at {end}"
        );
    }
}

#[test]
fn cpu_postcard_round_trips_every_state_field_and_rejects_truncation() {
    round_trip(&cpu());
}

#[test]
fn platform_postcard_round_trips_created_and_absent_pit() {
    let mut state = X86VmState {
        irqchips: [
            X86IrqchipState::pic(
                0,
                kvm_bindings::kvm_pic_state {
                    imr: 0xa5,
                    ..Default::default()
                },
            ),
            X86IrqchipState::pic(
                1,
                kvm_bindings::kvm_pic_state {
                    irr: 0x24,
                    ..Default::default()
                },
            ),
            X86IrqchipState::ioapic(Default::default()),
        ],
        pit: Some(Default::default()),
        clock: Default::default(),
    };
    let mut ioapic = kvm_bindings::kvm_ioapic_state::default();
    ioapic.redirtbl[7].bits = 0x71 | (1 << 16) | (3 << 56);
    state.irqchips[2] = X86IrqchipState::ioapic(ioapic);
    state.pit.as_mut().unwrap().channels[2].count = 0x7654;
    state.clock.clock = 0x23456789;
    state.clock.realtime = 0x3456789;
    state.clock.host_tsc = 0x456789;
    round_trip(&state);
    state.pit = None;
    round_trip(&state);
}

#[test]
fn cpu_postcard_enforces_flexible_array_bounds() {
    let mut state = cpu();
    for count in [65536, 65537] {
        state.xsave.resize(count, 0x12345678);
        let bytes = postcard::to_allocvec(&state).unwrap();
        assert_eq!(
            postcard::from_bytes::<X86VcpuState>(&bytes).is_ok(),
            count == 65536
        );
    }
    state.xsave.clear();
    for count in [256, 257] {
        state.cpuid.resize(count, Default::default());
        let bytes = postcard::to_allocvec(&state).unwrap();
        assert_eq!(
            postcard::from_bytes::<X86VcpuState>(&bytes).is_ok(),
            count == 256
        );
    }
    state.cpuid.clear();
    for count in [4096, 4097] {
        state.msrs.resize(count, Default::default());
        let bytes = postcard::to_allocvec(&state).unwrap();
        assert_eq!(
            postcard::from_bytes::<X86VcpuState>(&bytes).is_ok(),
            count == 4096
        );
    }
}
