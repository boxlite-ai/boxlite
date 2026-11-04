// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Real Linux allocator reporting over KVM/MMIO. The host samples the RAM
//! mapping's residency while the guest moves through its phases, and takes the
//! phases from the guest's console markers, so nothing in the guest needs a
//! test-only kernel capability.

use super::*;
use crate::{
    devices::{balloon::VirtioBalloon, x86_64::BALLOON_MMIO},
    memory::{GuestMemoryMmap, ReclaimPolicy},
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, VirtioDevice,
        interrupt::MmioInterrupt,
        mmio::{MMIO_WINDOW_LEN, MmioResources, MmioTransport},
    },
};
use std::sync::atomic::AtomicBool;
use vm_memory::GuestMemoryBackend;

/// Where the guest is, as far as its console says.
const TOUCHED: u32 = 1;
const FREED: u32 = 2;

#[derive(Default, Debug)]
struct Evidence {
    negotiated: u64,
    phase: u32,
    /// Most pages resident while the guest held every page it touched.
    resident_touched: usize,
    /// Fewest pages resident while the guest's scratch pages were free.
    resident_freed: usize,
    reports: usize,
    reports_after_free: usize,
    activations: usize,
    resets: usize,
}

struct ObservedBalloon {
    inner: VirtioBalloon,
    spec: DeviceSpec,
    evidence: Arc<Mutex<Evidence>>,
    used: Option<(Arc<GuestMemoryMmap>, GuestAddress)>,
}

impl VirtioDevice for ObservedBalloon {
    fn spec(&self) -> &DeviceSpec {
        &self.spec
    }
    fn set_features(&mut self, features: u64) -> Result<(), FeatureError> {
        self.evidence.lock().unwrap().negotiated = features;
        self.inner.set_features(features)
    }
    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        self.inner.read_config(offset, data)
    }
    fn write_config(&mut self, offset: u64, data: &[u8]) -> Result<(), DeviceError> {
        self.inner.write_config(offset, data)
    }
    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        // Only queue 2 is optional. Its used ring is the ninth control range.
        self.used = ctx
            .queues
            .control_ranges()
            .nth(8)
            .map(|(address, _)| (ctx.memory.clone(), GuestAddress(address.0 + 2)));
        self.inner.activate(ctx)?;
        self.evidence.lock().unwrap().activations += 1;
        Ok(())
    }
    fn reset(&mut self) -> Result<(), DeviceError> {
        self.inner.reset()?;
        self.used = None;
        self.evidence.lock().unwrap().resets += 1;
        Ok(())
    }
    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        let before = self
            .used
            .as_ref()
            .map(|(memory, address)| u16::from_le(memory.read_obj::<u16>(*address).unwrap()));
        self.inner.on_event(event)?;
        if let (Some(before), Some((memory, address))) = (before, self.used.as_ref()) {
            let after = u16::from_le(memory.read_obj::<u16>(*address).unwrap());
            let completed = usize::from(after.wrapping_sub(before));
            let mut evidence = self.evidence.lock().unwrap();
            evidence.reports += completed;
            if evidence.phase == 2 {
                evidence.reports_after_free += completed;
            }
        }
        Ok(())
    }
}

/// The guest's phase, read from the markers it prints.
fn phase_of(log: &str) -> u32 {
    if log.contains("BALLOON_REUSED") {
        3
    } else if log.contains("BALLOON_FREED") {
        FREED
    } else if log.contains("BALLOON_TOUCHED") {
        TOUCHED
    } else {
        0
    }
}

/// One byte per 4 KiB host page of the guest mapping, set when the page is
/// resident. Sampling repeats instead of catching an exact instant, so a slow
/// host cannot turn a passing guest into a failure.
fn residency(memory: &GuestMemoryMmap) -> Vec<u8> {
    let size = 256usize << 20;
    let pointer = memory.get_host_address(GuestAddress(0)).unwrap();
    let mut pages = vec![0; size / 4096];
    // SAFETY: this is the live, page-aligned private RAM mapping, and the
    // result has one byte per host page. mincore never changes its contents.
    assert_eq!(
        unsafe { libc::mincore(pointer.cast(), size, pages.as_mut_ptr()) },
        0
    );
    pages
}

fn resident(pages: &[u8]) -> usize {
    pages.iter().filter(|&&state| state & 1 != 0).count()
}

/// Records the residency that belongs to each guest phase until `stop` is set.
fn sample(
    log: &SerialLog,
    memory: &GuestMemoryMmap,
    evidence: &Mutex<Evidence>,
    stop: &AtomicBool,
) {
    while !stop.load(Ordering::SeqCst) {
        let phase = phase_of(&log.text());
        let count = resident(&residency(memory));
        let mut evidence = evidence.lock().unwrap();
        evidence.phase = phase;
        match phase {
            TOUCHED if count > evidence.resident_touched => evidence.resident_touched = count,
            FREED if count < evidence.resident_freed => evidence.resident_freed = count,
            _ => {}
        }
        drop(evidence);
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn run_reporting_guest(enabled: bool, init_on_free: bool) {
    let host_page = crate::memory::host_page_size().unwrap();
    assert_eq!(host_page, 4096, "x86_64 qualification uses 4 KiB PFNs");
    let init = fs::read(
        std::env::var_os("VMM_BALLOON_INIT")
            .expect("use make test:integration:vmm:linux for the guest init"),
    )
    .unwrap();
    let initramfs = TempFile::new(
        if enabled {
            "balloon-on.cpio"
        } else {
            "balloon-off.cpio"
        },
        &newc_archive("init", &init),
    );
    let log = SerialLog::default();
    let (writer, mut console) =
        ConsoleWorker::spawn(Box::new(log.clone()), DEFAULT_QUEUE_BYTES).unwrap();
    let evidence = Arc::new(Mutex::new(Evidence::default()));
    let mut cmdline = CONSOLE_CMDLINE.to_owned();
    BALLOON_MMIO.append_cmdline(&mut cmdline);
    if init_on_free {
        cmdline.push_str(" init_on_free=1");
    }
    let config = linux_config(1, &cmdline, Some(initramfs.0.clone()));
    let mut sampler_memory = None;
    let mut vm = crate::Vm::with_backend(
        config,
        boxlite_hypervisor::KvmVm::new,
        |ram, config| prepare(ram, config).map(|setup| setup.boot_regs),
        |builder, context| {
            add_legacy_devices(builder, writer)?;
            let inner =
                VirtioBalloon::new(ReclaimPolicy::Immediate).map_err(Error::CreateBalloon)?;
            let mut spec = *inner.spec();
            if !enabled && !init_on_free {
                spec.features = 0;
            }
            let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(ObservedBalloon {
                inner,
                spec,
                evidence: evidence.clone(),
                used: None,
            }));
            builder.add("balloon", |resources| {
                resources.mmio(BALLOON_MMIO.base, MMIO_WINDOW_LEN);
                let interrupt = Arc::new(MmioInterrupt::new(resources.line(BALLOON_MMIO.irq)));
                let worker = context.workers.add(device.clone(), interrupt.clone());
                sampler_memory = Some(Arc::clone(context.memory));
                MmioTransport::new(
                    device,
                    interrupt,
                    MmioResources {
                        memory: context.memory.clone(),
                        sender: resources.event_sender(),
                        worker,
                    },
                )
            })
        },
    )
    .unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let memory = sampler_memory.expect("the balloon device holds the RAM");
        let log = log.clone();
        let evidence = Arc::clone(&evidence);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || sample(&log, &memory, &evidence, &stop))
    };
    let (exit, elapsed) = run_with_watchdog(&mut vm, Duration::from_secs(35));
    stop.store(true, Ordering::SeqCst);
    sampler.join().unwrap();
    console.finish();
    let log = log.text();
    let evidence = evidence.lock().unwrap();
    eprintln!(
        "balloon KVM enabled={enabled}, init_on_free={init_on_free}, elapsed={elapsed:?}, resident={}/{}, reports={}\n{log}",
        evidence.resident_freed, evidence.resident_touched, evidence.reports
    );
    assert_eq!(exit.unwrap(), VmExit::GuestReset, "{log}");
    assert!(log.contains("BALLOON_GUEST_OK"), "{log}");
    assert!(!log.contains("BALLOON_FAIL"), "{log}");
    for marker in ["BALLOON_TOUCHED", "BALLOON_FREED", "BALLOON_REUSED"] {
        assert!(log.contains(marker), "{marker} missing: {log}");
    }
    assert!(
        evidence.activations >= 2,
        "guest unbind/bind must reactivate"
    );
    assert!(evidence.resets >= 1, "guest unbind must reset");
    assert_eq!(evidence.negotiated & (1 << 5) != 0, enabled);
    // The guest touches 64 MiB of scratch and 16 MiB of live pages.
    assert!(
        evidence.resident_touched >= 80 << 20 >> 12,
        "the sampled residency must cover the pages the guest touched: {}",
        evidence.resident_touched
    );
    if enabled {
        assert!(
            evidence.resident_freed < evidence.resident_touched / 2,
            "reporting must drop the freed scratch pages: {} of {}",
            evidence.resident_freed,
            evidence.resident_touched
        );
        assert!(
            evidence.reports_after_free > 0,
            "real used-ring completions after munmap"
        );
    } else {
        // Host reclaim or swap can evict guest RAM independently of the
        // device, so residency is logged, not asserted. The device must still
        // complete no report when reporting is disabled.
        assert_eq!(evidence.reports, 0);
    }
    eprintln!(
        "BALLOON_KVM_RESULT reporting={enabled} init_on_free={init_on_free} guest=6.12.110 host_page={host_page} resident_touched={} resident_freed={} reports={} reports_after_free={} activations={} resets={}",
        evidence.resident_touched,
        evidence.resident_freed,
        evidence.reports,
        evidence.reports_after_free,
        evidence.activations,
        evidence.resets
    );
}

#[test]
#[ignore = "requires Linux x86_64 KVM, reporting VMM_KERNEL and VMM_BALLOON_INIT"]
fn balloon_reporting_reclaims_and_reuses_guest_memory() {
    run_reporting_guest(true, false);
}

#[test]
#[ignore = "requires Linux x86_64 KVM, reporting VMM_KERNEL and VMM_BALLOON_INIT"]
fn balloon_without_reporting_produces_no_report_completions() {
    run_reporting_guest(false, false);
}

#[test]
#[ignore = "requires Linux x86_64 KVM, reporting VMM_KERNEL and VMM_BALLOON_INIT"]
fn balloon_init_on_free_disables_reporting_without_weakening_security() {
    run_reporting_guest(false, true);
}
