// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `prepare` on a kernel file: the ELF fixture from the loader tests, loaded
//! into fresh guest RAM together with the boot data, and the real kernel,
//! booted on KVM up to its root-mount panic.

use std::{error::Error as _, fs, io, path::PathBuf, process};

use linux_loader::loader::bootparam::boot_params;
use vm_memory::{Bytes, GuestAddress};

use super::prepare;
use crate::{
    boot::elf::tests::{ENTRY, fixture},
    config::VmConfig,
    error::Error,
    memory::{GuestRam, ram_ranges},
};

const MEMORY_MIB: u32 = 2;
const CMDLINE: &str = "console=ttyS0 panic=-1";

/// The ELF fixture in a temporary file, removed on drop.
struct KernelFile(PathBuf);

impl KernelFile {
    fn new(test: &str) -> Self {
        let name = format!("boxlite-vmm-{}-{test}.elf", process::id());
        let path = std::env::temp_dir().join(name);
        fs::write(&path, fixture()).expect("write the ELF fixture");
        Self(path)
    }
}

impl Drop for KernelFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn config(kernel: PathBuf, cmdline: &str) -> VmConfig {
    VmConfig {
        vcpu_count: 1,
        memory_mib: MEMORY_MIB,
        kernel,
        cmdline: cmdline.into(),
    }
}

fn ram() -> GuestRam {
    GuestRam::new(&ram_ranges(MEMORY_MIB)).expect("fresh guest RAM")
}

#[test]
fn enters_the_loaded_kernel_with_rsi_at_the_zero_page() {
    let kernel = KernelFile::new("prepare");
    let ram = ram();

    let regs = prepare(&ram, &config(kernel.0.clone(), CMDLINE))
        .unwrap()
        .boot_regs;

    assert_eq!((regs.rip, regs.rsi), (ENTRY, 0x7000));
    let memory = ram.memory();
    let mut code = [0; 8];
    memory.read_slice(&mut code, GuestAddress(ENTRY)).unwrap();
    assert_eq!(&code, b"CODE1234", "the kernel is loaded at its entry");
    let params: boot_params = memory.read_obj(GuestAddress(regs.rsi)).unwrap();
    let mut line = vec![0; CMDLINE.len()];
    memory
        .read_slice(&mut line, GuestAddress(params.hdr.cmd_line_ptr.into()))
        .unwrap();
    assert_eq!(line, CMDLINE.as_bytes());
    let top = params.e820_table[usize::from(params.e820_entries) - 1];
    assert_eq!(
        { top.addr + top.size },
        u64::from(MEMORY_MIB) << 20,
        "E820 ends where RAM ends"
    );
}

#[test]
fn a_failure_names_its_step_and_keeps_the_io_cause() {
    let kernel = KernelFile::new("failure");
    let missing = std::env::temp_dir()
        .join(format!("boxlite-vmm-{}-missing", process::id()))
        .join("vmlinux");

    for (config, message, kind) in [
        (
            config(missing.clone(), CMDLINE),
            format!("failed to load the kernel {}", missing.display()),
            io::ErrorKind::NotFound,
        ),
        // `Vm::new` validates first; this bypasses it.
        (
            config(kernel.0.clone(), "console=ttyS0\nquiet"),
            "failed to write the boot parameters into guest RAM".into(),
            io::ErrorKind::InvalidInput,
        ),
    ] {
        let error = prepare(&ram(), &config).unwrap_err();
        assert!(
            matches!(
                error,
                Error::LoadKernel { .. } | Error::WriteBootData { .. }
            ),
            "{error:?}"
        );
        assert_eq!(error.to_string(), message);
        let cause = error
            .source()
            .and_then(|cause| cause.downcast_ref::<io::Error>())
            .expect("I/O cause");
        assert_eq!(cause.kind(), kind);
    }
}

/// Boots the kernel named by `VMM_KERNEL` on one KVM vCPU. A serial stub
/// collects the earlycon log, which must show the boot data as Linux read it,
/// up to the root-mount panic and the keyboard-controller reset that
/// `panic=-1 reboot=k` turn it into.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_to_the_root_mount_panic() {
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    use boxlite_hypervisor::{KvmVm, VcpuExit, VcpuHandle as _};

    use crate::cpu_features::{BOOT_MSRS, vcpu_cpuid};

    const RAM_MIB: u32 = 256;
    const LINUX_CMDLINE: &str = "earlycon=uart8250,io,0x3f8 keep_bootcon panic=-1 reboot=k";
    const TIMEOUT: Duration = Duration::from_secs(30);
    const COM1: u16 = 0x3f8;
    const COM1_LSR: u16 = COM1 + 5;
    /// Transmitter holding register and shifter empty, which earlycon polls for.
    const LSR_IDLE: u8 = 0x60;
    /// `reboot=k` pulses the reset line by writing 0xfe to this i8042 port.
    const I8042_COMMAND: u16 = 0x64;

    let kernel = std::env::var_os("VMM_KERNEL")
        .expect("set VMM_KERNEL or run make test:integration:vmm:linux");
    let config = VmConfig {
        vcpu_count: 1,
        memory_mib: RAM_MIB,
        kernel: kernel.into(),
        cmdline: LINUX_CMDLINE.into(),
    };
    config.validate().unwrap();

    // RAM is declared before the VM and vCPU so it outlives them during unwinding.
    let mut ram = GuestRam::new(&ram_ranges(RAM_MIB)).unwrap();
    let vm = KvmVm::new().expect("create KVM VM");
    ram.map(&vm).expect("map guest RAM");
    let setup = prepare(&ram, &config).unwrap();
    let mut vcpu = vm.create_vcpu(0).expect("create vCPU");
    vcpu.set_cpu_features(&vcpu_cpuid(vm.supported_cpuid(), 0, 1), &BOOT_MSRS)
        .unwrap();
    vcpu.set_boot_registers(&setup.boot_regs).unwrap();

    // A hung guest makes no more exits, so a watchdog kicks it at the deadline.
    let started = Instant::now();
    let (finished, deadline) = mpsc::channel::<()>();
    let kick = vcpu.handle();
    let watchdog = thread::spawn(move || {
        if matches!(
            deadline.recv_timeout(TIMEOUT),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            kick.kick().unwrap();
        }
    });

    // The stub: earlycon output on COM1, an idle line status, zero for every
    // other read, and every other write ignored until the reset.
    let mut log = Vec::new();
    loop {
        match vcpu.run().expect("run vCPU") {
            VcpuExit::IoOut { port: COM1, bytes } => log.extend_from_slice(bytes),
            VcpuExit::IoOut {
                port: I8042_COMMAND,
                bytes: [0xfe],
            } => break,
            VcpuExit::IoIn { port, bytes } => {
                bytes.fill(if port == COM1_LSR { LSR_IDLE } else { 0 })
            }
            VcpuExit::MmioRead { bytes, .. } => bytes.fill(0),
            VcpuExit::IoOut { .. } | VcpuExit::MmioWrite { .. } => {}
            VcpuExit::Interrupted if started.elapsed() < TIMEOUT => {}
            exit => panic!(
                "{exit:?} after {:?}, before the reset; log:\n{}",
                started.elapsed(),
                String::from_utf8_lossy(&log)
            ),
        }
    }
    vcpu.complete_pending_io().unwrap();
    drop(finished);
    watchdog.join().unwrap();
    ram.unmap(&vm).unwrap();

    let log = String::from_utf8_lossy(&log);
    let lines: Vec<&str> = log.lines().collect();
    let has_prefix = |prefix: &str| lines.iter().any(|line| line.starts_with(prefix));
    assert!(has_prefix("Linux version "), "{log}");
    assert!(
        lines.contains(&format!("Command line: {LINUX_CMDLINE}").as_str()),
        "{log}"
    );
    // E820 as Linux read it: the RAM of `ram_ranges` without [0x9_FC00, 1 MiB).
    let e820: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| line.starts_with("BIOS-e820:"))
        .collect();
    let high = format!(
        "BIOS-e820: [mem 0x0000000000100000-{:#018x}] usable",
        (u64::from(RAM_MIB) << 20) - 1
    );
    assert_eq!(
        e820,
        [
            "BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable",
            high.as_str(),
        ],
        "{log}"
    );
    assert!(has_prefix("Memory: "), "{log}");
    assert!(log.contains("VFS: Unable to mount root fs"), "{log}");
}
