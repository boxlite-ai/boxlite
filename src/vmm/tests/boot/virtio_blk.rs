// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A real Linux virtio-blk driver over the virtio-mmio transport and the
//! virtio workers, booted on KVM through `Vm::new`. The guest reads sector 0,
//! writes sector 1, syncs, unbinds and rebinds the driver (Status=0, then a
//! fresh DRIVER_OK) and reads sector 1 back through the re-activated device,
//! on a raw disk and on a qcow2 disk over a raw backing file.

use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};

use imago::{
    FormatCreateBuilder, Storage, StorageCreateOptions, file::File as ImagoFile, qcow2::Qcow2,
};

use super::{
    BOOT_TIMEOUT, CONSOLE_CMDLINE, SerialLog, TempFile, linux_config, newc_archive,
    run_with_watchdog, static_program,
};
use crate::{
    VmExit,
    chipset::ChipsetBuilder,
    config::{DiskConfig, DiskFormat},
    devices::{
        console::{ConsoleWorker, DEFAULT_QUEUE_BYTES},
        x86_64::add_legacy_devices,
    },
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, VirtioDevice,
        VirtioInterrupt,
        blk::{
            VIRTIO_BLK_S_OK,
            backend::{DiskBackend, Outcome, Request, RequestKind},
            device::VirtioBlk,
            imago::ImagoBackend,
        },
        interrupt::MmioInterrupt,
        mmio::{MMIO_WINDOW_LEN, MmioResources, MmioTransport, Slot, Slots, announce},
    },
    vm::DeviceContext,
};

/// The image: 1 MiB, sector 0 starts with `MAGIC` and carries one MBR
/// partition so the kernel's partition scan reads it at probe time.
const IMAGE_SECTORS: u64 = 2048;
const MAGIC: &[u8; 8] = b"BLKEXP01";
const OK_MARKER: &str = "BOXLITE_BLK_OK";
const FAIL_MARKER: &str = "BOXLITE_BLK_FAIL";
/// The byte the init writes over sector 1.
const PATTERN: u8 = 0x5a;

/// The init, assembled from `blk_init.s` beside this file with `as --64` and
/// `objcopy -O binary -j .text`. Every path and message is RIP-relative, so
/// the code runs wherever `static_program` loads it. It prints
/// `BOXLITE_BLK_OK`, or `BOXLITE_BLK_FAIL <step>` where step 1..=13 is the
/// syscall that failed (10..=13 print as `:;<=`), drains the tty and
/// restarts the machine.
#[rustfmt::skip]
const BLK_INIT: [u8; 831] = [
        0x48, 0x81, 0xec, 0x00, 0x04, 0x00, 0x00, 0x48, 0x89, 0xe3, 0x41, 0xbd, 0x01, 0x00, 0x00, 0x00,
        0xb8, 0x53, 0x00, 0x00, 0x00, 0x48, 0x8d, 0x3d, 0x80, 0x02, 0x00, 0x00, 0xbe, 0xed, 0x01, 0x00,
        0x00, 0x0f, 0x05, 0xb8, 0xa5, 0x00, 0x00, 0x00, 0x48, 0x8d, 0x3d, 0x72, 0x02, 0x00, 0x00, 0x48,
        0x8d, 0x35, 0x66, 0x02, 0x00, 0x00, 0x48, 0x8d, 0x15, 0x64, 0x02, 0x00, 0x00, 0x45, 0x31, 0xd2,
        0x45, 0x31, 0xc0, 0x0f, 0x05, 0x48, 0x85, 0xc0, 0x0f, 0x85, 0x98, 0x01, 0x00, 0x00, 0x41, 0xbd,
        0x02, 0x00, 0x00, 0x00, 0xb8, 0x53, 0x00, 0x00, 0x00, 0x48, 0x8d, 0x3d, 0x4a, 0x02, 0x00, 0x00,
        0xbe, 0xed, 0x01, 0x00, 0x00, 0x0f, 0x05, 0xb8, 0xa5, 0x00, 0x00, 0x00, 0x48, 0x8d, 0x3d, 0x3c,
        0x02, 0x00, 0x00, 0x48, 0x8d, 0x35, 0x30, 0x02, 0x00, 0x00, 0x48, 0x8d, 0x15, 0x2e, 0x02, 0x00,
        0x00, 0x45, 0x31, 0xd2, 0x45, 0x31, 0xc0, 0x0f, 0x05, 0x48, 0x85, 0xc0, 0x0f, 0x85, 0x54, 0x01,
        0x00, 0x00, 0x41, 0xbd, 0x03, 0x00, 0x00, 0x00, 0xb8, 0x02, 0x00, 0x00, 0x00, 0x48, 0x8d, 0x3d,
        0x11, 0x02, 0x00, 0x00, 0xbe, 0x02, 0x00, 0x00, 0x00, 0x31, 0xd2, 0x0f, 0x05, 0x48, 0x85, 0xc0,
        0x0f, 0x88, 0x30, 0x01, 0x00, 0x00, 0x49, 0x89, 0xc4, 0x41, 0xbd, 0x04, 0x00, 0x00, 0x00, 0x31,
        0xc0, 0x4c, 0x89, 0xe7, 0x48, 0x89, 0xde, 0xba, 0x00, 0x02, 0x00, 0x00, 0x0f, 0x05, 0x48, 0x3d,
        0x00, 0x02, 0x00, 0x00, 0x0f, 0x85, 0x0c, 0x01, 0x00, 0x00, 0x41, 0xbd, 0x05, 0x00, 0x00, 0x00,
        0x48, 0x8b, 0x05, 0x30, 0x02, 0x00, 0x00, 0x48, 0x39, 0x03, 0x0f, 0x85, 0xf6, 0x00, 0x00, 0x00,
        0x48, 0x89, 0xdf, 0xb0, 0x5a, 0xb9, 0x00, 0x02, 0x00, 0x00, 0xf3, 0xaa, 0x41, 0xbd, 0x06, 0x00,
        0x00, 0x00, 0xb8, 0x01, 0x00, 0x00, 0x00, 0x4c, 0x89, 0xe7, 0x48, 0x89, 0xde, 0xba, 0x00, 0x02,
        0x00, 0x00, 0x0f, 0x05, 0x48, 0x3d, 0x00, 0x02, 0x00, 0x00, 0x0f, 0x85, 0xc6, 0x00, 0x00, 0x00,
        0x41, 0xbd, 0x07, 0x00, 0x00, 0x00, 0xb8, 0x4a, 0x00, 0x00, 0x00, 0x4c, 0x89, 0xe7, 0x0f, 0x05,
        0x48, 0x85, 0xc0, 0x0f, 0x85, 0xad, 0x00, 0x00, 0x00, 0xb8, 0x03, 0x00, 0x00, 0x00, 0x4c, 0x89,
        0xe7, 0x0f, 0x05, 0x41, 0xbd, 0x08, 0x00, 0x00, 0x00, 0x48, 0x8d, 0x3d, 0x6e, 0x01, 0x00, 0x00,
        0xe8, 0x02, 0x01, 0x00, 0x00, 0x41, 0xbd, 0x09, 0x00, 0x00, 0x00, 0x48, 0x8d, 0x3d, 0x86, 0x01,
        0x00, 0x00, 0xe8, 0xf0, 0x00, 0x00, 0x00, 0x41, 0xbd, 0x0a, 0x00, 0x00, 0x00, 0xb8, 0x02, 0x00,
        0x00, 0x00, 0x48, 0x8d, 0x3d, 0x3c, 0x01, 0x00, 0x00, 0x31, 0xf6, 0x31, 0xd2, 0x0f, 0x05, 0x48,
        0x85, 0xc0, 0x78, 0x62, 0x49, 0x89, 0xc4, 0x41, 0xbd, 0x0b, 0x00, 0x00, 0x00, 0xb8, 0x08, 0x00,
        0x00, 0x00, 0x4c, 0x89, 0xe7, 0xbe, 0x00, 0x02, 0x00, 0x00, 0x31, 0xd2, 0x0f, 0x05, 0x48, 0x3d,
        0x00, 0x02, 0x00, 0x00, 0x75, 0x40, 0x41, 0xbd, 0x0c, 0x00, 0x00, 0x00, 0x31, 0xc0, 0x4c, 0x89,
        0xe7, 0x48, 0x89, 0xde, 0xba, 0x00, 0x02, 0x00, 0x00, 0x0f, 0x05, 0x48, 0x3d, 0x00, 0x02, 0x00,
        0x00, 0x75, 0x23, 0x41, 0xbd, 0x0d, 0x00, 0x00, 0x00, 0x48, 0xb8, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a,
        0x5a, 0x5a, 0x5a, 0x48, 0x39, 0x03, 0x75, 0x0e, 0x48, 0x8d, 0x35, 0x40, 0x01, 0x00, 0x00, 0xba,
        0x0f, 0x00, 0x00, 0x00, 0xeb, 0x2a, 0x48, 0x8d, 0x35, 0x41, 0x01, 0x00, 0x00, 0xba, 0x11, 0x00,
        0x00, 0x00, 0xb8, 0x01, 0x00, 0x00, 0x00, 0xbf, 0x01, 0x00, 0x00, 0x00, 0x0f, 0x05, 0x41, 0x8d,
        0x45, 0x30, 0x88, 0x03, 0xc6, 0x43, 0x01, 0x0a, 0x48, 0x89, 0xde, 0xba, 0x02, 0x00, 0x00, 0x00,
        0xb8, 0x01, 0x00, 0x00, 0x00, 0xbf, 0x01, 0x00, 0x00, 0x00, 0x0f, 0x05, 0xb8, 0x10, 0x00, 0x00,
        0x00, 0xbf, 0x01, 0x00, 0x00, 0x00, 0xbe, 0x09, 0x54, 0x00, 0x00, 0xba, 0x01, 0x00, 0x00, 0x00,
        0x0f, 0x05, 0xb8, 0xa9, 0x00, 0x00, 0x00, 0xbf, 0xad, 0xde, 0xe1, 0xfe, 0xbe, 0x69, 0x19, 0x12,
        0x28, 0xba, 0x67, 0x45, 0x23, 0x01, 0x45, 0x31, 0xd2, 0x0f, 0x05, 0xb8, 0xe7, 0x00, 0x00, 0x00,
        0xbf, 0x01, 0x00, 0x00, 0x00, 0x0f, 0x05, 0xb8, 0x02, 0x00, 0x00, 0x00, 0xbe, 0x01, 0x00, 0x00,
        0x00, 0x31, 0xd2, 0x0f, 0x05, 0x48, 0x85, 0xc0, 0x0f, 0x88, 0x78, 0xff, 0xff, 0xff, 0x49, 0x89,
        0xc4, 0xb8, 0x01, 0x00, 0x00, 0x00, 0x4c, 0x89, 0xe7, 0x48, 0x8d, 0x35, 0x90, 0x00, 0x00, 0x00,
        0xba, 0x07, 0x00, 0x00, 0x00, 0x0f, 0x05, 0x48, 0x83, 0xf8, 0x07, 0x0f, 0x85, 0x55, 0xff, 0xff,
        0xff, 0xb8, 0x03, 0x00, 0x00, 0x00, 0x4c, 0x89, 0xe7, 0x0f, 0x05, 0xc3, 0x2f, 0x64, 0x65, 0x76,
        0x00, 0x64, 0x65, 0x76, 0x74, 0x6d, 0x70, 0x66, 0x73, 0x00, 0x2f, 0x73, 0x79, 0x73, 0x00, 0x73,
        0x79, 0x73, 0x66, 0x73, 0x00, 0x2f, 0x64, 0x65, 0x76, 0x2f, 0x76, 0x64, 0x61, 0x00, 0x2f, 0x73,
        0x79, 0x73, 0x2f, 0x62, 0x75, 0x73, 0x2f, 0x76, 0x69, 0x72, 0x74, 0x69, 0x6f, 0x2f, 0x64, 0x72,
        0x69, 0x76, 0x65, 0x72, 0x73, 0x2f, 0x76, 0x69, 0x72, 0x74, 0x69, 0x6f, 0x5f, 0x62, 0x6c, 0x6b,
        0x2f, 0x75, 0x6e, 0x62, 0x69, 0x6e, 0x64, 0x00, 0x2f, 0x73, 0x79, 0x73, 0x2f, 0x62, 0x75, 0x73,
        0x2f, 0x76, 0x69, 0x72, 0x74, 0x69, 0x6f, 0x2f, 0x64, 0x72, 0x69, 0x76, 0x65, 0x72, 0x73, 0x2f,
        0x76, 0x69, 0x72, 0x74, 0x69, 0x6f, 0x5f, 0x62, 0x6c, 0x6b, 0x2f, 0x62, 0x69, 0x6e, 0x64, 0x00,
        0x76, 0x69, 0x72, 0x74, 0x69, 0x6f, 0x30, 0x42, 0x4c, 0x4b, 0x45, 0x58, 0x50, 0x30, 0x31, 0x42,
        0x4f, 0x58, 0x4c, 0x49, 0x54, 0x45, 0x5f, 0x42, 0x4c, 0x4b, 0x5f, 0x4f, 0x4b, 0x0a, 0x42, 0x4f,
        0x58, 0x4c, 0x49, 0x54, 0x45, 0x5f, 0x42, 0x4c, 0x4b, 0x5f, 0x46, 0x41, 0x49, 0x4c, 0x20,
];

fn blk_program() -> Vec<u8> {
    static_program(&BLK_INIT)
}

/// The raw image bytes the guest expects.
fn raw_image_bytes() -> Vec<u8> {
    let mut image = vec![0u8; (IMAGE_SECTORS * 512) as usize];
    image[..MAGIC.len()].copy_from_slice(MAGIC);
    // One MBR entry: type 0x83, LBA 1, every remaining sector.
    let entry = &mut image[446..462];
    entry[4] = 0x83;
    entry[8..12].copy_from_slice(&1u32.to_le_bytes());
    entry[12..16].copy_from_slice(&((IMAGE_SECTORS - 1) as u32).to_le_bytes());
    image[510] = 0x55;
    image[511] = 0xaa;
    image
}

/// The raw image the device serves.
fn raw_image(name: &str) -> TempFile {
    TempFile::new(name, &raw_image_bytes())
}

/// A qcow2 image over `backing`, created with imago, in the same directory.
fn qcow2_over(backing: &Path, name: &str) -> TempFile {
    let image = TempFile::new(name, &[]);
    let file = ImagoFile::create_open(
        StorageCreateOptions::new()
            .filename(&image.0)
            .size(0)
            .overwrite(true),
    )
    .expect("create the qcow2 file");
    Qcow2::<ImagoFile>::create_builder(file)
        .size(IMAGE_SECTORS * 512)
        .backing(
            backing.file_name().unwrap().to_str().unwrap().to_owned(),
            "raw".to_owned(),
        )
        .create()
        .expect("format the qcow2 image");
    image
}

/// What the framework did to the device, as seen from the device side.
#[derive(Clone, Default)]
struct Observed {
    feature_calls: Arc<AtomicUsize>,
    activations: Arc<AtomicUsize>,
    resets: Arc<AtomicUsize>,
    event_threads: Arc<Mutex<Vec<String>>>,
}

/// The block device, recording the contract calls the framework makes.
struct Recording {
    inner: VirtioBlk,
    observed: Observed,
}

impl VirtioDevice for Recording {
    fn spec(&self) -> &DeviceSpec {
        self.inner.spec()
    }

    fn set_features(&mut self, negotiated: u64) -> Result<(), FeatureError> {
        self.observed.feature_calls.fetch_add(1, Ordering::Relaxed);
        self.inner.set_features(negotiated)
    }

    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        self.inner.read_config(offset, data)
    }

    fn write_config(&mut self, offset: u64, data: &[u8]) -> Result<(), DeviceError> {
        self.inner.write_config(offset, data)
    }

    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        self.observed.activations.fetch_add(1, Ordering::Relaxed);
        self.inner.activate(ctx)
    }

    fn reset(&mut self) -> Result<(), DeviceError> {
        self.observed.resets.fetch_add(1, Ordering::Relaxed);
        self.inner.reset()
    }

    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        let name = thread::current().name().unwrap_or("<unnamed>").to_owned();
        self.observed.event_threads.lock().unwrap().push(name);
        self.inner.on_event(event)
    }

    fn quiesce(&mut self) -> Result<(), DeviceError> {
        self.inner.quiesce()
    }
}

/// KVM, counting the rising edges of every interrupt line.
struct LineCounter {
    kvm: boxlite_hypervisor::KvmVm,
    edges: Arc<Mutex<Vec<(u32, usize)>>>,
}

/// The rising edges `edges` counted on `line`.
fn edges_on(edges: &Mutex<Vec<(u32, usize)>>, line: u32) -> usize {
    edges
        .lock()
        .unwrap()
        .iter()
        .find(|(l, _)| *l == line)
        .map_or(0, |(_, n)| *n)
}

impl boxlite_hypervisor::Vm for LineCounter {
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
        if level {
            let mut edges = self.edges.lock().unwrap();
            match edges.iter_mut().find(|(l, _)| *l == line) {
                Some((_, n)) => *n += 1,
                None => edges.push((line, 1)),
            }
        }
        boxlite_hypervisor::Vm::set_irq_line(&self.kvm, line, level)
    }
}

impl boxlite_hypervisor::X86Vm for LineCounter {
    fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
        boxlite_hypervisor::X86Vm::supported_cpuid(&self.kvm)
    }
}

/// Adds `device` behind a virtio-mmio transport in `slot`, as `add_disks`
/// does for a configured disk.
fn add_blk(
    chipset: &mut ChipsetBuilder,
    ctx: DeviceContext<'_>,
    device: Arc<Mutex<dyn VirtioDevice>>,
    slot: Slot,
) -> crate::Result<()> {
    chipset.add("virtio-blk", |resources| {
        resources.mmio(slot.base, MMIO_WINDOW_LEN);
        let interrupt = Arc::new(MmioInterrupt::new(resources.line(slot.gsi)));
        let worker = ctx.workers.add(
            Arc::clone(&device),
            Arc::clone(&interrupt) as Arc<dyn VirtioInterrupt>,
        );
        MmioTransport::new(
            device,
            interrupt,
            MmioResources {
                memory: Arc::clone(ctx.memory),
                sender: resources.event_sender(),
                worker,
            },
        )
    })
}

/// Asserts the guest reached `BOXLITE_BLK_OK` and wrote sector 1 of `image`.
fn assert_guest_passed(exit: crate::Result<VmExit>, log: &str, image: &Path) {
    assert!(
        matches!(exit, Ok(VmExit::GuestReset)),
        "{exit:?}; log:\n{log}"
    );
    assert!(
        log.lines().any(|line| line.trim_end() == OK_MARKER),
        "no {OK_MARKER} line in:\n{log}"
    );
    assert!(!log.contains(FAIL_MARKER), "the init failed:\n{log}");
    let bytes = std::fs::read(image).unwrap();
    assert_eq!(&bytes[..MAGIC.len()], MAGIC, "sector 0 changed");
    assert!(
        bytes[512..1024].iter().all(|&b| b == PATTERN),
        "sector 1 was not written: {:02x?}",
        &bytes[512..528]
    );
}

/// Boots the real kernel with the block device on the workers. The guest
/// drives the whole contract: negotiation, activation, kicks, completions,
/// interrupts, a Status=0 reset and a second activation.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_and_drives_virtio_blk_through_the_workers() {
    let image = raw_image("blk.raw");
    let archive = newc_archive("init", &blk_program());
    let initramfs = TempFile::new("blk.cpio", &archive);
    let log = SerialLog::default();
    let mut config = linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone()));
    let slot = Slots::new().take().unwrap();
    announce(&mut config.cmdline, &[slot]).unwrap();

    let observed = Observed::default();
    let backend = ImagoBackend::open(&image.0, DiskFormat::Raw, false).expect("open the image");
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(Recording {
        inner: VirtioBlk::new(Box::new(backend)),
        observed: observed.clone(),
    }));
    let edges = Arc::new(Mutex::new(Vec::new()));
    let (writer, mut console) =
        ConsoleWorker::spawn(Box::new(log.clone()), DEFAULT_QUEUE_BYTES).unwrap();
    let counter_edges = Arc::clone(&edges);
    let mut vm = crate::Vm::with_backend(
        config,
        || {
            Ok(LineCounter {
                kvm: boxlite_hypervisor::KvmVm::new()?,
                edges: counter_edges,
            })
        },
        |ram, config| crate::boot::prepare(ram, config).map(|setup| setup.boot_regs),
        |chipset, ctx| {
            add_legacy_devices(chipset, writer)?;
            add_blk(chipset, ctx, device, slot)
        },
    )
    .expect("create the KVM VM");

    let (exit, elapsed) = run_with_watchdog(&mut vm, BOOT_TIMEOUT);
    console.finish();
    let log = log.text();
    assert_guest_passed(exit, &log, &image.0);
    assert!(
        log.contains("[vda] 2048 512-byte logical blocks"),
        "no virtio-blk probe line in:\n{log}"
    );
    assert!(
        log.contains(" vda: vda1"),
        "no partition scan line in:\n{log}"
    );
    assert_eq!(
        observed.activations.load(Ordering::Relaxed),
        2,
        "activations"
    );
    assert!(
        observed.resets.load(Ordering::Relaxed) >= 1,
        "no Status=0 reset"
    );
    assert_eq!(
        observed.feature_calls.load(Ordering::Relaxed),
        2,
        "set_features calls"
    );
    let threads = observed.event_threads.lock().unwrap().clone();
    assert!(!threads.is_empty(), "no on_event call");
    assert!(
        threads.iter().all(|name| name == "virtio-worker"),
        "events ran off the worker thread: {threads:?}"
    );
    let blk_edges = edges_on(&edges, slot.gsi);
    assert!(blk_edges > 0, "no interrupt on GSI {}", slot.gsi);
    eprintln!(
        "blk on the workers: {elapsed:?}, {} events, {blk_edges} GSI {} edges, {} resets, {} console bytes dropped",
        threads.len(),
        slot.gsi,
        observed.resets.load(Ordering::Relaxed),
        console.dropped_bytes()
    );
}

/// The same guest through the public API alone: `VmConfig::disks` names a
/// raw image, `Vm::new` adds the device and announces it on the command
/// line.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_with_a_raw_virtio_disk_through_the_public_api() {
    let image = raw_image("blk-public.raw");
    let archive = newc_archive("init", &blk_program());
    let initramfs = TempFile::new("blk-public.cpio", &archive);
    let log = SerialLog::default();
    let mut config = linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone()));
    config.disks = vec![DiskConfig {
        path: image.0.clone(),
        format: DiskFormat::Raw,
        read_only: false,
    }];
    let mut vm = crate::Vm::new(config, Box::new(log.clone())).expect("create the VM");

    let (exit, elapsed) = run_with_watchdog(&mut vm, BOOT_TIMEOUT);

    let log = log.text();
    assert!(
        log.contains(
            "virtio-mmio: Registering device virtio-mmio.0 at 0xd0000000-0xd0000fff, IRQ 5."
        ),
        "the kernel did not take the generated device parameter:\n{log}"
    );
    assert_guest_passed(exit, &log, &image.0);
    eprintln!("blk public API, raw: {elapsed:?}");
}

/// A qcow2 disk over a raw backing file: the guest reads sector 0 through
/// to the backing file, and its write lands in the qcow2 image alone.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm and VMM_KERNEL naming an x86_64 vmlinux"]
fn boots_linux_with_a_qcow2_virtio_disk_over_a_backing_file() {
    let backing = raw_image("blk-backing.raw");
    let image = qcow2_over(&backing.0, "blk-overlay.qcow2");
    let backing_before = std::fs::read(&backing.0).unwrap();
    let image_before = std::fs::metadata(&image.0).unwrap().len();
    let archive = newc_archive("init", &blk_program());
    let initramfs = TempFile::new("blk-qcow2.cpio", &archive);
    let log = SerialLog::default();
    let mut config = linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone()));
    config.disks = vec![DiskConfig {
        path: image.0.clone(),
        format: DiskFormat::Qcow2,
        read_only: false,
    }];
    let mut vm = crate::Vm::new(config, Box::new(log.clone())).expect("create the VM");

    let (exit, elapsed) = run_with_watchdog(&mut vm, BOOT_TIMEOUT);
    drop(vm);

    let log = log.text();
    assert!(
        matches!(exit, Ok(VmExit::GuestReset)),
        "{exit:?} after {elapsed:?}; log:\n{log}"
    );
    assert!(
        log.lines().any(|line| line.trim_end() == OK_MARKER),
        "no {OK_MARKER} line in:\n{log}"
    );
    assert!(!log.contains(FAIL_MARKER), "the init failed:\n{log}");
    assert_eq!(
        std::fs::read(&backing.0).unwrap(),
        backing_before,
        "the backing file changed"
    );
    assert!(
        std::fs::metadata(&image.0).unwrap().len() > image_before,
        "the qcow2 image did not grow"
    );
    // Read sector 1 through the backend the device uses, so the qcow2
    // metadata is decoded rather than the raw file.
    let mut backend = ImagoBackend::open(&image.0, DiskFormat::Qcow2, true).unwrap();
    let request = Request {
        kind: RequestKind::In {
            offset: 512,
            buf: vec![0u8; 512],
        },
    };
    let Outcome::Done(completed) = backend.submit(0, request) else {
        panic!("the imago backend completes inline");
    };
    assert_eq!(completed.status, VIRTIO_BLK_S_OK);
    let RequestKind::In { buf, .. } = completed.request.kind else {
        panic!("the request comes back");
    };
    assert!(
        buf.iter().all(|&b| b == PATTERN),
        "sector 1 was not written: {:02x?}",
        &buf[..16]
    );
    eprintln!("blk public API, qcow2: {elapsed:?}");
}
