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

/// Stub devices for the real-kernel boots. COM1 collects the earlycon log
/// and reports an idle line; the i8042 turns the reset pulse that
/// `panic=-1 reboot=k` make of every panic into `GuestReset`; the CMOS clock
/// reads zero. Every other port reads 0xFF, as the buses make it.
mod stubs {
    use std::sync::{Arc, Mutex};

    use crate::{
        bus::BusDevice,
        chipset::ChipsetBuilder,
        error::Result,
        events::{Event, EventSender},
    };

    /// Transmitter holding register and shifter empty, which earlycon polls for.
    const LSR_IDLE: u8 = 0x60;

    struct Com1(Arc<Mutex<Vec<u8>>>);

    impl BusDevice for Com1 {
        fn read(&mut self, offset: u64, data: &mut [u8]) {
            if offset == 5 {
                data[0] = LSR_IDLE;
            }
        }

        fn write(&mut self, offset: u64, data: &[u8]) {
            if offset == 0 {
                self.0.lock().unwrap().extend_from_slice(data);
            }
        }
    }

    struct I8042(EventSender);

    impl BusDevice for I8042 {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, offset: u64, data: &[u8]) {
            // Port 0x64, the command register.
            if offset == 4 && data == [0xfe] {
                self.0.send(Event::GuestReset);
            }
        }
    }

    struct Zeros;

    impl BusDevice for Zeros {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, _data: &[u8]) {}
    }

    /// Adds the stubs to `chipset` and returns the log COM1 fills.
    pub(super) fn add(chipset: &mut ChipsetBuilder) -> Result<Arc<Mutex<Vec<u8>>>> {
        let log = Arc::new(Mutex::new(Vec::new()));
        chipset.add("com1", |resources| {
            resources.pio(0x3f8, 8);
            Ok(Com1(Arc::clone(&log)))
        })?;
        chipset.add("i8042", |resources| {
            resources.pio(0x60, 5);
            Ok(I8042(resources.event_sender()))
        })?;
        chipset.add("cmos", |resources| {
            resources.pio(0x70, 2);
            Ok(Zeros)
        })?;
        Ok(log)
    }
}

/// A KVM VM booting `config` on the stubs, the earlycon log they collect, and
/// the zero page as `prepare` wrote it.
struct LinuxVm {
    vm: crate::Vm<boxlite_hypervisor::KvmVm>,
    log: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    zero_page: boot_params,
}

fn linux_vm(config: &VmConfig) -> LinuxVm {
    let mut zero_page = None;
    let mut log = None;
    let vm = crate::Vm::with_backend(
        config.clone(),
        boxlite_hypervisor::KvmVm::new,
        |ram, config| {
            let setup = prepare(ram, config)?;
            let address = GuestAddress(setup.boot_regs.rsi);
            zero_page = Some(ram.memory().read_obj(address).unwrap());
            Ok(setup.boot_regs)
        },
        |chipset| {
            log = Some(stubs::add(chipset)?);
            Ok(())
        },
    )
    .expect("create the KVM VM");
    LinuxVm {
        vm,
        log: log.unwrap(),
        zero_page: zero_page.unwrap(),
    }
}

fn log_text(log: &std::sync::Mutex<Vec<u8>>) -> String {
    String::from_utf8_lossy(&log.lock().unwrap()).into_owned()
}

/// Boots `config` through `Vm::run` until the guest pulses the i8042 reset.
/// A watchdog stops a boot that has not reset after 30 seconds, so a failed
/// boot reports the log so far.
fn boot_to_reset(config: &VmConfig) -> (String, boot_params) {
    use std::{
        sync::mpsc::{self, RecvTimeoutError},
        thread,
        time::{Duration, Instant},
    };

    const TIMEOUT: Duration = Duration::from_secs(30);

    let LinuxVm {
        mut vm,
        log,
        zero_page,
    } = linux_vm(config);
    let stop = vm.stop_handle();
    let (finished, done) = mpsc::channel::<()>();
    let watchdog = thread::spawn(move || {
        let fired = matches!(done.recv_timeout(TIMEOUT), Err(RecvTimeoutError::Timeout));
        if fired {
            stop.stop();
        }
        fired
    });
    let started = Instant::now();

    let exit = vm.run();
    drop(finished);

    let fired = watchdog.join().unwrap();
    let log = log_text(&log);
    if !matches!(exit, Ok(crate::VmExit::GuestReset)) {
        let watchdog = if fired { " (watchdog)" } else { "" };
        panic!(
            "{exit:?}{watchdog} after {:?}; log:\n{log}",
            started.elapsed()
        );
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

/// Boots the kernel named by `VMM_KERNEL` with an `/init` that sleeps forever.
/// Once it runs, a stop from another thread must end `Vm::run` within two
/// seconds, every vCPU thread joined.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn stops_a_guest_that_sleeps_forever() {
    use std::{
        thread,
        time::{Duration, Instant},
    };

    // pause: mov eax, 34 (pause); syscall; jmp pause
    let init = static_program(&[0xb8, 34, 0, 0, 0, 0x0f, 0x05, 0xeb, 0xf7]);
    let archive = newc_archive("init", &init);
    let initramfs = TempFile::new("pause.cpio", &archive);
    let LinuxVm { mut vm, log, .. } = linux_vm(&linux_config(1, Some(initramfs.0.clone())));
    let stop = vm.stop_handle();
    let watched = std::sync::Arc::clone(&log);
    let stopper = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !log_text(&watched).contains("Run /init as init process") && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        // Let init reach its pause before the stop.
        thread::sleep(Duration::from_millis(200));
        let stopped = Instant::now();
        stop.stop();
        stopped
    });

    let exit = vm.run();
    let returned = Instant::now();

    let stopped = stopper.join().unwrap();
    let log = log_text(&log);
    assert!(log.contains("Run /init as init process"), "{log}");
    assert_eq!(exit.unwrap(), crate::VmExit::StopRequested, "{log}");
    let took = returned.duration_since(stopped);
    assert!(took < Duration::from_secs(2), "{took:?}");
}
