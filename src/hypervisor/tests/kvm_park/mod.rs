// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `ParkedKvmVcpu` on real KVM. A boot vCPU sends INIT and SIPI to APIC 1. SIPI vector 1 starts the
//! second vCPU at 0x1000, which reports 0xAA; vector 2 starts it at
//! 0x2000, which reports 0xBB. Both stubs then halt with interrupts off,
//! as an offlined Linux CPU does.

use std::{
    ptr::NonNull,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use kvm_bindings::{kvm_regs, kvm_segment};

use super::*;
use crate::{KvmVm, MemoryRegion, VcpuExit, VcpuHandle, X86ParkVcpu};

const RAM: usize = 0x10000;
const REPORT_PORT: u16 = 0xe9;
const DONE_PORT: u8 = 0x10;

struct Ram(NonNull<u8>);

impl Ram {
    fn new() -> Self {
        // SAFETY: anonymous mmap owns RAM writable bytes, released in Drop.
        let pointer = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                RAM,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                -1,
                0,
            )
        };
        assert_ne!(pointer, libc::MAP_FAILED);
        Self(NonNull::new(pointer.cast()).unwrap())
    }

    fn write(&self, at: usize, bytes: &[u8]) {
        assert!(at + bytes.len() <= RAM);
        // SAFETY: in bounds, and written before any vCPU runs.
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.0.as_ptr().add(at), bytes.len())
        };
    }
}

impl Drop for Ram {
    fn drop(&mut self) {
        // SAFETY: each test drops its VM and vCPUs before this backing.
        unsafe { libc::munmap(self.0.as_ptr().cast(), RAM) };
    }
}

/// `mov dword [addr], value`.
fn store(code: &mut Vec<u8>, addr: u32, value: u32) {
    code.extend([0xc7, 0x05]);
    code.extend(addr.to_le_bytes());
    code.extend(value.to_le_bytes());
}

/// Flat 32-bit code that sends INIT, then SIPI with `vector`, to APIC 1.
fn send_init_sipi(vector: u8) -> Vec<u8> {
    let mut code = Vec::new();
    store(&mut code, 0xfee0_00f0, 0x1ff); // spurious vector: APIC enabled
    for low in [0x4500, 0x4600 | u32::from(vector)] {
        store(&mut code, 0xfee0_0310, 1 << 24); // destination APIC 1
        store(&mut code, 0xfee0_0300, low); // INIT, then SIPI
    }
    code.extend([0xe6, DONE_PORT, 0xf4]); // out DONE_PORT, al; hlt
    code
}

/// Real-mode stub: report `tag`, then halt with interrupts off.
fn ap_stub(tag: u8) -> [u8; 8] {
    [0xb0, tag, 0xe6, REPORT_PORT as u8, 0xfa, 0xf4, 0xeb, 0xfd]
}

/// The VM, its RAM and a boot vCPU on its own thread. Threads inherit
/// their creator's signal mask, so the boot vCPU's kick reservation must
/// not live on the thread that spawns the second vCPU's workers.
struct Machine {
    vm: Arc<KvmVm>,
    vectors: Option<mpsc::Sender<u8>>,
    sent: mpsc::Receiver<()>,
    bsp: Option<thread::JoinHandle<()>>,
    _ram: Ram,
}

impl Machine {
    fn new() -> Self {
        let ram = Ram::new();
        ram.write(0x1000, &ap_stub(0xaa));
        ram.write(0x2000, &ap_stub(0xbb));
        ram.write(0x8000, &send_init_sipi(1));
        ram.write(0x8100, &send_init_sipi(2));
        let vm = Arc::new(KvmVm::new().unwrap());
        let region = MemoryRegion {
            guest_addr: 0,
            host_addr: ram.0,
            size: RAM,
        };
        // SAFETY: ram outlives vm and every vCPU; Drop joins the boot
        // vCPU's thread before the fields drop.
        unsafe { vm.map_memory(&region) }.unwrap();
        let (vectors, requests) = mpsc::channel();
        let (done, sent) = mpsc::channel();
        let bsp = {
            let vm = vm.clone();
            thread::spawn(move || boot_cpu(&vm, &requests, &done))
        };
        Self {
            vm,
            vectors: Some(vectors),
            sent,
            bsp: Some(bsp),
            _ram: ram,
        }
    }

    /// Has the boot vCPU send INIT and SIPI with `vector`.
    fn send(&mut self, vector: u8) {
        self.vectors.as_ref().unwrap().send(vector).unwrap();
        self.sent.recv().unwrap();
    }

    /// Creates vCPU 1 on its own thread and parks it before it runs.
    fn park_new_ap(&self) -> ParkedKvmVcpu {
        let vm = &*self.vm;
        thread::scope(|scope| {
            scope
                .spawn(|| vm.create_vcpu(1).unwrap().park().unwrap())
                .join()
                .unwrap()
        })
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        self.vectors = None;
        if let Some(bsp) = self.bsp.take() {
            let _ = bsp.join();
        }
    }
}

/// Runs vCPU 0 in flat 32-bit mode; each vector received runs its
/// INIT and SIPI routine until the routine reports completion.
fn boot_cpu(vm: &KvmVm, vectors: &mpsc::Receiver<u8>, sent: &mpsc::Sender<()>) {
    let mut bsp = vm.create_vcpu(0).unwrap();
    bsp.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
    let mut sregs = bsp.fd.get_sregs().unwrap();
    let code = kvm_segment {
        limit: 0xffff_ffff,
        selector: 8,
        type_: 0xb,
        present: 1,
        db: 1,
        s: 1,
        g: 1,
        ..Default::default()
    };
    let data = kvm_segment {
        selector: 0x10,
        type_: 3,
        ..code
    };
    (sregs.cs, sregs.ds, sregs.es, sregs.ss) = (code, data, data, data);
    sregs.cr0 |= 1;
    bsp.fd.set_sregs(&sregs).unwrap();
    for vector in vectors {
        let rip = if vector == 1 { 0x8000 } else { 0x8100 };
        bsp.fd
            .set_regs(&kvm_regs {
                rip,
                rflags: 2,
                ..Default::default()
            })
            .unwrap();
        loop {
            match bsp.run().unwrap() {
                VcpuExit::IoOut { port, .. } if port == u16::from(DONE_PORT) => break,
                VcpuExit::Interrupted => {}
                exit => panic!("unexpected boot vCPU exit: {exit:?}"),
            }
        }
        sent.send(()).unwrap();
    }
}

/// Resumes `ap` on a fresh thread for up to 300 ms and parks it again.
/// Returns the tag it reported, or `None` if it ran no guest code.
fn run_ap(ap: ParkedKvmVcpu) -> (Option<u8>, ParkedKvmVcpu) {
    let stop = Arc::new(AtomicBool::new(false));
    let (handles, handle) = mpsc::channel();
    let worker = {
        let stop = stop.clone();
        thread::spawn(move || {
            let mut vcpu = ap.resume().unwrap();
            handles.send(vcpu.handle()).unwrap();
            let tag = loop {
                if stop.load(Ordering::SeqCst) {
                    break None;
                }
                match vcpu.run().unwrap() {
                    VcpuExit::Interrupted => {}
                    VcpuExit::IoOut { port, bytes } if port == REPORT_PORT => {
                        break Some(bytes[0]);
                    }
                    exit => panic!("unexpected AP exit: {exit:?}"),
                }
            };
            (tag, vcpu.park().unwrap())
        })
    };
    let handle = handle.recv().unwrap();
    thread::sleep(Duration::from_millis(300));
    stop.store(true, Ordering::SeqCst);
    handle.kick().unwrap();
    worker.join().unwrap()
}

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_parked_vcpu_runs_a_stale_sipi_unless_reset() {
    let mut machine = Machine::new();
    let ap = machine.park_new_ap();
    machine.send(1);
    let (tag, _) = run_ap(ap);
    assert_eq!(
        tag,
        Some(0xaa),
        "KVM latches INIT and SIPI for a parked vCPU"
    );

    let mut machine = Machine::new();
    let mut ap = machine.park_new_ap();
    machine.send(1);
    ap.reset().unwrap();
    let (tag, ap) = run_ap(ap);
    assert_eq!(tag, None, "reset drops the stale INIT and SIPI");
    machine.send(2);
    assert_eq!(
        run_ap(ap).0,
        Some(0xbb),
        "a fresh INIT and SIPI still boot it"
    );
}

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn an_offlined_vcpu_parks_halted_and_boots_again_after_reset() {
    let mut machine = Machine::new();
    let mut ap = machine.park_new_ap();
    for round in 0..3 {
        machine.send(2);
        let (tag, parked) = run_ap(ap);
        assert_eq!(tag, Some(0xbb), "round {round}: SIPI boots the vCPU");
        // The stub halts with interrupts off; this run waits in KVM until kicked.
        let (tag, parked) = run_ap(parked);
        assert_eq!(tag, None);
        assert!(
            parked.is_halted().unwrap(),
            "round {round}: offlined vCPU is halted"
        );
        ap = parked;
        machine.send(1);
        ap.reset().unwrap();
        let (tag, parked) = run_ap(ap);
        assert_eq!(
            tag, None,
            "round {round}: a stale SIPI after parking runs nothing"
        );
        ap = parked;
    }
}
