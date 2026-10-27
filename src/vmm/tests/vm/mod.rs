// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `Vm` construction: validation before any host call, RAM registration on
//! the mock backend, and real KVM VMs whose guests read the mapped RAM and run
//! 64-bit code with the boot CPU state.

use std::{cell::Cell, error::Error as _, io};

use boxlite_hypervisor::Error as HypervisorError;
use vm_memory::GuestMemoryBackend;

use super::{BootRegisters, Vm};
use crate::{
    config::{MAX_VCPUS, VmConfig},
    error::Error,
    memory::{MAX_MEMORY_MIB, RAM_START, ram_ranges},
    mock_vm::{Call, MockVm},
};

/// A VM on `host_vm` with no boot data and no devices.
#[cfg_attr(
    not(target_arch = "x86_64"),
    expect(clippy::unit_arg, reason = "arm64 has no boot registers yet.")
)]
fn bare<H: boxlite_hypervisor::Vm + 'static>(
    config: VmConfig,
    host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
) -> crate::error::Result<Vm<H>> {
    Vm::with_backend(
        config,
        host_vm,
        |_, _| Ok(BootRegisters::default()),
        |_| Ok(()),
    )
}

fn config(vcpu_count: u8, memory_mib: u32) -> VmConfig {
    VmConfig {
        vcpu_count,
        memory_mib,
        kernel: "vmlinux".into(),
        cmdline: "console=ttyS0".into(),
        initramfs: None,
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
        let error = bare(config.clone(), || {
            built.set(true);
            Ok(MockVm::new())
        })
        .expect_err("invalid configuration");

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
    let vm = bare(config(1, 16), || Ok(MockVm::new())).unwrap();
    let log = vm.host_vm.log();
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

    let error = bare(config(1, 16), || Ok(backend)).expect_err("mapping fails");

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

/// A chipset conflict fails the build before any RAM is registered, so the
/// failed VM leaves nothing mapped and leaks no guest RAM.
#[test]
#[cfg_attr(
    not(target_arch = "x86_64"),
    expect(clippy::unit_arg, reason = "arm64 has no boot registers yet.")
)]
fn a_chipset_conflict_fails_before_any_ram_is_registered() {
    struct Idle;

    impl crate::bus::BusDevice for Idle {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, _data: &[u8]) {}
    }

    let backend = MockVm::new();
    let log = backend.log();

    let error = Vm::with_backend(
        config(1, 16),
        || Ok(backend),
        |_, _| Ok(BootRegisters::default()),
        |chipset| {
            for name in ["first", "second"] {
                chipset.add(name, |resources| {
                    resources.mmio(0xd000_0000, 0x1000);
                    Ok(Idle)
                })?;
            }
            Ok(())
        },
    )
    .expect_err("the second device claims a taken range");

    assert!(
        matches!(&error, Error::ChipsetConflicts(conflicts) if conflicts.len() == 1),
        "{error:?}"
    );
    assert_eq!(*log.lock().unwrap(), [], "no RAM was registered");
}

#[test]
fn a_failing_host_vm_keeps_its_cause() {
    let error = bare::<MockVm>(config(1, 16), || {
        Err(HypervisorError::CreateVm(io::Error::from(
            io::ErrorKind::Unsupported,
        )))
    })
    .expect_err("host failure");

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

    let vm = bare(config(1, MAX_MEMORY_MIB), boxlite_hypervisor::KvmVm::new).unwrap();
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

    let mut vcpu = vm.host_vm.create_vcpu(0).unwrap();
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
fn a_kvm_guest_runs_64_bit_code_with_the_boot_cpu_state() {
    use std::sync::Arc;

    use boxlite_hypervisor::VcpuExit;
    use vm_memory::{Bytes, GuestAddress};

    use crate::{
        boot::entry::long_mode_entry,
        cpu_features::{BOOT_MSRS, vcpu_cpuid},
        memory::MMIO_HOLE_START,
    };

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
        0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
        0x0f, 0xa2, // cpuid
        0x89, 0x5f, 0x38, // mov [rdi + 0x38], ebx
        0x89, 0x4f, 0x3c, // mov [rdi + 0x3c], ecx
        0x89, 0x57, 0x40, // mov [rdi + 0x40], edx
        0xb8, 0x0b, 0x00, 0x00, 0x00, // mov eax, 0xb
        0xb9, 0x01, 0x00, 0x00, 0x00, // mov ecx, 1
        0x0f, 0xa2, // cpuid
        0x89, 0x5f, 0x44, // mov [rdi + 0x44], ebx
        0x89, 0x57, 0x48, // mov [rdi + 0x48], edx
        0xb9, 0xa0, 0x01, 0x00, 0x00, // mov ecx, 0x1a0 (MISC_ENABLE)
        0x0f, 0x32, // rdmsr
        0x89, 0x47, 0x50, // mov [rdi + 0x50], eax
        0x89, 0x57, 0x54, // mov [rdi + 0x54], edx
        0xb9, 0xff, 0x02, 0x00, 0x00, // mov ecx, 0x2ff (MTRRdefType)
        0x0f, 0x32, // rdmsr
        0x89, 0x47, 0x58, // mov [rdi + 0x58], eax
        0x89, 0x57, 0x5c, // mov [rdi + 0x5c], edx
        0xba, 0xf8, 0x03, 0x00, 0x00, // mov edx, 0x3f8
        0xb0, b'L', // mov al, 'L'
        0xee, // out dx, al
        0x0f, 0x0b, // ud2
    ]);

    // Two vCPUs so the topology has a count to check; only vCPU 0 runs.
    let vm = bare(config(2, MAX_MEMORY_MIB), boxlite_hypervisor::KvmVm::new).unwrap();
    let memory = Arc::clone(vm.ram.memory());
    memory.write_slice(&program, GuestAddress(ENTRY)).unwrap();
    memory
        .write_obj(PARAMS_MARKER, GuestAddress(BOOT_PARAMS))
        .unwrap();
    memory.write_obj(TOP_MARKER, GuestAddress(top)).unwrap();
    let regs = long_mode_entry(&*memory, ENTRY, BOOT_PARAMS).unwrap();
    let cpuid = vcpu_cpuid(vm.host_vm.supported_cpuid(), 0, 2);

    let mut vcpu = vm.host_vm.create_vcpu(0).unwrap();
    vcpu.set_cpu_features(&cpuid, &BOOT_MSRS).unwrap();
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
    let [ebx, ecx, edx, core_ebx, core_edx, _]: [u32; 6] =
        memory.read_obj(GuestAddress(RESULTS + 0x38)).unwrap();
    // Leaf 1: APIC ID 0 of 2 logical CPUs, hypervisor, TSC-deadline and HTT.
    assert_eq!(ebx >> 16, 0x0002);
    assert_eq!(ecx & ((1 << 31) | (1 << 24)), (1 << 31) | (1 << 24));
    assert_eq!(edx & (1 << 28), 1 << 28);
    // Leaf 0xB core level: 2 CPUs, x2APIC ID 0.
    assert_eq!((core_ebx, core_edx), (2, 0));
    // MISC_ENABLE with FAST_STRING; MTRRs on, write-back by default.
    let msrs: [u64; 2] = memory.read_obj(GuestAddress(RESULTS + 0x50)).unwrap();
    assert_eq!(msrs, [0x1801, 0x806]);
    // ud2 without an IDT escalates to a triple fault.
    assert!(matches!(vcpu.run().unwrap(), VcpuExit::Reset));
}

/// `Vm::run` on the mock backend, whose scripted vCPUs exit as listed and
/// then wait for a kick.
#[cfg(target_arch = "x86_64")]
mod lifecycle {
    use std::{sync::mpsc, thread, time::Duration};

    use super::{config, *};
    use crate::{VmExit, bus::BusDevice, mock_vm::Step};

    /// Runs `vm` on another thread and fails the test instead of hanging when
    /// the run never returns.
    fn run(mut vm: Vm<MockVm>) -> (crate::Result<VmExit>, Vm<MockVm>) {
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            let exit = vm.run();
            let _ = done.send((exit, vm));
        });
        finished
            .recv_timeout(Duration::from_secs(10))
            .expect("Vm::run did not return")
    }

    fn mock(vcpu_count: u8, backend: MockVm) -> Vm<MockVm> {
        bare(config(vcpu_count, 16), || Ok(backend)).unwrap()
    }

    #[test]
    fn the_first_guest_exit_decides_the_outcome_and_stops_every_vcpu() {
        for (step, expected) in [
            (Step::Shutdown, VmExit::GuestShutdown),
            (Step::Reset, VmExit::GuestReset),
        ] {
            // vCPU 1 never exits on its own, so only a kick ends it.
            let (exit, vm) = run(mock(2, MockVm::with_scripts(vec![vec![step]])));
            assert_eq!(exit.unwrap(), expected);
            let log = vm.host_vm.log();
            drop(vm);
            let calls = log.lock().unwrap().clone();
            let first_unmap = calls
                .iter()
                .position(|call| matches!(call, Call::Unmap { .. }))
                .unwrap();
            let drops: Vec<_> = calls
                .iter()
                .enumerate()
                .filter(|(_, call)| matches!(call, Call::DropVcpu { .. }))
                .map(|(index, _)| index)
                .collect();
            assert_eq!(drops.len(), 2, "{calls:?}");
            assert!(drops.iter().all(|&index| index < first_unmap), "{calls:?}");
        }
    }

    #[test]
    fn only_vcpu_0_gets_the_boot_registers() {
        let (exit, vm) = run(mock(3, MockVm::with_scripts(vec![vec![Step::Shutdown]])));
        exit.unwrap();

        let calls = vm.host_vm.calls();
        let boot: Vec<_> = calls
            .iter()
            .filter(|call| matches!(call, Call::SetBootRegisters { .. }))
            .collect();
        let features = calls
            .iter()
            .filter(|call| matches!(call, Call::SetCpuFeatures { .. }))
            .count();
        assert_eq!(boot, [&Call::SetBootRegisters { id: 0 }]);
        assert_eq!(features, 3);
    }

    #[test]
    fn a_failed_run_keeps_the_hypervisor_cause() {
        let (exit, _) = run(mock(2, MockVm::with_scripts(vec![vec![Step::Fail]])));

        let error = exit.unwrap_err();
        assert!(
            matches!(
                error,
                Error::Hypervisor(HypervisorError::RunVcpu { id: 0, .. })
            ),
            "{error:?}"
        );
        let cause = error
            .source()
            .and_then(|hypervisor| hypervisor.source())
            .and_then(|cause| cause.downcast_ref::<io::Error>())
            .expect("host cause");
        assert_eq!(cause.kind(), io::ErrorKind::Other);
    }

    #[test]
    fn a_halted_vcpu_is_unexpected_with_an_in_kernel_irqchip() {
        let (exit, _) = run(mock(1, MockVm::with_scripts(vec![vec![Step::Halted]])));

        let error = exit.unwrap_err();
        assert!(
            matches!(&error, Error::UnexpectedExit { vcpu: 0, exit } if exit == "Halted"),
            "{error:?}"
        );
    }

    #[test]
    fn a_stop_from_another_thread_ends_the_run() {
        let vm = mock(2, MockVm::new());
        let stop = vm.stop_handle();
        let stopping = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            stop.stop();
        });

        let (exit, _) = run(vm);

        assert_eq!(exit.unwrap(), VmExit::StopRequested);
        stopping.join().unwrap();
    }

    #[test]
    fn a_stop_before_the_run_ends_it_at_once() {
        let vm = mock(2, MockVm::new());
        vm.stop_handle().stop();

        let (exit, _) = run(vm);

        assert_eq!(exit.unwrap(), VmExit::StopRequested);
    }

    #[test]
    fn a_vm_runs_once() {
        let (exit, mut vm) = run(mock(1, MockVm::with_scripts(vec![vec![Step::Reset]])));
        exit.unwrap();

        assert_eq!(format!("{vm:?}"), "Vm { vcpus: 1, state: Exited, .. }");
        assert!(matches!(vm.run(), Err(Error::AlreadyRan)));
    }

    struct Panics;

    impl BusDevice for Panics {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, _data: &[u8]) {
            panic!("a device bug");
        }
    }

    #[test]
    fn a_panicking_device_ends_the_vm_with_an_error() {
        const DEVICE: u64 = 0xd000_0000;
        let backend = MockVm::with_scripts(vec![vec![Step::Write {
            addr: DEVICE,
            byte: 1,
        }]]);
        let vm = Vm::with_backend(
            config(2, 16),
            || Ok(backend),
            |_, _| Ok(BootRegisters::default()),
            |chipset| {
                chipset.add("panics", |resources| {
                    resources.mmio(DEVICE, 1);
                    Ok(Panics)
                })
            },
        )
        .unwrap();

        let (exit, _) = run(vm);

        assert!(
            matches!(exit, Err(Error::VcpuPanicked { vcpu: 0 })),
            "{exit:?}"
        );
    }

    /// A console sink that takes each write only after a delay, like a slow
    /// log reader.
    #[derive(Clone, Default)]
    struct SlowSink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for SlowSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            thread::sleep(Duration::from_millis(200));
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Writes every byte the guest stores at its register to the console.
    struct ConsolePort(crate::devices::console::ConsoleWriter);

    impl BusDevice for ConsolePort {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, data: &[u8]) {
            std::io::Write::write_all(&mut self.0, data).unwrap();
        }
    }

    /// `run` returns only after the slow sink has taken the console output
    /// the guest wrote before its reset.
    #[test]
    fn run_returns_after_the_console_reaches_its_sink() {
        use crate::devices::console::ConsoleWorker;

        const DEVICE: u64 = 0xd000_0000;
        let sink = SlowSink::default();
        let (writer, worker) = ConsoleWorker::spawn(Box::new(sink.clone()), 64).unwrap();
        let backend = MockVm::with_scripts(vec![vec![
            Step::Write {
                addr: DEVICE,
                byte: b'o',
            },
            Step::Write {
                addr: DEVICE,
                byte: b'k',
            },
            Step::Reset,
        ]]);
        let mut vm = Vm::with_backend(
            config(1, 16),
            || Ok(backend),
            |_, _| Ok(BootRegisters::default()),
            |chipset| {
                chipset.add("console", |resources| {
                    resources.mmio(DEVICE, 1);
                    Ok(ConsolePort(writer))
                })
            },
        )
        .unwrap();
        vm.console = std::sync::Mutex::new(Some(worker));

        let (exit, _vm) = run(vm);

        assert_eq!(exit.unwrap(), VmExit::GuestReset);
        assert_eq!(*sink.0.lock().unwrap(), b"ok");
    }

    /// A vCPU that fails setup reports it before the start gate opens, so no
    /// vCPU enters the guest and the setup error, not a guest exit, ends the
    /// run. The two sends race, so the run repeats.
    #[test]
    fn a_setup_failure_ends_the_vm_before_any_vcpu_enters_the_guest() {
        for _ in 0..100 {
            // vCPU 1 spawns last, so it opens the gate and runs at once while
            // vCPU 0, whose setup failed, still wakes from the gate.
            let backend =
                MockVm::with_scripts(vec![vec![], vec![Step::Reset]]).and_failing_setup_of(0);
            let entries = backend.entries();

            let (exit, _) = run(mock(2, backend));

            assert!(
                matches!(
                    exit,
                    Err(Error::Hypervisor(HypervisorError::ConfigureVcpu {
                        id: 0,
                        ..
                    }))
                ),
                "{exit:?}"
            );
            assert_eq!(
                *entries.lock().unwrap(),
                [0u32; 0],
                "a vCPU entered the guest"
            );
        }
    }

    #[test]
    fn a_vcpu_that_fails_setup_ends_the_vm_without_a_deadlock() {
        let (exit, _) = run(mock(3, MockVm::failing_setup_of(1)));

        let error = exit.unwrap_err();
        assert!(
            matches!(
                error,
                Error::Hypervisor(HypervisorError::ConfigureVcpu { id: 1, .. })
            ),
            "{error:?}"
        );
    }
}

#[test]
fn lifecycle_errors_describe_themselves() {
    let io = || io::Error::from(io::ErrorKind::Other);
    let cases = [
        (Error::EventLoop(io()), "the VM event loop failed"),
        (
            Error::SpawnConsole(io()),
            "failed to start the console thread",
        ),
        (
            Error::SpawnVcpu {
                vcpu: 3,
                source: io(),
            },
            "failed to start vCPU 3",
        ),
        (
            Error::UnexpectedExit {
                vcpu: 1,
                exit: "Halted".into(),
            },
            "vCPU 1 exited unexpectedly: Halted",
        ),
        (Error::VcpuPanicked { vcpu: 2 }, "vCPU 2 panicked"),
        (Error::AlreadyRan, "the VM has already run"),
    ];
    for (error, message) in cases {
        assert_eq!(error.to_string(), message);
        let has_io_cause = matches!(
            error,
            Error::EventLoop(_) | Error::SpawnConsole(_) | Error::SpawnVcpu { .. }
        );
        assert_eq!(error.source().is_some(), has_io_cause, "{error:?}");
    }
}

#[test]
fn debug_shows_the_vm_shape_without_its_internals() {
    let vm = bare(config(2, 16), || Ok(MockVm::new())).unwrap();

    assert_eq!(format!("{vm:?}"), "Vm { vcpus: 2, state: Created, .. }");
    assert!(format!("{:?}", vm.stop_handle()).starts_with("StopHandle("));
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn new_names_a_kernel_it_cannot_load() {
    let error = Vm::new(config(1, 16), Box::new(io::sink())).expect_err("no kernel file");

    assert!(
        matches!(&error, Error::LoadKernel { path, .. } if path.as_os_str() == "vmlinux"),
        "{error:?}"
    );
}

/// Two KVM vCPUs through `Vm::run`: vCPU 0 runs a flat guest that pulses the
/// i8042 reset, while vCPU 1 waits for an INIT that never comes, so only the
/// kick after the reset ends it.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_kvm_vm_runs_until_its_guest_resets() {
    use crate::{
        VmExit,
        bus::BusDevice,
        events::{Event, EventSender},
        flat_guest,
    };

    struct Reset(EventSender);

    impl BusDevice for Reset {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, data: &[u8]) {
            if data == [0xfe] {
                self.0.send(Event::GuestReset);
            }
        }
    }

    // mov al, 0xfe; out 0x64, al; hlt
    let program = [0xb0, 0xfe, 0xe6, 0x64, 0xf4];
    let mut vm = Vm::with_backend(
        config(2, 2),
        boxlite_hypervisor::KvmVm::new,
        |ram, _| Ok(flat_guest::load(ram.memory(), &program)),
        |chipset| {
            chipset.add("i8042", |resources| {
                resources.pio(0x64, 1);
                Ok(Reset(resources.event_sender()))
            })
        },
    )
    .unwrap();

    assert_eq!(vm.run().unwrap(), VmExit::GuestReset);
}
