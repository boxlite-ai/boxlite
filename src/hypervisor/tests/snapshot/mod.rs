// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Postcard coverage for the host-specific state images, without a VMM envelope.

use kvm_bindings::KVM_MAX_CPUID_ENTRIES;
use serde::{Serialize, de::DeserializeOwned};

use super::{MAX_SNAPSHOT_MSR_ENTRIES, X86IrqchipState, X86VcpuState, X86VmState};

struct Blob<'a>(&'a [u8]);

impl Serialize for Blob<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(self.0)
    }
}

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
    let mut state = platform();
    round_trip(&state);
    state.pit = None;
    round_trip(&state);
}

fn platform() -> X86VmState {
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
    state
}

#[test]
fn cpu_postcard_enforces_flexible_array_bounds() {
    let mut state = cpu();
    for count in [0, 65535, 65536, 65537] {
        state.xsave.resize(count, 0x12345678);
        let bytes = postcard::to_allocvec(&state).unwrap();
        assert_eq!(
            postcard::from_bytes::<X86VcpuState>(&bytes).is_ok(),
            count <= 65536
        );
    }
    state.xsave.clear();
    for count in [
        0,
        KVM_MAX_CPUID_ENTRIES - 1,
        KVM_MAX_CPUID_ENTRIES,
        KVM_MAX_CPUID_ENTRIES + 1,
    ] {
        state.cpuid.resize(count, Default::default());
        let bytes = postcard::to_allocvec(&state).unwrap();
        assert_eq!(
            postcard::from_bytes::<X86VcpuState>(&bytes).is_ok(),
            count <= KVM_MAX_CPUID_ENTRIES
        );
    }
    state.cpuid.clear();
    for count in [
        0,
        MAX_SNAPSHOT_MSR_ENTRIES - 1,
        MAX_SNAPSHOT_MSR_ENTRIES,
        MAX_SNAPSHOT_MSR_ENTRIES + 1,
    ] {
        state.msrs.resize(count, Default::default());
        let bytes = postcard::to_allocvec(&state).unwrap();
        assert_eq!(
            postcard::from_bytes::<X86VcpuState>(&bytes).is_ok(),
            count <= MAX_SNAPSHOT_MSR_ENTRIES
        );
    }
}

fn wrong_abi_lengths(encoded: &[u8]) -> impl Iterator<Item = Vec<u8>> + '_ {
    let payload: &[u8] = postcard::from_bytes(encoded).unwrap();
    [0, payload.len() - 1, payload.len() + 1]
        .into_iter()
        .map(move |len| {
            let mut wrong = payload.to_vec();
            wrong.resize(len, 0);
            postcard::to_allocvec(&Blob(&wrong)).unwrap()
        })
}

#[test]
fn fixed_abi_fields_reject_malformed_postcard_lengths() {
    fn check<T: Serialize + DeserializeOwned>(value: &T) {
        let encoded = postcard::to_allocvec(value).unwrap();
        assert!(postcard::from_bytes::<T>(&encoded).is_ok());
        for malformed in wrong_abi_lengths(&encoded) {
            assert!(postcard::from_bytes::<T>(&malformed).is_err());
        }
    }
    check(&platform().irqchips[0]);

    #[derive(Serialize, serde::Deserialize)]
    struct Abi<T>(
        #[serde(
            with = "super::exact_abi_serde",
            bound = "T: Serialize + DeserializeOwned"
        )]
        T,
    );
    let state = cpu();
    check(&Abi(state.regs));
    check(&Abi(state.sregs));
    check(&Abi(state.xcrs));
    check(&Abi(state.debug_regs));
    check(&Abi(state.events));
    check(&Abi(state.mp_state));
    check(&Abi(state.lapic));
    check(&Abi(state.cpuid[0]));
    check(&Abi(state.msrs[0]));
    let vm = platform();
    check(&Abi(vm.clock));
    check(&Abi(vm.pit.unwrap()));
}

#[test]
fn full_snapshots_reject_malformed_abi_field_lengths() {
    fn check<T: Serialize + DeserializeOwned, F: Serialize>(state: &T, field: &F) {
        let field_type = std::any::type_name::<F>();
        let encoded = postcard::to_allocvec(state).unwrap();
        let field = postcard::to_allocvec(field).unwrap();
        let offsets: Vec<_> = encoded
            .windows(field.len())
            .enumerate()
            .filter_map(|(offset, bytes)| (bytes == field).then_some(offset))
            .collect();
        assert_eq!(offsets.len(), 1, "locating {field_type}");
        let offset = offsets[0];
        for malformed in wrong_abi_lengths(&field) {
            let mut bytes = encoded.clone();
            bytes.splice(offset..offset + field.len(), malformed);
            assert!(postcard::from_bytes::<T>(&bytes).is_err(), "{field_type}");
        }
    }
    let vm = platform();
    check(&vm, &vm.irqchips[1]);
    check(&vm, vm.pit.as_ref().unwrap());
    check(&vm, &vm.clock);
    let state = cpu();
    check(&state, &state.regs);
    check(&state, &state.sregs);
    check(&state, &state.cpuid[0]);
    check(&state, &state.msrs[0]);
    check(&state, &state.xcrs);
    check(&state, &state.debug_regs);
    check(&state, &state.events);
    check(&state, &state.mp_state);
    check(&state, &state.lapic);
}

#[test]
fn fpu_postcard_rejects_non_abi_lengths() {
    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct Fpu(#[serde(with = "super::fpu_serde")] kvm_bindings::kvm_fpu);
    let state = Fpu(cpu().fpu);
    let encoded = postcard::to_allocvec(&state).unwrap();
    assert_eq!(postcard::from_bytes::<Fpu>(&encoded).unwrap(), state);
    // Obtain the ABI payload from the production serializer, not a second
    // implementation of the FPU layout or its postcard length prefix.
    for malformed in wrong_abi_lengths(&encoded) {
        assert!(postcard::from_bytes::<Fpu>(&malformed).is_err());
    }
}

#[test]
fn snapshot_defaults_fail_closed_for_an_unsnapshotable_backend() {
    use crate::{IoCompletion, MemoryRegion, Vcpu, VcpuExit, VcpuHandle, Vm, X86Vcpu, X86Vm};
    struct Backend;
    struct Cpu;
    #[derive(Clone)]
    struct Handle;
    impl VcpuHandle for Handle {
        fn kick(&self) -> crate::Result<()> {
            panic!("unexpected kick")
        }
    }
    impl Vcpu for Cpu {
        type Handle = Handle;
        fn run(&mut self) -> crate::Result<VcpuExit<'_>> {
            panic!("unexpected guest entry")
        }
        fn complete_pending_io(&mut self) -> crate::Result<IoCompletion<'_>> {
            panic!("unexpected I/O completion")
        }
        fn handle(&self) -> Handle {
            Handle
        }
    }
    impl X86Vcpu for Cpu {
        fn set_cpu_features(
            &mut self,
            _: &[crate::X86CpuidEntry],
            _: &[crate::X86Msr],
        ) -> crate::Result<()> {
            panic!("unexpected boot features")
        }
        fn set_boot_registers(&mut self, _: &crate::X86BootRegisters) -> crate::Result<()> {
            panic!("unexpected boot registers")
        }
    }
    impl Vm for Backend {
        type Vcpu = Cpu;
        unsafe fn map_memory(&self, _: &MemoryRegion) -> crate::Result<()> {
            panic!("unexpected map")
        }
        fn unmap_memory(&self, _: &MemoryRegion) -> crate::Result<()> {
            panic!("unexpected unmap")
        }
        fn set_irq_line(&self, _: u32, _: bool) -> crate::Result<()> {
            panic!("unexpected IRQ")
        }
        fn create_vcpu(&self, _: u32) -> crate::Result<Cpu> {
            panic!("unexpected vCPU creation")
        }
    }
    impl X86Vm for Backend {
        fn supported_cpuid(&self) -> &[crate::X86CpuidEntry] {
            panic!("unexpected boot CPUID")
        }
    }
    let platform = X86VmState {
        irqchips: [
            X86IrqchipState::pic(0, Default::default()),
            X86IrqchipState::pic(1, Default::default()),
            X86IrqchipState::ioapic(Default::default()),
        ],
        pit: None,
        clock: Default::default(),
    };
    for (operation, error) in [
        ("save", Backend.save_state().unwrap_err()),
        (
            "restore",
            Backend.restore_before_vcpus(&platform).unwrap_err(),
        ),
        (
            "restore",
            Backend.restore_after_vcpus(&platform).unwrap_err(),
        ),
    ] {
        assert!(
            matches!(error, crate::Error::VmState { operation: actual, ref source }
            if actual == operation && source.kind() == std::io::ErrorKind::Unsupported
                && source.raw_os_error().is_none())
        );
    }
    for (operation, error) in [
        (
            "save CPU state (unsupported backend)",
            Cpu.save_state().unwrap_err(),
        ),
        (
            "restore CPU state (unsupported backend)",
            Cpu.restore_state(&cpu()).unwrap_err(),
        ),
        (
            "notify guest stopped (unsupported backend)",
            Cpu.notify_guest_stopped().unwrap_err(),
        ),
    ] {
        assert!(
            matches!(error, crate::Error::ConfigureVcpu { id: 0, operation: actual, ref source }
            if actual == operation && source.kind() == std::io::ErrorKind::Unsupported
                && source.raw_os_error().is_none())
        );
    }
}
