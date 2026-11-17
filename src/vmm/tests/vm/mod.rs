// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `Vm` construction: validation before any host call, RAM registration on
//! the mock backend, and real KVM VMs whose guests read the mapped RAM and run
//! 64-bit code with the boot CPU state.

use std::{
    cell::Cell,
    error::Error as _,
    fmt::{self, Write as _},
    io,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use boxlite_hypervisor::{Error as HypervisorError, MemoryRegion, Vm as HostVm};
use tracing::{Event, Level, Metadata, Subscriber, field::Field, span};
use vm_memory::{GuestAddress, GuestMemoryBackend};

use super::{BootRegisters, Vm};
use crate::{
    bus::BusDevice,
    chipset::ChipsetBuilder,
    config::VmConfig,
    error::Error,
    irq::IrqLine,
    memory::{GuestMemoryMmap, GuestRam, RAM_START, ram_ranges},
    mock_vm::{Call, MockVm},
    virtio::{
        DeviceContext, DeviceError, VirtioDevice, VirtioInterrupt, WorkerContext,
        worker::{ShutdownError, SlotId, VirtioWorkers, WorkerRuntime},
    },
};

/// A VM on `host_vm` with no boot data and no devices.
#[cfg_attr(
    not(target_arch = "x86_64"),
    expect(clippy::unit_arg, reason = "arm64 has no boot registers yet.")
)]
fn bare<H: boxlite_hypervisor::Vm + 'static>(
    config: VmConfig,
    host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
) -> crate::error::Result<Vm<H>> {
    Vm::with_backend(
        config,
        host_vm,
        |_, _| Ok(BootRegisters::default()),
        |_, _| Ok(()),
    )
}

fn config(vcpu_count: u8, memory_mib: u32) -> VmConfig {
    VmConfig {
        vcpu_count,
        memory_mib,
        kernel: "vmlinux".into(),
        cmdline: "console=ttyS0".into(),
        initramfs: None,
        disks: Vec::new(),
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
    }
}

#[test]
fn invalid_configuration_fails_before_the_host_vm_exists() {
    let cases = [
        (config(0, 1), "invalid vCPU count: 0"),
        (config(65, 1), "invalid vCPU count: 65"),
        (config(1, 0), "invalid memory size: 0 MiB"),
    ];
    for (config, message) in cases {
        let built = Cell::new(false);
        let error = bare(config.clone(), || {
            built.set(true);
            Ok(MockVm::new())
        })
        .expect_err("invalid configuration");

        assert_eq!(error.to_string(), message);
        assert!(matches!(
            error,
            Error::InvalidVcpuCount(_) | Error::InvalidMemorySize(_)
        ));
        assert!(error.source().is_none());
        assert!(!built.get(), "the host VM must not exist for {config:?}");
    }
}

#[test]
fn maps_the_ram_layout_with_its_host_address_and_unmaps_on_drop() {
    let vm = bare(config(1, 16), || Ok(MockVm::new())).unwrap();
    let log = vm.host_vm.as_deref().unwrap().log();
    let [(start, size)] = ram_ranges(16)[..] else {
        panic!("one region")
    };
    assert_eq!(start.0, RAM_START);
    let host_addr = vm.ram.memory().get_host_address(start).unwrap() as usize;
    let map = Call::Map {
        guest_addr: start.0,
        host_addr,
        size,
    };
    let unmap = Call::Unmap {
        guest_addr: start.0,
        host_addr,
        size,
    };
    assert_eq!(*log.lock().unwrap(), [map]);

    drop(vm);
    assert_eq!(*log.lock().unwrap(), [map, unmap]);
}

#[test]
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn blocked_fs_shutdown_keeps_vm_ram_registered_until_retry_and_drop() {
    use std::{sync::Arc, time::Duration};

    use crate::virtio::worker::{SharedRuntime, Timeouts, VirtioWorkers};

    let mut vm = bare(config(1, 16), || Ok(MockVm::new())).unwrap();
    let log = vm.host_vm.as_deref().unwrap().log();
    let memory = Arc::downgrade(vm.ram.memory());
    vm.workers = Some(VirtioWorkers::with_runtime(Arc::new(
        SharedRuntime::new(
            vm.sender.clone(),
            Timeouts {
                stop: Duration::from_millis(200),
                shutdown: Duration::from_millis(200),
            },
        )
        .unwrap(),
    )));
    let workers = vm.workers.as_ref().unwrap();
    crate::virtio::fs::worker_tests::with_blocked_vm_read(
        vm.ram.memory().clone(),
        workers,
        &vm.events.lock().unwrap(),
        |release| {
            let error = workers.shutdown().map_err(Error::from).unwrap_err();
            assert!(matches!(error, Error::VirtioWorker(error)
                if error.kind() == io::ErrorKind::TimedOut));
            assert!(memory.upgrade().is_some());
            assert!(
                !log.lock()
                    .unwrap()
                    .iter()
                    .any(|call| matches!(call, Call::Unmap { .. })),
                "a blocked Fs still uses registered VM RAM"
            );
            release();
            workers.shutdown().unwrap();
        },
    );
    assert!(memory.upgrade().is_some(), "VM still owns the backing");
    assert_eq!(log.lock().unwrap().len(), 1, "only RAM registration");
    let region = vm.ram.regions().next().expect("one RAM region");
    let map = Call::map(&region);
    let unmap = Call::unmap(&region);
    drop(vm);
    assert_eq!(*log.lock().unwrap(), [map, unmap]);
    assert!(
        memory.upgrade().is_none(),
        "successful VM drop frees backing RAM"
    );
}

#[test]
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn dropping_vm_during_blocked_fs_keeps_registration_and_backing() {
    use std::{sync::Arc, time::Duration};

    use crate::{
        events::EventLoop,
        virtio::worker::{SharedRuntime, Timeouts, VirtioWorkers},
    };

    let mut vm = bare(config(1, 1), || Ok(MockVm::new())).unwrap();
    let log = vm.host_vm.as_deref().unwrap().log();
    let memory = vm.ram.memory().clone();
    let backing = Arc::downgrade(&memory);
    let events = EventLoop::new().unwrap();
    let runtime = Arc::new(
        SharedRuntime::new(
            events.sender(),
            Timeouts {
                stop: Duration::from_millis(200),
                shutdown: Duration::from_millis(200),
            },
        )
        .unwrap(),
    );
    let workers = VirtioWorkers::with_runtime(runtime.clone());
    vm.workers = Some(VirtioWorkers::with_runtime(runtime));
    crate::virtio::fs::worker_tests::with_blocked_vm_read(memory, &workers, &events, |release| {
        drop(vm);
        assert_eq!(
            log.lock().unwrap().len(),
            1,
            "failed Drop must not unregister RAM"
        );
        assert!(backing.upgrade().is_some());
        release();
        workers.shutdown().unwrap();
    });
    drop(workers);
    assert_eq!(
        log.lock().unwrap().len(),
        1,
        "failed Drop preserves the registration"
    );
    assert!(
        backing.upgrade().is_some(),
        "failed Drop deliberately retains backing RAM"
    );
}

#[test]
fn a_rejected_vm_mapping_releases_the_backing() {
    let backend = MockVm::failing_at(&[0]);
    let log = backend.log();
    let call_log = backend.call_log();
    let mut backing = None;

    let error = Vm::with_backend(
        config(1, 16),
        || Ok(backend),
        |_, _| panic!("a rejected map must not reach boot"),
        |_, ctx| {
            let host_addr = ctx
                .memory
                .get_host_address(GuestAddress(RAM_START))
                .unwrap() as usize;
            backing = Some((Arc::downgrade(ctx.memory), host_addr));
            Ok(())
        },
    )
    .expect_err("mapping fails");

    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::MapMemory { guest_addr, size, source })
            if guest_addr == RAM_START && size == 16 << 20
                && source.kind() == io::ErrorKind::OutOfMemory
    ));
    let (backing, host_addr) = backing.expect("allocated 16 MiB backing");
    let map = Call::Map {
        guest_addr: RAM_START,
        host_addr,
        size: 16 << 20,
    };
    let unmap = Call::Unmap {
        guest_addr: RAM_START,
        host_addr,
        size: 16 << 20,
    };
    assert_eq!(log.lock().unwrap().as_slice(), [map, unmap]);
    assert_eq!(call_log.ioctl_calls(), [map]);
    assert!(
        backing.upgrade().is_none(),
        "failed VM construction must release the backing"
    );
}

struct MappingTestDevice {
    _irq: Option<IrqLine>,
}

impl BusDevice for MappingTestDevice {
    fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

    fn write(&mut self, _offset: u64, _data: &[u8]) {}
}

fn failing_mapping() -> (u32, MockVm) {
    // x86_64 maps low RAM before rejecting high RAM. On arm64, the mock
    // fails the rollback attempt on the single region.
    let memory_mib = if cfg!(target_arch = "x86_64") {
        3073
    } else {
        16
    };
    let ranges = ram_ranges(memory_mib);
    let backend = MockVm::failing_with(&[
        (ranges.len() - 1, io::ErrorKind::PermissionDenied),
        (2 * ranges.len() - 1, io::ErrorKind::OutOfMemory),
    ]);
    (memory_mib, backend)
}

fn with_fresh_backend<H: HostVm + 'static>(
    config: VmConfig,
    backend: H,
    boot: impl FnOnce(&GuestRam, &VmConfig) -> crate::error::Result<BootRegisters>,
    devices: impl FnOnce(&mut ChipsetBuilder, DeviceContext<'_>) -> crate::error::Result<()>,
) -> crate::error::Result<Vm<H>> {
    Vm::build(
        config,
        || Ok(backend),
        true,
        VirtioWorkers::new,
        boot,
        |chipset, ctx, _| devices(chipset, ctx),
    )
}

fn failed_boot(_: &GuestRam, _: &VmConfig) -> crate::error::Result<BootRegisters> {
    Err(Error::WriteBootData {
        what: "boot data",
        source: io::ErrorKind::InvalidData.into(),
    })
}

fn assert_boot_error(error: Error) {
    assert!(matches!(
        error,
        Error::WriteBootData { what: "boot data", source }
            if source.kind() == io::ErrorKind::InvalidData
    ));
}

fn capture_warnings<T>(run: impl FnOnce() -> T) -> (T, Vec<String>) {
    struct Warnings(Arc<Mutex<Vec<String>>>);

    impl Subscriber for Warnings {
        fn enabled(&self, metadata: &Metadata<'_>) -> bool {
            *metadata.level() == Level::WARN
        }

        fn event(&self, event: &Event<'_>) {
            if self.enabled(event.metadata()) {
                let mut warning = String::new();
                event.record(&mut |field: &Field, value: &dyn fmt::Debug| {
                    write!(warning, "{}={value:?} ", field.name()).unwrap();
                });
                self.0.lock().unwrap().push(warning);
            }
        }

        fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
            span::Id::from_u64(1)
        }

        fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
        fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
        fn enter(&self, _: &span::Id) {}
        fn exit(&self, _: &span::Id) {}
    }

    let warnings = Arc::new(Mutex::new(Vec::new()));
    // Keep callsite interest independent of which test thread registers it first.
    let _dispatcher = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::new());
    let result = tracing::subscriber::with_default(Warnings(warnings.clone()), run);
    let warnings = std::mem::take(&mut *warnings.lock().unwrap());
    (result, warnings)
}

struct DropCheckedVm {
    backend: MockVm,
    backing: Arc<OnceLock<Weak<GuestMemoryMmap>>>,
    dropped: Arc<AtomicBool>,
}

impl HostVm for DropCheckedVm {
    type Vcpu = <MockVm as HostVm>::Vcpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        // SAFETY: The caller upholds the forwarded mapping contract.
        unsafe { self.backend.map_memory(region) }
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        self.backend.unmap_memory(region)
    }

    fn create_vcpu(&self, id: u32) -> boxlite_hypervisor::Result<Self::Vcpu> {
        self.backend.create_vcpu(id)
    }

    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
        self.backend.set_irq_line(line, level)
    }
}

impl Drop for DropCheckedVm {
    fn drop(&mut self) {
        assert!(
            self.backing.get().unwrap().upgrade().is_some(),
            "RAM must stay alive while the host VM closes"
        );
        self.dropped.store(true, Ordering::Relaxed);
    }
}

#[test]
fn failed_vm_mapping_releases_backing_after_failed_rollback() {
    let (memory_mib, backend) = failing_mapping();
    let ranges = ram_ranges(memory_mib);
    let (failed_start, failed_size) = *ranges.last().unwrap();
    let log = backend.log();
    let backing = Arc::new(OnceLock::new());
    let dropped = Arc::new(AtomicBool::new(false));

    let (result, warnings) = capture_warnings(|| {
        with_fresh_backend(
            config(1, memory_mib),
            DropCheckedVm {
                backend,
                backing: backing.clone(),
                dropped: dropped.clone(),
            },
            |_, _| panic!("a rejected map must not reach boot"),
            |chipset, ctx| {
                backing.set(Arc::downgrade(ctx.memory)).unwrap();
                // The device's interrupt line holds a strong reference to the host VM.
                chipset.add("device", |resources| {
                    Ok(MappingTestDevice {
                        _irq: Some(resources.line(4)),
                    })
                })
            },
        )
    });
    let error = result.expect_err("mapping fails");

    assert!(matches!(
        error,
        Error::Hypervisor(HypervisorError::MapMemory { guest_addr, size, source })
            if guest_addr == failed_start.0 && size == failed_size
                && source.kind() == io::ErrorKind::PermissionDenied
    ));
    let calls = log.lock().unwrap();
    assert_eq!(calls.len(), 2 * ranges.len());
    assert!(
        matches!(calls.last(), Some(Call::Unmap { guest_addr, .. }) if *guest_addr == RAM_START)
    );
    assert!(dropped.load(Ordering::Relaxed), "the host VM must close");
    assert!(
        backing.get().unwrap().upgrade().is_none(),
        "failed VM construction must release backing after closing the host VM"
    );
    assert!(
        warnings.iter().any(|warning| {
            warning.contains("failed to roll back guest RAM mappings")
                && warning.contains("rollback=Hypervisor(UnmapMemory")
                && warning.contains("OutOfMemory")
        }),
        "missing rollback error warning in {warnings:?}"
    );
}

#[test]
fn failed_boot_keeps_backing_while_an_irq_line_owns_the_host_vm() {
    let backend = MockVm::failing_at(&[1]);
    let call_log = backend.call_log();
    let mut backing = None;
    let mut irq = None;

    let error = with_fresh_backend(config(1, 16), backend, failed_boot, |chipset, ctx| {
        backing = Some(Arc::downgrade(ctx.memory));
        chipset.add("device", |resources| {
            irq = Some(resources.line(4));
            Ok(MappingTestDevice { _irq: None })
        })
    })
    .expect_err("boot fails");

    assert_boot_error(error);
    assert!(matches!(
        call_log.ioctl_calls().as_slice(),
        [Call::Map { .. }, Call::Unmap { .. }]
    ));
    assert!(backing.unwrap().upgrade().is_some());
    irq.unwrap().pulse().unwrap();
}

#[test]
fn failed_boot_keeps_backing_without_a_fresh_backend() {
    let backend = MockVm::failing_at(&[1]);
    let call_log = backend.call_log();
    let mut backing = None;

    let error = Vm::with_backend(
        config(1, 16),
        || Ok(backend),
        failed_boot,
        |_, ctx| {
            backing = Some(Arc::downgrade(ctx.memory));
            Ok(())
        },
    )
    .expect_err("boot fails");

    assert_boot_error(error);
    assert!(matches!(
        call_log.ioctl_calls().as_slice(),
        [Call::Map { .. }, Call::Unmap { .. }]
    ));
    assert!(backing.unwrap().upgrade().is_some());
}

#[test]
fn failed_boot_quiesces_devices_before_unmapping_ram() {
    use crate::virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, SnapshotSupport,
        VirtioDevice, mmio,
    };

    struct QuiesceCheck {
        log: Arc<Mutex<Vec<Call>>>,
        quiesced: Arc<AtomicBool>,
    }

    impl VirtioDevice for QuiesceCheck {
        fn spec(&self) -> &DeviceSpec {
            &DeviceSpec {
                name: "quiesce-check",
                device_id: 1,
                features: 0,
                config_len: 0,
                queue_max: &[8],
                snapshot: SnapshotSupport::Unsupported,
            }
        }

        fn set_features(&mut self, _: u64) -> Result<(), FeatureError> {
            Ok(())
        }

        fn read_config(&mut self, _: u64, _: &mut [u8]) -> Result<(), DeviceError> {
            Ok(())
        }

        fn write_config(&mut self, _: u64, _: &[u8]) -> Result<(), DeviceError> {
            Ok(())
        }

        fn activate(&mut self, _: ActivationContext) -> Result<(), DeviceError> {
            Ok(())
        }

        fn reset(&mut self) -> Result<(), DeviceError> {
            Ok(())
        }

        fn on_event(&mut self, _: DeviceEvent) -> Result<(), DeviceError> {
            Ok(())
        }

        fn quiesce(&mut self) -> Result<(), DeviceError> {
            assert!(
                matches!(self.log.lock().unwrap().as_slice(), [Call::Map { .. }]),
                "RAM must still be registered during quiesce"
            );
            self.quiesced.store(true, Ordering::Relaxed);
            Ok(())
        }
    }

    let backend = MockVm::new();
    let log = backend.log();
    let quiesced = Arc::new(AtomicBool::new(false));

    let error = with_fresh_backend(config(1, 16), backend, failed_boot, |chipset, ctx| {
        mmio::add_device(
            chipset,
            &ctx,
            "quiesce-check",
            mmio::Slots::new().take()?,
            Arc::new(Mutex::new(QuiesceCheck {
                log: log.clone(),
                quiesced: quiesced.clone(),
            })),
        )
    })
    .expect_err("boot fails");

    assert_boot_error(error);
    assert!(quiesced.load(Ordering::Relaxed), "quiesce must complete");
    assert!(matches!(
        log.lock().unwrap().as_slice(),
        [Call::Map { .. }, Call::Unmap { .. }]
    ));
}

#[test]
fn failed_boot_releases_backing_after_failed_unmap() {
    let backend = MockVm::failing_at(&[1]);
    let call_log = backend.call_log();
    let backing = Arc::new(OnceLock::new());
    let dropped = Arc::new(AtomicBool::new(false));
    let backend = DropCheckedVm {
        backend,
        backing: backing.clone(),
        dropped: dropped.clone(),
    };

    let (result, warnings) = capture_warnings(|| {
        with_fresh_backend(config(1, 16), backend, failed_boot, |_, ctx| {
            backing.set(Arc::downgrade(ctx.memory)).unwrap();
            Ok(())
        })
    });

    assert_boot_error(result.expect_err("boot fails"));
    assert!(matches!(
        call_log.ioctl_calls().as_slice(),
        [Call::Map { .. }, Call::Unmap { .. }]
    ));
    assert!(dropped.load(Ordering::Relaxed), "the host VM must close");
    assert!(
        backing.get().unwrap().upgrade().is_none(),
        "failed boot must release backing after closing the host VM"
    );
    assert!(
        warnings.iter().any(|warning| {
            warning.contains("failed to unmap guest RAM")
                && warning.contains("cause=Some(UnmapMemory")
                && warning.contains("OutOfMemory")
        }),
        "missing unmap error warning in {warnings:?}"
    );
}

/// A runtime that never stops, as when a device event never returns.
#[derive(Default)]
struct StuckRuntime {
    shutdowns: AtomicUsize,
}

impl WorkerRuntime for StuckRuntime {
    fn add(
        &self,
        _name: &'static str,
        _device: Arc<Mutex<dyn VirtioDevice>>,
        _interrupt: Arc<dyn VirtioInterrupt>,
    ) -> SlotId {
        SlotId(0)
    }

    fn prepare(&self, _slot: SlotId) -> Result<WorkerContext, DeviceError> {
        Err(DeviceError::Fatal("stuck"))
    }

    fn start(&self, _slot: SlotId) -> Result<(), DeviceError> {
        Err(DeviceError::Fatal("stuck"))
    }

    fn kick(&self, _slot: SlotId, _index: u16) {}

    fn stop(&self, _slot: SlotId) -> Result<(), DeviceError> {
        Err(DeviceError::Fatal("stuck"))
    }

    fn cancel_prepare(&self, _slot: SlotId) {}

    fn shutdown(&self) -> Result<(), ShutdownError> {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
        Err(ShutdownError::Join(io::Error::from(
            io::ErrorKind::TimedOut,
        )))
    }
}

#[test]
fn failed_boot_keeps_registration_and_backing_when_workers_fail_to_join() {
    let backend = MockVm::new();
    let log = backend.log();
    let runtime = Arc::new(StuckRuntime::default());
    let mut backing = None;

    let (result, warnings) = capture_warnings(|| {
        Vm::build(
            config(1, 16),
            || Ok(backend),
            true,
            |_| Ok(VirtioWorkers::with_runtime(runtime.clone())),
            failed_boot,
            |_, ctx, _| {
                backing = Some(Arc::downgrade(ctx.memory));
                Ok(())
            },
        )
    });

    assert_boot_error(result.expect_err("boot fails"));
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);
    assert!(matches!(log.lock().unwrap().as_slice(), [Call::Map { .. }]));
    assert!(backing.unwrap().upgrade().is_some());
    assert!(
        warnings.iter().any(|warning| {
            warning.contains("the virtio workers did not stop; leaking guest RAM")
        }),
        "missing worker join warning in {warnings:?}"
    );
}

#[test]
fn panicking_boot_unmaps_ram_and_releases_backing_after_host_vm_closes() {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    let backend = MockVm::failing_at(&[1]);
    let call_log = backend.call_log();
    let backing = Arc::new(OnceLock::new());
    let dropped = Arc::new(AtomicBool::new(false));
    let backend = DropCheckedVm {
        backend,
        backing: backing.clone(),
        dropped: dropped.clone(),
    };

    let panic = catch_unwind(AssertUnwindSafe(|| {
        with_fresh_backend(
            config(1, 16),
            backend,
            |_, _| panic!("boot panic"),
            |chipset, ctx| {
                backing.set(Arc::downgrade(ctx.memory)).unwrap();
                chipset.add("device", |resources| {
                    Ok(MappingTestDevice {
                        _irq: Some(resources.line(4)),
                    })
                })
            },
        )
    }))
    .expect_err("boot panics");

    assert_eq!(panic.downcast_ref::<&str>(), Some(&"boot panic"));
    assert!(matches!(
        call_log.ioctl_calls().as_slice(),
        [Call::Map { .. }, Call::Unmap { .. }]
    ));
    assert!(dropped.load(Ordering::Relaxed), "the host VM must close");
    assert!(backing.get().unwrap().upgrade().is_none());
}

/// A chipset conflict fails the build before any RAM is registered, so the
/// failed VM leaves nothing mapped and leaks no guest RAM.
#[test]
#[cfg_attr(
    not(target_arch = "x86_64"),
    expect(clippy::unit_arg, reason = "arm64 has no boot registers yet.")
)]
fn a_chipset_conflict_fails_before_any_ram_is_registered() {
    struct Idle;

    impl crate::bus::BusDevice for Idle {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, _data: &[u8]) {}
    }

    let backend = MockVm::new();
    let log = backend.log();

    let error = Vm::with_backend(
        config(1, 16),
        || Ok(backend),
        |_, _| Ok(BootRegisters::default()),
        |chipset, _| {
            for name in ["first", "second"] {
                chipset.add(name, |resources| {
                    resources.mmio(0xd000_0000, 0x1000);
                    Ok(Idle)
                })?;
            }
            Ok(())
        },
    )
    .expect_err("the second device claims a taken range");

    assert!(
        matches!(&error, Error::ChipsetConflicts(conflicts) if conflicts.len() == 1),
        "{error:?}"
    );
    assert_eq!(*log.lock().unwrap(), [], "no RAM was registered");
}

#[test]
fn a_failing_host_vm_keeps_its_cause() {
    let error = bare::<MockVm>(config(1, 16), || {
        Err(HypervisorError::CreateVm(io::Error::from(
            io::ErrorKind::Unsupported,
        )))
    })
    .expect_err("host failure");

    let cause = error
        .source()
        .and_then(|hypervisor| hypervisor.source())
        .and_then(|cause| cause.downcast_ref::<io::Error>())
        .expect("host cause");
    assert_eq!(cause.kind(), io::ErrorKind::Unsupported);
}

#[test]
fn vm_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Vm<MockVm>>();
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_kvm_guest_reads_the_last_byte_of_the_mapped_layout() {
    use std::sync::Arc;

    use boxlite_hypervisor::{KvmVm, VcpuExit, X86BootRegisters, X86Segment};
    use vm_memory::{Bytes, GuestAddress};

    use crate::{boot::BOOT_LEAF, cpu_features::preflight_x86, memory::MMIO_HOLE_START};

    let config = config(1, 3072);
    let prepared = KvmVm::prepare().unwrap();
    preflight_x86(config.memory_mib, prepared.supported_cpuid(), BOOT_LEAF).unwrap();
    let vm = bare(config, move || KvmVm::from_prepared(prepared)).unwrap();
    let memory = Arc::clone(vm.ram.memory());
    let last = GuestAddress(MMIO_HOLE_START - 1);
    // mov al,[0xBFFFFFFF]; mov dx,0x3f8; out dx,al; hlt
    let program = [
        0xa0, 0xff, 0xff, 0xff, 0xbf, 0x66, 0xba, 0xf8, 0x03, 0xee, 0xf4,
    ];
    memory.write_slice(&program, GuestAddress(0x1000)).unwrap();
    memory.write_obj(b'Z', last).unwrap();
    // Flat 32-bit descriptors: null, code, data.
    for (index, descriptor) in [0u64, 0x00cf_9b00_0000_ffff, 0x00cf_9300_0000_ffff]
        .into_iter()
        .enumerate()
    {
        memory
            .write_obj(descriptor, GuestAddress(0x500 + index as u64 * 8))
            .unwrap();
    }

    let mut vcpu = vm.host_vm.as_deref().unwrap().create_vcpu(0).unwrap();
    let code = X86Segment {
        limit: u32::MAX,
        selector: 8,
        attributes: 0xc09b,
        ..Default::default()
    };
    vcpu.set_boot_registers(&X86BootRegisters {
        rip: 0x1000,
        rsp: 0x8000,
        rflags: 2,
        cr0: 1, // Protected mode with paging off: linear address == guest address.
        code,
        data: X86Segment {
            selector: 16,
            attributes: 0xc093,
            ..code
        },
        gdt_base: 0x500,
        gdt_limit: 23,
        ..Default::default()
    })
    .unwrap();

    match vcpu.run().unwrap() {
        VcpuExit::IoOut { port, bytes } => {
            assert_eq!(port, 0x3f8);
            assert_eq!(bytes, b"Z");
        }
        exit => panic!("unexpected exit: {exit:?}"),
    }
    // Complete the OUT without reaching HLT, which would wait inside KVM.
    vcpu.complete_pending_io().unwrap();
    drop(vcpu);

    let weak = Arc::downgrade(&memory);
    drop(memory);
    drop(vm);
    assert!(
        weak.upgrade().is_none(),
        "the VM unmapped its RAM on drop and released it"
    );
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_kvm_guest_runs_64_bit_code_with_the_boot_cpu_state() {
    use std::sync::Arc;

    use boxlite_hypervisor::{KvmVm, VcpuExit};
    use vm_memory::{Bytes, GuestAddress};

    use crate::{
        boot::{BOOT_LEAF, entry::long_mode_entry},
        cpu_features::{BOOT_MSRS, preflight_x86, vcpu_cpuid},
    };

    const ENTRY: u64 = 0x100_0000;
    const BOOT_PARAMS: u64 = 0x7000;
    const RESULTS: u64 = 0x6000;
    const PARAMS_MARKER: u64 = 0x0123_4567_89ab_cdef;
    const TOP_MARKER: u64 = 0xfedc_ba98_7654_3210;

    // Two vCPUs so the topology has a count to check; only vCPU 0 runs.
    let config = config(2, 4097);
    // The marker occupies the last eight bytes of RAM, above 4 GiB.
    let (start, len) = ram_ranges(config.memory_mib).pop().expect("high RAM range");
    let top = start.0 + len as u64 - 8;
    assert!(
        top > 0x1_0000_0000,
        "marker GPA {top:#x} is not above 4 GiB"
    );
    let mut program = vec![
        0xb8, 0x18, 0x00, 0x00, 0x00, // mov eax, 0x18 (__BOOT_DS)
        0x8e, 0xd8, // mov ds, eax: each reload reads the GDT in RAM
        0x8e, 0xc0, // mov es, eax
        0x8e, 0xd0, // mov ss, eax
        0x6a, 0x10, // push 0x10 (__BOOT_CS)
        0x48, 0x8d, 0x05, 0x03, 0x00, 0x00, 0x00, // lea rax, [rip + 3]
        0x50, // push rax
        0x48, 0xcb, // retfq: reloads CS, which must keep 64-bit mode
        0xbf, 0x00, 0x60, 0x00, 0x00, // mov edi, RESULTS
        0x9c, // pushfq
        0x8f, 0x47, 0x10, // pop qword [rdi + 0x10]
        0x48, 0x8b, 0x06, // mov rax, [rsi]
        0x48, 0x89, 0x07, // mov [rdi], rax
        0x48, 0xbb, // mov rbx, top
    ];
    program.extend_from_slice(&top.to_le_bytes());
    program.extend_from_slice(&[
        0x48, 0x8b, 0x03, // mov rax, [rbx]
        0x48, 0x89, 0x47, 0x08, // mov [rdi + 0x08], rax
        0x0f, 0x20, 0xc0, // mov rax, cr0
        0x48, 0x89, 0x47, 0x18, // mov [rdi + 0x18], rax
        0x0f, 0x20, 0xd8, // mov rax, cr3
        0x48, 0x89, 0x47, 0x20, // mov [rdi + 0x20], rax
        0x0f, 0x20, 0xe0, // mov rax, cr4
        0x48, 0x89, 0x47, 0x28, // mov [rdi + 0x28], rax
        0xb9, 0x80, 0x00, 0x00, 0xc0, // mov ecx, 0xc0000080 (EFER)
        0x0f, 0x32, // rdmsr
        0x89, 0x47, 0x30, // mov [rdi + 0x30], eax
        0x89, 0x57, 0x34, // mov [rdi + 0x34], edx
        0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
        0x0f, 0xa2, // cpuid
        0x89, 0x5f, 0x38, // mov [rdi + 0x38], ebx
        0x89, 0x4f, 0x3c, // mov [rdi + 0x3c], ecx
        0x89, 0x57, 0x40, // mov [rdi + 0x40], edx
        0xb8, 0x0b, 0x00, 0x00, 0x00, // mov eax, 0xb
        0xb9, 0x01, 0x00, 0x00, 0x00, // mov ecx, 1
        0x0f, 0xa2, // cpuid
        0x89, 0x5f, 0x44, // mov [rdi + 0x44], ebx
        0x89, 0x57, 0x48, // mov [rdi + 0x48], edx
        0xb9, 0xa0, 0x01, 0x00, 0x00, // mov ecx, 0x1a0 (MISC_ENABLE)
        0x0f, 0x32, // rdmsr
        0x89, 0x47, 0x50, // mov [rdi + 0x50], eax
        0x89, 0x57, 0x54, // mov [rdi + 0x54], edx
        0xb9, 0xff, 0x02, 0x00, 0x00, // mov ecx, 0x2ff (MTRRdefType)
        0x0f, 0x32, // rdmsr
        0x89, 0x47, 0x58, // mov [rdi + 0x58], eax
        0x89, 0x57, 0x5c, // mov [rdi + 0x5c], edx
        0xba, 0xf8, 0x03, 0x00, 0x00, // mov edx, 0x3f8
        0xb0, b'L', // mov al, 'L'
        0xee, // out dx, al
        0x0f, 0x0b, // ud2
    ]);

    let prepared = KvmVm::prepare().unwrap();
    let leaf = preflight_x86(config.memory_mib, prepared.supported_cpuid(), BOOT_LEAF).unwrap();
    let vm = bare(config, move || KvmVm::from_prepared(prepared)).unwrap();
    let memory = Arc::clone(vm.ram.memory());
    memory.write_slice(&program, GuestAddress(ENTRY)).unwrap();
    memory
        .write_obj(PARAMS_MARKER, GuestAddress(BOOT_PARAMS))
        .unwrap();
    memory.write_obj(TOP_MARKER, GuestAddress(top)).unwrap();
    let ranges: Vec<_> = vm.ram.ranges().collect();
    let plan = crate::x86_boot_layout::plan_boot_tables(
        &ranges,
        (ENTRY, ENTRY + program.len() as u64),
        None,
        leaf.page_size(),
    )
    .unwrap();
    let regs = long_mode_entry(&*memory, ENTRY, BOOT_PARAMS, &plan).unwrap();
    let host_vm = vm.host_vm.as_deref().unwrap();
    let cpuid = vcpu_cpuid(host_vm.supported_cpuid(), 0, 2);

    let mut vcpu = host_vm.create_vcpu(0).unwrap();
    vcpu.set_cpu_features(&cpuid, &BOOT_MSRS).unwrap();
    vcpu.set_boot_registers(&regs).unwrap();
    match vcpu.run().unwrap() {
        VcpuExit::IoOut { port, bytes } => assert_eq!((port, bytes), (0x3f8, &b"L"[..])),
        exit => panic!("unexpected exit: {exit:?}"),
    }
    vcpu.complete_pending_io().unwrap();
    let results: [u64; 7] = memory.read_obj(GuestAddress(RESULTS)).unwrap();
    assert_eq!(
        results,
        [
            PARAMS_MARKER,
            TOP_MARKER,
            regs.rflags,
            regs.cr0,
            regs.cr3,
            regs.cr4,
            regs.efer
        ]
    );
    let [ebx, ecx, edx, core_ebx, core_edx, _]: [u32; 6] =
        memory.read_obj(GuestAddress(RESULTS + 0x38)).unwrap();
    // Leaf 1: APIC ID 0 of 2 logical CPUs, hypervisor, TSC-deadline and HTT.
    assert_eq!(ebx >> 16, 0x0002);
    assert_eq!(ecx & ((1 << 31) | (1 << 24)), (1 << 31) | (1 << 24));
    assert_eq!(edx & (1 << 28), 1 << 28);
    // Leaf 0xB core level: 2 CPUs, x2APIC ID 0.
    assert_eq!((core_ebx, core_edx), (2, 0));
    // MISC_ENABLE with FAST_STRING; MTRRs on, write-back by default.
    let msrs: [u64; 2] = memory.read_obj(GuestAddress(RESULTS + 0x50)).unwrap();
    assert_eq!(msrs, [0x1801, 0x806]);
    // ud2 without an IDT escalates to a triple fault.
    assert!(matches!(vcpu.run().unwrap(), VcpuExit::Reset));
}

/// `Vm::run` on the mock backend, whose scripted vCPUs exit as listed and
/// then wait for a kick.
#[cfg(target_arch = "x86_64")]
mod lifecycle {
    use std::{sync::mpsc, thread, time::Duration};

    use super::{config, *};
    use crate::{VmExit, bus::BusDevice, mock_vm::Step};

    /// Runs `vm` on another thread and fails the test instead of hanging when
    /// the run never returns.
    fn run(mut vm: Vm<MockVm>) -> (crate::Result<VmExit>, Vm<MockVm>) {
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            let exit = vm.run();
            let _ = done.send((exit, vm));
        });
        finished
            .recv_timeout(Duration::from_secs(10))
            .expect("Vm::run did not return")
    }

    fn mock(vcpu_count: u8, backend: MockVm) -> Vm<MockVm> {
        bare(config(vcpu_count, 16), || Ok(backend)).unwrap()
    }

    fn memory_calls(calls: &[Call]) -> Vec<Call> {
        calls
            .iter()
            .copied()
            .filter(|call| matches!(call, Call::Map { .. } | Call::Unmap { .. }))
            .collect()
    }

    #[test]
    fn the_first_guest_exit_decides_the_outcome_and_stops_every_vcpu() {
        for (step, expected) in [
            (Step::Shutdown, VmExit::GuestShutdown),
            (Step::Reset, VmExit::GuestReset),
        ] {
            // vCPU 1 never exits on its own, so only a kick ends it.
            let (exit, vm) = run(mock(2, MockVm::with_scripts(vec![vec![step]])));
            assert_eq!(exit.unwrap(), expected);
            let host_vm = vm.host_vm.as_deref().unwrap();
            let log = host_vm.log();
            let call_log = host_vm.call_log();
            let region = vm.ram.regions().next().expect("one RAM region");
            let expected_memory = [Call::map(&region), Call::unmap(&region)];
            drop(vm);
            let calls = log.lock().unwrap().clone();
            let first_unmap = calls
                .iter()
                .position(|call| matches!(call, Call::Unmap { .. }))
                .unwrap();
            let drops: Vec<_> = calls
                .iter()
                .enumerate()
                .filter(|(_, call)| matches!(call, Call::DropVcpu { .. }))
                .map(|(index, _)| index)
                .collect();
            assert_eq!(drops.len(), 2, "{calls:?}");
            assert!(drops.iter().all(|&index| index < first_unmap), "{calls:?}");
            assert_eq!(memory_calls(&calls), expected_memory);
            assert_eq!(memory_calls(&call_log.ioctl_calls()), expected_memory);
        }
    }

    #[test]
    fn only_vcpu_0_gets_the_boot_registers() {
        let (exit, vm) = run(mock(3, MockVm::with_scripts(vec![vec![Step::Shutdown]])));
        exit.unwrap();

        let calls = vm.host_vm.as_deref().unwrap().calls();
        let boot: Vec<_> = calls
            .iter()
            .filter(|call| matches!(call, Call::SetBootRegisters { .. }))
            .collect();
        let features = calls
            .iter()
            .filter(|call| matches!(call, Call::SetCpuFeatures { .. }))
            .count();
        assert_eq!(boot, [&Call::SetBootRegisters { id: 0 }]);
        assert_eq!(features, 3);
    }

    #[test]
    fn a_failed_run_keeps_the_hypervisor_cause() {
        let (exit, _) = run(mock(2, MockVm::with_scripts(vec![vec![Step::Fail]])));

        let error = exit.unwrap_err();
        assert!(
            matches!(
                error,
                Error::Hypervisor(HypervisorError::RunVcpu { id: 0, .. })
            ),
            "{error:?}"
        );
        let cause = error
            .source()
            .and_then(|hypervisor| hypervisor.source())
            .and_then(|cause| cause.downcast_ref::<io::Error>())
            .expect("host cause");
        assert_eq!(cause.kind(), io::ErrorKind::Other);
    }

    #[test]
    fn a_halted_vcpu_is_unexpected_with_an_in_kernel_irqchip() {
        let (exit, _) = run(mock(1, MockVm::with_scripts(vec![vec![Step::Halted]])));

        let error = exit.unwrap_err();
        assert!(
            matches!(&error, Error::UnexpectedExit { vcpu: 0, exit } if exit == "Halted"),
            "{error:?}"
        );
    }

    #[test]
    fn a_stop_from_another_thread_ends_the_run() {
        let vm = mock(2, MockVm::new());
        let stop = vm.stop_handle();
        let stopping = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            stop.stop();
        });

        let (exit, _) = run(vm);

        assert_eq!(exit.unwrap(), VmExit::StopRequested);
        stopping.join().unwrap();
    }

    #[test]
    fn a_stop_before_the_run_ends_it_at_once() {
        let vm = mock(2, MockVm::new());
        vm.stop_handle().stop();

        let (exit, _) = run(vm);

        assert_eq!(exit.unwrap(), VmExit::StopRequested);
    }

    #[test]
    fn a_vm_runs_once() {
        let (exit, mut vm) = run(mock(1, MockVm::with_scripts(vec![vec![Step::Reset]])));
        exit.unwrap();

        assert_eq!(format!("{vm:?}"), "Vm { vcpus: 1, state: Exited, .. }");
        assert!(matches!(vm.run(), Err(Error::AlreadyRan)));
    }

    struct Panics;

    impl BusDevice for Panics {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, _data: &[u8]) {
            panic!("a device bug");
        }
    }

    #[test]
    fn a_panicking_device_ends_the_vm_with_an_error() {
        const DEVICE: u64 = 0xd000_0000;
        let backend = MockVm::with_scripts(vec![vec![Step::Write {
            addr: DEVICE,
            byte: 1,
        }]]);
        let vm = Vm::with_backend(
            config(2, 16),
            || Ok(backend),
            |_, _| Ok(BootRegisters::default()),
            |chipset, _| {
                chipset.add("panics", |resources| {
                    resources.mmio(DEVICE, 1);
                    Ok(Panics)
                })
            },
        )
        .unwrap();

        let (exit, _) = run(vm);

        assert!(
            matches!(exit, Err(Error::VcpuPanicked { vcpu: 0 })),
            "{exit:?}"
        );
    }

    /// A console sink that takes each write only after a delay, like a slow
    /// log reader.
    #[derive(Clone, Default)]
    struct SlowSink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for SlowSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            thread::sleep(Duration::from_millis(200));
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Writes every byte the guest stores at its register to the console.
    struct ConsolePort(crate::devices::console::ConsoleWriter);

    impl BusDevice for ConsolePort {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, data: &[u8]) {
            std::io::Write::write_all(&mut self.0, data).unwrap();
        }
    }

    /// `run` returns only after the slow sink has taken the console output
    /// the guest wrote before its reset.
    #[test]
    fn run_returns_after_the_console_reaches_its_sink() {
        use crate::devices::console::ConsoleWorker;

        const DEVICE: u64 = 0xd000_0000;
        let sink = SlowSink::default();
        let (writer, worker) = ConsoleWorker::spawn(Box::new(sink.clone()), 64).unwrap();
        let backend = MockVm::with_scripts(vec![vec![
            Step::Write {
                addr: DEVICE,
                byte: b'o',
            },
            Step::Write {
                addr: DEVICE,
                byte: b'k',
            },
            Step::Reset,
        ]]);
        let mut vm = Vm::with_backend(
            config(1, 16),
            || Ok(backend),
            |_, _| Ok(BootRegisters::default()),
            |chipset, _| {
                chipset.add("console", |resources| {
                    resources.mmio(DEVICE, 1);
                    Ok(ConsolePort(writer))
                })
            },
        )
        .unwrap();
        vm.console = std::sync::Mutex::new(Some(worker));

        let (exit, _vm) = run(vm);

        assert_eq!(exit.unwrap(), VmExit::GuestReset);
        assert_eq!(*sink.0.lock().unwrap(), b"ok");
    }

    /// A vCPU that fails setup reports it before the start gate opens, so no
    /// vCPU enters the guest and the setup error, not a guest exit, ends the
    /// run. The two sends race, so the run repeats.
    #[test]
    fn a_setup_failure_ends_the_vm_before_any_vcpu_enters_the_guest() {
        for _ in 0..100 {
            // vCPU 1 spawns last, so it opens the gate and runs at once while
            // vCPU 0, whose setup failed, still wakes from the gate.
            let backend =
                MockVm::with_scripts(vec![vec![], vec![Step::Reset]]).and_failing_setup_of(0);
            let entries = backend.entries();

            let (exit, _) = run(mock(2, backend));

            assert!(
                matches!(
                    exit,
                    Err(Error::Hypervisor(HypervisorError::ConfigureVcpu {
                        id: 0,
                        ..
                    }))
                ),
                "{exit:?}"
            );
            assert_eq!(
                *entries.lock().unwrap(),
                [0u32; 0],
                "a vCPU entered the guest"
            );
        }
    }

    #[test]
    fn a_vcpu_that_fails_setup_ends_the_vm_without_a_deadlock() {
        let (exit, _) = run(mock(3, MockVm::failing_setup_of(1)));

        let error = exit.unwrap_err();
        assert!(
            matches!(
                error,
                Error::Hypervisor(HypervisorError::ConfigureVcpu { id: 1, .. })
            ),
            "{error:?}"
        );
    }

    mod virtio {
        use std::{
            sync::{Arc, Mutex},
            thread,
            time::{Duration, Instant},
        };

        use super::{super::*, SlowSink, memory_calls, run};
        use crate::{
            VmExit,
            chipset::ChipsetBuilder,
            events::Event,
            mock_vm::Step,
            virtio::{
                ActivationContext, DeviceContext, DeviceError, DeviceEvent, DeviceSpec,
                FeatureError, SnapshotSupport, VirtioDevice,
                mmio::{self, Slot},
            },
        };

        const BASE: u64 = 0xd000_0000;
        const GSI: u32 = 5;

        const SPEC: DeviceSpec = DeviceSpec {
            device_id: 1,
            name: "reset-on-kick",
            features: 0,
            config_len: 0,
            queue_max: &[8],
            snapshot: SnapshotSupport::Unsupported,
        };

        /// A device that resets the guest on its first queue notification,
        /// from the worker thread, and then runs `then` there.
        struct ResetOnKick {
            ctx: Option<ActivationContext>,
            then: Box<dyn FnMut() + Send>,
        }

        impl ResetOnKick {
            fn shared(then: Box<dyn FnMut() + Send>) -> Arc<Mutex<dyn VirtioDevice>> {
                Arc::new(Mutex::new(Self { ctx: None, then }))
            }
        }

        impl VirtioDevice for ResetOnKick {
            fn spec(&self) -> &DeviceSpec {
                &SPEC
            }

            fn set_features(&mut self, _negotiated: u64) -> Result<(), FeatureError> {
                Ok(())
            }

            fn read_config(&mut self, _offset: u64, _data: &mut [u8]) -> Result<(), DeviceError> {
                Ok(())
            }

            fn write_config(&mut self, _offset: u64, _data: &[u8]) -> Result<(), DeviceError> {
                Ok(())
            }

            fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
                self.ctx = Some(ctx);
                Ok(())
            }

            fn reset(&mut self) -> Result<(), DeviceError> {
                self.ctx = None;
                Ok(())
            }

            fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
                if event == DeviceEvent::QueueKick(0)
                    && let Some(ctx) = &self.ctx
                {
                    ctx.sender.send(Event::GuestReset);
                    (self.then)();
                }
                Ok(())
            }
        }

        /// The 4-byte writes a virtio-mmio driver makes to bring the device at
        /// `BASE` up with every queue unready, then to notify queue 0.
        fn driver() -> Vec<Step> {
            [
                (0x070, 1),
                (0x070, 3),
                (0x024, 1),
                (0x020, 1),
                (0x070, 0xb),
                (0x070, 0xf),
                (0x050, 0),
            ]
            .into_iter()
            .map(|(offset, value)| Step::Write32 {
                addr: BASE + offset,
                value,
            })
            .collect()
        }

        /// Adds `device` behind a virtio-mmio transport at `BASE` on `GSI`.
        fn add(
            chipset: &mut ChipsetBuilder,
            ctx: DeviceContext<'_>,
            device: Arc<Mutex<dyn VirtioDevice>>,
        ) -> crate::Result<()> {
            mmio::add_device(
                chipset,
                &ctx,
                "virtio",
                Slot {
                    base: BASE,
                    gsi: GSI,
                },
                device,
            )
        }

        /// Waits until `condition` holds, failing the test after ten seconds.
        fn wait_until(mut condition: impl FnMut() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !condition() {
                assert!(Instant::now() < deadline, "the condition never held");
                thread::sleep(Duration::from_millis(1));
            }
        }

        #[test]
        fn a_virtio_transport_runs_on_the_workers_until_guest_reset() {
            let mut memory = None;
            let vm = Vm::with_backend(
                config(1, 16),
                || Ok(MockVm::with_scripts(vec![driver()])),
                |_, _| Ok(BootRegisters::default()),
                |chipset, ctx| {
                    memory = Some(Arc::downgrade(ctx.memory));
                    add(chipset, ctx, ResetOnKick::shared(Box::new(|| {})))
                },
            )
            .unwrap();

            let (exit, vm) = run(vm);

            assert_eq!(exit.unwrap(), VmExit::GuestReset);
            drop(vm);
            assert!(
                memory.unwrap().upgrade().is_none(),
                "the guest memory outlived the VM"
            );
        }

        #[test]
        fn run_shuts_the_workers_down_before_the_console_finishes() {
            use crate::devices::console::ConsoleWorker;

            let sink = SlowSink::default();
            let (mut writer, worker) = ConsoleWorker::spawn(Box::new(sink.clone()), 64).unwrap();
            let backend = MockVm::with_scripts(vec![driver()]);
            let log = backend.log();
            // The device writes only once its vCPU is gone, after `run` has
            // stopped waiting for events.
            let then = Box::new(move || {
                wait_until(|| log.lock().unwrap().contains(&Call::DropVcpu { id: 0 }));
                std::io::Write::write_all(&mut writer, b"late").unwrap();
            });
            let mut vm = Vm::with_backend(
                config(1, 16),
                || Ok(backend),
                |_, _| Ok(BootRegisters::default()),
                |chipset, ctx| add(chipset, ctx, ResetOnKick::shared(then)),
            )
            .unwrap();
            vm.console = Mutex::new(Some(worker));

            let (exit, mut vm) = run(vm);

            assert_eq!(exit.unwrap(), VmExit::GuestReset);
            assert_eq!(*sink.0.lock().unwrap(), b"late");
            let console = vm.console.get_mut().unwrap();
            assert_eq!(console.as_ref().unwrap().dropped_bytes(), 0);
        }

        #[test]
        fn run_drains_virtio_console_tx_without_a_final_queue_kick() {
            use vm_memory::{Bytes, GuestAddress};

            let (vm, sink) = console_vm(0, Step::Reset);
            let (exit, vm) = run(vm);
            assert_eq!(exit.unwrap(), VmExit::GuestReset);
            assert_eq!(*sink.0.lock().unwrap(), b"final");
            assert_eq!(
                vm.ram
                    .memory()
                    .read_obj::<u16>(GuestAddress(0x3002))
                    .unwrap(),
                1u16.to_le()
            );
        }

        #[test]
        fn console_quiesce_failure_preserves_run_error_and_allows_ram_release() {
            for (step, clean) in [(Step::Reset, true), (Step::Fail, false)] {
                // A writable TX descriptor is rejected by the final scan.
                let (vm, sink) = console_vm(2, step);
                let log = vm.host_vm.as_deref().unwrap().log();
                let memory = Arc::downgrade(vm.ram.memory());
                let (exit, vm) = run(vm);
                let error = exit.unwrap_err();
                if clean {
                    assert!(
                        matches!(
                            error,
                            Error::VirtioDevice {
                                device: "virtio-console",
                                ..
                            }
                        ),
                        "{error:?}"
                    );
                } else {
                    assert!(
                        matches!(error, Error::Hypervisor(HypervisorError::RunVcpu { .. })),
                        "{error:?}"
                    );
                }
                assert!(sink.0.lock().unwrap().is_empty());
                assert!(
                    vm.workers.as_ref().unwrap().shutdown().is_err(),
                    "hook failure is cached"
                );

                let call_log = vm.host_vm.as_deref().unwrap().call_log();
                let region = vm.ram.regions().next().expect("one RAM region");
                let expected_memory = [Call::map(&region), Call::unmap(&region)];
                drop(vm);

                assert_eq!(memory_calls(&log.lock().unwrap()), expected_memory);
                assert_eq!(memory_calls(&call_log.ioctl_calls()), expected_memory);
                assert!(
                    memory.upgrade().is_none(),
                    "joined workers permit RAM release"
                );
            }
        }

        fn console_vm(flags: u16, exit: Step) -> (Vm<MockVm>, SlowSink) {
            use crate::devices::{console::ConsoleWorker, virtio_console::VirtioConsole};
            use virtio_queue::desc::split::Descriptor;
            use vm_memory::{Bytes, GuestAddress};

            let sink = SlowSink::default();
            let (writer, worker) = ConsoleWorker::spawn(Box::new(sink.clone()), 64).unwrap();
            let console = Arc::new(Mutex::new(VirtioConsole::new(writer)));
            let mut steps: Vec<_> = [
                (0x070, 1),
                (0x070, 3),
                (0x024, 1),
                (0x020, 1),
                (0x070, 0xb),
                (0x030, 1),
                (0x038, 8),
                (0x080, 0x1000),
                (0x090, 0x2000),
                (0x0a0, 0x3000),
                (0x044, 1),
                (0x070, 0xf),
            ]
            .into_iter()
            .map(|(offset, value)| Step::Write32 {
                addr: BASE + offset,
                value,
            })
            .collect();
            // No TX kick: shutdown must find the console through its slot.
            steps.push(exit);
            let mut vm = Vm::with_backend(
                config(1, 16),
                || Ok(MockVm::with_scripts(vec![steps])),
                |_, _| Ok(BootRegisters::default()),
                |chipset, ctx| {
                    ctx.memory
                        .write_slice(b"final", GuestAddress(0x4000))
                        .unwrap();
                    ctx.memory
                        .write_obj(Descriptor::new(0x4000, 5, flags, 0), GuestAddress(0x1000))
                        .unwrap();
                    ctx.memory
                        .write_obj(1u16.to_le(), GuestAddress(0x2002))
                        .unwrap();
                    add(chipset, ctx, console)
                },
            )
            .unwrap();
            vm.console = Mutex::new(Some(worker));
            (vm, sink)
        }

        /// A clean exit becomes the workers' failure; an error exit keeps
        /// its error. Either way the RAM stays registered.
        #[test]
        fn workers_that_do_not_stop_fail_a_clean_run_and_keep_ram_mapped() {
            for (step, clean) in [(Step::Shutdown, true), (Step::Fail, false)] {
                let backend = MockVm::with_scripts(vec![vec![step]]);
                let log = backend.log();
                let mut vm = bare(config(1, 16), || Ok(backend)).unwrap();
                let runtime = Arc::new(StuckRuntime::default());
                vm.workers = Some(VirtioWorkers::with_runtime(runtime.clone()));

                let (exit, vm) = run(vm);

                let error = exit.unwrap_err();
                if clean {
                    assert!(
                        matches!(&error, Error::VirtioWorker(source)
                            if source.kind() == io::ErrorKind::TimedOut),
                        "{error:?}"
                    );
                } else {
                    assert!(
                        matches!(error, Error::Hypervisor(HypervisorError::RunVcpu { .. })),
                        "{error:?}"
                    );
                }
                drop(vm);
                assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 2);
                let calls = log.lock().unwrap().clone();
                assert!(calls.iter().any(|call| matches!(call, Call::Map { .. })));
                assert!(
                    !calls.iter().any(|call| matches!(call, Call::Unmap { .. })),
                    "{calls:?}"
                );
            }
        }
    }
}

#[test]
fn lifecycle_errors_describe_themselves() {
    let io = || io::Error::from(io::ErrorKind::Other);
    let cases = [
        (Error::EventLoop(io()), "the VM event loop failed"),
        (
            Error::SpawnConsole(io()),
            "failed to start the console thread",
        ),
        (
            Error::SpawnVcpu {
                vcpu: 3,
                source: io(),
            },
            "failed to start vCPU 3",
        ),
        (
            Error::UnexpectedExit {
                vcpu: 1,
                exit: "Halted".into(),
            },
            "vCPU 1 exited unexpectedly: Halted",
        ),
        (Error::VcpuPanicked { vcpu: 2 }, "vCPU 2 panicked"),
        (Error::AlreadyRan, "the VM has already run"),
        (Error::VirtioWorker(io()), "the virtio workers failed"),
    ];
    for (error, message) in cases {
        assert_eq!(error.to_string(), message);
        let has_io_cause = matches!(
            error,
            Error::EventLoop(_)
                | Error::SpawnConsole(_)
                | Error::SpawnVcpu { .. }
                | Error::VirtioWorker(_)
        );
        assert_eq!(error.source().is_some(), has_io_cause, "{error:?}");
    }
}

#[test]
fn debug_shows_the_vm_shape_without_its_internals() {
    let vm = bare(config(2, 16), || Ok(MockVm::new())).unwrap();

    assert_eq!(format!("{vm:?}"), "Vm { vcpus: 2, state: Created, .. }");
    assert!(format!("{:?}", vm.stop_handle()).starts_with("StopHandle("));
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn new_names_a_kernel_it_cannot_load() {
    let error = Vm::new(config(1, 16), Box::new(io::sink())).expect_err("no kernel file");

    assert!(
        matches!(&error, Error::LoadKernel { path, .. } if path.as_os_str() == "vmlinux"),
        "{error:?}"
    );
}

/// Two KVM vCPUs through `Vm::run`: vCPU 0 runs a flat guest that pulses the
/// i8042 reset, while vCPU 1 waits for an INIT that never comes, so only the
/// kick after the reset ends it.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_kvm_vm_runs_until_its_guest_resets() {
    use crate::{
        VmExit,
        bus::BusDevice,
        events::{Event, EventSender},
        flat_guest,
    };

    struct Reset(EventSender);

    impl BusDevice for Reset {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, data: &[u8]) {
            if data == [0xfe] {
                self.0.send(Event::GuestReset);
            }
        }
    }

    // mov al, 0xfe; out 0x64, al; hlt
    let program = [0xb0, 0xfe, 0xe6, 0x64, 0xf4];
    let mut vm = Vm::with_backend(
        config(2, 2),
        boxlite_hypervisor::KvmVm::new,
        |ram, _| Ok(flat_guest::load(ram.memory(), &program)),
        |chipset, _| {
            chipset.add("i8042", |resources| {
                resources.pio(0x64, 1);
                Ok(Reset(resources.event_sender()))
            })
        },
    )
    .unwrap();

    assert_eq!(vm.run().unwrap(), VmExit::GuestReset);
}

/// Exercises the production composition and boot loader at the disk limit;
/// the backend is mocked, but none of the attached devices are test doubles.
/// Eight disks, the balloon and the aggregate filesystem fill the slots up
/// to and across the RTC's line, so every virtio GSI must land past GSI 8.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
fn rtc_coexists_with_max_disks_balloon_and_aggregate_filesystem() {
    use boxlite_hypervisor::VcpuExit;
    use linux_loader::loader::bootparam::boot_params;
    use vm_memory::{Bytes, GuestAddress};

    use crate::{
        config::{DiskConfig, DiskFormat, MAX_DISKS},
        devices::console::{ConsoleWorker, DEFAULT_QUEUE_BYTES},
        x86_boot_layout::PageSize,
    };

    let directory = tempfile::tempdir().unwrap();
    let kernel = directory.path().join("kernel.elf");
    std::fs::write(&kernel, crate::boot::elf::tests::fixture()).unwrap();
    let disks: Vec<_> = (0..MAX_DISKS)
        .map(|index| {
            let path = directory.path().join(format!("disk-{index}.raw"));
            std::fs::File::create(&path).unwrap().set_len(4096).unwrap();
            DiskConfig {
                path,
                format: DiskFormat::Raw,
                read_only: false,
            }
        })
        .collect();
    let mut configuration = config(1, 2);
    configuration.kernel = kernel;
    configuration.cmdline = "console=ttyS0".into();
    configuration.disks = disks;
    configuration.filesystem = Some(crate::FsConfig {
        tag: "aggregate-test".into(),
        shares: vec![crate::FsShareConfig {
            name: "BoxLiteShared".into(),
            path: directory.path().to_owned(),
            read_only: false,
        }],
    });
    let (writer, mut console) =
        ConsoleWorker::spawn(Box::new(io::sink()), DEFAULT_QUEUE_BYTES).unwrap();
    let leaf = PageSize::Mib.checked(false).unwrap();
    let vm = Vm::with_devices(
        configuration,
        || Ok(MockVm::new()),
        |ram, config| crate::boot::prepare(ram, config, leaf).map(|setup| setup.boot_regs),
        |chipset, ctx, config| crate::devices::add_all(chipset, ctx, config, writer),
    )
    .expect("real RTC and all configured virtio devices must compose without conflicts");

    let params: boot_params = vm
        .ram
        .memory()
        .read_obj(GuestAddress(vm.boot_regs.rsi))
        .unwrap();
    let mut line = vec![0; params.hdr.cmdline_size as usize];
    vm.ram
        .memory()
        .read_slice(&mut line, GuestAddress(params.hdr.cmd_line_ptr.into()))
        .unwrap();
    let line = std::ffi::CStr::from_bytes_with_nul(&line)
        .unwrap()
        .to_str()
        .unwrap();
    let (announcements, _) = line.split_once("console=ttyS0").unwrap();
    let announcements: Vec<_> = announcements.split_whitespace().collect();
    assert_eq!(announcements.len(), MAX_DISKS + 2);
    let gsis = [5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
    let chipset = vm.chipset.as_ref().unwrap();
    for (index, argument) in announcements.iter().enumerate() {
        let base = 0xd000_0000 + index as u64 * 0x1000;
        assert_eq!(
            *argument,
            format!("virtio_mmio.device=4K@{base:#x}:{}", gsis[index])
        );
        let read = |offset, bytes: &mut [u8]| {
            assert!(
                chipset
                    .dispatch(VcpuExit::MmioRead {
                        guest_addr: base + offset,
                        bytes,
                    })
                    .is_none()
            );
        };
        let mut id = [0; 4];
        read(8, &mut id);
        assert_eq!(
            u32::from_le_bytes(id),
            if index < MAX_DISKS {
                2
            } else if index == MAX_DISKS {
                5
            } else {
                26
            }
        );
    }
    // Register D's valid-RAM bit identifies the real CMOS device at its ports.
    chipset.dispatch(VcpuExit::IoOut {
        port: 0x70,
        bytes: &[0x0d],
    });
    let mut status = [0];
    chipset.dispatch(VcpuExit::IoIn {
        port: 0x71,
        bytes: &mut status,
    });
    assert_eq!(status, [0x80]);
    drop(vm);
    console.finish();
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
fn aggregate_filesystem_is_announced_and_exposes_its_transport_config() {
    use crate::devices::console::{ConsoleWorker, DEFAULT_QUEUE_BYTES};
    use boxlite_hypervisor::VcpuExit;
    let path = std::env::temp_dir().join(format!("boxlite-fs-wiring-{}", std::process::id()));
    std::fs::create_dir(&path).unwrap();
    let mut configuration = config(1, 2);
    configuration.filesystem = Some(crate::FsConfig {
        tag: "aggregate-test".into(),
        shares: vec![crate::FsShareConfig {
            name: "BoxLiteShared".into(),
            path: path.clone(),
            read_only: false,
        }],
    });
    let (writer, mut console) =
        ConsoleWorker::spawn(Box::new(io::sink()), DEFAULT_QUEUE_BYTES).unwrap();
    let vm = Vm::with_devices(
        configuration,
        || Ok(MockVm::new()),
        |_, config| {
            assert_eq!(
                config.cmdline,
                "virtio_mmio.device=4K@0xd0000000:5 \
                 virtio_mmio.device=4K@0xd0001000:6 console=ttyS0"
            );
            Ok(BootRegisters::default())
        },
        |chipset, ctx, config| crate::devices::add_all(chipset, ctx, config, writer).map(|_| ()),
    )
    .unwrap();
    let mut id = [0; 4];
    let chipset = vm.chipset.as_ref().unwrap();
    chipset.dispatch(VcpuExit::MmioRead {
        guest_addr: 0xd000_1008,
        bytes: &mut id,
    });
    assert_eq!(u32::from_le_bytes(id), 26);
    let mut tag = [0; 4];
    chipset.dispatch(VcpuExit::MmioRead {
        guest_addr: 0xd000_1100,
        bytes: &mut tag,
    });
    assert_eq!(&tag, b"aggr");
    drop(vm);
    console.finish();
    std::fs::remove_dir(path).unwrap();
}
