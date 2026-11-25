// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs, io,
    marker::PhantomData,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    rc::Rc,
    sync::{Mutex, mpsc},
    thread::{self, ThreadId},
    time::Duration,
};

use super::{image::Header, state::MachineState};
use crate::{
    ControlReason, Error, Vm, VmControl, VmExit, VmStatus,
    events::EventLoop,
    lifecycle::Lifecycle,
    mock_vm::{MockHandle, MockVcpu, MockVm},
};
use boxlite_hypervisor::{
    IoCompletion, MemoryRegion, Vcpu, VcpuExit, X86BootRegisters, X86IrqchipState, X86Vcpu,
    X86VcpuState, X86Vm, X86VmState,
};
use vm_memory::{Bytes, GuestAddress};

const WAIT: Duration = Duration::from_secs(5);

fn cpu(id: u32) -> X86VcpuState {
    let mut state = X86VcpuState {
        regs: Default::default(),
        sregs: Default::default(),
        fpu: Default::default(),
        xsave: vec![],
        cpuid: vec![],
        msrs: vec![],
        xcrs: Default::default(),
        debug_regs: Default::default(),
        events: Default::default(),
        mp_state: Default::default(),
        lapic: Default::default(),
        tsc_khz: 1000,
    };
    state.regs.rax = u64::from(id);
    state
}

fn platform() -> X86VmState {
    X86VmState {
        irqchips: [
            X86IrqchipState::pic(0, Default::default()),
            X86IrqchipState::pic(1, Default::default()),
            X86IrqchipState::ioapic(Default::default()),
        ],
        pit: None,
        clock: Default::default(),
    }
}

#[derive(Debug)]
enum Capture {
    Cpu(u32, ThreadId),
    Done(u32),
    Failed(u32),
    Platform(ThreadId),
}
struct Backend {
    inner: MockVm,
    observed: mpsc::Sender<Capture>,
    gates: Vec<Mutex<mpsc::Receiver<()>>>,
    fail_cpu: bool,
    fail_cpu_once: bool,
    fail_platform: bool,
    platform_gate: Option<Mutex<mpsc::Receiver<()>>>,
}
struct Cpu {
    inner: MockVcpu,
    id: u32,
    owner: ThreadId,
    observed: mpsc::Sender<Capture>,
    gate: mpsc::Receiver<()>,
    fail: bool,
    fail_once: bool,
    // Enforce the backend contract: only its owning thread may access the CPU.
    local: PhantomData<Rc<()>>,
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
        let (_, empty) = mpsc::channel();
        let gate = std::mem::replace(&mut *self.gates[id as usize].lock().unwrap(), empty);
        Ok(Cpu {
            inner: self.inner.create_vcpu(id)?,
            id,
            owner: thread::current().id(),
            observed: self.observed.clone(),
            gate,
            fail: self.fail_cpu && id == 0,
            fail_once: self.fail_cpu_once && id == 0,
            local: PhantomData,
        })
    }
}
impl X86Vm for Backend {
    fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
        &[]
    }
    fn save_state(&self) -> boxlite_hypervisor::Result<X86VmState> {
        self.observed
            .send(Capture::Platform(thread::current().id()))
            .unwrap();
        if let Some(gate) = &self.platform_gate {
            gate.lock().unwrap().recv_timeout(WAIT).unwrap();
        }
        if self.fail_platform {
            return Err(boxlite_hypervisor::Error::CreateVm(io::Error::other(
                "platform failure",
            )));
        }
        Ok(platform())
    }
}
impl Vcpu for Cpu {
    type Handle = MockHandle;
    fn run(&mut self) -> boxlite_hypervisor::Result<VcpuExit<'_>> {
        self.inner.run()
    }
    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<IoCompletion<'_>> {
        self.inner.complete_pending_io()
    }
    fn handle(&self) -> MockHandle {
        self.inner.handle()
    }
}
impl X86Vcpu for Cpu {
    fn set_cpu_features(
        &mut self,
        cpuid: &[boxlite_hypervisor::X86CpuidEntry],
        msrs: &[boxlite_hypervisor::X86Msr],
    ) -> boxlite_hypervisor::Result<()> {
        self.inner.set_cpu_features(cpuid, msrs)
    }
    fn set_boot_registers(&mut self, state: &X86BootRegisters) -> boxlite_hypervisor::Result<()> {
        self.inner.set_boot_registers(state)
    }
    fn save_state(&mut self) -> boxlite_hypervisor::Result<X86VcpuState> {
        assert_eq!(thread::current().id(), self.owner);
        self.observed
            .send(Capture::Cpu(self.id, self.owner))
            .unwrap();
        self.gate.recv_timeout(WAIT).unwrap();
        if self.fail || std::mem::take(&mut self.fail_once) {
            self.observed.send(Capture::Failed(self.id)).unwrap();
            return Err(boxlite_hypervisor::Error::ConfigureVcpu {
                id: self.id,
                operation: "save state",
                source: io::Error::other("CPU failure"),
            });
        }
        self.observed.send(Capture::Done(self.id)).unwrap();
        Ok(cpu(self.id))
    }
}

fn config() -> crate::VmConfig {
    crate::VmConfig {
        vcpu_count: 3,
        memory_mib: 1,
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
fn backend(
    fail_cpu: bool,
    fail_platform: bool,
) -> (Backend, Vec<mpsc::Sender<()>>, mpsc::Receiver<Capture>) {
    let (observed, rx) = mpsc::channel();
    let mut gates = vec![];
    let mut releases = vec![];
    for _ in 0..3 {
        let (tx, rx) = mpsc::channel();
        gates.push(Mutex::new(rx));
        releases.push(tx);
    }
    (
        Backend {
            inner: MockVm::new(),
            observed,
            gates,
            fail_cpu,
            fail_cpu_once: false,
            fail_platform,
            platform_gate: None,
        },
        releases,
        rx,
    )
}
fn machine(backend: Backend) -> Vm<Backend> {
    Vm::with_backend(
        config(),
        || Ok(backend),
        |ram, _| {
            ram.boot_memory()
                .write_slice(b"guest RAM", GuestAddress(0))
                .unwrap();
            Ok(X86BootRegisters::default())
        },
        |_, _| Ok(()),
    )
    .unwrap()
}

struct StopOnDrop<'a>(&'a VmControl);
impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        self.0.stop();
    }
}

fn with_paused<H: X86Vm, R>(
    mut vm: Vm<H>,
    test: impl FnOnce(&VmControl, &Lifecycle, ThreadId) -> R,
) -> R {
    let control = vm.control();
    let lifecycle = vm.lifecycle().clone();
    control.request_pause().unwrap();
    thread::scope(|scope| {
        let driver = scope.spawn(|| vm.run());
        let stop = StopOnDrop(&control);
        control.wait_paused(WAIT).unwrap();
        let result = test(&control, &lifecycle, driver.thread().id());
        drop(stop);
        assert_eq!(driver.join().unwrap().unwrap(), VmExit::StopRequested);
        result
    })
}

fn decode(mut bytes: &[u8], memory: &[u8]) -> (Header, MachineState) {
    let len = bytes.len() as u64;
    let header = Header::read_from(&mut bytes, len, memory.len() as u64).unwrap();
    let (state, tail) = postcard::take_from_bytes(bytes).unwrap();
    assert!(tail.is_empty());
    (header, state)
}

fn expect_export_error<T>(result: crate::Result<T>, reason: ControlReason) {
    assert!(
        matches!(result, Err(Error::Control { operation: "export", reason: why }) if why == reason)
    );
}

#[test]
fn driver_captures_platform_first_and_owning_threads_produce_id_ordered_records() {
    let (backend, releases, observed) = backend(false, false);
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    with_paused(machine(backend), |control, _, driver| {
        thread::scope(|scope| {
            let caller = scope.spawn(|| control.export(&state_path, &memory_path));
            assert!(
                matches!(observed.recv_timeout(WAIT).unwrap(), Capture::Platform(owner) if owner == driver)
            );
            let mut ids = Vec::new();
            for _ in 0..3 {
                let Capture::Cpu(id, owner) = observed.recv_timeout(WAIT).unwrap() else {
                    panic!("expected a vCPU capture after platform capture");
                };
                assert_ne!(owner, driver);
                ids.push(id);
            }
            ids.sort_unstable();
            assert_eq!(ids, [0, 1, 2]);
            assert!(!state_path.exists() && !memory_path.exists());
            expect_export_error(
                control.clone().export(&state_path, &memory_path),
                ControlReason::InvalidState,
            );
            for id in [2, 1, 0] {
                releases[id].send(()).unwrap();
                assert!(
                    matches!(observed.recv_timeout(WAIT).unwrap(), Capture::Done(done) if done == id as u32)
                );
                if id != 0 {
                    assert!(matches!(
                        observed.try_recv(),
                        Err(mpsc::TryRecvError::Empty)
                    ));
                }
            }
            caller.join().unwrap().unwrap();
        });
        assert_eq!(control.status(), VmStatus::Paused);
    });
    let memory = fs::read(&memory_path).unwrap();
    let (header, state) = decode(&fs::read(&state_path).unwrap(), &memory);
    assert_eq!(header.vcpus, 3);
    assert_eq!(header.ram_len, 1 << 20);
    assert_eq!(&memory[..9], b"guest RAM");
    assert!(memory[9..].iter().all(|&byte| byte == 0));
    let probe_path = dir.path().join("umask-probe");
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o777)
        .open(&probe_path)
        .unwrap();
    let probe_mode = fs::metadata(&probe_path).unwrap().permissions().mode() & 0o777;
    for path in [&state_path, &memory_path] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600 & probe_mode
        );
    }
    assert_eq!(
        state
            .vcpus
            .iter()
            .map(|record| (record.id, record.state.regs.rax))
            .collect::<Vec<_>>(),
        [(0, 0), (1, 1), (2, 2)]
    );
    assert_eq!(state.platform, platform());
}

#[test]
fn capture_failures_leave_vm_paused_without_creating_files() {
    for (fail_cpu, fail_platform) in [(true, false), (false, true)] {
        let (backend, releases, observed) = backend(fail_cpu, fail_platform);
        with_paused(machine(backend), |control, _, driver| {
            for release in releases {
                release.send(()).unwrap();
            }
            let dir = tempfile::tempdir().unwrap();
            let state_path = dir.path().join("state");
            let memory_path = dir.path().join("memory");
            assert!(matches!(
                control.export(&state_path, &memory_path),
                Err(Error::Hypervisor(_))
            ));
            if fail_platform {
                assert!(
                    matches!(observed.try_recv().unwrap(), Capture::Platform(owner) if owner == driver)
                );
                assert!(matches!(
                    observed.try_recv(),
                    Err(mpsc::TryRecvError::Empty)
                ));
            }
            assert_eq!(control.status(), VmStatus::Paused);
            assert!(!state_path.exists() && !memory_path.exists());
            control.resume().unwrap();
        });
    }
}

#[test]
fn capture_error_keeps_export_exclusive_until_every_vcpu_replies() {
    let (backend, releases, observed) = backend(true, false);
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    with_paused(machine(backend), |control, lifecycle, _| {
        let reply = lifecycle.submit_export(&state_path, &memory_path).unwrap();
        assert!(matches!(
            observed.recv_timeout(WAIT).unwrap(),
            Capture::Platform(_)
        ));
        for _ in 0..3 {
            assert!(matches!(
                observed.recv_timeout(WAIT).unwrap(),
                Capture::Cpu(..)
            ));
        }
        releases[1].send(()).unwrap();
        assert!(matches!(
            observed.recv_timeout(WAIT).unwrap(),
            Capture::Done(1)
        ));
        releases[0].send(()).unwrap();
        assert!(matches!(
            observed.recv_timeout(WAIT).unwrap(),
            Capture::Failed(0)
        ));

        let pending = reply.recv_timeout(Duration::from_millis(250));
        if !matches!(pending, Err(mpsc::RecvTimeoutError::Timeout)) {
            releases[2].send(()).unwrap();
            panic!("export completed while vCPU 2 was still capturing: {pending:?}");
        }
        assert!(matches!(
            control.resume(),
            Err(Error::Control {
                operation: "resume",
                reason: ControlReason::InvalidState
            })
        ));
        expect_export_error(
            control.export(&state_path, &memory_path),
            ControlReason::InvalidState,
        );

        releases[2].send(()).unwrap();
        assert!(matches!(
            observed.recv_timeout(WAIT).unwrap(),
            Capture::Done(2)
        ));
        assert!(matches!(
            reply.recv_timeout(WAIT).unwrap(),
            Err(Error::Hypervisor(
                boxlite_hypervisor::Error::ConfigureVcpu { id: 0, .. }
            ))
        ));
        control.resume().unwrap();
    });
}

struct ReleaseOnDrop(Vec<mpsc::Sender<()>>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        for release in self.0.drain(..) {
            let _ = release.send(());
        }
    }
}

#[test]
fn vcpu_panic_interrupts_capture_before_a_blocked_vcpu_replies() {
    let (backend, releases, observed) = backend(false, false);
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    let mut vm = machine(backend);
    let control = vm.control();
    control.request_pause().unwrap();
    thread::scope(|scope| {
        let driver = scope.spawn(|| vm.run());
        let mut releases = ReleaseOnDrop(releases);
        let _stop = StopOnDrop(&control);
        control.wait_paused(WAIT).unwrap();
        let (reply, result) = mpsc::channel();
        let control = &control;
        let (state_path, memory_path) = (&state_path, &memory_path);
        scope.spawn(move || reply.send(control.export(state_path, memory_path)).unwrap());
        assert!(matches!(
            observed.recv_timeout(WAIT).unwrap(),
            Capture::Platform(_)
        ));
        for _ in 0..3 {
            assert!(matches!(
                observed.recv_timeout(WAIT).unwrap(),
                Capture::Cpu(..)
            ));
        }

        // Disconnect vCPU 0's gate so its save_state panics while the others are blocked.
        drop(releases.0.remove(0));
        let result = result.recv_timeout(Duration::from_millis(500));
        for release in releases.0.drain(..) {
            release.send(()).unwrap();
        }
        assert!(matches!(
            driver.join().unwrap(),
            Err(Error::VcpuPanicked { vcpu: 0 })
        ));
        expect_export_error(
            result.expect("panic did not wake capture"),
            ControlReason::TerminalOutcome,
        );
        assert!(!state_path.exists() && !memory_path.exists());
    });
}

#[test]
fn stop_interrupts_capture_before_a_blocked_vcpu_replies() {
    let (backend, releases, observed) = backend(false, false);
    let mut releases = ReleaseOnDrop(releases);
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    with_paused(machine(backend), |control, _, _| {
        thread::scope(|scope| {
            let (reply, result) = mpsc::channel();
            let (state_path, memory_path) = (&state_path, &memory_path);
            scope.spawn(move || reply.send(control.export(state_path, memory_path)).unwrap());
            assert!(matches!(
                observed.recv_timeout(WAIT).unwrap(),
                Capture::Platform(_)
            ));
            for _ in 0..3 {
                assert!(matches!(
                    observed.recv_timeout(WAIT).unwrap(),
                    Capture::Cpu(..)
                ));
            }
            control.stop();
            expect_export_error(
                result.recv_timeout(Duration::from_millis(500)).unwrap(),
                ControlReason::TerminalOutcome,
            );
            assert!(!state_path.exists() && !memory_path.exists());
            for release in releases.0.drain(..) {
                release.send(()).unwrap();
            }
        });
    });
}

#[test]
fn retry_export_succeeds_in_same_pause_epoch_after_capture_failure() {
    let (mut backend, releases, _observed) = backend(false, false);
    backend.fail_cpu_once = true;
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    with_paused(machine(backend), |control, _, _| {
        for release in &releases {
            release.send(()).unwrap();
        }
        assert!(matches!(
            control.export(&state_path, &memory_path),
            Err(Error::Hypervisor(_))
        ));
        assert!(!state_path.exists() && !memory_path.exists());
        assert_eq!(control.status(), VmStatus::Paused);

        for release in &releases {
            release.send(()).unwrap();
        }
        control.export(&state_path, &memory_path).unwrap();
        assert_eq!(control.status(), VmStatus::Paused);
    });
    let memory = fs::read(&memory_path).unwrap();
    let (header, state) = decode(&fs::read(&state_path).unwrap(), &memory);
    assert_eq!(header.vcpus, 3);
    assert_eq!(header.ram_len, 1 << 20);
    assert_eq!(&memory[..9], b"guest RAM");
    assert_eq!(
        state
            .vcpus
            .iter()
            .map(|record| (record.id, record.state.regs.rax))
            .collect::<Vec<_>>(),
        [(0, 0), (1, 1), (2, 2)]
    );
    assert_eq!(state.platform, platform());
}

#[test]
fn export_rejects_vms_with_devices() {
    struct Idle;
    impl crate::bus::BusDevice for Idle {
        fn read(&mut self, _: u64, _: &mut [u8]) {}
        fn write(&mut self, _: u64, _: &[u8]) {}
    }

    let vm = Vm::with_backend(
        config(),
        || Ok(MockVm::new()),
        |_, _| Ok(X86BootRegisters::default()),
        |chipset, _| chipset.add("idle", |_| Ok(Idle)),
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    expect_export_error(
        vm.control().export(&state_path, &memory_path),
        ControlReason::UnsupportedDevice,
    );
    assert!(!state_path.exists() && !memory_path.exists());
}

#[test]
fn stop_during_platform_capture_skips_vcpu_capture_and_file_creation() {
    let (mut backend, releases, observed) = backend(false, false);
    let (release_platform, platform_gate) = mpsc::channel();
    backend.platform_gate = Some(Mutex::new(platform_gate));
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    with_paused(machine(backend), |control, _, driver| {
        for release in releases {
            release.send(()).unwrap();
        }
        thread::scope(|scope| {
            let export = scope.spawn(|| control.export(&state_path, &memory_path));
            assert!(
                matches!(observed.recv_timeout(WAIT).unwrap(), Capture::Platform(owner) if owner == driver)
            );
            control.stop();
            assert_eq!(control.status(), VmStatus::Stopping);
            release_platform.send(()).unwrap();
            expect_export_error(export.join().unwrap(), ControlReason::TerminalOutcome);
        });
    });
    assert!(matches!(
        observed.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    assert!(!state_path.exists() && !memory_path.exists());
}

#[test]
fn export_holds_the_slot_during_platform_capture_and_reply_survives_resume() {
    let (mut backend, releases, observed) = backend(false, false);
    let (release_platform, platform_gate) = mpsc::channel();
    backend.platform_gate = Some(Mutex::new(platform_gate));
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    with_paused(machine(backend), |control, lifecycle, _| {
        for release in releases {
            release.send(()).unwrap();
        }
        let reply = lifecycle.submit_export(&state_path, &memory_path).unwrap();
        assert!(matches!(
            observed.recv_timeout(WAIT).unwrap(),
            Capture::Platform(_)
        ));
        let competitor = control.clone();
        assert_eq!(competitor.status(), VmStatus::Paused);
        competitor.wait_paused(Duration::ZERO).unwrap();
        assert!(matches!(
            competitor.resume(),
            Err(Error::Control {
                operation: "resume",
                reason: ControlReason::InvalidState
            })
        ));
        expect_export_error(
            competitor.export(&state_path, &memory_path),
            ControlReason::InvalidState,
        );
        assert!(!state_path.exists() && !memory_path.exists());
        assert!(matches!(
            observed.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        release_platform.send(()).unwrap();

        // Keep the export reply unread until another handle has resumed.
        let deadline = std::time::Instant::now() + WAIT;
        loop {
            match competitor.resume() {
                Ok(()) => break,
                Err(Error::Control {
                    reason: ControlReason::InvalidState,
                    ..
                }) => {
                    assert!(std::time::Instant::now() < deadline);
                    thread::yield_now();
                }
                Err(error) => panic!("resume: {error}"),
            }
        }
        assert_eq!(control.status(), VmStatus::Running);
        assert!(reply.recv_timeout(WAIT).unwrap().is_ok());
        expect_export_error(
            control.export(&state_path, &memory_path),
            ControlReason::InvalidState,
        );
    });
}

#[test]
fn export_reports_terminal_state_before_unsupported_devices() {
    let events = EventLoop::new().unwrap();
    let lifecycle = Lifecycle::new(events.sender(), false);
    let state_path = Path::new("state");
    let memory_path = Path::new("memory");

    expect_export_error(
        lifecycle.submit_export(state_path, memory_path),
        ControlReason::UnsupportedDevice,
    );
    lifecycle.stop();
    expect_export_error(
        lifecycle.submit_export(state_path, memory_path),
        ControlReason::InvalidState,
    );
}

#[test]
fn file_export_refuses_existing_target_and_unstarted_or_terminal_vm() {
    let (backend, releases, _observed) = backend(false, false);
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    let target = dir.path().join("existing");
    fs::write(&target, b"existing").unwrap();
    let vm = machine(backend);
    let control = vm.control();
    expect_export_error(
        control.export(&state_path, &memory_path),
        ControlReason::InvalidState,
    );
    with_paused(vm, |control, _, _| {
        for release in releases {
            for _ in 0..3 {
                release.send(()).unwrap();
            }
        }
        for (state, memory) in [
            (&target, &memory_path),
            (&state_path, &target),
            (&state_path, &state_path),
        ] {
            assert!(
                matches!(control.export(state, memory), Err(Error::Snapshot(error))
                if error.kind() == io::ErrorKind::AlreadyExists)
            );
            assert_eq!(control.status(), VmStatus::Paused);
            assert!(!state_path.exists() && !memory_path.exists());
            assert_eq!(fs::read(&target).unwrap(), b"existing");
        }
        control.stop();
        expect_export_error(
            control.export(&state_path, &memory_path),
            ControlReason::InvalidState,
        );
    });
    assert_eq!(control.status(), VmStatus::Exited);
    expect_export_error(
        control.export(&state_path, &memory_path),
        ControlReason::InvalidState,
    );
    assert!(!state_path.exists() && !memory_path.exists());
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_export_of_parked_device_less_guest() {
    const PROGRAM: [u8; 2] = [0xeb, 0xfe];
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    let vm = Vm::with_backend(
        config(),
        boxlite_hypervisor::KvmVm::new,
        |ram, _| Ok(crate::flat_guest::load(ram.boot_memory(), &PROGRAM)),
        |_, _| Ok(()),
    )
    .unwrap();
    with_paused(vm, |control, _, _| {
        control.export(&state_path, &memory_path).unwrap();
        let memory = fs::read(&memory_path).unwrap();
        let (header, state) = decode(&fs::read(&state_path).unwrap(), &memory);
        assert_eq!(header.vcpus, 3);
        assert_eq!(header.ram_len, 1 << 20);
        assert_eq!(state.vcpus.len(), 3);
        let code = crate::flat_guest::CODE as usize;
        assert_eq!(&memory[code..code + PROGRAM.len()], &PROGRAM);
        assert_eq!(control.status(), VmStatus::Paused);
        control.resume().unwrap();
    });
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_export_captures_executed_guest_state_and_ram() {
    use std::{sync::atomic::Ordering, time::Instant};
    use vm_memory::GuestAddressSpace;

    use crate::flat_guest;

    const MARKER_ADDR: GuestAddress = GuestAddress(0x2000);
    const COUNTER_ADDR: GuestAddress = GuestAddress(0x2004);
    const MARKER: u32 = 0x1234_5678;
    #[rustfmt::skip]
    const PROGRAM: [u8; 19] = [
        0xb8, 0x78, 0x56, 0x34, 0x12,             // mov eax, 0x12345678
        0xa3, 0x00, 0x20, 0x00, 0x00,             // mov dword ptr ds:[0x2000], eax
        0xf0, 0xff, 0x05, 0x04, 0x20, 0x00, 0x00, // lock inc dword ptr ds:[0x2004]
        0xeb, 0xf7,                               // jmp $-7 (0x100a)
    ];

    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    let state_path_2 = dir.path().join("state2");
    let memory_path_2 = dir.path().join("memory2");
    let state_path_3 = dir.path().join("state3");
    let memory_path_3 = dir.path().join("memory3");
    let mut guest_memory = None;
    let vm = Vm::with_backend(
        config(),
        boxlite_hypervisor::KvmVm::new,
        |ram, _| {
            guest_memory = Some(ram.memory().clone());
            Ok(flat_guest::load(ram.boot_memory(), &PROGRAM))
        },
        |_, _| Ok(()),
    )
    .unwrap();
    let guest_memory = guest_memory.unwrap();
    let read_u32 = |addr| {
        guest_memory
            .memory()
            .load::<u32>(addr, Ordering::Relaxed)
            .unwrap()
    };

    with_paused(vm, |control, _, _| {
        assert_eq!(read_u32(MARKER_ADDR), 0);
        assert_eq!(read_u32(COUNTER_ADDR), 0);
        control.resume().unwrap();
        let deadline = Instant::now() + WAIT;
        while read_u32(MARKER_ADDR) != MARKER || read_u32(COUNTER_ADDR) == 0 {
            assert!(
                Instant::now() < deadline,
                "guest did not write the RAM marker and counter"
            );
            thread::sleep(Duration::from_millis(10));
        }
        control.request_pause().unwrap();
        control.wait_paused(WAIT).unwrap();
        assert_eq!(control.status(), VmStatus::Paused);
        let paused_counter = read_u32(COUNTER_ADDR);
        assert!(paused_counter > 0);
        control.export(&state_path, &memory_path).unwrap();

        let memory = fs::read(&memory_path).unwrap();
        let (header, state) = decode(&fs::read(&state_path).unwrap(), &memory);
        assert_eq!(header.vcpus, 3);
        assert_eq!(header.ram_len, 1 << 20);
        assert_eq!(state.vcpus.len(), 3);
        let ids: Vec<_> = state.vcpus.iter().map(|record| record.id).collect();
        assert_eq!(ids, [0, 1, 2]);
        assert!(state.platform.pit.is_some());
        let chip_ids: Vec<_> = state
            .platform
            .irqchips
            .iter()
            .map(|chip| chip.as_kvm().chip_id)
            .collect();
        assert_eq!(chip_ids, [0, 1, 2]);
        let regs = &state.vcpus[0].state.regs;
        assert_eq!(regs.rax, u64::from(MARKER));
        assert!((0x100a..=0x1011).contains(&regs.rip));
        for vcpu in &state.vcpus[1..] {
            assert!(!vcpu.state.cpuid.is_empty());
            assert!(!vcpu.state.xsave.is_empty());
        }
        let marker = MARKER_ADDR.0 as usize;
        assert_eq!(
            u32::from_le_bytes(memory[marker..marker + 4].try_into().unwrap()),
            MARKER
        );
        let counter = COUNTER_ADDR.0 as usize;
        assert_eq!(
            u32::from_le_bytes(memory[counter..counter + 4].try_into().unwrap()),
            paused_counter
        );
        let code = flat_guest::CODE as usize;
        assert_eq!(&memory[code..code + PROGRAM.len()], &PROGRAM);

        // Re-exporting within the same pause epoch succeeds without changing state.
        control.export(&state_path_2, &memory_path_2).unwrap();
        let memory_2 = fs::read(&memory_path_2).unwrap();
        let (header_2, _) = decode(&fs::read(&state_path_2).unwrap(), &memory_2);
        assert_eq!(header_2.vcpus, 3);
        assert_eq!(
            u32::from_le_bytes(memory_2[counter..counter + 4].try_into().unwrap()),
            paused_counter
        );

        assert_eq!(control.status(), VmStatus::Paused);
        control.resume().unwrap();
        assert_eq!(control.status(), VmStatus::Running);
        let deadline = Instant::now() + WAIT;
        while read_u32(COUNTER_ADDR) <= paused_counter {
            assert!(
                Instant::now() < deadline,
                "guest counter did not advance after resume"
            );
            thread::sleep(Duration::from_millis(10));
        }
        control.request_pause().unwrap();
        control.wait_paused(WAIT).unwrap();
        assert_eq!(control.status(), VmStatus::Paused);
        let resumed_counter = read_u32(COUNTER_ADDR);
        assert!(resumed_counter > paused_counter);
        control.export(&state_path_3, &memory_path_3).unwrap();
        let memory_3 = fs::read(&memory_path_3).unwrap();
        let (_, _) = decode(&fs::read(&state_path_3).unwrap(), &memory_3);
        assert_eq!(
            u32::from_le_bytes(memory_3[counter..counter + 4].try_into().unwrap()),
            resumed_counter
        );
    });
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_export_after_split_mmio_pause() {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Instant,
    };

    use boxlite_hypervisor::{KvmVcpu, KvmVcpuHandle, KvmVm};
    use vm_memory::GuestAddressSpace;

    use crate::flat_guest;

    const COUNTER: GuestAddress = GuestAddress(0x2000);
    const READBACK: GuestAddress = GuestAddress(0x2004);
    const MMIO_SPLIT_ADDR: u64 = 0xd000_0ffe;
    #[rustfmt::skip]
    const PROGRAM: [u8; 29] = [
        0xa1, 0xfe, 0x0f, 0x00, 0xd0,                               // mov eax, [0xd0000ffe]
        0xa3, 0x04, 0x20, 0x00, 0x00,                               // mov [0x2004], eax
        0xc7, 0x05, 0xfe, 0x0f, 0x00, 0xd0, 0x78, 0x56, 0x34, 0x12, // mov dword [0xd0000ffe], 0x12345678
        0xf0, 0xff, 0x05, 0x00, 0x20, 0x00, 0x00,                   // lock inc dword [0x2000]
        0xeb, 0xe3,                                                 // jmp to the start
    ];

    #[derive(Clone, Copy, Debug)]
    enum SplitAccess {
        Read,
        Write,
    }

    impl SplitAccess {
        fn is_fragment(self, exit: &VcpuExit<'_>, addr: u64) -> bool {
            match (self, exit) {
                (Self::Read, VcpuExit::MmioRead { guest_addr, bytes }) => {
                    *guest_addr == addr && bytes.len() == 2
                }
                (Self::Write, VcpuExit::MmioWrite { guest_addr, bytes }) => {
                    *guest_addr == addr && bytes.len() == 2
                }
                _ => false,
            }
        }
    }

    struct ExitGate {
        arrived: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl ExitGate {
        fn new() -> (Arc<Self>, mpsc::Receiver<()>, mpsc::Sender<()>) {
            let (arrived, ready) = mpsc::channel();
            let (release, resume) = mpsc::channel();
            (
                Arc::new(Self {
                    arrived,
                    release: Mutex::new(resume),
                }),
                ready,
                release,
            )
        }

        fn wait(&self) {
            self.arrived.send(()).unwrap();
            self.release.lock().unwrap().recv_timeout(WAIT).unwrap();
        }
    }

    struct SplitMmioVm {
        vm: KvmVm,
        gate: Arc<ExitGate>,
        access: SplitAccess,
        completed_fragments: Arc<AtomicUsize>,
    }

    impl boxlite_hypervisor::Vm for SplitMmioVm {
        type Vcpu = SplitMmioVcpu;

        unsafe fn map_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
            // SAFETY: forwards the caller's unchanged registration contract.
            unsafe { self.vm.map_memory(region) }
        }

        fn unmap_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
            self.vm.unmap_memory(region)
        }

        fn create_vcpu(&self, id: u32) -> boxlite_hypervisor::Result<Self::Vcpu> {
            Ok(SplitMmioVcpu {
                vcpu: self.vm.create_vcpu(id)?,
                gate: Some(Arc::clone(&self.gate)),
                access: self.access,
                check_completion: false,
                completed_fragments: Arc::clone(&self.completed_fragments),
            })
        }

        fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
            self.vm.set_irq_line(line, level)
        }
    }

    impl X86Vm for SplitMmioVm {
        fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
            self.vm.supported_cpuid()
        }

        fn save_state(&self) -> boxlite_hypervisor::Result<X86VmState> {
            self.vm.save_state()
        }
    }

    struct SplitMmioVcpu {
        vcpu: KvmVcpu,
        gate: Option<Arc<ExitGate>>,
        access: SplitAccess,
        check_completion: bool,
        completed_fragments: Arc<AtomicUsize>,
    }

    impl Vcpu for SplitMmioVcpu {
        type Handle = KvmVcpuHandle;

        fn run(&mut self) -> boxlite_hypervisor::Result<VcpuExit<'_>> {
            let exit = self.vcpu.run()?;
            if self.access.is_fragment(&exit, MMIO_SPLIT_ADDR)
                && let Some(gate) = self.gate.take()
            {
                self.check_completion = true;
                gate.wait();
            }
            Ok(exit)
        }

        fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<IoCompletion<'_>> {
            let completion = self.vcpu.complete_pending_io()?;
            if std::mem::take(&mut self.check_completion) {
                assert!(
                    matches!(&completion, IoCompletion::Exit(exit)
                        if self.access.is_fragment(exit, MMIO_SPLIT_ADDR + 2)),
                    "expected the second {:?} fragment from completion, got {completion:?}",
                    self.access
                );
                self.completed_fragments.fetch_add(1, Ordering::Relaxed);
            }
            Ok(completion)
        }

        fn notify_guest_stopped(&mut self) -> boxlite_hypervisor::Result<()> {
            self.vcpu.notify_guest_stopped()
        }

        fn handle(&self) -> Self::Handle {
            self.vcpu.handle()
        }
    }

    impl X86Vcpu for SplitMmioVcpu {
        fn set_cpu_features(
            &mut self,
            cpuid: &[boxlite_hypervisor::X86CpuidEntry],
            msrs: &[boxlite_hypervisor::X86Msr],
        ) -> boxlite_hypervisor::Result<()> {
            self.vcpu.set_cpu_features(cpuid, msrs)
        }

        fn set_boot_registers(
            &mut self,
            regs: &X86BootRegisters,
        ) -> boxlite_hypervisor::Result<()> {
            self.vcpu.set_boot_registers(regs)
        }

        fn save_state(&mut self) -> boxlite_hypervisor::Result<X86VcpuState> {
            self.vcpu.save_state()
        }
    }

    for access in [SplitAccess::Read, SplitAccess::Write] {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join("state");
        let memory_path = dir.path().join("memory");
        let (gate, ready, release) = ExitGate::new();
        let completed_fragments = Arc::new(AtomicUsize::new(0));
        let mut guest_memory = None;
        let mut cfg = config();
        cfg.vcpu_count = 1;
        let mut vm = Vm::with_backend(
            cfg,
            || {
                Ok(SplitMmioVm {
                    vm: KvmVm::new()?,
                    gate,
                    access,
                    completed_fragments: Arc::clone(&completed_fragments),
                })
            },
            |ram, _| {
                guest_memory = Some(ram.memory().clone());
                let guest = ram.memory().memory();
                guest.store(0u32, COUNTER, Ordering::Relaxed).unwrap();
                guest
                    .store(0xdead_beefu32, READBACK, Ordering::Relaxed)
                    .unwrap();
                Ok(flat_guest::load(&guest, &PROGRAM))
            },
            |_, _| Ok(()),
        )
        .unwrap();
        let guest_memory = guest_memory.unwrap();
        let load = |addr| {
            guest_memory
                .memory()
                .load::<u32>(addr, Ordering::Relaxed)
                .unwrap()
        };
        let control = vm.control();
        thread::scope(|scope| {
            let driver = scope.spawn(|| vm.run());
            let stop = StopOnDrop(&control);
            ready.recv_timeout(WAIT).unwrap();
            control.request_pause().unwrap();
            let deadline = Instant::now() + WAIT;
            while control.status() != VmStatus::Pausing {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(1));
            }
            release.send(()).unwrap();
            control.wait_paused(WAIT).unwrap();
            assert_eq!(control.status(), VmStatus::Paused);
            assert_eq!(completed_fragments.load(Ordering::Relaxed), 1);

            control.export(&state_path, &memory_path).unwrap();
            let memory = fs::read(&memory_path).unwrap();
            let (header, state) = decode(&fs::read(&state_path).unwrap(), &memory);
            assert_eq!(header.vcpus, 1);
            assert_eq!(header.ram_len, 1 << 20);
            assert_eq!(state.vcpus.len(), 1);

            control.resume().unwrap();
            let deadline = Instant::now() + WAIT;
            while load(COUNTER) == 0 {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(load(READBACK), u32::MAX);
            drop(stop);
            assert_eq!(driver.join().unwrap().unwrap(), VmExit::StopRequested);
        });
    }
}
