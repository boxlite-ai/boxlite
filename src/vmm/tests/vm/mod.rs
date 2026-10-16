// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `Vm` construction: validation before any host call, RAM registration on
//! the mock backend, and real KVM VMs whose guests read the mapped RAM and run
//! 64-bit code from the long-mode entry state.

use std::{cell::Cell, error::Error as _, io};

use boxlite_hypervisor::Error as HypervisorError;
use vm_memory::GuestMemoryBackend;

use super::Vm;
use crate::{
    config::{MAX_VCPUS, VmConfig},
    error::Error,
    memory::{MAX_MEMORY_MIB, RAM_START, ram_ranges},
    mock_vm::{Call, MockVm},
};

fn config(vcpu_count: u8, memory_mib: u32) -> VmConfig {
    VmConfig {
        vcpu_count,
        memory_mib,
    }
}

#[test]
fn invalid_configuration_fails_before_the_host_vm_exists() {
    let cases = [
        (config(0, 1), "invalid vCPU count: 0"),
        (config(65, 1), "invalid vCPU count: 65"),
        (config(1, 0), "invalid memory size: 0 MiB"),
        (config(1, 3073), "invalid memory size: 3073 MiB"),
    ];
    for (config, message) in cases {
        let built = Cell::new(false);
        let error = Vm::with_backend(config, || {
            built.set(true);
            Ok(MockVm::new())
        })
        .err()
        .expect("invalid configuration");

        assert_eq!(error.to_string(), message);
        assert!(matches!(
            error,
            Error::InvalidVcpuCount(_) | Error::InvalidMemorySize(_)
        ));
        assert!(error.source().is_none());
        assert!(!built.get(), "the host VM must not exist for {config:?}");
    }
    config(MAX_VCPUS, MAX_MEMORY_MIB).validate().unwrap();
}

#[test]
fn maps_the_ram_layout_with_its_host_address_and_unmaps_on_drop() {
    let vm = Vm::with_backend(config(1, 16), || Ok(MockVm::new())).unwrap();
    let log = vm.backend.log();
    let [(start, size)] = ram_ranges(16)[..] else {
        panic!("one region")
    };
    assert_eq!(start.0, RAM_START);
    let host_addr = vm.ram.memory().get_host_address(start).unwrap() as usize;
    let map = Call::Map {
        guest_addr: start.0,
        host_addr,
        size,
    };
    let unmap = Call::Unmap {
        guest_addr: start.0,
        host_addr,
        size,
    };
    assert_eq!(*log.lock().unwrap(), [map]);

    drop(vm);
    assert_eq!(*log.lock().unwrap(), [map, unmap]);
}

#[test]
fn a_rejected_mapping_returns_the_hypervisor_error_and_keeps_no_registration() {
    let backend = MockVm::failing_at(&[0]);
    let log = backend.log();

    let error = Vm::with_backend(config(1, 16), || Ok(backend))
        .err()
        .expect("mapping fails");

    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::MapMemory { guest_addr, size, .. })
            if guest_addr == RAM_START && size == 16 << 20
    ));
    let calls = log.lock().unwrap().clone();
    assert_eq!(
        calls.len(),
        1,
        "nothing was registered, so nothing is unmapped"
    );
    assert!(matches!(calls[0], Call::Map { .. }));
}

#[test]
fn a_failing_host_vm_keeps_its_cause() {
    let error = Vm::<MockVm>::with_backend(config(1, 16), || {
        Err(HypervisorError::CreateVm(io::Error::from(
            io::ErrorKind::Unsupported,
        )))
    })
    .err()
    .expect("host failure");

    let cause = error
        .source()
        .and_then(|hypervisor| hypervisor.source())
        .and_then(|cause| cause.downcast_ref::<io::Error>())
        .expect("host cause");
    assert_eq!(cause.kind(), io::ErrorKind::Unsupported);
}

#[test]
fn vm_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Vm<MockVm>>();
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_kvm_guest_reads_the_last_byte_of_the_mapped_layout() {
    use std::sync::Arc;

    use boxlite_hypervisor::{VcpuExit, X86BootRegisters, X86Segment};
    use vm_memory::{Bytes, GuestAddress};

    use crate::memory::MMIO_HOLE_START;

    let vm = Vm::new(config(1, MAX_MEMORY_MIB)).unwrap();
    let memory = Arc::clone(vm.ram.memory());
    let last = GuestAddress(MMIO_HOLE_START - 1);
    // mov al,[0xBFFFFFFF]; mov dx,0x3f8; out dx,al; hlt
    let program = [
        0xa0, 0xff, 0xff, 0xff, 0xbf, 0x66, 0xba, 0xf8, 0x03, 0xee, 0xf4,
    ];
    memory.write_slice(&program, GuestAddress(0x1000)).unwrap();
    memory.write_obj(b'Z', last).unwrap();
    // Flat 32-bit descriptors: null, code, data.
    for (index, descriptor) in [0u64, 0x00cf_9b00_0000_ffff, 0x00cf_9300_0000_ffff]
        .into_iter()
        .enumerate()
    {
        memory
            .write_obj(descriptor, GuestAddress(0x500 + index as u64 * 8))
            .unwrap();
    }

    let mut vcpu = vm.backend.create_vcpu(0).unwrap();
    let code = X86Segment {
        limit: u32::MAX,
        selector: 8,
        attributes: 0xc09b,
        ..Default::default()
    };
    vcpu.set_boot_registers(&X86BootRegisters {
        rip: 0x1000,
        rsp: 0x8000,
        rflags: 2,
        cr0: 1, // Protected mode with paging off: linear address == guest address.
        code,
        data: X86Segment {
            selector: 16,
            attributes: 0xc093,
            ..code
        },
        gdt_base: 0x500,
        gdt_limit: 23,
        ..Default::default()
    })
    .unwrap();

    match vcpu.run().unwrap() {
        VcpuExit::IoOut { port, bytes } => {
            assert_eq!(port, 0x3f8);
            assert_eq!(bytes, b"Z");
        }
        exit => panic!("unexpected exit: {exit:?}"),
    }
    // Complete the OUT without reaching HLT, which would wait inside KVM.
    vcpu.complete_pending_io().unwrap();
    drop(vcpu);

    let weak = Arc::downgrade(&memory);
    drop(memory);
    drop(vm);
    assert!(
        weak.upgrade().is_none(),
        "the VM unmapped its RAM on drop and released it"
    );
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_kvm_guest_runs_64_bit_code_from_the_long_mode_entry_state() {
    use std::sync::Arc;

    use boxlite_hypervisor::VcpuExit;
    use vm_memory::{Bytes, GuestAddress};

    use crate::{boot::entry::long_mode_entry, memory::MMIO_HOLE_START};

    const ENTRY: u64 = 0x100_0000;
    const BOOT_PARAMS: u64 = 0x7000;
    const RESULTS: u64 = 0x6000;
    const PARAMS_MARKER: u64 = 0x0123_4567_89ab_cdef;
    const TOP_MARKER: u64 = 0xfedc_ba98_7654_3210;
    let top = MMIO_HOLE_START - 8;
    let mut program = vec![
        0xb8, 0x18, 0x00, 0x00, 0x00, // mov eax, 0x18 (__BOOT_DS)
        0x8e, 0xd8, // mov ds, eax: each reload reads the GDT in RAM
        0x8e, 0xc0, // mov es, eax
        0x8e, 0xd0, // mov ss, eax
        0x6a, 0x10, // push 0x10 (__BOOT_CS)
        0x48, 0x8d, 0x05, 0x03, 0x00, 0x00, 0x00, // lea rax, [rip + 3]
        0x50, // push rax
        0x48, 0xcb, // retfq: reloads CS, which must keep 64-bit mode
        0xbf, 0x00, 0x60, 0x00, 0x00, // mov edi, RESULTS
        0x9c, // pushfq
        0x8f, 0x47, 0x10, // pop qword [rdi + 0x10]
        0x48, 0x8b, 0x06, // mov rax, [rsi]
        0x48, 0x89, 0x07, // mov [rdi], rax
        0xbb, // mov ebx, top
    ];
    program.extend_from_slice(&(top as u32).to_le_bytes());
    program.extend_from_slice(&[
        0x48, 0x8b, 0x03, // mov rax, [rbx]
        0x48, 0x89, 0x47, 0x08, // mov [rdi + 0x08], rax
        0x0f, 0x20, 0xc0, // mov rax, cr0
        0x48, 0x89, 0x47, 0x18, // mov [rdi + 0x18], rax
        0x0f, 0x20, 0xd8, // mov rax, cr3
        0x48, 0x89, 0x47, 0x20, // mov [rdi + 0x20], rax
        0x0f, 0x20, 0xe0, // mov rax, cr4
        0x48, 0x89, 0x47, 0x28, // mov [rdi + 0x28], rax
        0xb9, 0x80, 0x00, 0x00, 0xc0, // mov ecx, 0xc0000080 (EFER)
        0x0f, 0x32, // rdmsr
        0x89, 0x47, 0x30, // mov [rdi + 0x30], eax
        0x89, 0x57, 0x34, // mov [rdi + 0x34], edx
        0xba, 0xf8, 0x03, 0x00, 0x00, // mov edx, 0x3f8
        0xb0, b'L', // mov al, 'L'
        0xee, // out dx, al
        0x0f, 0x0b, // ud2
    ]);

    let vm = Vm::new(config(1, MAX_MEMORY_MIB)).unwrap();
    let memory = Arc::clone(vm.ram.memory());
    memory.write_slice(&program, GuestAddress(ENTRY)).unwrap();
    memory
        .write_obj(PARAMS_MARKER, GuestAddress(BOOT_PARAMS))
        .unwrap();
    memory.write_obj(TOP_MARKER, GuestAddress(top)).unwrap();
    let regs = long_mode_entry(&*memory, ENTRY, BOOT_PARAMS).unwrap();

    let mut vcpu = vm.backend.create_vcpu(0).unwrap();
    vcpu.set_cpu_features(vm.backend.supported_cpuid(), &[])
        .unwrap();
    vcpu.set_boot_registers(&regs).unwrap();
    match vcpu.run().unwrap() {
        VcpuExit::IoOut { port, bytes } => assert_eq!((port, bytes), (0x3f8, &b"L"[..])),
        exit => panic!("unexpected exit: {exit:?}"),
    }
    vcpu.complete_pending_io().unwrap();
    let results: [u64; 7] = memory.read_obj(GuestAddress(RESULTS)).unwrap();
    assert_eq!(
        results,
        [
            PARAMS_MARKER,
            TOP_MARKER,
            regs.rflags,
            regs.cr0,
            regs.cr3,
            regs.cr4,
            regs.efer
        ]
    );
    // ud2 without an IDT escalates to a triple fault.
    assert!(matches!(vcpu.run().unwrap(), VcpuExit::Reset));
}
