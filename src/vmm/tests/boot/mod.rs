// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `prepare` on a kernel file: the ELF fixture from the loader tests, loaded
//! into fresh guest RAM together with the boot data, and the real kernel,
//! booted on KVM and the legacy devices up to its root-mount panic, up to the
//! panic when a generated init exits, or, with its console on ttyS0, until a
//! generated init restarts the machine.

use std::{
    error::Error as _,
    fs,
    io::{self, Write},
    path::PathBuf,
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use linux_loader::loader::bootparam::boot_params;
use vm_memory::{Bytes, GuestAddress};

use super::prepare;
use crate::{
    boot::elf::tests::{ENTRY, fixture},
    bus::Buses,
    config::VmConfig,
    devices::DeviceManager,
    error::Error,
    events::{Event, EventLoop},
    irq::IrqChip,
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
    // 2 MiB of RAM minus 3000 bytes, rounded down to a page, above the
    // fixture kernel that ends just past 1 MiB.
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

/// The real-kernel tests boot `VMM_KERNEL` with one of these command lines:
/// the early console, which polls the UART, or the 8250 driver's console.
const LINUX_CMDLINE: &str = "earlycon=uart8250,io,0x3f8 keep_bootcon panic=-1 reboot=k";
const CONSOLE_CMDLINE: &str = "console=ttyS0 panic=-1 reboot=k";
/// How long a real-kernel boot may take before the watchdog ends it.
const BOOT_TIMEOUT: Duration = Duration::from_secs(30);
/// The time the CMOS RTC reports, 2026-01-02T03:04:05Z, in nanoseconds.
const CMOS_TIME: i64 = 1_767_323_045_000_000_000;

/// 256 MiB of RAM for `kernel` and `initramfs`, booted with `cmdline`.
fn linux_config(cmdline: &str, initramfs: Option<PathBuf>) -> VmConfig {
    let kernel = std::env::var_os("VMM_KERNEL")
        .expect("set VMM_KERNEL or run make test:integration:vmm:linux");
    let config = VmConfig {
        vcpu_count: 1,
        memory_mib: 256,
        kernel: kernel.into(),
        cmdline: cmdline.into(),
        initramfs,
    };
    config.validate().unwrap();
    config
}

/// Guest serial output, shared with the test.
#[derive(Clone, Default)]
struct SerialLog(Arc<Mutex<Vec<u8>>>);

impl SerialLog {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl Write for SerialLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// KVM's interrupt controller, counting the edges raised on GSI 4. With
/// `deliver` off it drops every interrupt instead of passing it on.
struct Gsi4Counter {
    vm: Arc<boxlite_hypervisor::KvmVm>,
    deliver: bool,
    edges: AtomicUsize,
}

impl IrqChip for Gsi4Counter {
    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
        if line == 4 && level {
            self.edges.fetch_add(1, Ordering::Relaxed);
        }
        if self.deliver {
            boxlite_hypervisor::Vm::set_irq_line(&*self.vm, line, level)
        } else {
            Ok(())
        }
    }
}

/// How a real-kernel boot ended.
struct LinuxRun {
    /// Everything the guest wrote to the serial port.
    log: String,
    /// The zero page, read before the vCPU first ran.
    zero_page: boot_params,
    /// The event that ended the run, or `None` when the watchdog did.
    end: Option<Event>,
    /// The edges the serial port raised on GSI 4.
    gsi_4_edges: usize,
}

/// Boots `config` on one KVM vCPU and the legacy devices, with the CMOS RTC
/// stopped at `CMOS_TIME`, until a device event ends the run or `timeout`
/// passes. With `deliver_irqs` off, every device interrupt is dropped.
fn run_linux(config: &VmConfig, deliver_irqs: bool, timeout: Duration) -> LinuxRun {
    use boxlite_hypervisor::{KvmVm, VcpuExit, VcpuHandle as _};

    use crate::cpu_features::{BOOT_MSRS, guest_cpuid};

    // RAM is declared before the VM and vCPU so it outlives them during unwinding.
    let mut ram = GuestRam::new(&ram_ranges(config.memory_mib)).unwrap();
    let vm = Arc::new(KvmVm::new().expect("create KVM VM"));
    ram.map(&*vm).expect("map guest RAM");
    let setup = prepare(&ram, config).unwrap();
    let zero_page = ram
        .memory()
        .read_obj(GuestAddress(setup.boot_regs.rsi))
        .unwrap();
    let mut vcpu = vm.create_vcpu(0).expect("create vCPU");
    vcpu.set_cpu_features(&guest_cpuid(vm.supported_cpuid(), 0, 1), &BOOT_MSRS)
        .unwrap();
    vcpu.set_boot_registers(&setup.boot_regs).unwrap();

    let irqs = Arc::new(Gsi4Counter {
        vm: Arc::clone(&vm),
        deliver: deliver_irqs,
        edges: AtomicUsize::new(0),
    });
    let log = SerialLog::default();
    let mut events = EventLoop::new().unwrap();
    let mut buses = Buses::default();
    let devices = DeviceManager::new(
        &mut buses,
        irqs.clone(),
        &events.sender(),
        Box::new(log.clone()),
        Box::new(|| CMOS_TIME),
    )
    .unwrap();

    // A hung guest makes no more exits, so a watchdog kicks it at the deadline.
    let started = Instant::now();
    let (finished, deadline) = mpsc::channel::<()>();
    let kick = vcpu.handle();
    let watchdog = thread::spawn(move || {
        if matches!(
            deadline.recv_timeout(timeout),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            kick.kick().unwrap();
        }
    });

    let end = loop {
        match vcpu.run().expect("run vCPU") {
            VcpuExit::Interrupted if started.elapsed() < timeout => {}
            VcpuExit::Interrupted => break None,
            exit => {
                if let Some(exit) = buses.dispatch(exit) {
                    panic!(
                        "{exit:?} after {:?}; log:\n{}",
                        started.elapsed(),
                        log.text()
                    );
                }
            }
        }
        // The device that ends the run sends its event while it serves the
        // exit, so the event is already queued.
        if let Some(event) = events.wait(Some(Duration::ZERO)).unwrap() {
            break Some(event);
        }
    };
    vcpu.complete_pending_io().unwrap();
    drop(finished);
    watchdog.join().unwrap();
    drop(devices);
    ram.unmap(&*vm).unwrap();
    LinuxRun {
        log: log.text(),
        zero_page,
        end,
        gsi_4_edges: irqs.edges.load(Ordering::Relaxed),
    }
}

/// Asserts that the guest asked for the reset that ended `run`.
fn assert_reset(run: &LinuxRun) {
    assert!(
        matches!(run.end, Some(Event::GuestReset)),
        "{:?}; log:\n{}",
        run.end,
        run.log
    );
}

/// Boots the kernel named by `VMM_KERNEL` without an initramfs. The earlycon
/// log must show the boot data as Linux read it, up to the root-mount panic
/// and its reset.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_to_the_root_mount_panic() {
    let run = run_linux(&linux_config(LINUX_CMDLINE, None), true, BOOT_TIMEOUT);

    assert_reset(&run);
    let log = run.log;
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

/// Where `static_program` loads its one segment, and the length of the ELF
/// and program headers in front of the code.
const PROGRAM_BASE: u64 = 0x40_0000;
const PROGRAM_HEADERS: u64 = 64 + 56;

/// A static x86_64 executable: one read-only, executable `PT_LOAD` at
/// `PROGRAM_BASE` holding the headers and then `text`, its entry point.
fn static_program(text: &[u8]) -> Vec<u8> {
    let size = PROGRAM_HEADERS + text.len() as u64;
    let mut elf = vec![0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    elf.extend_from_slice(&2u16.to_le_bytes()); // ET_EXEC
    elf.extend_from_slice(&62u16.to_le_bytes()); // EM_X86_64
    elf.extend_from_slice(&1u32.to_le_bytes()); // EV_CURRENT
    elf.extend_from_slice(&(PROGRAM_BASE + PROGRAM_HEADERS).to_le_bytes()); // entry
    elf.extend_from_slice(&64u64.to_le_bytes()); // program headers
    elf.extend_from_slice(&0u64.to_le_bytes()); // no section headers
    elf.extend_from_slice(&0u32.to_le_bytes()); // flags
    for half in [64u16, 56, 1, 0, 0, 0] {
        // header size, program header size and count, no sections
        elf.extend_from_slice(&half.to_le_bytes());
    }
    elf.extend_from_slice(&1u32.to_le_bytes()); // PT_LOAD
    elf.extend_from_slice(&5u32.to_le_bytes()); // R and X
    for word in [0, PROGRAM_BASE, PROGRAM_BASE, size, size, 0x1000] {
        // offset, virtual and physical address, file and memory size, alignment
        elf.extend_from_slice(&word.to_le_bytes());
    }
    elf.extend_from_slice(text);
    elf
}

/// A static executable that calls `exit_group(code)`.
fn exit_program(code: u8) -> Vec<u8> {
    // mov edi, code; mov eax, 231 (exit_group); syscall
    static_program(&[0xbf, code, 0, 0, 0, 0xb8, 231, 0, 0, 0, 0x0f, 0x05])
}

/// A static executable that writes `line` and a newline to its stdout, waits
/// until the tty has sent them, and restarts the machine; `exit_group(1)`
/// follows in case the restart returns.
fn print_and_restart(line: &str) -> Vec<u8> {
    const CODE_LEN: u64 = 81;
    let message = format!("{line}\n");
    let message_addr = u32::try_from(PROGRAM_BASE + PROGRAM_HEADERS + CODE_LEN).unwrap();
    let message_len = u32::try_from(message.len()).unwrap();
    let mut text = Vec::new();
    // mov eax, 1 (write); mov edi, 1; mov esi, message; mov edx, length; syscall
    text.extend_from_slice(&[0xb8, 1, 0, 0, 0, 0xbf, 1, 0, 0, 0, 0xbe]);
    text.extend_from_slice(&message_addr.to_le_bytes());
    text.push(0xba);
    text.extend_from_slice(&message_len.to_le_bytes());
    text.extend_from_slice(&[0x0f, 0x05]);
    // mov eax, 16 (ioctl); mov edi, 1; mov esi, 0x5409 (TCSBRK); mov edx, 1
    // (drain, no break); syscall
    text.extend_from_slice(&[
        0xb8, 16, 0, 0, 0, 0xbf, 1, 0, 0, 0, 0xbe, 0x09, 0x54, 0, 0, 0xba, 1, 0, 0, 0, 0x0f, 0x05,
    ]);
    // mov eax, 169 (reboot); mov edi, 0xfee1dead; mov esi, 0x28121969;
    // mov edx, 0x01234567 (LINUX_REBOOT_CMD_RESTART); xor r10d, r10d; syscall
    text.extend_from_slice(&[
        0xb8, 169, 0, 0, 0, 0xbf, 0xad, 0xde, 0xe1, 0xfe, 0xbe, 0x69, 0x19, 0x12, 0x28, 0xba, 0x67,
        0x45, 0x23, 0x01, 0x45, 0x31, 0xd2, 0x0f, 0x05,
    ]);
    // mov edi, 1; mov eax, 231 (exit_group); syscall
    text.extend_from_slice(&[0xbf, 1, 0, 0, 0, 0xb8, 231, 0, 0, 0, 0x0f, 0x05]);
    assert_eq!(text.len() as u64, CODE_LEN);
    text.extend_from_slice(message.as_bytes());
    static_program(&text)
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

/// Asserts that each of `steps` is a line of `log`, in that order.
fn assert_in_order(log: &str, steps: &[&str]) {
    let lines: Vec<&str> = log.lines().collect();
    let positions: Vec<usize> = steps
        .iter()
        .map(|step| {
            lines
                .iter()
                .position(|line| line == step)
                .unwrap_or_else(|| panic!("no {step:?} in:\n{log}"))
        })
        .collect();
    assert!(positions.is_sorted(), "out of order {positions:?}:\n{log}");
}

/// Boots the kernel named by `VMM_KERNEL` with a generated initramfs whose
/// `/init` exits with 42. Linux must find the archive where the zero page
/// says, run its init, and report the exit code when init dies.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn runs_the_initramfs_init_until_it_exits() {
    let archive = newc_archive("init", &exit_program(42));
    let initramfs = TempFile::new("init.cpio", &archive);

    let run = run_linux(
        &linux_config(LINUX_CMDLINE, Some(initramfs.0.clone())),
        true,
        BOOT_TIMEOUT,
    );

    assert_reset(&run);
    let (start, size) = (
        u64::from(run.zero_page.hdr.ramdisk_image),
        u64::from(run.zero_page.hdr.ramdisk_size),
    );
    assert_eq!(size, archive.len() as u64);
    let end = (start + size).next_multiple_of(0x1000) - 1;
    assert_in_order(
        &run.log,
        &[
            &format!("RAMDISK: [mem {start:#010x}-{end:#010x}]"),
            "Unpacking initramfs...",
            "Run /init as init process",
            "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00002a00",
        ],
    );
    assert!(
        !run.log.contains("VFS: Unable to mount root fs"),
        "{}",
        run.log
    );
}

/// The line `/init` prints in the console tests.
const INIT_MARKER: &str = "INIT-MARKER-0123456789ABCDEF";

/// Boots the kernel named by `VMM_KERNEL` with its console on the 8250 driver
/// and an `/init` that prints `INIT_MARKER` and restarts the machine. Linux
/// must find a 16550A on IRQ 4 and set its clock from the CMOS RTC, `/init`'s
/// line must leave through the tty, and the restart must end the run with
/// the i8042 reset.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_on_the_legacy_devices_until_init_restarts() {
    let archive = newc_archive("init", &print_and_restart(INIT_MARKER));
    let initramfs = TempFile::new("restart.cpio", &archive);

    let run = run_linux(
        &linux_config(CONSOLE_CMDLINE, Some(initramfs.0.clone())),
        true,
        BOOT_TIMEOUT,
    );

    assert_reset(&run);
    assert_in_order(
        &run.log,
        &[
            "serial8250: ttyS0 at I/O 0x3f8 (irq = 4, base_baud = 115200) is a 16550A",
            "rtc_cmos rtc_cmos: setting system clock to 2026-01-02T03:04:05 UTC (1767323045)",
            INIT_MARKER,
            "reboot: Restarting system",
        ],
    );
    assert!(!run.log.contains("Kernel panic"), "{}", run.log);
    assert!(run.gsi_4_edges > 0);
}

/// The same boot with every device interrupt dropped. Kernel messages still
/// appear, since the console polls the UART, but tty output waits for THRE
/// on IRQ 4: the start of `/init`'s line must not leave, so the run ends at
/// the timeout. vm-superio 0.8.1 lets its first 16 bytes through.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn tty_output_waits_for_irq_4() {
    let archive = newc_archive("init", &print_and_restart(INIT_MARKER));
    let initramfs = TempFile::new("no-irq.cpio", &archive);

    let run = run_linux(
        &linux_config(CONSOLE_CMDLINE, Some(initramfs.0.clone())),
        false,
        Duration::from_secs(3),
    );

    assert!(run.end.is_none(), "{:?}; log:\n{}", run.end, run.log);
    assert!(run.log.contains("Run /init as init process"), "{}", run.log);
    assert!(!run.log.contains("INIT-MARKER"), "{}", run.log);
    assert!(run.gsi_4_edges > 0, "the UART asked for IRQ 4");
}
