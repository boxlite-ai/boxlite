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
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_three_vcpu_export_destroy_restore_resume_preserves_worker_state() {
    let config = crate::VmConfig {
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
    };
    let vm = Vm::with_backend(
        config,
        boxlite_hypervisor::KvmVm::new,
        |ram, _| {
            // Only the BSP receives boot registers; APs wait for INIT/SIPI.
            // inc dword [0x8000]; jmp back, with per-worker state checked below.
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
    let resumed = dir.path().join("resumed");
    let mut handle = vm.spawn().unwrap();
    thread::sleep(Duration::from_millis(20));
    handle.pause().unwrap();
    handle.export(&source).unwrap();
    drop(handle);

    let read_machine = |path: &Path| {
        let mut file = File::open(path).unwrap();
        let header = image::Header::read(&mut file).unwrap();
        assert_eq!(header.vcpus, 3);
        let machine = header.read_machine(&mut file).unwrap();
        assert_eq!(machine.vcpus.len(), 3);
        machine
    };
    let before = read_machine(&source);
    // LAPIC IDs distinguish even the two APs that have identical reset registers.
    for i in 0..3 {
        for j in i + 1..3 {
            assert_ne!(before.vcpus[i].state.lapic, before.vcpus[j].state.lapic);
        }
    }
    assert!(counter(&source) > 0);
    let mut restored = Vm::from_state(&source).unwrap();
    assert_eq!(restored.status(), VmStatus::Paused);
    restored.export(&destination).unwrap();
    let after = read_machine(&destination);
    for (id, (before, after)) in before.vcpus.iter().zip(&after.vcpus).enumerate() {
        assert_eq!(before.id as usize, id);
        assert_eq!(after.id as usize, id);
        assert_eq!(before.state.regs, after.state.regs, "vCPU {id} registers");
        assert_eq!(before.state.sregs, after.state.sregs, "vCPU {id} sregs");
        assert_eq!(before.state.lapic, after.state.lapic, "vCPU {id} LAPIC");
        assert_eq!(before.state.cpuid, after.state.cpuid, "vCPU {id} CPUID");
        assert_eq!(before.state.mp_state, after.state.mp_state, "vCPU {id} MP");
    }
    assert_eq!(counter(&source), counter(&destination));
    restored.resume().unwrap();
    thread::sleep(Duration::from_millis(20));
    restored.pause().unwrap();
    restored.export(&resumed).unwrap();
    assert!(counter(&resumed) > counter(&source));
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

#[test]
fn invalid_machine_payloads_and_empty_ram_never_create_a_host() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let missing =
        from_path::<Backend>(&path, || panic!("created host for missing file")).unwrap_err();
    assert!(matches!(missing, Error::Snapshot(ref e) if e.kind() == io::ErrorKind::NotFound));
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    let encoded = machine().encode().unwrap();
    for payload in [&[][..], &encoded[..encoded.len() - 1]] {
        image::write(&path, 3, payload, &ram).unwrap();
        let error =
            from_path::<Backend>(&path, || panic!("created host for invalid machine")).unwrap_err();
        assert!(matches!(error, Error::Snapshot(_)));
        fs::remove_file(&path).unwrap();
    }
    image::write(&path, 3, &encoded, &ram).unwrap();
    let mut bytes = fs::read(&path).unwrap();
    bytes[16..24].copy_from_slice(&0u64.to_le_bytes());
    bytes.truncate(32 + encoded.len());
    fs::write(&path, bytes).unwrap();
    let error = from_path::<Backend>(&path, || panic!("created host for empty RAM")).unwrap_err();
    assert!(matches!(error, Error::Snapshot(ref e)
        if e.kind() == io::ErrorKind::InvalidInput && e.to_string() == "missing RAM"));
}

#[test]
fn machine_read_propagates_truncation_after_header_admission() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    write_image(&path);
    let mut file = File::open(&path).unwrap();
    let header = image::Header::read(&mut file).unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(32 + header.machine_len - 1)
        .unwrap();
    let error = header.read_machine(&mut file).unwrap_err();
    assert!(matches!(error, Error::Snapshot(ref e) if e.kind() == io::ErrorKind::UnexpectedEof));
}

#[test]
fn valid_vcpu_count_boundaries_reach_host_creation() {
    let dir = tempfile::tempdir().unwrap();
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    for count in [1, crate::config::MAX_VCPUS - 1, crate::config::MAX_VCPUS] {
        let mut state = machine();
        let cpu = state.vcpus[0].state.clone();
        state.vcpus = (0..count)
            .map(|id| VcpuRecord {
                id,
                state: cpu.clone(),
            })
            .collect();
        let path = dir.path().join(format!("image-{count}"));
        image::write(&path, count.into(), &state.encode().unwrap(), &ram).unwrap();
        let mut created = false;
        let result = from_path::<Backend>(&path, || {
            created = true;
            Err(failure())
        });
        assert!(created, "valid count {count} was rejected: {result:?}");
        assert!(result.is_err());
    }
}

#[expect(
    clippy::duplicate_mod,
    reason = "Share boot fixtures without exposing private production test modules."
)]
#[path = "../boot/initramfs.rs"]
mod linux_initramfs;

/// Read only the declared RAM payload, never the header or machine bytes.
fn linux_snapshot(path: &Path) -> (MachineState, Vec<u8>) {
    use std::io::Read;
    let mut file = File::open(path).unwrap();
    let header = image::Header::read(&mut file).unwrap();
    let machine = header.read_machine(&mut file).unwrap();
    let mut ram = vec![0; header.ram_len as usize];
    file.read_exact(&mut ram).unwrap();
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
    handle: &mut crate::VmHandle<boxlite_hypervisor::KvmVm>,
    before: &(MachineState, Vec<u8>),
    path: &Path,
    timeout: Duration,
    wait_for_init: bool,
) -> (MachineState, Vec<u8>) {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "Linux guest progress timed out (wait_for_init={wait_for_init})"
        );
        handle.resume().unwrap();
        thread::sleep(Duration::from_millis(200));
        handle.pause().unwrap();
        handle.export(path).unwrap();
        let after = linux_snapshot(path);
        fs::remove_file(path).unwrap();
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
fn lapic_comparison_ignores_stale_source_ppr() {
    let mut expected = [0i8; 1024];
    expected[0x80] = 0x10;
    expected[0xA0] = 0xE0u8 as i8;
    let mut actual = expected;
    actual[0xA0] = 0x10;
    // The real failure's only difference is the stale source PPR.
    assert_ne!(expected, actual);
    assert_eq!(lapic_differences(&expected, &actual), Ok(()));
}

#[test]
fn lapic_comparison_rejects_non_ppr_differences() {
    let mut expected = [0i8; 1024];
    expected[0x80] = 0x10;
    expected[0xA0] = 0x10;
    let mut actual = expected;
    actual[0x80] = 0x20;
    actual[0xA0] = 0x20;
    let detail = lapic_differences(&expected, &actual).unwrap_err();
    assert!(detail.contains("0x080 TPR"), "{detail}");
    assert!(detail.contains("expected 0x10, actual 0x20"), "{detail}");

    actual = expected;
    actual[0x180] = 1;
    let detail = lapic_differences(&expected, &actual).unwrap_err();
    assert!(detail.contains("0x180 TMR"), "{detail}");
    assert!(detail.contains("expected 0x00, actual 0x01"), "{detail}");
}

#[test]
fn lapic_comparison_rejects_noncanonical_restored_ppr() {
    let mut expected = [0i8; 1024];
    expected[0x80] = 0x80u8 as i8;
    expected[0xA0] = 0x80u8 as i8;
    let mut actual = expected;
    actual[0xA0] = 0x10;
    let detail = lapic_differences(&expected, &actual).unwrap_err();
    assert!(detail.contains("0xA0 PPR"), "{detail}");
    assert!(
        detail.contains("expected canonical 0x80, actual 0x10"),
        "{detail}"
    );
}

#[test]
fn lapic_comparison_preserves_tpr_subpriority() {
    let mut expected = [0i8; 1024];
    expected[0x80] = 0x1F;
    expected[0xA0] = 0x1F;
    let mut actual = expected;
    assert_eq!(lapic_differences(&expected, &actual), Ok(()));
    actual[0xA0] = 0x10;
    let detail = lapic_differences(&expected, &actual).unwrap_err();
    assert!(detail.contains("0xA0 PPR"), "{detail}");
    assert!(
        detail.contains("expected canonical 0x1f, actual 0x10"),
        "{detail}"
    );

    // TPR also keeps its subpriority when its class equals ISRV's class.
    expected[0x103] = 0x80u8 as i8; // Vector 31.
    actual = expected;
    assert_eq!(lapic_differences(&expected, &actual), Ok(()));
}

#[test]
fn lapic_comparison_uses_highest_in_service_vector() {
    let mut expected = [0i8; 1024];
    expected[0x80] = 0x10;
    expected[0x100] = 1; // Vector 0.
    expected[0x173] = 0x80u8 as i8; // Vector 255.
    expected[0xA0] = 0xF0u8 as i8;
    let mut actual = expected;
    assert_eq!(lapic_differences(&expected, &actual), Ok(()));
    actual[0xA0] = 0x10;
    let detail = lapic_differences(&expected, &actual).unwrap_err();
    assert!(detail.contains("0xA0 PPR"), "{detail}");
    assert!(
        detail.contains("expected canonical 0xf0, actual 0x10"),
        "{detail}"
    );
}

#[test]
fn lapic_comparison_ignores_reserved_bytes_for_isrv() {
    let mut expected = [0i8; 1024];
    expected[0x80] = 0x10;
    expected[0xA0] = 0x10;
    expected[0x11F] = 0x80u8 as i8; // Reserved, not an ISR vector.
    assert_eq!(lapic_differences(&expected, &expected), Ok(()));
}

#[test]
fn lapic_comparison_reads_isr_slots_at_16_byte_intervals() {
    for (offset, ppr) in [(0x110, 0x20), (0x170, 0xE0u8 as i8)] {
        let mut expected = [0i8; 1024];
        expected[0x80] = 0x10;
        expected[offset] = 1; // Vectors 32 and 224, respectively.
        expected[0xA0] = ppr;
        assert_eq!(lapic_differences(&expected, &expected), Ok(()));
    }
}

#[test]
fn lapic_comparison_ignores_current_count_but_checks_timer_configuration() {
    let expected = [0i8; 1024];
    // Exercise every byte, including the low byte at 0x390 and high byte at 0x393.
    for offset in APIC_TMCCT {
        let mut actual = expected;
        actual[offset] = 1;
        assert_ne!(expected, actual);
        assert_eq!(lapic_differences(&expected, &actual), Ok(()));
        assert_eq!(lapic_differences(&actual, &expected), Ok(()));
    }
    for (offset, register) in [
        (0x380, "initial count"),
        (0x320, "LVT timer"),
        (0x394, "LAPIC"), // Reserved bytes in the same slot remain compared.
    ] {
        let mut actual = expected;
        actual[offset] = 1;
        let detail = lapic_differences(&expected, &actual).unwrap_err();
        assert!(
            detail.contains(&format!("{offset:#05x} {register}")),
            "{detail}"
        );
    }
}

#[test]
fn lapic_timer_state_changed_ignores_current_count_only() {
    let before = [0i8; 1024];
    assert!(!lapic_timer_state_changed(&before, &before));
    for offset in APIC_TMCCT {
        let mut after = before;
        after[offset] = 1;
        assert!(!lapic_timer_state_changed(&before, &after));
        assert!(!lapic_timer_state_changed(&after, &before));
    }
    // LVT timer, initial count, ISR, PPR and slot padding remain compared.
    for offset in [0x320, 0x380, 0x100, 0xA0, 0x394] {
        let mut after = before;
        after[offset] = 1;
        assert!(lapic_timer_state_changed(&before, &after));
        assert!(lapic_timer_state_changed(&after, &before));
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
    let vm = Vm::new_device_less(crate::VmConfig {
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
    })
    .unwrap();
    let scratch = dir.path().join("scratch");
    let source = dir.path().join("source");
    let mut handle = vm.spawn().unwrap();
    handle.pause().unwrap();
    handle.export(&scratch).unwrap();
    let initial = linux_snapshot(&scratch);
    fs::remove_file(&scratch).unwrap();
    let ready = linux_wait_for_progress(
        &mut handle,
        &initial,
        &scratch,
        Duration::from_secs(30),
        true,
    );
    drop(initial);
    // Require a second interval after Linux announces /init, not just boot writes.
    let before =
        linux_wait_for_progress(&mut handle, &ready, &scratch, Duration::from_secs(5), false);
    drop(ready);
    handle.export(&source).unwrap();
    let still = linux_snapshot(&source);
    assert!(before.1 == still.1, "RAM must be stable while Paused");
    assert!(
        !linux_timer_changed(&before.0, &still.0),
        "timer configuration changed without guest entry"
    );
    drop(still);
    drop(handle);

    let mut restored = Vm::from_state(&source).unwrap();
    assert_eq!(restored.status(), VmStatus::Paused);
    restored.export(&scratch).unwrap();
    let installed = linux_snapshot(&scratch);
    fs::remove_file(&scratch).unwrap();
    // Installing KVM's wall-clock MSR can update its shared RAM page without
    // guest entry. Compare resumed RAM to this installed baseline as well as A.
    assert_eq!(
        before.0.vcpus[0].state.regs,
        installed.0.vcpus[0].state.regs
    );
    let lapic = lapic_differences(
        &before.0.vcpus[0].state.lapic.regs,
        &installed.0.vcpus[0].state.lapic.regs,
    );
    assert!(lapic.is_ok(), "restored LAPIC: {}", lapic.unwrap_err());
    assert_eq!(before.0.platform.irqchips, installed.0.platform.irqchips);
    let after = linux_wait_for_progress(
        &mut restored,
        &installed,
        &scratch,
        Duration::from_secs(5),
        false,
    );
    assert!(before.1 != after.1);
    assert!(linux_timer_changed(&before.0, &after.0));
}

// The reader stops at the first RAM byte, independently of RAM size or timing.
struct RamGuard {
    file: File,
    ram_start: u64,
}
impl io::Read for RamGuard {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let position = std::io::Seek::stream_position(&mut self.file)?;
        assert!(position < self.ram_start, "RAM read before vCPU admission");
        let len = bytes.len().min((self.ram_start - position) as usize);
        io::Read::read(&mut self.file, &mut bytes[..len])
    }
}

fn reject_before_ram(count: u32, payload: &[u8], reason: &str) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    image::write(&path, count, payload, &ram).unwrap();
    let mut reader = RamGuard {
        file: File::open(&path).unwrap(),
        ram_start: 32 + payload.len() as u64,
    };
    let len = reader.file.metadata().unwrap().len();
    let error = from_reader::<Backend, _>(
        &mut reader,
        len,
        false,
        |_| -> Result<fn() -> boxlite_hypervisor::Result<Backend>> {
            panic!("host prepared before vCPU admission")
        },
    )
    .expect_err("invalid vCPU structure admitted");
    assert!(
        matches!(error, Error::Snapshot(ref e)
        if e.kind() == io::ErrorKind::InvalidInput && e.to_string() == reason),
        "unexpected admission error: {error:?}"
    );
    let position = std::io::Seek::stream_position(&mut reader.file).unwrap();
    assert!(position >= 32 && position <= reader.ram_start);
    if count == 0 || count > u32::from(crate::config::MAX_VCPUS) {
        assert_eq!(position, 32, "invalid header must not read byte 33");
    } else {
        assert!(position > 32, "machine admission must read past the header");
    }
}

#[test]
fn zero_vcpus_are_rejected_before_ram() {
    let mut state = machine();
    state.vcpus.clear();
    reject_before_ram(0, &state.encode().unwrap(), "vCPU count must be in 1..=64");
}

#[test]
fn excessive_vcpus_are_rejected_before_ram() {
    let mut state = machine();
    let cpu = state.vcpus[0].state.clone();
    state.vcpus = (0..65)
        .map(|id| VcpuRecord {
            id,
            state: cpu.clone(),
        })
        .collect();
    reject_before_ram(65, &state.encode().unwrap(), "vCPU count must be in 1..=64");
}

#[test]
fn forged_outer_list_length_is_rejected_before_decoding_records_or_ram() {
    // Postcard's first field is the sequence length. There are deliberately no
    // records: admission must reject the length, not attempt to decode one.
    for count in [0usize, 65, usize::MAX] {
        let payload = postcard::to_allocvec(&count).unwrap();
        reject_before_ram(1, &payload, "vCPU count must be in 1..=64");
    }
}

#[test]
fn duplicate_ids_are_rejected_before_ram() {
    let mut state = machine();
    state.vcpus[1].id = 0;
    reject_before_ram(
        3,
        &state.encode().unwrap(),
        "vCPU records must be contiguous and ordered by id",
    );
}

#[test]
fn unordered_ids_are_rejected_before_ram() {
    let mut state = machine();
    state.vcpus.swap(0, 1);
    reject_before_ram(
        3,
        &state.encode().unwrap(),
        "vCPU records must be contiguous and ordered by id",
    );
}
