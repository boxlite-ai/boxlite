// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File},
    io,
    marker::PhantomData,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread::{self, ThreadId},
    time::{Duration, Instant},
};

use boxlite_hypervisor::{
    KvmVm, MemoryRegion, Vcpu, VcpuExit, X86BootRegisters, X86CpuidEntry, X86Msr, X86Vcpu,
    X86VcpuState, X86Vm, X86VmState,
};
use vm_memory::{Bytes, GuestAddress};

use super::{image::Header, machine, state::MachineState};
use crate::{
    ControlReason, Error, Vm, VmConfig, VmControl, VmExit, VmStatus,
    memory::GuestRam,
    mock_vm::{Call, MockHandle, MockVcpu, MockVm},
};

const WAIT: Duration = Duration::from_secs(5);
const COUNT: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Failure {
    None,
    BeforeVcpus,
    AfterVcpus,
    PlatformPanic,
    CreateCpu,
    RestoreRegs,
    NotifyStopped,
    NotifyUnsupported,
    InitialPark,
    CpuPanic,
}

#[derive(Debug)]
enum Install {
    BeforeVcpus(ThreadId),
    Cpu(u32, ThreadId),
    Notified(u32, ThreadId),
    AfterVcpus(ThreadId),
    Entry,
}

struct Backend {
    inner: MockVm,
    failure: Failure,
    observed: mpsc::Sender<Install>,
    before_vcpus_done: AtomicBool,
    after_vcpus_done: Arc<AtomicBool>,
    create_attempts: Arc<AtomicUsize>,
    hold_last: Mutex<Option<mpsc::Receiver<()>>>,
    hold_failure: Mutex<Option<mpsc::Receiver<()>>>,
}

struct Cpu {
    inner: MockVcpu,
    id: u32,
    owner: ThreadId,
    failure: Failure,
    observed: mpsc::Sender<Install>,
    after_vcpus_done: Arc<AtomicBool>,
    notified: bool,
    hold: Option<mpsc::Receiver<()>>,
    local: PhantomData<Rc<()>>,
}

fn failure() -> io::Error {
    io::Error::other("injected install failure")
}

impl Backend {
    fn platform_failure(&self, operation: &'static str) -> boxlite_hypervisor::Error {
        if let Some(hold) = self.hold_failure.lock().unwrap().take() {
            hold.recv_timeout(WAIT).unwrap();
        }
        boxlite_hypervisor::Error::VmState {
            operation,
            source: failure(),
        }
    }
}

impl boxlite_hypervisor::Vm for Backend {
    type Vcpu = Cpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        // SAFETY: forwards the caller's unchanged registration contract.
        unsafe { self.inner.map_memory(region) }
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        self.inner.unmap_memory(region)
    }

    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
        self.inner.set_irq_line(line, level)
    }

    fn create_vcpu(&self, id: u32) -> boxlite_hypervisor::Result<Cpu> {
        self.create_attempts.fetch_add(1, Ordering::SeqCst);
        assert!(self.before_vcpus_done.load(Ordering::SeqCst));
        if id == 1 && self.failure == Failure::CreateCpu {
            return Err(boxlite_hypervisor::Error::CreateVcpu {
                id,
                source: failure(),
            });
        }
        let hold = if id == u32::from(COUNT - 1) {
            self.hold_last.lock().unwrap().take()
        } else {
            None
        };
        Ok(Cpu {
            inner: self.inner.create_vcpu(id)?,
            id,
            owner: thread::current().id(),
            failure: self.failure,
            observed: self.observed.clone(),
            after_vcpus_done: self.after_vcpus_done.clone(),
            notified: false,
            hold,
            local: PhantomData,
        })
    }
}

impl X86Vm for Backend {
    fn supported_cpuid(&self) -> &[X86CpuidEntry] {
        panic!("restore queried boot CPUID")
    }

    fn restore_before_vcpus(&self, state: &X86VmState) -> boxlite_hypervisor::Result<()> {
        self.observed
            .send(Install::BeforeVcpus(thread::current().id()))
            .unwrap();
        assert_eq!(state, &machine(COUNT).platform);
        assert_ne!(self.failure, Failure::PlatformPanic, "platform panic");
        if self.failure == Failure::BeforeVcpus {
            return Err(self.platform_failure("restore before vCPUs"));
        }
        self.before_vcpus_done.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn restore_after_vcpus(&self, state: &X86VmState) -> boxlite_hypervisor::Result<()> {
        self.observed
            .send(Install::AfterVcpus(thread::current().id()))
            .unwrap();
        assert_eq!(state, &machine(COUNT).platform);
        if self.failure == Failure::AfterVcpus {
            return Err(self.platform_failure("restore after vCPUs"));
        }
        self.after_vcpus_done.store(true, Ordering::SeqCst);
        Ok(())
    }
}

impl Vcpu for Cpu {
    type Handle = MockHandle;

    fn run(&mut self) -> boxlite_hypervisor::Result<VcpuExit<'_>> {
        self.observed.send(Install::Entry).unwrap();
        assert!(self.after_vcpus_done.load(Ordering::SeqCst));
        self.inner.run()
    }

    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<Option<VcpuExit<'_>>> {
        self.inner.complete_pending_io()
    }

    fn notify_guest_stopped(&mut self) -> boxlite_hypervisor::Result<()> {
        assert_eq!(thread::current().id(), self.owner);
        if self.notified {
            if self.id == 1 && self.failure == Failure::InitialPark {
                return Err(self.error("notify guest stopped"));
            }
            return Ok(());
        }
        if let Some(hold) = self.hold.take() {
            hold.recv_timeout(WAIT).unwrap();
        }
        self.notified = true;
        self.observed
            .send(Install::Notified(self.id, self.owner))
            .unwrap();
        if self.id == 1 && self.failure == Failure::NotifyStopped {
            return Err(self.error("notify guest stopped"));
        }
        if self.id == 1 && self.failure == Failure::NotifyUnsupported {
            return Err(boxlite_hypervisor::Error::ConfigureVcpu {
                id: self.id,
                operation: "notify guest stopped",
                source: io::Error::from(io::ErrorKind::Unsupported),
            });
        }
        Ok(())
    }

    fn handle(&self) -> MockHandle {
        self.inner.handle()
    }
}

impl X86Vcpu for Cpu {
    fn set_cpu_features(
        &mut self,
        _: &[X86CpuidEntry],
        _: &[X86Msr],
    ) -> boxlite_hypervisor::Result<()> {
        panic!("restore applied boot CPU features")
    }

    fn set_boot_registers(&mut self, _: &X86BootRegisters) -> boxlite_hypervisor::Result<()> {
        panic!("restore applied boot registers")
    }

    fn restore_state(&mut self, state: &X86VcpuState) -> boxlite_hypervisor::Result<()> {
        assert_eq!(thread::current().id(), self.owner);
        assert_eq!(state.regs.rax, u64::from(self.id) + 10);
        if self.id == 1 {
            assert_ne!(self.failure, Failure::CpuPanic, "vCPU restore panic");
            if self.failure == Failure::RestoreRegs {
                return Err(self.error("restore CPU state"));
            }
        }
        self.observed
            .send(Install::Cpu(self.id, self.owner))
            .unwrap();
        Ok(())
    }
}

impl Cpu {
    fn error(&self, operation: &'static str) -> boxlite_hypervisor::Error {
        boxlite_hypervisor::Error::ConfigureVcpu {
            id: self.id,
            operation,
            source: failure(),
        }
    }
}

fn backend(failure: Failure) -> (Backend, mpsc::Receiver<Install>) {
    let (observed, events) = mpsc::channel();
    (
        Backend {
            inner: MockVm::new(),
            failure,
            observed,
            before_vcpus_done: AtomicBool::new(false),
            after_vcpus_done: Arc::new(AtomicBool::new(false)),
            create_attempts: Arc::new(AtomicUsize::new(0)),
            hold_last: Mutex::new(None),
            hold_failure: Mutex::new(None),
        },
        events,
    )
}

fn ram() -> GuestRam {
    GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap()
}

fn drive<H: X86Vm, T>(
    vm: &mut Vm<H>,
    initially_paused: bool,
    test: impl FnOnce(&VmControl, ThreadId) -> T,
) -> T {
    struct StopOnDrop<'a>(&'a VmControl);
    impl Drop for StopOnDrop<'_> {
        fn drop(&mut self) {
            self.0.stop();
        }
    }

    let control = vm.control();
    if initially_paused {
        control.pause().unwrap();
        assert_eq!(control.status(), VmStatus::Created);
    }
    let result = thread::scope(|scope| {
        let driver = scope.spawn(|| vm.run());
        let stop = StopOnDrop(&control);
        let result = test(&control, driver.thread().id());
        drop(stop);
        assert_eq!(driver.join().unwrap().unwrap(), VmExit::StopRequested);
        result
    });
    assert_eq!(control.status(), VmStatus::Exited);
    result
}

#[test]
fn restore_installs_platform_on_driver_and_vcpus_on_their_owners_before_guest_entry() {
    for (initially_paused, injected) in [
        (false, Failure::None),
        (true, Failure::None),
        (false, Failure::NotifyUnsupported),
    ] {
        let (backend, observed) = backend(injected);
        let (release, hold) = mpsc::channel();
        *backend.hold_last.lock().unwrap() = Some(hold);
        let entries = backend.inner.entries();
        let mut vm = Vm::with_restored_ram(ram(), machine(COUNT), || Ok(backend)).unwrap();
        assert_eq!(vm.control().status(), VmStatus::Created);
        assert!(matches!(
            observed.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        drive(&mut vm, initially_paused, |control, driver| {
            assert!(
                matches!(observed.recv_timeout(WAIT).unwrap(), Install::BeforeVcpus(owner) if owner == driver)
            );
            let mut workers = [None; COUNT as usize];
            let mut notified = [false; COUNT as usize];
            for _ in 0..(COUNT * 2 - 1) {
                match observed.recv_timeout(WAIT).unwrap() {
                    Install::Cpu(id, owner) => {
                        assert_ne!(owner, driver);
                        assert!(!workers.contains(&Some(owner)));
                        assert!(workers[id as usize].replace(owner).is_none());
                    }
                    Install::Notified(id, owner) => {
                        assert_eq!(workers[id as usize], Some(owner));
                        assert!(!notified[id as usize]);
                        notified[id as usize] = true;
                    }
                    event => panic!("unexpected event before every vCPU was ready: {event:?}"),
                }
            }
            assert_eq!(notified, [true, true, false]);
            assert!(entries.lock().unwrap().is_empty());
            release.send(()).unwrap();
            assert!(matches!(
                observed.recv_timeout(WAIT).unwrap(),
                Install::Notified(2, owner) if Some(owner) == workers[2]
            ));
            assert!(matches!(
                observed.recv_timeout(WAIT).unwrap(),
                Install::AfterVcpus(owner) if owner == driver
            ));

            if initially_paused {
                control.wait_paused(WAIT).unwrap();
                assert_eq!(control.status(), VmStatus::Paused);
                assert!(entries.lock().unwrap().is_empty());
                assert!(matches!(
                    observed.try_recv(),
                    Err(mpsc::TryRecvError::Empty)
                ));
                control.resume().unwrap();
            }
            assert!(matches!(
                observed.recv_timeout(WAIT).unwrap(),
                Install::Entry
            ));
            assert_eq!(control.status(), VmStatus::Running);
        });
    }
}

#[test]
fn pause_during_restore_startup_parks_vcpus_before_guest_entry() {
    let (backend, observed) = backend(Failure::None);
    let (release, hold) = mpsc::channel();
    *backend.hold_last.lock().unwrap() = Some(hold);
    let entries = backend.inner.entries();
    let mut vm = Vm::with_restored_ram(ram(), machine(COUNT), || Ok(backend)).unwrap();

    drive(&mut vm, false, |control, _| {
        while !matches!(
            observed.recv_timeout(WAIT).unwrap(),
            Install::Cpu(id, _) if id == u32::from(COUNT - 1)
        ) {}
        thread::scope(|scope| {
            let pause = scope.spawn(|| control.pause());
            // Observe acceptance before the last vCPU's setup hold can time out.
            let deadline = Instant::now() + WAIT / 2;
            while control.status() == VmStatus::Running && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(1));
            }
            let status = control.status();
            release.send(()).unwrap();
            assert_eq!(
                status,
                VmStatus::Pausing,
                "pause must be accepted during setup"
            );
            pause.join().unwrap().unwrap();
        });

        assert_eq!(control.status(), VmStatus::Paused);
        assert!(entries.lock().unwrap().is_empty());
        control.resume().unwrap();
        while !matches!(observed.recv_timeout(WAIT).unwrap(), Install::Entry) {}
    });
}

#[test]
fn stop_before_all_vcpus_are_ready_skips_final_platform_restore_and_guest_entry() {
    let (backend, observed) = backend(Failure::None);
    let (release, hold) = mpsc::channel();
    *backend.hold_last.lock().unwrap() = Some(hold);
    let entries = backend.inner.entries();
    let mut vm = Vm::with_restored_ram(ram(), machine(COUNT), || Ok(backend)).unwrap();

    drive(&mut vm, false, |control, _| {
        while !matches!(
            observed.recv_timeout(WAIT).unwrap(),
            Install::Cpu(id, _) if id == u32::from(COUNT - 1)
        ) {}
        control.stop();
        release.send(()).unwrap();
    });

    let mut last_ready = false;
    for event in observed.try_iter() {
        match event {
            Install::Notified(id, _) if id == u32::from(COUNT - 1) => last_ready = true,
            Install::AfterVcpus(_) | Install::Entry => panic!("unexpected event: {event:?}"),
            _ => {}
        }
    }
    assert!(last_ready);
    assert!(entries.lock().unwrap().is_empty());
}

#[test]
fn stop_wins_over_a_later_platform_restore_failure() {
    for injected in [Failure::AfterVcpus, Failure::BeforeVcpus] {
        let (backend, observed) = backend(injected);
        let (release, hold) = mpsc::channel();
        *backend.hold_failure.lock().unwrap() = Some(hold);
        let entries = backend.inner.entries();
        let mut vm = Vm::with_restored_ram(ram(), machine(COUNT), || Ok(backend)).unwrap();

        drive(&mut vm, false, |control, driver| {
            loop {
                match (injected, observed.recv_timeout(WAIT).unwrap()) {
                    (Failure::BeforeVcpus, Install::BeforeVcpus(owner))
                    | (Failure::AfterVcpus, Install::AfterVcpus(owner)) => {
                        assert_eq!(owner, driver);
                        break;
                    }
                    (_, Install::Entry) => panic!("guest entered during platform restore"),
                    _ => {}
                }
            }
            control.stop();
            release.send(()).unwrap();
        });

        assert!(entries.lock().unwrap().is_empty());
        assert!(
            !observed
                .try_iter()
                .any(|event| matches!(event, Install::Entry))
        );
    }
}

#[test]
fn run_reports_install_failures_wakes_pause_waiters_and_joins_every_started_vcpu() {
    use boxlite_hypervisor::Error as HostError;

    for injected in [
        Failure::BeforeVcpus,
        Failure::AfterVcpus,
        Failure::PlatformPanic,
        Failure::CreateCpu,
        Failure::RestoreRegs,
        Failure::NotifyStopped,
        Failure::InitialPark,
        Failure::CpuPanic,
    ] {
        let (backend, observed) = backend(injected);
        let calls = backend.inner.log();
        let entries = backend.inner.entries();
        let create_attempts = Arc::clone(&backend.create_attempts);
        let ram = ram();
        let backing = Arc::downgrade(ram.boot_memory());
        let mut vm = Vm::with_restored_ram(ram, machine(COUNT), || Ok(backend)).unwrap();
        let control = vm.control();
        control.pause().unwrap();
        let error = thread::scope(|scope| {
            let (ready, started) = mpsc::channel();
            let (reply, result) = mpsc::channel();
            let control = &control;
            scope.spawn(move || {
                ready.send(()).unwrap();
                reply
                    .send(control.wait_paused(Duration::from_secs(30)))
                    .unwrap();
            });
            started.recv_timeout(WAIT).unwrap();
            let driver = scope.spawn(|| vm.run());
            assert!(
                matches!(
                    result.recv_timeout(WAIT).unwrap(),
                    Err(Error::Control {
                        operation: "wait_paused",
                        reason: ControlReason::TerminalOutcome,
                    })
                ),
                "{injected:?}"
            );
            driver.join().unwrap().unwrap_err()
        });
        assert_eq!(control.status(), VmStatus::Exited);
        assert!(matches!(vm.run(), Err(Error::AlreadyRan)));
        assert!(entries.lock().unwrap().is_empty(), "{injected:?}");
        let events: Vec<_> = observed.try_iter().collect();
        assert!(!events.iter().any(|event| matches!(event, Install::Entry)));
        assert_eq!(
            events
                .iter()
                .any(|event| matches!(event, Install::AfterVcpus(_))),
            matches!(injected, Failure::AfterVcpus | Failure::InitialPark)
        );

        let expected_drops: &[u32] = match (&error, injected) {
            (
                Error::Hypervisor(HostError::VmState {
                    operation: "restore before vCPUs",
                    source,
                }),
                Failure::BeforeVcpus,
            ) if source.to_string() == "injected install failure" => {
                assert!(matches!(events.as_slice(), [Install::BeforeVcpus(_)]));
                assert_eq!(create_attempts.load(Ordering::SeqCst), 0);
                &[]
            }
            (
                Error::Hypervisor(HostError::VmState {
                    operation: "restore after vCPUs",
                    source,
                }),
                Failure::AfterVcpus,
            ) if source.to_string() == "injected install failure" => &[0, 1, 2],
            (Error::Snapshot(source), Failure::PlatformPanic)
                if source.to_string() == "platform restore panicked" =>
            {
                &[]
            }
            (Error::Hypervisor(HostError::CreateVcpu { id: 1, source }), Failure::CreateCpu)
                if source.to_string() == "injected install failure" =>
            {
                &[0, 2]
            }
            (
                Error::Hypervisor(HostError::ConfigureVcpu {
                    id: 1,
                    operation: "restore CPU state",
                    source,
                }),
                Failure::RestoreRegs,
            )
            | (
                Error::Hypervisor(HostError::ConfigureVcpu {
                    id: 1,
                    operation: "notify guest stopped",
                    source,
                }),
                Failure::InitialPark | Failure::NotifyStopped,
            ) if source.to_string() == "injected install failure" => &[0, 1, 2],
            (Error::VcpuPanicked { vcpu: 1 }, Failure::CpuPanic) => &[0, 1, 2],
            _ => panic!("unexpected error for {injected:?}: {error:?}"),
        };
        let mut dropped: Vec<_> = calls
            .lock()
            .unwrap()
            .iter()
            .filter_map(|call| match call {
                Call::DropVcpu { id } => Some(*id),
                _ => None,
            })
            .collect();
        dropped.sort_unstable();
        assert_eq!(dropped, expected_drops);
        assert!(backing.upgrade().is_some());
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| matches!(call, Call::Unmap { .. }))
        );

        drop(vm);
        assert!(backing.upgrade().is_none(), "{injected:?}");
        assert!(matches!(
            calls.lock().unwrap().last(),
            Some(Call::Unmap { .. })
        ));
    }
}

fn flat_config(vcpu_count: u8, memory_mib: u32) -> VmConfig {
    VmConfig {
        vcpu_count,
        memory_mib,
        kernel: "unused".into(),
        cmdline: String::new(),
        initramfs: None,
        disks: vec![],
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
        hotplug_mib: 0,
    }
}

fn flat_vm(vcpu_count: u8, program: &[u8]) -> Vm<KvmVm> {
    Vm::with_backend(
        flat_config(vcpu_count, 1),
        KvmVm::new,
        |ram, _| Ok(crate::flat_guest::load(ram.boot_memory(), program)),
        |_, _| Ok(()),
    )
    .unwrap()
}

// inc dword [0x8000]; jmp back, using the flat guest's identity mapping.
const INCREMENT: &[u8] = &[0xff, 0x05, 0x00, 0x80, 0x00, 0x00, 0xeb, 0xf8];

struct SnapshotFiles {
    state: PathBuf,
    memory: PathBuf,
}

impl SnapshotFiles {
    fn new(dir: &Path, name: &str) -> Self {
        let base = dir.join(name);
        Self {
            state: base.with_extension("state"),
            memory: base.with_extension("memory"),
        }
    }

    fn remove(&self) {
        fs::remove_file(&self.state).unwrap();
        fs::remove_file(&self.memory).unwrap();
    }
}

fn export_after_progress(
    control: &VmControl,
    files: &SnapshotFiles,
    timeout: Duration,
    mut progressed: impl FnMut(&Path) -> bool,
) {
    let deadline = Instant::now() + timeout;
    loop {
        control.resume().unwrap();
        thread::sleep(Duration::from_millis(10));
        control.pause().unwrap();
        control.export(&files.state, &files.memory).unwrap();
        if progressed(&files.memory) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "guest counters did not advance for {}",
            files.memory.display()
        );
        files.remove();
    }
}

#[test]
#[ignore = "requires /dev/kvm"]
fn kvm_export_restores_and_resumes() {
    let mut source_vm = flat_vm(1, &[0xeb, 0xfe]);
    let dir = tempfile::tempdir().unwrap();
    let files = SnapshotFiles::new(dir.path(), "source");
    drive(&mut source_vm, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        control.export(&files.state, &files.memory).unwrap();
    });
    drop(source_vm);

    let header = Header::read(&mut File::open(&files.state).unwrap()).unwrap();
    assert_eq!(header.vcpus, 1);
    assert_eq!(header.ram_len, 1 << 20);
    let mut restored = Vm::from_state(&files.state, &files.memory).unwrap();
    drive(&mut restored, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        control.resume().unwrap();
        assert_eq!(control.status(), VmStatus::Running);
    });
}

#[test]
#[ignore = "requires /dev/kvm"]
fn kvm_export_destroy_restore_resume_continues_counter() {
    let mut source_vm = flat_vm(1, INCREMENT);
    let dir = tempfile::tempdir().unwrap();
    let source = SnapshotFiles::new(dir.path(), "source");
    let destination = SnapshotFiles::new(dir.path(), "destination");
    let resumed = SnapshotFiles::new(dir.path(), "resumed");
    drive(&mut source_vm, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        export_after_progress(control, &source, WAIT, |path| counter(path) > 0);
    });
    drop(source_vm);

    let saved = counter(&source.memory);
    let mut restored = Vm::from_state(&source.state, &source.memory).unwrap();
    drive(&mut restored, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        control
            .export(&destination.state, &destination.memory)
            .unwrap();
        assert_eq!(counter(&destination.memory), saved);
        export_after_progress(control, &resumed, WAIT, |path| counter(path) > saved);
    });
}

#[test]
#[ignore = "requires /dev/kvm"]
fn kvm_split_ram_export_destroy_restore_resume_continues_both_counters() {
    use std::io::{Read, Seek, SeekFrom};

    use crate::{
        boot::{BOOT_LEAF, entry::long_mode_entry},
        flat_guest::CODE,
        x86_boot_layout::plan_boot_tables,
    };

    const MEMORY_MIB: u32 = 3073;
    const LOW_RAM_LEN: u64 = 3072 << 20;
    const RAM_LEN: u64 = (MEMORY_MIB as u64) << 20;
    const LOW_COUNTER: u32 = 0x8000;
    const HIGH_COUNTER: u64 = 0x1_0000_0000;
    const RELEASE: GuestAddress = GuestAddress(LOW_COUNTER as u64 + 4);
    const INITIAL: [u32; 2] = [0x1234_5678, 0x9abc_def0];

    let mut source_memory = None;
    let mut source_vm = Vm::with_backend(
        flat_config(1, MEMORY_MIB),
        KvmVm::new,
        |ram, _| {
            source_memory = Some(Arc::clone(ram.boot_memory()));
            // Park at the release byte after both initial increments. After
            // resume, each INC reads its saved counter and writes the next value.
            let mut program = vec![0xbf]; // mov edi, LOW_COUNTER
            program.extend_from_slice(&LOW_COUNTER.to_le_bytes());
            program.extend_from_slice(&[0x48, 0xbb]); // mov rbx, HIGH_COUNTER
            program.extend_from_slice(&HIGH_COUNTER.to_le_bytes());
            program.extend_from_slice(&[
                0xff, 0x07, // inc dword [rdi]
                0xff, 0x03, // inc dword [rbx]
                0x80, 0x7f, 0x04, 0x00, // wait: cmp byte [rdi + 4], 0
                0x74, 0xfa, // je wait
                0xff, 0x07, // inc dword [rdi]
                0xff, 0x03, // inc dword [rbx]
                0xeb, 0xfe, // jmp $ (keep the final counters stable)
            ]);
            let memory = ram.boot_memory().as_ref();
            memory
                .write_obj(INITIAL[0], GuestAddress(u64::from(LOW_COUNTER)))
                .unwrap();
            memory
                .write_obj(INITIAL[1], GuestAddress(HIGH_COUNTER))
                .unwrap();
            memory.write_slice(&program, GuestAddress(CODE)).unwrap();
            let ranges: Vec<_> = ram.ranges().collect();
            let plan = plan_boot_tables(
                &ranges,
                (CODE, CODE + program.len() as u64),
                None,
                BOOT_LEAF,
            )
            .unwrap();
            Ok(long_mode_entry(memory, CODE, 0, &plan).unwrap())
        },
        |_, _| Ok(()),
    )
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let files = SnapshotFiles::new(dir.path(), "split-ram");
    let read_counters = |path: &Path| {
        let mut file = File::open(path).unwrap();
        assert_eq!(file.metadata().unwrap().len(), RAM_LEN);
        // Packed high RAM follows the low band directly in the memory file.
        [u64::from(LOW_COUNTER), LOW_RAM_LEN].map(|offset| {
            file.seek(SeekFrom::Start(offset)).unwrap();
            let mut bytes = [0; 4];
            file.read_exact(&mut bytes).unwrap();
            u32::from_le_bytes(bytes)
        })
    };

    let memory = source_memory.unwrap();
    let checkpoint = INITIAL.map(|value| value + 1);
    let timeout = Duration::from_secs(10);
    drive(&mut source_vm, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        control.resume().unwrap();
        let deadline = Instant::now() + timeout;
        while memory.read_obj::<u32>(GuestAddress(HIGH_COUNTER)).unwrap() != checkpoint[1] {
            assert!(
                Instant::now() < deadline,
                "source guest missed its checkpoint"
            );
            thread::sleep(Duration::from_millis(10));
        }
        control.pause().unwrap();
        // The release byte takes effect when the restored vCPU resumes.
        memory.write_obj(1u8, RELEASE).unwrap();
        control.export(&files.state, &files.memory).unwrap();
        let header = Header::read(&mut File::open(&files.state).unwrap()).unwrap();
        assert_eq!(header.ram_len, RAM_LEN);
        assert_eq!(
            read_counters(&files.memory),
            checkpoint,
            "packed source counters"
        );
    });
    drop(memory);
    drop(source_vm);

    let advanced = checkpoint.map(|value| value + 1);
    let mut restored = Vm::from_state(&files.state, &files.memory).unwrap();
    drive(&mut restored, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        files.remove();
        export_after_progress(control, &files, Duration::from_secs(120), |path| {
            let counters = read_counters(path);
            for ((counter, saved), next) in counters.into_iter().zip(checkpoint).zip(advanced) {
                assert!(
                    (saved..=next).contains(&counter),
                    "unexpected packed restored counter"
                );
            }
            counters == advanced
        });
    });
}

#[test]
#[ignore = "requires /dev/kvm"]
fn kvm_three_vcpu_export_destroy_restore_resume_preserves_worker_state() {
    // Only the BSP receives boot registers. APs wait for INIT/SIPI.
    let mut source_vm = flat_vm(3, INCREMENT);
    let dir = tempfile::tempdir().unwrap();
    let source = SnapshotFiles::new(dir.path(), "source");
    let destination = SnapshotFiles::new(dir.path(), "destination");
    let resumed = SnapshotFiles::new(dir.path(), "resumed");
    drive(&mut source_vm, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        export_after_progress(control, &source, WAIT, |path| counter(path) > 0);
    });
    drop(source_vm);

    let read_machine = |path: &Path| {
        let mut file = File::open(path).unwrap();
        let header = Header::read(&mut file).unwrap();
        assert_eq!(header.vcpus, 3);
        header.read_machine(&mut file).unwrap()
    };
    let before = read_machine(&source.state);
    // LAPIC IDs distinguish the APs even when their reset registers agree.
    for i in 0..3 {
        for j in i + 1..3 {
            assert_ne!(before.vcpus[i].state.lapic, before.vcpus[j].state.lapic);
        }
    }
    let saved = counter(&source.memory);
    let mut restored = Vm::from_state(&source.state, &source.memory).unwrap();
    drive(&mut restored, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        control
            .export(&destination.state, &destination.memory)
            .unwrap();
        let after = read_machine(&destination.state);
        for (id, (before, after)) in before.vcpus.iter().zip(&after.vcpus).enumerate() {
            assert_eq!(before.id as usize, id);
            assert_eq!(after.id as usize, id);
            assert_eq!(before.state.regs, after.state.regs, "vCPU {id} registers");
            assert_eq!(before.state.sregs, after.state.sregs, "vCPU {id} sregs");
            assert_eq!(before.state.lapic, after.state.lapic, "vCPU {id} LAPIC");
            assert_eq!(before.state.cpuid, after.state.cpuid, "vCPU {id} CPUID");
            assert_eq!(before.state.mp_state, after.state.mp_state, "vCPU {id} MP");
        }
        assert_eq!(counter(&destination.memory), saved);
        export_after_progress(control, &resumed, WAIT, |path| counter(path) > saved);
    });
}

fn counter(path: &Path) -> u32 {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = File::open(path).unwrap();
    file.seek(SeekFrom::Start(0x8000)).unwrap();
    let mut bytes = [0; 4];
    file.read_exact(&mut bytes).unwrap();
    u32::from_le_bytes(bytes)
}

#[expect(
    clippy::duplicate_mod,
    reason = "Share boot fixtures without exposing private production test modules."
)]
#[path = "../boot/initramfs.rs"]
mod linux_initramfs;

fn linux_snapshot(files: &SnapshotFiles) -> (MachineState, Vec<u8>) {
    let mut file = File::open(&files.state).unwrap();
    let header = Header::read(&mut file).unwrap();
    let machine = header.read_machine(&mut file).unwrap();
    let ram = fs::read(&files.memory).unwrap();
    assert_eq!(ram.len() as u64, header.ram_len);
    (machine, ram)
}

/// APIC_TMCCT is a 32-bit countdown derived by KVM from host time, even while
/// Paused. Its entire four bytes are excluded on both sides of comparisons.
/// Initial count (0x380) and LVT timer (0x320) remain compared, preserving guest
/// timer reprogramming signals.
const APIC_TMCCT: std::ops::RangeInclusive<usize> = 0x390..=0x393;

/// Compare all LAPIC bytes except the four-byte APIC_TMCCT derived from host
/// time. Initial count and LVT timer still detect guest timer reprogramming;
/// PPR and the reserved bytes after APIC_TMCCT remain strictly compared here.
fn lapic_timer_state_changed(before: &[i8; 1024], after: &[i8; 1024]) -> bool {
    before
        .iter()
        .zip(after)
        .enumerate()
        .any(|(offset, (before, after))| !APIC_TMCCT.contains(&offset) && before != after)
}

fn linux_timer_changed(before: &MachineState, after: &MachineState) -> bool {
    // Linux uses TSC-deadline mode on capable hosts, otherwise LAPIC counters.
    // Unlike TSC/KVM clock reads, reprogramming this MSR requires guest activity.
    let deadline = |machine: &MachineState| {
        machine.vcpus[0]
            .state
            .msrs
            .iter()
            .find(|msr| msr.index == 0x6e0) // IA32_TSC_DEADLINE
            .map(|msr| msr.data)
    };
    lapic_timer_state_changed(
        &before.vcpus[0].state.lapic.regs,
        &after.vcpus[0].state.lapic.regs,
    ) || deadline(before) != deadline(after)
}

/// Returns Paused, after observed progress, or fails at the deadline.
fn linux_wait_for_progress(
    control: &VmControl,
    before: &(MachineState, Vec<u8>),
    files: &SnapshotFiles,
    timeout: Duration,
    wait_for_init: bool,
) -> (MachineState, Vec<u8>) {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "Linux guest progress timed out (wait_for_init={wait_for_init})"
        );
        control.resume().unwrap();
        thread::sleep(Duration::from_millis(200));
        control.pause().unwrap();
        control.export(&files.state, &files.memory).unwrap();
        let after = linux_snapshot(files);
        files.remove();
        let ready = !wait_for_init
            || String::from_utf8_lossy(&after.1).contains("Run /init as init process");
        if ready && before.1 != after.1 && linux_timer_changed(&before.0, &after.0) {
            let changed = before
                .1
                .chunks(4096)
                .zip(after.1.chunks(4096))
                .filter(|(a, b)| a != b)
                .map(|(a, b)| a.iter().zip(b).filter(|(a, b)| a != b).count())
                .sum::<usize>();
            eprintln!(
                "Linux progress: RAM changed bytes={changed}, timer state changed, wait_for_init={wait_for_init}"
            );
            return after;
        }
    }
}

/// PPR (0xA0) is KVM's derived shadow of the SDM max(TPR, ISRV) rule: retain
/// full TPR when its priority class is >= ISRV's, otherwise use ISRV & 0xF0.
/// KVM refreshes it on TPR/ISR changes, so KVM_GET_LAPIC can return a stale value:
/// a real failure differed only at 0xA0, with source PPR=0xE0 despite TPR=0x10
/// and an empty ISR (canonical PPR=0x10). Source PPR carries no guest state and
/// is excluded from comparison. KVM_SET_LAPIC recomputes PPR. This test allows
/// no vCPU guest entry before re-export, so restored PPR must be canonical.
///
/// APIC_TMCCT is a 32-bit countdown derived by KVM from host time. Its entire
/// four bytes are excluded on both sides. Initial count (0x380) and LVT timer
/// (0x320) remain compared to detect guest timer reprogramming; all remaining
/// bytes must match.
fn lapic_differences(
    expected: &[i8; 1024],
    actual: &[i8; 1024],
) -> std::result::Result<(), String> {
    let isrv = (0..256)
        .rev()
        .find(|&vector| {
            // Eight 32-bit ISR registers occupy 16-byte slots in the APIC page.
            let offset = 0x100 + (vector / 32) * 16 + (vector % 32) / 8;
            actual[offset] as u8 & (1 << (vector & 7)) != 0
        })
        .unwrap_or(0) as u8;
    let tpr = actual[0x80] as u8;
    let ppr = if tpr >> 4 >= isrv >> 4 {
        tpr
    } else {
        isrv & 0xF0
    };
    let mut differences = Vec::new();
    if actual[0xA0] as u8 != ppr {
        differences.push(format!(
            "0xA0 PPR: expected canonical {ppr:#04x}, actual {:#04x}",
            actual[0xA0] as u8
        ));
    }
    for (offset, (&expected, &actual)) in expected.iter().zip(actual).enumerate() {
        if offset == 0xA0 || APIC_TMCCT.contains(&offset) || expected == actual {
            continue;
        }
        let register = match offset {
            0x80 => "TPR",
            0x100..=0x17F => "ISR",
            0x180..=0x1FF => "TMR",
            0x200..=0x27F => "IRR",
            0x320 => "LVT timer",
            0x380 => "initial count",
            0x3E0 => "divide configuration",
            _ => "LAPIC",
        };
        differences.push(format!(
            "{offset:#05x} {register}: expected {:#04x}, actual {:#04x}",
            expected as u8, actual as u8
        ));
    }
    if differences.is_empty() {
        Ok(())
    } else {
        Err(differences.join("; "))
    }
}

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_linux_device_less_export_destroy_restore_resume_makes_progress() {
    let dir = tempfile::tempdir().unwrap();
    let initramfs = dir.path().join("init.cpio");
    // /init repeatedly nanosleeps for 10 ms. No device, console, /dev/mem,
    // fixed physical address or host-side RAM writes provide the signal.
    #[rustfmt::skip]
    let init = linux_initramfs::static_program(&[
        0x68, 0x80, 0x96, 0x98, 0x00, // push 10000000 (tv_nsec)
        0x6a, 0x00,                   // push 0 (tv_sec)
        0x48, 0x89, 0xe7,             // again: mov rdi,rsp
        0x31, 0xf6,                   // xor esi,esi
        0xb8, 35, 0, 0, 0,            // mov eax,35 (nanosleep)
        0x0f, 0x05,                   // syscall
        0xeb, 0xf2,                   // jmp again
    ]);
    fs::write(&initramfs, linux_initramfs::newc_archive("init", &init)).unwrap();
    let mut source_vm = Vm::new_device_less(crate::VmConfig {
        vcpu_count: 1,
        memory_mib: 256,
        kernel: std::env::var_os("VMM_KERNEL")
            .expect("run make vmm:boot:host and set VMM_KERNEL to its vmlinux")
            .into(),
        cmdline: "console=null panic=0".into(),
        initramfs: Some(initramfs),
        disks: vec![],
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
        hotplug_mib: 0,
    })
    .unwrap();
    let scratch = SnapshotFiles::new(dir.path(), "scratch");
    let source = SnapshotFiles::new(dir.path(), "source");
    let before = drive(&mut source_vm, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        control.export(&scratch.state, &scratch.memory).unwrap();
        let initial = linux_snapshot(&scratch);
        scratch.remove();
        let ready =
            linux_wait_for_progress(control, &initial, &scratch, Duration::from_secs(30), true);
        drop(initial);
        // Require a second interval after Linux announces /init.
        let before = linux_wait_for_progress(control, &ready, &scratch, WAIT, false);
        drop(ready);
        control.export(&source.state, &source.memory).unwrap();
        let still = linux_snapshot(&source);
        assert!(before.1 == still.1, "RAM must be stable while Paused");
        assert!(
            !linux_timer_changed(&before.0, &still.0),
            "timer configuration changed without guest entry"
        );
        still
    });
    drop(source_vm);

    let mut restored = Vm::from_state(&source.state, &source.memory).unwrap();
    drive(&mut restored, true, |control, _| {
        control.wait_paused(WAIT).unwrap();
        control.export(&scratch.state, &scratch.memory).unwrap();
        let installed = linux_snapshot(&scratch);
        scratch.remove();
        // Installing KVM's wall-clock MSR can update its shared RAM page.
        assert_eq!(
            before.0.vcpus[0].state.regs,
            installed.0.vcpus[0].state.regs
        );
        if let Err(differences) = lapic_differences(
            &before.0.vcpus[0].state.lapic.regs,
            &installed.0.vcpus[0].state.lapic.regs,
        ) {
            panic!("restored LAPIC: {differences}");
        }
        assert_eq!(before.0.platform.irqchips, installed.0.platform.irqchips);
        let after = linux_wait_for_progress(control, &installed, &scratch, WAIT, false);
        assert!(before.1 != after.1);
        assert!(linux_timer_changed(&before.0, &after.0));
    });
}
