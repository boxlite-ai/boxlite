// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `prepare` on a kernel file: the ELF fixture from the loader tests, loaded
//! into fresh guest RAM together with the boot data, and the real kernel,
//! booted on KVM, on one or four vCPUs, and the legacy devices up to its
//! root-mount panic, up to the panic when a generated init exits, or, with
//! its console on ttyS0, until a generated init restarts the machine.

use std::{
    error::Error as _,
    fs,
    io::{self, Write},
    path::PathBuf,
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use linux_loader::loader::bootparam::boot_params;
use vm_memory::{Bytes, GuestAddress};

use super::prepare;
use crate::{
    VmExit,
    boot::elf::tests::{ENTRY, fixture},
    config::VmConfig,
    devices::{
        console::{ConsoleWorker, DEFAULT_QUEUE_BYTES},
        x86_64::{COM1, COM1_GSI, add_legacy_devices},
    },
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

/// The real-kernel tests boot `VMM_KERNEL` with one of these command lines:
/// the early console, which polls the UART, or the 8250 driver's console.
const LINUX_CMDLINE: &str = "earlycon=uart8250,io,0x3f8 keep_bootcon panic=-1 reboot=k";
const CONSOLE_CMDLINE: &str = "console=ttyS0 panic=-1 reboot=k";
/// How long a real-kernel boot may take before the watchdog ends it.
const BOOT_TIMEOUT: Duration = Duration::from_secs(30);
/// The time the CMOS RTC reports, 2026-01-02T03:04:05Z, in nanoseconds.
const CMOS_TIME: i64 = 1_767_323_045_000_000_000;

/// `vcpu_count` vCPUs and 256 MiB of RAM for `kernel` and `initramfs`,
/// booted with `cmdline`.
fn linux_config(vcpu_count: u8, cmdline: &str, initramfs: Option<PathBuf>) -> VmConfig {
    let kernel = std::env::var_os("VMM_KERNEL")
        .expect("set VMM_KERNEL or run make test:integration:vmm:linux");
    let config = VmConfig {
        vcpu_count,
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

/// A console sink that blocks every write until the test opens its gate,
/// like a log reader that stopped reading.
#[derive(Clone, Default)]
struct StalledLog {
    open: Arc<(Mutex<bool>, std::sync::Condvar)>,
    log: SerialLog,
}

impl StalledLog {
    fn open(&self) {
        let (open, changed) = &*self.open;
        *open.lock().unwrap() = true;
        changed.notify_all();
    }
}

impl Write for StalledLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let (open, changed) = &*self.open;
        let mut open = open.lock().unwrap();
        while !*open {
            open = changed.wait(open).unwrap();
        }
        self.log.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// How the console behind the serial port is wired for a run.
struct Console {
    sink: Box<dyn Write + Send>,
    capacity: usize,
}

impl Console {
    fn to(log: &SerialLog) -> Self {
        Self {
            sink: Box::new(log.clone()),
            capacity: DEFAULT_QUEUE_BYTES,
        }
    }
}

/// KVM, counting the edges devices raise on GSI 4. With `deliver` off it
/// drops every interrupt instead of passing it on.
struct Gsi4Counter {
    kvm: boxlite_hypervisor::KvmVm,
    deliver: bool,
    edges: Arc<AtomicUsize>,
}

impl boxlite_hypervisor::Vm for Gsi4Counter {
    type Vcpu = boxlite_hypervisor::KvmVcpu;

    unsafe fn map_memory(
        &self,
        region: &boxlite_hypervisor::MemoryRegion,
    ) -> boxlite_hypervisor::Result<()> {
        // SAFETY: the caller's contract passes through to KVM unchanged.
        unsafe { self.kvm.map_memory(region) }
    }

    fn unmap_memory(
        &self,
        region: &boxlite_hypervisor::MemoryRegion,
    ) -> boxlite_hypervisor::Result<()> {
        boxlite_hypervisor::Vm::unmap_memory(&self.kvm, region)
    }

    fn create_vcpu(&self, id: u32) -> boxlite_hypervisor::Result<Self::Vcpu> {
        boxlite_hypervisor::Vm::create_vcpu(&self.kvm, id)
    }

    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
        if line == 4 && level {
            self.edges.fetch_add(1, Ordering::Relaxed);
        }
        if self.deliver {
            boxlite_hypervisor::Vm::set_irq_line(&self.kvm, line, level)
        } else {
            Ok(())
        }
    }
}

impl boxlite_hypervisor::X86Vm for Gsi4Counter {
    fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
        boxlite_hypervisor::X86Vm::supported_cpuid(&self.kvm)
    }
}

/// A KVM VM booting `config` on the legacy devices, before it runs.
struct LinuxVm {
    vm: crate::Vm<Gsi4Counter>,
    /// The zero page as `prepare` wrote it.
    zero_page: boot_params,
    /// The console worker behind COM1: a test finishes it once its sink can
    /// take the rest.
    console: ConsoleWorker,
    /// The edges the serial port raised on GSI 4.
    gsi_4_edges: Arc<AtomicUsize>,
}

/// Builds a KVM VM for `config` with the legacy devices, COM1 writing to
/// `console` and the CMOS RTC stopped at `CMOS_TIME`. With `deliver_irqs`
/// off, every device interrupt is dropped.
fn linux_vm(config: &VmConfig, deliver_irqs: bool, console: Console) -> LinuxVm {
    let (writer, console) = ConsoleWorker::spawn(console.sink, console.capacity).unwrap();
    let gsi_4_edges = Arc::new(AtomicUsize::new(0));
    let mut zero_page = None;
    let vm = crate::Vm::with_backend(
        config.clone(),
        || {
            Ok(Gsi4Counter {
                kvm: boxlite_hypervisor::KvmVm::new()?,
                deliver: deliver_irqs,
                edges: Arc::clone(&gsi_4_edges),
            })
        },
        |ram, config| {
            let setup = prepare(ram, config)?;
            let address = GuestAddress(setup.boot_regs.rsi);
            zero_page = Some(ram.memory().read_obj(address).unwrap());
            Ok(setup.boot_regs)
        },
        |chipset| add_legacy_devices(chipset, writer, Box::new(|| CMOS_TIME)),
    )
    .expect("create the KVM VM");
    LinuxVm {
        vm,
        zero_page: zero_page.unwrap(),
        console,
        gsi_4_edges,
    }
}

/// How a real-kernel boot ended.
struct LinuxRun {
    /// The zero page as `prepare` wrote it.
    zero_page: boot_params,
    /// How `Vm::run` ended; `StopRequested` means the watchdog stopped it.
    exit: crate::Result<VmExit>,
    /// The edges the serial port raised on GSI 4.
    gsi_4_edges: usize,
    /// The console worker, still running: a test finishes it once its sink
    /// can take the rest.
    console: ConsoleWorker,
    /// How long the guest ran.
    elapsed: Duration,
    /// The port and the MMIO reads and writes no device claimed.
    unclaimed_ports: (u64, u64),
    unclaimed_mmio: (u64, u64),
}

/// Boots `config` through `Vm::run` on the legacy devices, with the serial
/// port on `console`, until the VM ends or a watchdog stops it at `timeout`.
fn run_linux(
    config: &VmConfig,
    deliver_irqs: bool,
    timeout: Duration,
    console: Console,
) -> LinuxRun {
    use std::sync::mpsc::{self, RecvTimeoutError};

    let LinuxVm {
        mut vm,
        zero_page,
        console,
        gsi_4_edges,
    } = linux_vm(config, deliver_irqs, console);
    let stop = vm.stop_handle();
    let (finished, done) = mpsc::channel::<()>();
    let watchdog = thread::spawn(move || {
        if let Err(RecvTimeoutError::Timeout) = done.recv_timeout(timeout) {
            stop.stop();
        }
    });
    let started = Instant::now();

    let exit = vm.run();
    let elapsed = started.elapsed();
    drop(finished);
    watchdog.join().unwrap();
    let buses = vm.chipset().buses();
    LinuxRun {
        zero_page,
        exit,
        gsi_4_edges: gsi_4_edges.load(Ordering::Relaxed),
        console,
        elapsed,
        unclaimed_ports: buses.pio.unclaimed(),
        unclaimed_mmio: buses.mmio.unclaimed(),
    }
}

/// Asserts that the guest asked for the reset that ended `run`, and prints
/// the run's counters for the record.
fn assert_reset(run: &LinuxRun, log: &str) {
    assert!(
        matches!(run.exit, Ok(VmExit::GuestReset)),
        "{:?} after {:?}; log:\n{log}",
        run.exit,
        run.elapsed
    );
    eprintln!(
        "boot: {:?}, {} GSI 4 edges, unclaimed ports {:?} and MMIO {:?}, {} console bytes dropped",
        run.elapsed,
        run.gsi_4_edges,
        run.unclaimed_ports,
        run.unclaimed_mmio,
        run.console.dropped_bytes()
    );
}

/// Boots the kernel named by `VMM_KERNEL` without an initramfs. The earlycon
/// log must show the boot data as Linux read it, up to the root-mount panic
/// and its reset.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_to_the_root_mount_panic() {
    let log = SerialLog::default();
    let mut run = run_linux(
        &linux_config(1, LINUX_CMDLINE, None),
        true,
        BOOT_TIMEOUT,
        Console::to(&log),
    );

    run.console.finish();
    let log = log.text();
    assert_reset(&run, &log);
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

/// A static executable that pins itself to each of the first `count` CPUs in
/// turn and exits with bit i set when `getcpu` then reports CPU i.
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

    let log = SerialLog::default();
    let mut run = run_linux(
        &linux_config(1, LINUX_CMDLINE, Some(initramfs.0.clone())),
        true,
        BOOT_TIMEOUT,
        Console::to(&log),
    );

    run.console.finish();
    let log = log.text();
    assert_reset(&run, &log);
    let (start, size) = (
        u64::from(run.zero_page.hdr.ramdisk_image),
        u64::from(run.zero_page.hdr.ramdisk_size),
    );
    assert_eq!(size, archive.len() as u64);
    let end = (start + size).next_multiple_of(0x1000) - 1;
    assert_in_order(
        &log,
        &[
            &format!("RAMDISK: [mem {start:#010x}-{end:#010x}]"),
            "Unpacking initramfs...",
            "Run /init as init process",
            "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00002a00",
        ],
    );
    assert!(!log.contains("VFS: Unable to mount root fs"), "{log}");
}

/// The line `/init` prints in the console tests.
const INIT_MARKER: &str = "INIT-MARKER-0123456789ABCDEF";

/// Boots the kernel named by `VMM_KERNEL` with its console on the 8250 driver
/// and an `/init` that prints `INIT_MARKER` and restarts the machine. Linux
/// must find a 16550A on IRQ 4 and set its clock from the CMOS RTC, `/init`'s
/// line must leave through the tty, and the restart must end the run with
/// the i8042 reset. The only access no device claims is one port read,
/// Linux's probe of the ISA DMA page register at 0x87.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_on_the_legacy_devices_until_init_restarts() {
    let archive = newc_archive("init", &print_and_restart(INIT_MARKER));
    let initramfs = TempFile::new("restart.cpio", &archive);

    let log = SerialLog::default();
    let mut run = run_linux(
        &linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone())),
        true,
        BOOT_TIMEOUT,
        Console::to(&log),
    );

    run.console.finish();
    let log = log.text();
    assert_reset(&run, &log);
    assert_in_order(
        &log,
        &[
            &serial_probe_line(),
            "rtc_cmos rtc_cmos: setting system clock to 2026-01-02T03:04:05 UTC (1767323045)",
            INIT_MARKER,
            "reboot: Restarting system",
        ],
    );
    assert!(!log.contains("Kernel panic"), "{log}");
    assert!(run.gsi_4_edges > 0);
    assert_eq!(run.console.dropped_bytes(), 0);
    assert_eq!(run.unclaimed_ports, (1, 0), "{log}");
    assert_eq!(run.unclaimed_mmio, (0, 0));
}

/// The line Linux prints when it finds COM1 at its port and GSI.
fn serial_probe_line() -> String {
    format!("serial8250: ttyS0 at I/O {COM1:#x} (irq = {COM1_GSI}, base_baud = 115200) is a 16550A")
}

/// The same boot with a console sink that takes nothing until the run has
/// ended, and a queue of 4 KiB. The guest must still reach its restart on
/// time: output is lost and counted, never waited for. The sink then gets
/// the batch the worker held when the sink stalled, whose size depends on
/// when the worker woke, and the newest 4 KiB, which hold the restart line.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn a_stalled_console_sink_never_stalls_the_guest() {
    let archive = newc_archive("init", &print_and_restart(INIT_MARKER));
    let initramfs = TempFile::new("stalled.cpio", &archive);
    let stalled = StalledLog::default();
    let capacity = 4096;

    let mut run = run_linux(
        &linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone())),
        true,
        BOOT_TIMEOUT,
        Console {
            sink: Box::new(stalled.clone()),
            capacity,
        },
    );
    let dropped = run.console.dropped_bytes();
    // Only now may the sink take anything: the worker writes the batch it
    // held, then the newest 4 KiB, and ends.
    stalled.open();
    run.console.finish();
    let log = stalled.log.text();

    assert_reset(&run, &log);
    assert!(dropped > 0, "the boot log outgrew the queue");
    assert!(log.len() <= 2 * capacity, "{}", log.len());
    assert!(log.contains("reboot: Restarting system"), "{log}");
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

    let log = SerialLog::default();
    let mut run = run_linux(
        &linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone())),
        false,
        Duration::from_secs(3),
        Console::to(&log),
    );

    run.console.finish();
    let log = log.text();
    assert!(
        matches!(run.exit, Ok(VmExit::StopRequested)),
        "{:?}; log:\n{log}",
        run.exit
    );
    assert!(log.contains("Run /init as init process"), "{log}");
    assert!(!log.contains("INIT-MARKER"), "{log}");
    assert!(run.gsi_4_edges > 0, "the UART asked for IRQ 4");
}

/// Boots the kernel named by `VMM_KERNEL` on four vCPUs. Linux must read the
/// MP table, list each vCPU and the IOAPIC, and bring every vCPU up with a
/// synchronized TSC.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn brings_up_every_vcpu() {
    let log = SerialLog::default();
    let mut run = run_linux(
        &linux_config(4, LINUX_CMDLINE, None),
        true,
        BOOT_TIMEOUT,
        Console::to(&log),
    );

    run.console.finish();
    let log = log.text();
    assert_reset(&run, &log);
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

    let log = SerialLog::default();
    let mut run = run_linux(
        &linux_config(4, LINUX_CMDLINE, Some(initramfs.0.clone())),
        true,
        BOOT_TIMEOUT,
        Console::to(&log),
    );

    run.console.finish();
    let log = log.text();
    assert_reset(&run, &log);
    let panic = "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000f00";
    assert!(log.lines().any(|line| line == panic), "{log}");
}

/// Boots the kernel named by `VMM_KERNEL` with an `/init` that sleeps forever.
/// Once it runs, a stop from another thread must end `Vm::run` within two
/// seconds, every vCPU thread joined.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn stops_a_guest_that_sleeps_forever() {
    // pause: mov eax, 34 (pause); syscall; jmp pause
    let init = static_program(&[0xb8, 34, 0, 0, 0, 0x0f, 0x05, 0xeb, 0xf7]);
    let archive = newc_archive("init", &init);
    let initramfs = TempFile::new("pause.cpio", &archive);
    let log = SerialLog::default();
    let LinuxVm {
        mut vm,
        mut console,
        ..
    } = linux_vm(
        &linux_config(1, LINUX_CMDLINE, Some(initramfs.0.clone())),
        true,
        Console::to(&log),
    );
    let stop = vm.stop_handle();
    let watched = log.clone();
    let stopper = thread::spawn(move || {
        let deadline = Instant::now() + BOOT_TIMEOUT;
        while !watched.text().contains("Run /init as init process") && Instant::now() < deadline {
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
    console.finish();
    let log = log.text();
    assert!(log.contains("Run /init as init process"), "{log}");
    assert_eq!(exit.unwrap(), VmExit::StopRequested, "{log}");
    let took = returned.duration_since(stopped);
    assert!(took < Duration::from_secs(2), "{took:?}");
}
