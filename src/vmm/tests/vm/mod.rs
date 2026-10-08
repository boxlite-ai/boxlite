// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `Vm` construction: validation before any host call, RAM registration on
//! the fake backend, and one real KVM VM whose guest reads the mapped RAM.

use std::{cell::Cell, error::Error as _, io};

use boxlite_hypervisor::Error as HypervisorError;
use vm_memory::GuestMemoryBackend;

use super::Vm;
use crate::{
    config::{MAX_VCPUS, VmConfig},
    error::Error,
    fake_vm::{Call, FakeVm},
    memory::{MAX_MEMORY_MIB, RAM_START, ram_ranges},
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
            Ok(FakeVm::new())
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
    let vm = Vm::with_backend(config(1, 16), || Ok(FakeVm::new())).unwrap();
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
    let backend = FakeVm::failing_at(&[0]);
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
    let error = Vm::<FakeVm>::with_backend(config(1, 16), || {
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
    assert_send_sync::<Vm<FakeVm>>();
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
