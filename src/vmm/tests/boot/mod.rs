// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `prepare` on a kernel file: the ELF fixture from the loader tests, loaded
//! into fresh guest RAM together with the boot data, and the real kernel,
//! booted on KVM up to its root-mount panic or, with a generated initramfs,
//! up to the panic when its init exits.

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

/// `bytes` in a temporary file named after `name`, removed on drop.
struct TempFile(PathBuf);

impl TempFile {
    fn new(name: &str, bytes: &[u8]) -> Self {
        let path = std::env::temp_dir().join(format!("boxlite-vmm-{}-{name}", process::id()));
        fs::write(&path, bytes).expect("write the temporary file");
        Self(path)
    }
}

impl Drop for TempFile {
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
        initramfs: None,
    }
}

fn ram() -> GuestRam {
    GuestRam::new(&ram_ranges(MEMORY_MIB)).expect("fresh guest RAM")
}

#[test]
fn enters_the_loaded_kernel_with_rsi_at_the_zero_page() {
    let kernel = TempFile::new("prepare.elf", &fixture());
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
fn loads_the_initramfs_at_the_top_of_ram_and_records_it() {
    let kernel = TempFile::new("initramfs.elf", &fixture());
    let archive: Vec<u8> = (0..3000).map(|index| index as u8).collect();
    let initramfs = TempFile::new("initramfs.cpio", &archive);
    let ram = ram();
    let config = VmConfig {
        initramfs: Some(initramfs.0.clone()),
        ..config(kernel.0.clone(), CMDLINE)
    };

    let regs = prepare(&ram, &config).unwrap().boot_regs;

    let memory = ram.memory();
    let params: boot_params = memory.read_obj(GuestAddress(regs.rsi)).unwrap();
    // 2 MiB of RAM minus 3000 bytes, rounded down to a page.
    let hdr = params.hdr;
    assert_eq!((hdr.ramdisk_image, hdr.ramdisk_size), (0x1f_f000, 3000));
    let mut loaded = vec![0; archive.len()];
    memory
        .read_slice(&mut loaded, GuestAddress(0x1f_f000))
        .unwrap();
    assert_eq!(loaded, archive);
}

#[test]
fn a_failure_names_its_step_and_keeps_the_io_cause() {
    let kernel = TempFile::new("failure.elf", &fixture());
    let missing = std::env::temp_dir()
        .join(format!("boxlite-vmm-{}-missing", process::id()))
        .join("vmlinux");
    let missing_initramfs = missing.with_file_name("initramfs.cpio");

    for (config, message, kind) in [
        (
            config(missing.clone(), CMDLINE),
            format!("failed to load the kernel {}", missing.display()),
            io::ErrorKind::NotFound,
        ),
        (
            VmConfig {
                initramfs: Some(missing_initramfs.clone()),
                ..config(kernel.0.clone(), CMDLINE)
            },
            format!(
                "failed to load the initramfs {}",
                missing_initramfs.display()
            ),
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
                Error::LoadKernel { .. }
                    | Error::LoadInitramfs { .. }
                    | Error::WriteBootData { .. }
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

/// The real-kernel tests boot this command line from `VMM_KERNEL`.
const LINUX_CMDLINE: &str = "earlycon=uart8250,io,0x3f8 keep_bootcon panic=-1 reboot=k";

/// `vcpu_count` vCPUs and 256 MiB of RAM for `kernel` and `initramfs`, booted
/// with `LINUX_CMDLINE`.
fn linux_config(vcpu_count: u8, initramfs: Option<PathBuf>) -> VmConfig {
    let kernel = std::env::var_os("VMM_KERNEL")
        .expect("set VMM_KERNEL or run make test:integration:vmm:linux");
    let config = VmConfig {
        vcpu_count,
        memory_mib: 256,
        kernel: kernel.into(),
        cmdline: LINUX_CMDLINE.into(),
        initramfs,
    };
    config.validate().unwrap();
    config
}

/// Boots `config` on KVM, one thread per vCPU, until the guest pulses the
/// i8042 reset that `panic=-1 reboot=k` turn every panic into. Every vCPU
/// exists before any runs, and only vCPU 0 gets the entry registers; the others
/// wait for the INIT and SIPI Linux sends them. A serial stub collects the
/// earlycon log from every vCPU; the zero page is read before they first run.
/// The reset, the first failure or a watchdog deadline kicks every vCPU.
fn boot_to_reset(config: &VmConfig) -> (String, boot_params) {
    use std::{
        sync::{Barrier, Condvar, Mutex},
        thread,
        time::{Duration, Instant},
    };

    use boxlite_hypervisor::{KvmVcpuHandle, KvmVm, VcpuExit, VcpuHandle as _};

    use crate::cpu_features::{BOOT_MSRS, vcpu_cpuid};

    const TIMEOUT: Duration = Duration::from_secs(30);
    const COM1: u16 = 0x3f8;
    const COM1_LSR: u16 = COM1 + 5;
    /// Transmitter holding register and shifter empty, which earlycon polls for.
    const LSR_IDLE: u8 = 0x60;
    /// `reboot=k` pulses the reset line by writing 0xfe to this i8042 port.
    const I8042_COMMAND: u16 = 0x64;

    // RAM is declared before the VM and vCPUs so it outlives them during unwinding.
    let mut ram = GuestRam::new(&ram_ranges(config.memory_mib)).unwrap();
    let vm = KvmVm::new().expect("create KVM VM");
    ram.map(&vm).expect("map guest RAM");
    let setup = prepare(&ram, config).unwrap();
    let zero_page = ram
        .memory()
        .read_obj(GuestAddress(setup.boot_regs.rsi))
        .unwrap();

    let count = config.vcpu_count;
    let started = Instant::now();
    let log = Mutex::new(Vec::new());
    // `None` while the guest runs, then the reset or the first failure.
    let outcome = Mutex::new(None::<Result<(), String>>);
    let stopped = Condvar::new();
    let kicks = Mutex::new(Vec::<KvmVcpuHandle>::new());
    let barrier = Barrier::new(usize::from(count) + 1);
    let stop = |result: Result<(), String>| {
        outcome.lock().unwrap().get_or_insert(result);
        stopped.notify_all();
        for kick in kicks.lock().unwrap().iter() {
            kick.kick().unwrap();
        }
    };
    let is_stopped = || outcome.lock().unwrap().is_some();

    thread::scope(|scope| {
        for index in 0..count {
            let (vm, setup, log, kicks, barrier) = (&vm, &setup, &log, &kicks, &barrier);
            let (stop, is_stopped) = (&stop, &is_stopped);
            scope.spawn(move || {
                let vcpu = vm.create_vcpu(index.into()).and_then(|mut vcpu| {
                    let cpuid = vcpu_cpuid(vm.supported_cpuid(), index, count);
                    vcpu.set_cpu_features(&cpuid, &BOOT_MSRS)?;
                    if index == 0 {
                        vcpu.set_boot_registers(&setup.boot_regs)?;
                    }
                    Ok(vcpu)
                });
                match &vcpu {
                    Ok(vcpu) => kicks.lock().unwrap().push(vcpu.handle()),
                    Err(error) => stop(Err(format!("set up vCPU {index}: {error:?}"))),
                }
                barrier.wait();
                let Ok(mut vcpu) = vcpu else { return };
                // The stub: earlycon output on COM1, an idle line status, zero
                // for every other read, and every other write ignored.
                while !is_stopped() {
                    match vcpu.run() {
                        Ok(VcpuExit::IoOut { port: COM1, bytes }) => {
                            log.lock().unwrap().extend_from_slice(bytes)
                        }
                        Ok(VcpuExit::IoOut {
                            port: I8042_COMMAND,
                            bytes: [0xfe],
                        }) => stop(Ok(())),
                        Ok(VcpuExit::IoIn { port, bytes }) => {
                            bytes.fill(if port == COM1_LSR { LSR_IDLE } else { 0 })
                        }
                        Ok(VcpuExit::MmioRead { bytes, .. }) => bytes.fill(0),
                        Ok(
                            VcpuExit::IoOut { .. }
                            | VcpuExit::MmioWrite { .. }
                            | VcpuExit::Interrupted,
                        ) => {}
                        Ok(exit) => stop(Err(format!("vCPU {index}: {exit:?}"))),
                        Err(error) => stop(Err(format!("vCPU {index}: {error:?}"))),
                    }
                }
                vcpu.complete_pending_io().unwrap();
            });
        }
        barrier.wait();
        let running = outcome.lock().unwrap();
        let (running, wait) = stopped
            .wait_timeout_while(running, TIMEOUT, |outcome| outcome.is_none())
            .unwrap();
        drop(running);
        if wait.timed_out() {
            stop(Err(format!("no reset within {TIMEOUT:?}")));
        }
    });
    ram.unmap(&vm).unwrap();

    let log = String::from_utf8_lossy(&log.into_inner().unwrap()).into_owned();
    if let Err(failure) = outcome.into_inner().unwrap().expect("stopped") {
        panic!("{failure} after {:?}; log:\n{log}", started.elapsed());
    }
    (log, zero_page)
}

/// Boots the kernel named by `VMM_KERNEL` without an initramfs. The earlycon
/// log must show the boot data as Linux read it, up to the root-mount panic.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_to_the_root_mount_panic() {
    let (log, _) = boot_to_reset(&linux_config(1, None));

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
        (256u64 << 20) - 1
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

/// A static x86_64 executable that calls `exit_group(code)`.
fn exit_program(code: u8) -> Vec<u8> {
    // mov edi, code; mov eax, 231 (exit_group); syscall
    static_program(&[0xbf, code, 0, 0, 0, 0xb8, 231, 0, 0, 0, 0x0f, 0x05])
}

/// A static x86_64 executable that pins itself to each of the first `count`
/// CPUs in turn and exits with bit i set when `getcpu` then reports CPU i.
fn affinity_program(count: u8) -> Vec<u8> {
    #[rustfmt::skip]
    let mut text = [
        0x45, 0x31, 0xe4,                   // xor r12d, r12d       (the mask)
        0x31, 0xdb,                         // xor ebx, ebx         (CPU i)
        0x41, 0xbd, 0, 0, 0, 0,             // mov r13d, count
        0x44, 0x39, 0xeb,                   // next: cmp ebx, r13d
        0x73, 0x42,                         // jae done
        0xb8, 1, 0, 0, 0,                   // mov eax, 1
        0x89, 0xd9,                         // mov ecx, ebx
        0x48, 0xd3, 0xe0,                   // shl rax, cl
        0x50,                               // push rax             (cpu_set_t)
        0xb8, 203, 0, 0, 0,                 // mov eax, 203         (sched_setaffinity)
        0x31, 0xff,                         // xor edi, edi         (this task)
        0xbe, 8, 0, 0, 0,                   // mov esi, 8
        0x48, 0x89, 0xe2,                   // mov rdx, rsp
        0x0f, 0x05,                         // syscall
        0x58,                               // pop rax
        0x48, 0x83, 0xec, 8,                // sub rsp, 8
        0xb8, 0x35, 1, 0, 0,                // mov eax, 309         (getcpu)
        0x48, 0x89, 0xe7,                   // mov rdi, rsp
        0x31, 0xf6,                         // xor esi, esi
        0x31, 0xd2,                         // xor edx, edx
        0x0f, 0x05,                         // syscall
        0x8b, 0x04, 0x24,                   // mov eax, [rsp]
        0x48, 0x83, 0xc4, 8,                // add rsp, 8
        0x39, 0xd8,                         // cmp eax, ebx
        0x75, 0x04,                         // jne skip
        0x41, 0x0f, 0xab, 0xdc,             // bts r12d, ebx
        0xff, 0xc3,                         // skip: inc ebx
        0xeb, 0xb9,                         // jmp next
        0x44, 0x89, 0xe7,                   // done: mov edi, r12d
        0xb8, 231, 0, 0, 0,                 // mov eax, 231         (exit_group)
        0x0f, 0x05,                         // syscall
    ];
    text[7] = count;
    static_program(&text)
}

/// A static x86_64 executable running `text`: one read-only, executable
/// `PT_LOAD` at 0x40_0000 holding the headers and the code.
fn static_program(text: &[u8]) -> Vec<u8> {
    const BASE: u64 = 0x40_0000;
    const HEADERS: u64 = 64 + 56;
    let size = HEADERS + text.len() as u64;
    let mut elf = vec![0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    elf.extend_from_slice(&2u16.to_le_bytes()); // ET_EXEC
    elf.extend_from_slice(&62u16.to_le_bytes()); // EM_X86_64
    elf.extend_from_slice(&1u32.to_le_bytes()); // EV_CURRENT
    elf.extend_from_slice(&(BASE + HEADERS).to_le_bytes()); // entry
    elf.extend_from_slice(&64u64.to_le_bytes()); // program headers
    elf.extend_from_slice(&0u64.to_le_bytes()); // no section headers
    elf.extend_from_slice(&0u32.to_le_bytes()); // flags
    for half in [64u16, 56, 1, 0, 0, 0] {
        // header size, program header size and count, no sections
        elf.extend_from_slice(&half.to_le_bytes());
    }
    elf.extend_from_slice(&1u32.to_le_bytes()); // PT_LOAD
    elf.extend_from_slice(&5u32.to_le_bytes()); // R and X
    for word in [0, BASE, BASE, size, size, 0x1000] {
        // offset, virtual and physical address, file and memory size, alignment
        elf.extend_from_slice(&word.to_le_bytes());
    }
    elf.extend_from_slice(text);
    elf
}

/// An uncompressed newc archive holding one executable file, `name`
/// (`Documentation/driver-api/early-userspace/buffer-format.rst`).
fn newc_archive(name: &str, data: &[u8]) -> Vec<u8> {
    fn entry(archive: &mut Vec<u8>, ino: u32, mode: u32, name: &str, data: &[u8]) {
        let fields = [
            ino,
            mode,
            0,
            0,
            1,
            0,
            data.len() as u32,
            0,
            0,
            0,
            0,
            name.len() as u32 + 1,
            0,
        ];
        archive.extend_from_slice(b"070701");
        for field in fields {
            archive.extend_from_slice(format!("{field:08X}").as_bytes());
        }
        archive.extend_from_slice(name.as_bytes());
        archive.push(0);
        archive.resize(archive.len().next_multiple_of(4), 0);
        archive.extend_from_slice(data);
        archive.resize(archive.len().next_multiple_of(4), 0);
    }

    let mut archive = Vec::new();
    entry(&mut archive, 1, 0o100_755, name, data);
    entry(&mut archive, 0, 0, "TRAILER!!!", &[]);
    archive
}

/// Boots the kernel named by `VMM_KERNEL` with a generated initramfs whose
/// `/init` exits with 42. Linux must find the archive where the zero page
/// says, run its init, and report the exit code when init dies.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn runs_the_initramfs_init_until_it_exits() {
    let archive = newc_archive("init", &exit_program(42));
    let initramfs = TempFile::new("init.cpio", &archive);

    let (log, zero_page) = boot_to_reset(&linux_config(1, Some(initramfs.0.clone())));

    let (start, size) = (
        u64::from(zero_page.hdr.ramdisk_image),
        u64::from(zero_page.hdr.ramdisk_size),
    );
    assert_eq!(size, archive.len() as u64);
    let end = (start + size).next_multiple_of(0x1000) - 1;
    let lines: Vec<&str> = log.lines().collect();
    let position = |line: &str| lines.iter().position(|logged| *logged == line);
    let ramdisk = format!("RAMDISK: [mem {start:#010x}-{end:#010x}]");
    let steps = [
        ramdisk.as_str(),
        "Unpacking initramfs...",
        "Run /init as init process",
        "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00002a00",
    ]
    .map(|line| position(line).unwrap_or_else(|| panic!("no {line:?} in:\n{log}")));
    assert!(steps.is_sorted(), "out of order {steps:?}:\n{log}");
    assert!(!log.contains("VFS: Unable to mount root fs"), "{log}");
}

/// Boots the kernel named by `VMM_KERNEL` on four vCPUs. Linux must read the
/// MP table, list each vCPU and the IOAPIC, and bring every vCPU up with a
/// synchronized TSC.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn brings_up_every_vcpu() {
    let (log, _) = boot_to_reset(&linux_config(4, None));

    let lines: Vec<&str> = log.lines().collect();
    for line in [
        "found SMP MP-table at [mem 0x0009fc00-0x0009fc0f]",
        "Processor #0 (Bootup-CPU)",
        "Processor #1",
        "Processor #2",
        "Processor #3",
        "IOAPIC[0]: apic_id 5, version 17, address 0xfec00000, GSI 0-23",
        "smp: Brought up 1 node, 4 CPUs",
    ] {
        assert!(lines.contains(&line), "no {line:?} in:\n{log}");
    }
    assert!(
        !lines
            .iter()
            .any(|line| line.contains("TSC") && line.contains("unstable")),
        "{log}"
    );
    assert!(log.contains("VFS: Unable to mount root fs"), "{log}");
}

/// Boots the kernel named by `VMM_KERNEL` on four vCPUs with an `/init` that
/// moves itself to each CPU in turn; it exits with a bit set for every CPU it
/// ran on, so Linux reports 0x0f.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn runs_user_code_on_every_vcpu() {
    let archive = newc_archive("init", &affinity_program(4));
    let initramfs = TempFile::new("affinity.cpio", &archive);

    let (log, _) = boot_to_reset(&linux_config(4, Some(initramfs.0.clone())));

    let panic = "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000f00";
    assert!(log.lines().any(|line| line == panic), "{log}");
}
