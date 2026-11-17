// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File},
    marker::PhantomData,
    rc::Rc,
    sync::{Mutex, mpsc},
    thread::{self, ThreadId},
    time::Duration,
};

use super::*;
use crate::{
    Vm,
    mock_vm::{MockHandle, MockVcpu, MockVm},
    snapshot::image::Header,
};
use boxlite_hypervisor::{
    MemoryRegion, Vcpu, VcpuExit, X86BootRegisters, X86IrqchipState, X86Vcpu, X86VcpuState, X86Vm,
    X86VmState,
};

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
    Platform(ThreadId),
}
struct Backend {
    inner: MockVm,
    observed: mpsc::Sender<Capture>,
    gates: Vec<Mutex<mpsc::Receiver<()>>>,
    fail_cpu: bool,
    fail_platform: bool,
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
        assert_eq!(thread::current().name(), Some("vm-supervisor"));
        self.observed
            .send(Capture::Platform(thread::current().id()))
            .unwrap();
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
    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<()> {
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
        self.gate.recv_timeout(Duration::from_secs(5)).unwrap();
        if self.fail {
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
        },
        releases,
        rx,
    )
}
fn machine(backend: Backend) -> Vm<Backend> {
    Vm::with_backend(
        config(),
        || Ok(backend),
        |_, _| Ok(X86BootRegisters::default()),
        |_, _| Ok(()),
    )
    .unwrap()
}

#[test]
fn owning_threads_capture_all_cpus_before_platform_and_records_are_id_ordered() {
    let (backend, releases, observed) = backend(false, false);
    let vm = machine(backend);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let mut handle = vm.spawn().unwrap();
    handle.pause().unwrap();
    thread::scope(|scope| {
        let caller = scope.spawn(|| handle.export(&path));
        let mut owners = vec![];
        for _ in 0..3 {
            match observed.recv_timeout(Duration::from_secs(1)).unwrap() {
                Capture::Cpu(id, owner) => {
                    owners.push((id, owner));
                }
                event => panic!("platform captured too early: {event:?}"),
            }
        }
        for id in [2, 1] {
            releases[id].send(()).unwrap();
            assert!(
                matches!(observed.recv_timeout(Duration::from_secs(1)).unwrap(), Capture::Done(done) if done == id as u32)
            );
        }
        assert!(observed.recv_timeout(Duration::from_millis(20)).is_err());
        releases[0].send(()).unwrap();
        assert!(matches!(
            observed.recv_timeout(Duration::from_secs(1)).unwrap(),
            Capture::Done(0)
        ));
        let Capture::Platform(owner) = observed.recv_timeout(Duration::from_secs(1)).unwrap()
        else {
            panic!("expected platform")
        };
        assert!(owners.iter().all(|(_, cpu)| *cpu != owner));
        owners.sort_by_key(|(id, _)| *id);
        assert_eq!(
            owners.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        caller.join().unwrap().unwrap();
    });
    assert_eq!(handle.status(), VmStatus::Paused);
    let mut file = File::open(&path).unwrap();
    let header = Header::read(&mut file).unwrap();
    let state = header.read_machine(&mut file).unwrap();
    assert_eq!(
        state
            .vcpus
            .iter()
            .map(|record| (record.id, record.state.regs.rax))
            .collect::<Vec<_>>(),
        vec![(0, 0), (1, 1), (2, 2)]
    );
    assert_eq!(state.platform, platform());
    let mut bytes = fs::read(&path).unwrap();
    bytes[12..16].copy_from_slice(&4u32.to_le_bytes());
    fs::write(&path, bytes).unwrap();
    let mut file = File::open(&path).unwrap();
    let header = Header::read(&mut file).unwrap();
    assert!(header.read_machine(&mut file).is_err());
    handle.resume().unwrap();
    handle.stop();
    handle.join().unwrap();
}

#[test]
fn capture_platform_and_file_failures_leave_vm_paused_without_image() {
    for failure in 0..3 {
        let (backend, releases, _observed) = backend(failure == 0, failure == 1);
        let mut handle = machine(backend).spawn().unwrap();
        handle.pause().unwrap();
        for release in releases {
            release.send(()).unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let path = if failure == 2 {
            dir.path().join("missing/image")
        } else {
            dir.path().join("image")
        };
        assert!(handle.export(&path).is_err());
        assert_eq!(handle.status(), VmStatus::Paused);
        assert!(!path.exists());
        handle.resume().unwrap();
        handle.stop();
        handle.join().unwrap();
    }
}

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_export_of_parked_device_less_guest() {
    let vm = Vm::with_backend(
        config(),
        boxlite_hypervisor::KvmVm::new,
        |ram, _| Ok(crate::flat_guest::load(ram.memory(), &[0xeb, 0xfe])),
        |_, _| Ok(()),
    )
    .unwrap();
    let mut handle = vm.spawn().unwrap();
    handle.pause().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    handle.export(&path).unwrap();
    assert_eq!(handle.status(), VmStatus::Paused);
    let mut file = File::open(&path).unwrap();
    let header = Header::read(&mut file).unwrap();
    assert_eq!(header.read_machine(&mut file).unwrap().vcpus.len(), 3);
    handle.resume().unwrap();
    handle.stop();
    handle.join().unwrap();
}
