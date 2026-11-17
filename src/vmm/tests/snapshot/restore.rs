// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs, io,
    marker::PhantomData,
    rc::Rc,
    sync::{Arc, Mutex, mpsc},
    thread::{self, ThreadId},
    time::Duration,
};

use boxlite_hypervisor::{
    MemoryRegion, Vcpu, VcpuExit, X86BootRegisters, X86IrqchipState, X86Vcpu, X86VcpuState, X86Vm,
    X86VmState,
};
use vm_memory::{Bytes, GuestAddress};

use super::*;
use crate::{
    VmStatus,
    mock_vm::{Call, MockHandle, MockVcpu, MockVm},
    snapshot::{
        image,
        state::{MachineState, VcpuRecord},
    },
};

fn machine() -> MachineState {
    MachineState {
        platform: X86VmState {
            irqchips: [
                X86IrqchipState::pic(0, Default::default()),
                X86IrqchipState::pic(1, Default::default()),
                X86IrqchipState::ioapic(Default::default()),
            ],
            pit: None,
            clock: Default::default(),
        },
        vcpus: (0..3)
            .map(|id| {
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
                state.regs.rax = u64::from(id) + 42;
                VcpuRecord { id, state }
            })
            .collect(),
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Failure {
    None,
    Map,
    Platform,
    CreateCpu,
    Cpu,
    CpuPanic,
    PlatformPanic,
    Park,
}
#[derive(Debug)]
enum Install {
    Platform(ThreadId),
    Cpu(u32, ThreadId),
}
struct Backend {
    inner: MockVm,
    failure: Failure,
    installs: mpsc::Sender<Install>,
    gates: Vec<Mutex<mpsc::Receiver<()>>>,
}
struct Cpu {
    inner: MockVcpu,
    id: u32,
    owner: ThreadId,
    failure: Failure,
    installs: mpsc::Sender<Install>,
    gate: mpsc::Receiver<()>,
    local: PhantomData<Rc<()>>,
}
fn failure() -> boxlite_hypervisor::Error {
    boxlite_hypervisor::Error::CreateVm(io::Error::other("injected restore failure"))
}
impl boxlite_hypervisor::Vm for Backend {
    type Vcpu = Cpu;
    unsafe fn map_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        if self.failure == Failure::Map {
            return Err(failure());
        }
        // SAFETY: forwards the unchanged mapping and lifetime contract.
        unsafe { self.inner.map_memory(region) }
    }
    fn unmap_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        self.inner.unmap_memory(region)
    }
    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
        self.inner.set_irq_line(line, level)
    }
    fn create_vcpu(&self, id: u32) -> boxlite_hypervisor::Result<Cpu> {
        if self.failure == Failure::CreateCpu && id == 1 {
            return Err(failure());
        }
        let (_, empty) = mpsc::channel();
        let gate = std::mem::replace(&mut *self.gates[id as usize].lock().unwrap(), empty);
        Ok(Cpu {
            inner: self.inner.create_vcpu(id)?,
            id,
            owner: thread::current().id(),
            failure: self.failure,
            installs: self.installs.clone(),
            gate,
            local: PhantomData,
        })
    }
}
impl X86Vm for Backend {
    fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
        panic!("boot CPUID read")
    }
    fn restore_state(&self, state: &X86VmState) -> boxlite_hypervisor::Result<()> {
        assert_eq!(thread::current().name(), Some("vm-supervisor"));
        assert_eq!(state, &machine().platform);
        self.installs
            .send(Install::Platform(thread::current().id()))
            .unwrap();
        if self.failure == Failure::Platform {
            return Err(failure());
        }
        assert_ne!(
            self.failure,
            Failure::PlatformPanic,
            "injected platform panic"
        );
        Ok(())
    }
}
impl Vcpu for Cpu {
    type Handle = MockHandle;
    fn run(&mut self) -> boxlite_hypervisor::Result<VcpuExit<'_>> {
        self.inner.run()
    }
    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<()> {
        if self.failure == Failure::Park && self.id == 1 {
            return Err(failure());
        }
        self.inner.complete_pending_io()
    }
    fn handle(&self) -> MockHandle {
        self.inner.handle()
    }
}
impl X86Vcpu for Cpu {
    fn set_cpu_features(
        &mut self,
        _: &[boxlite_hypervisor::X86CpuidEntry],
        _: &[boxlite_hypervisor::X86Msr],
    ) -> boxlite_hypervisor::Result<()> {
        panic!("boot CPUID/MSRs installed")
    }
    fn set_boot_registers(&mut self, _: &X86BootRegisters) -> boxlite_hypervisor::Result<()> {
        panic!("boot registers installed")
    }
    fn restore_state(&mut self, state: &X86VcpuState) -> boxlite_hypervisor::Result<()> {
        assert_eq!(thread::current().id(), self.owner);
        assert_eq!(state.regs.rax, u64::from(self.id) + 42);
        self.installs
            .send(Install::Cpu(self.id, self.owner))
            .unwrap();
        self.gate.recv_timeout(Duration::from_secs(5)).unwrap();
        if self.id == 1 {
            if self.failure == Failure::Cpu {
                return Err(failure());
            }
            assert_ne!(self.failure, Failure::CpuPanic, "injected CPU panic");
        }
        Ok(())
    }
}
fn backend(failure: Failure) -> (Backend, Vec<mpsc::Sender<()>>, mpsc::Receiver<Install>) {
    let (installs, observed) = mpsc::channel();
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
            failure,
            installs,
            gates,
        },
        releases,
        observed,
    )
}
fn write_image(path: &Path) {
    let ram = GuestRam::new(&[(GuestAddress(0), (1 << 20) + 4096)]).unwrap();
    ram.memory()
        .write_slice(b"restored RAM", GuestAddress(1 << 20))
        .unwrap();
    image::write(path, 3, &machine().encode().unwrap(), &ram).unwrap();
}

#[test]
fn restore_installs_platform_then_owning_cpus_and_returns_paused_without_entry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    write_image(&path);
    let (backend, releases, observed) = backend(Failure::None);
    let entries = backend.inner.entries();
    let log = backend.inner.log();
    let (ready, result) = mpsc::channel();
    let caller = thread::spawn(move || {
        ready.send(from_path(&path, || Ok(backend))).unwrap();
    });
    let Install::Platform(supervisor) = observed.recv_timeout(Duration::from_secs(1)).unwrap()
    else {
        panic!("platform must install before any CPU")
    };
    let mut ids = vec![];
    for _ in 0..3 {
        let Install::Cpu(id, owner) = observed.recv_timeout(Duration::from_secs(1)).unwrap() else {
            panic!("expected CPU installation")
        };
        assert_ne!(owner, supervisor);
        ids.push(id);
    }
    ids.sort();
    assert_eq!(ids, vec![0, 1, 2]);
    assert!(
        result.try_recv().is_err(),
        "must wait for every CPU installation"
    );
    assert!(entries.lock().unwrap().is_empty());
    for release in releases {
        release.send(()).unwrap();
    }
    let mut handle = result
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    caller.join().unwrap();
    assert_eq!(handle.status(), VmStatus::Paused);
    assert!(entries.lock().unwrap().is_empty());
    assert!(!log.lock().unwrap().iter().any(|call| matches!(
        call,
        Call::SetCpuFeatures { .. } | Call::SetBootRegisters { .. }
    )));
    handle.resume().unwrap();
    handle.stop();
    handle.join().unwrap();
    let calls = log.lock().unwrap();
    assert!(matches!(calls.last(), Some(Call::Unmap { .. })));
    assert_eq!(
        calls
            .iter()
            .filter(|call| matches!(call, Call::DropVcpu { .. }))
            .count(),
        3
    );
}

#[test]
fn every_install_failure_joins_workers_and_releases_ram_before_returning_error() {
    for stage in [
        Failure::Map,
        Failure::Platform,
        Failure::CreateCpu,
        Failure::Cpu,
        Failure::CpuPanic,
        Failure::PlatformPanic,
        Failure::Park,
    ] {
        let (backend, releases, _observed) = backend(stage);
        let log = backend.inner.log();
        let entries = backend.inner.entries();
        for release in releases {
            release.send(()).unwrap();
        }
        let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
        let backing = Arc::downgrade(ram.memory());
        assert!(
            from_ram(ram, machine(), || Ok(backend)).is_err(),
            "{stage:?}"
        );
        assert!(backing.upgrade().is_none(), "RAM leaked at {stage:?}");
        assert!(entries.lock().unwrap().is_empty(), "entered at {stage:?}");
        let calls = log.lock().unwrap();
        let expected = match stage {
            Failure::Map | Failure::Platform | Failure::PlatformPanic => 0,
            Failure::CreateCpu => 2,
            _ => 3,
        };
        assert_eq!(
            calls
                .iter()
                .filter(|call| matches!(call, Call::DropVcpu { .. }))
                .count(),
            expected,
            "{stage:?}"
        );
        if stage != Failure::Map {
            assert!(
                matches!(calls.last(), Some(Call::Unmap { .. })),
                "{stage:?}"
            );
        }
    }
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    let backing = Arc::downgrade(ram.memory());
    assert!(from_ram::<Backend>(ram, machine(), || Err(failure())).is_err());
    assert!(backing.upgrade().is_none());
}

#[test]
fn malformed_images_are_refused_before_creating_a_host_vm() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    write_image(&path);
    let original = fs::read(&path).unwrap();
    for case in 0..6 {
        let mut bytes = original.clone();
        match case {
            0 => bytes[0] = b'?',
            1 => bytes[8] = 2,
            2 => bytes.truncate(17),
            3 => {
                bytes.pop();
            }
            4 => bytes[12..16].copy_from_slice(&4u32.to_le_bytes()),
            5 => bytes[24..32].copy_from_slice(&u64::MAX.to_le_bytes()),
            _ => unreachable!(),
        }
        fs::write(&path, bytes).unwrap();
        assert!(
            from_path::<Backend>(&path, || panic!("host VM created for bad image {case}")).is_err()
        );
    }
}

#[test]
fn invalid_ram_lengths_are_refused_before_creating_a_host_vm() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    write_image(&path);
    let original = fs::read(&path).unwrap();
    for (ram_len, reason) in [
        (0, "missing RAM"),
        (4095, "guest RAM size is not page-aligned"),
        (u64::MAX, "image lengths exceed file bounds"),
    ] {
        let mut bytes = original.clone();
        bytes[16..24].copy_from_slice(&ram_len.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        let error = from_path::<Backend>(&path, || panic!("host VM created for RAM size {ram_len}"))
            .expect_err("invalid RAM length accepted");
        assert!(
            matches!(error, Error::Snapshot(ref e)
                if e.kind() == io::ErrorKind::InvalidInput && e.to_string() == reason),
            "RAM size {ram_len}: {error:?}"
        );
    }
}

#[test]
fn header_admits_ram_above_four_gib() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    write_image(&path);
    let ram_len = (4u64 << 30) + 4096;
    let mut bytes = fs::read(&path).unwrap();
    let machine_len = u64::from_le_bytes(bytes[24..32].try_into().unwrap());
    bytes[16..24].copy_from_slice(&ram_len.to_le_bytes());
    fs::write(&path, bytes).unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(32 + machine_len + ram_len)
        .unwrap();
    let header = image::Header::read(&mut File::open(&path).unwrap()).unwrap();
    assert_eq!(header.ram_len, ram_len);
}

#[test]
fn maximum_vcpu_serialization_fits_machine_state_length_limit() {
    let mut machine = machine();
    machine.vcpus.truncate(1);
    let state = &mut machine.vcpus[0].state;
    state.xsave = vec![u32::MAX; 65536];
    state.cpuid = vec![Default::default(); 256];
    state.msrs = vec![Default::default(); 4096];
    state.tsc_khz = u32::MAX;
    machine.platform.pit = Some(Default::default());
    let single_len = machine.encode().unwrap().len() as u64;
    machine.vcpus.clear();
    let platform_len = machine.encode().unwrap().len() as u64;
    // These are X86VcpuState's decode ceilings. KVM/FPU byte-blob lengths do
    // not depend on field values; u32::MAX maximizes XSAVE/TSC varints.
    // Records serialize independently. Multiplying the entire one-record image
    // overcounts platform/framing, conservatively covering MAX_VCPUS without
    // constructing that many records; the extra empty image covers outer framing.
    let projected = single_len * u64::from(crate::config::MAX_VCPUS) + platform_len;
    assert!(
        projected <= image::MAX_MACHINE_STATE_LEN,
        "maximum machine state needs {projected} bytes, limit is {}",
        image::MAX_MACHINE_STATE_LEN
    );
}

#[test]
fn noncontiguous_vcpu_records_are_refused_before_creating_a_host_vm() {
    let dir = tempfile::tempdir().unwrap();
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    for ids in [[1, 0, 2], [0, 0, 2], [0, 2, 2]] {
        let path = dir.path().join(format!("image-{ids:?}"));
        let mut machine = machine();
        let records = std::mem::take(&mut machine.vcpus);
        machine.vcpus = ids
            .into_iter()
            .map(|id| VcpuRecord {
                id,
                state: records[usize::from(id)].state.clone(),
            })
            .collect();
        image::write(&path, 3, &machine.encode().unwrap(), &ram).unwrap();
        let error = from_path::<Backend>(&path, || {
            panic!("host VM created for noncontiguous vCPU records {ids:?}")
        })
        .expect_err("noncontiguous vCPU records accepted");
        assert!(matches!(error, Error::Snapshot(ref e)
            if e.kind() == io::ErrorKind::InvalidInput
                && e.to_string() == "vCPU records must be contiguous and ordered by id"));
    }
}

#[test]
fn out_of_range_vcpu_counts_are_refused_before_creating_a_host_vm() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let dir = tempfile::tempdir().unwrap();
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    let creates = AtomicUsize::new(0);
    for count in [0, 65, 256, 257] {
        let path = dir.path().join(format!("image-{count}"));
        let mut machine = machine();
        let state = machine.vcpus[0].state.clone();
        machine.vcpus.resize_with(count, || VcpuRecord {
            id: 0,
            state: state.clone(),
        });
        image::write(&path, count as u32, &machine.encode().unwrap(), &ram).unwrap();
        let error = from_path::<Backend>(&path, || {
            creates.fetch_add(1, Ordering::SeqCst);
            Err(failure())
        })
        .expect_err("invalid vCPU count accepted");
        assert_eq!(creates.load(Ordering::SeqCst), 0, "count {count}");
        assert!(matches!(error, Error::Snapshot(ref e) if e.kind() == io::ErrorKind::InvalidInput));
    }
}

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_export_destroy_restore_resume_continues_counter() {
    let config = crate::VmConfig {
        vcpu_count: 1,
        memory_mib: 1,
        kernel: "unused".into(),
        cmdline: String::new(),
        initramfs: None,
        disks: vec![],
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
    };
    let vm = Vm::with_backend(
        config,
        boxlite_hypervisor::KvmVm::new,
        |ram, _| {
            // inc dword [0x8000]; jmp back. The flat guest uses identity addressing.
            Ok(crate::flat_guest::load(
                ram.memory(),
                &[0xff, 0x05, 0x00, 0x80, 0x00, 0x00, 0xeb, 0xf8],
            ))
        },
        |_, _| Ok(()),
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let destination = dir.path().join("destination");
    let mut handle = vm.spawn().unwrap();
    thread::sleep(Duration::from_millis(20));
    handle.pause().unwrap();
    handle.export(&source).unwrap();
    drop(handle);
    let mut restored = Vm::from_state(&source).unwrap();
    assert_eq!(restored.status(), VmStatus::Paused);
    restored.export(&destination).unwrap();
    assert_eq!(counter(&source), counter(&destination));
    restored.resume().unwrap();
    thread::sleep(Duration::from_millis(20));
    restored.pause().unwrap();
    fs::remove_file(&destination).unwrap();
    restored.export(&destination).unwrap();
    assert!(counter(&destination) > counter(&source));
    drop(restored);
}
fn counter(path: &Path) -> u32 {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = File::open(path).unwrap();
    let header = image::Header::read(&mut file).unwrap();
    file.seek(SeekFrom::Start(32 + header.machine_len + 0x8000))
        .unwrap();
    let mut bytes = [0; 4];
    file.read_exact(&mut bytes).unwrap();
    u32::from_le_bytes(bytes)
}
