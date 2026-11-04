// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! VM ownership barriers with a device that performs real guest-memory writes.

#![cfg_attr(
    not(target_arch = "x86_64"),
    expect(clippy::unit_arg, reason = "arm64 has no boot registers yet.")
)]

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use vm_memory::{Bytes, GuestAddress};

use super::{BootRegisters, Call, Error, MockVm, Vm, config};
use crate::{
    irq::IrqLine,
    memory::{GuestMemoryMmap, GuestRam},
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
        VirtioDevice, WorkerControl, interrupt::MmioInterrupt,
    },
};

const WAIT: Duration = Duration::from_secs(2);
const SPEC: DeviceSpec = DeviceSpec {
    device_id: 1,
    name: "vm-memory-writer",
    features: 0,
    config_len: 0,
    queue_max: &[8],
    snapshot: SnapshotSupport::Unsupported,
};

struct MemoryWriter {
    memory: Arc<GuestMemoryMmap>,
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
    finished: Arc<AtomicBool>,
}

impl VirtioDevice for MemoryWriter {
    fn spec(&self) -> &DeviceSpec {
        &SPEC
    }
    fn set_features(&mut self, bits: u64) -> Result<(), FeatureError> {
        if bits == 0 {
            Ok(())
        } else {
            Err(FeatureError { unsupported: bits })
        }
    }
    fn read_config(&mut self, _: u64, _: &mut [u8]) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("configuration"))
    }
    fn write_config(&mut self, _: u64, _: &[u8]) -> Result<(), DeviceError> {
        Err(DeviceError::Unsupported("configuration"))
    }
    fn activate(&mut self, _: ActivationContext) -> Result<(), DeviceError> {
        Ok(())
    }
    fn reset(&mut self) -> Result<(), DeviceError> {
        Ok(())
    }
    fn on_event(&mut self, _: DeviceEvent) -> Result<(), DeviceError> {
        self.entered.send(()).unwrap();
        self.release.recv_timeout(WAIT).unwrap();
        self.memory
            .write_obj(0xa5_u8, GuestAddress(crate::memory::RAM_START + 0x1000))
            .unwrap();
        self.finished.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn with_writer(
    backend: MockVm,
    boot: impl FnOnce(&GuestRam, &crate::config::VmConfig) -> crate::Result<BootRegisters>,
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
    finished: Arc<AtomicBool>,
    kick: bool,
) -> crate::Result<(Vm<MockVm>, Arc<dyn WorkerControl>)> {
    let mut worker = None;
    let vm = Vm::with_backend(
        config(1, 16),
        || Ok(backend),
        boot,
        |_, context| {
            let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(MemoryWriter {
                memory: Arc::clone(context.memory),
                entered,
                release,
                finished,
            }));
            let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
            let control = context.workers.add(device, interrupt);
            control.prepare().unwrap();
            control.start().unwrap();
            if kick {
                control.kick(0);
            }
            worker = Some(control);
            Ok(())
        },
    )?;
    Ok((vm, worker.unwrap()))
}

#[test]
fn drop_waits_for_guest_memory_access_before_unregistering_ram() {
    let backend = MockVm::new();
    let log = backend.log();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let (vm, worker) = with_writer(
        backend,
        |_, _| Ok(BootRegisters::default()),
        entered_tx,
        release_rx,
        finished.clone(),
        false,
    )
    .unwrap();
    worker.kick(0);
    entered_rx.recv_timeout(WAIT).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let dropping = thread::spawn(move || {
        drop(vm);
        done_tx.send(()).unwrap();
    });
    assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
    assert!(
        !log.lock()
            .unwrap()
            .iter()
            .any(|call| matches!(call, Call::Unmap { .. }))
    );
    release_tx.send(()).unwrap();
    done_rx.recv_timeout(WAIT).unwrap();
    dropping.join().unwrap();
    assert!(finished.load(Ordering::SeqCst));
    assert!(
        log.lock()
            .unwrap()
            .iter()
            .any(|call| matches!(call, Call::Unmap { .. }))
    );
}

#[test]
fn failed_boot_stops_started_device_access_before_unregistering_ram() {
    let backend = MockVm::new();
    let log = backend.log();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let callback_finished = finished.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let (fail_tx, fail_rx) = mpsc::channel();
    let building = thread::spawn(move || {
        let result = with_writer(
            backend,
            |_, _| {
                // Fail only after the callback has entered its RAM access.
                fail_rx.recv_timeout(WAIT).unwrap();
                Err(Error::VirtioDevice {
                    device: "boot-test",
                    reason: "boot failed after mapping",
                })
            },
            entered_tx,
            release_rx,
            callback_finished,
            true,
        );
        done_tx.send(result.map(|_| ())).unwrap();
    });
    entered_rx.recv_timeout(WAIT).unwrap();
    fail_tx.send(()).unwrap();
    assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
    assert!(
        !log.lock()
            .unwrap()
            .iter()
            .any(|call| matches!(call, Call::Unmap { .. }))
    );
    release_tx.send(()).unwrap();
    assert!(matches!(
        done_rx.recv_timeout(WAIT).unwrap(),
        Err(Error::VirtioDevice {
            device: "boot-test",
            ..
        })
    ));
    building.join().unwrap();
    assert!(finished.load(Ordering::SeqCst));
    assert!(
        log.lock()
            .unwrap()
            .iter()
            .any(|call| matches!(call, Call::Unmap { .. }))
    );
}

#[test]
#[cfg(target_arch = "x86_64")]
fn normal_run_waits_for_device_access_after_all_vcpus_exit() {
    let backend = MockVm::with_scripts(vec![vec![crate::mock_vm::Step::Reset]]);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let (mut vm, worker) = with_writer(
        backend,
        |_, _| Ok(BootRegisters::default()),
        entered_tx,
        release_rx,
        finished.clone(),
        false,
    )
    .unwrap();
    worker.kick(0);
    entered_rx.recv_timeout(WAIT).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let running = thread::spawn(move || {
        let result = vm.run();
        done_tx.send((result, vm)).unwrap();
    });
    assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
    release_tx.send(()).unwrap();
    let (result, vm) = done_rx.recv_timeout(WAIT).unwrap();
    running.join().unwrap();
    assert_eq!(result.unwrap(), crate::VmExit::GuestReset);
    assert!(finished.load(Ordering::SeqCst));
    assert_eq!(
        vm.ram
            .memory()
            .read_obj::<u8>(GuestAddress(0x1000))
            .unwrap(),
        0xa5
    );
    assert!(worker.prepare().is_err());
}
