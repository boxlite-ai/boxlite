// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs, io,
    marker::PhantomData,
    os::unix::fs::PermissionsExt,
    rc::Rc,
    sync::{Mutex, mpsc},
    thread::{self, ThreadId},
    time::Duration,
};

use super::{image::Header, state::MachineState};
use crate::{
    ControlReason, Error, Vm, VmControl, VmExit, VmStatus,
    lifecycle::Lifecycle,
    mock_vm::{MockHandle, MockVcpu, MockVm},
};
use boxlite_hypervisor::{
    MemoryRegion, Vcpu, VcpuExit, X86BootRegisters, X86IrqchipState, X86Vcpu, X86VcpuState, X86Vm,
    X86VmState,
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
    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<Option<VcpuExit<'_>>> {
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
        if self.fail {
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

fn with_paused<H: X86Vm, R>(
    mut vm: Vm<H>,
    test: impl FnOnce(&VmControl, &Lifecycle, ThreadId) -> R,
) -> R {
    struct StopOnDrop<'a>(&'a VmControl);
    impl Drop for StopOnDrop<'_> {
        fn drop(&mut self) {
            self.0.stop();
        }
    }

    let control = vm.control();
    let lifecycle = vm.lifecycle().clone();
    control.pause().unwrap();
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
    for path in [&state_path, &memory_path] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
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

#[test]
fn vcpu_panic_interrupts_capture_before_a_blocked_vcpu_replies() {
    let (backend, mut releases, observed) = backend(false, false);
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    let mut vm = machine(backend);
    let control = vm.control();
    control.pause().unwrap();
    thread::scope(|scope| {
        let driver = scope.spawn(|| vm.run());
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
        drop(releases.remove(0));
        let result = result.recv_timeout(Duration::from_millis(500));
        for release in releases {
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
            assert!(matches!(
                observed.recv_timeout(WAIT).unwrap(),
                Capture::Cpu(..)
            ));
            control.stop();
            expect_export_error(
                result.recv_timeout(WAIT).unwrap(),
                ControlReason::TerminalOutcome,
            );
            assert!(!state_path.exists() && !memory_path.exists());
            for release in releases {
                let _ = release.send(());
            }
        });
    });
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
