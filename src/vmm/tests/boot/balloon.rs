// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Real Linux allocator reporting over KVM/MMIO, with exact-PFN residency
//! observations. The observation port is test-only; it never reclaims memory.

use super::*;
use crate::{
    bus::BusDevice,
    devices::{balloon::VirtioBalloon, x86_64::BALLOON_MMIO},
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, DeviceSpec, FeatureError, VirtioDevice,
        interrupt::MmioInterrupt,
        mmio::{MMIO_WINDOW_LEN, MmioResources, MmioTransport},
    },
};
use vm_memory::GuestMemoryBackend;

#[derive(Default, Debug)]
struct Evidence {
    enabled: bool,
    negotiated: u64,
    phase: u32,
    phases: Vec<u32>,
    scratch: Vec<u32>,
    live: Vec<u32>,
    before: usize,
    after: usize,
    live_after: usize,
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

struct Observer {
    memory: Arc<GuestMemoryMmap>,
    evidence: Arc<Mutex<Evidence>>,
}

impl Observer {
    fn residency(&self) -> Vec<u8> {
        let size = 256usize << 20;
        let pointer = self.memory.get_host_address(GuestAddress(0)).unwrap();
        let mut pages = vec![0; size / 4096];
        // SAFETY: this is the live, page-aligned private RAM mapping, and the
        // result has one byte per host page. mincore never changes its contents.
        assert_eq!(
            unsafe { libc::mincore(pointer.cast(), size, pages.as_mut_ptr()) },
            0
        );
        pages
    }
}

impl BusDevice for Observer {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        assert_eq!((offset, data.len()), (0, 4));
        let pages = self.residency();
        let mut evidence = self.evidence.lock().unwrap();
        assert_eq!(evidence.phase, 2);
        evidence.after = evidence
            .scratch
            .iter()
            .filter(|&&gpa| pages[gpa as usize / 4096] & 1 != 0)
            .count();
        evidence.live_after = evidence
            .live
            .iter()
            .filter(|&&gpa| pages[gpa as usize / 4096] & 1 != 0)
            .count();
        let reclaimed = evidence.after < evidence.before / 2;
        let expected = reclaimed == evidence.enabled
            && evidence.live_after == evidence.live.len()
            && (!evidence.enabled || evidence.reports_after_free > 0);
        data.copy_from_slice(&u32::from(expected).to_le_bytes());
    }
    fn write(&mut self, offset: u64, data: &[u8]) {
        let value = u32::from_le_bytes(data.try_into().unwrap());
        if offset == 0 && value == 1 {
            let pages = self.residency();
            let mut evidence = self.evidence.lock().unwrap();
            evidence.before = evidence
                .scratch
                .iter()
                .filter(|&&gpa| pages[gpa as usize / 4096] & 1 != 0)
                .count();
        }
        let mut evidence = self.evidence.lock().unwrap();
        match offset {
            0 => {
                evidence.phase = value;
                evidence.phases.push(value);
            }
            4 => evidence.scratch.push(value),
            8 => evidence.live.push(value),
            _ => panic!("unexpected observation port {offset}"),
        }
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
    let evidence = Arc::new(Mutex::new(Evidence {
        enabled,
        ..Evidence::default()
    }));
    let mut cmdline = CONSOLE_CMDLINE.to_owned();
    BALLOON_MMIO.append_cmdline(&mut cmdline);
    if init_on_free {
        cmdline.push_str(" init_on_free=1");
    }
    let config = linux_config(1, &cmdline, Some(initramfs.0.clone()));
    let mut vm = crate::Vm::with_backend(
        config,
        boxlite_hypervisor::KvmVm::new,
        |ram, config| prepare(ram, config).map(|setup| setup.boot_regs),
        |builder, context| {
            add_legacy_devices(builder, writer)?;
            let inner = VirtioBalloon::new().map_err(Error::CreateBalloon)?;
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
                let worker = context.executor.register(device.clone(), interrupt.clone());
                MmioTransport::new(
                    device,
                    interrupt,
                    MmioResources {
                        memory: context.memory.clone(),
                        sender: resources.event_sender(),
                        worker,
                    },
                )
            })?;
            builder.add("balloon-observer", |resources| {
                resources.pio(0x500, 12);
                Ok(Observer {
                    memory: context.memory,
                    evidence: evidence.clone(),
                })
            })
        },
    )
    .unwrap();
    let (exit, elapsed) = run_with_watchdog(&mut vm, Duration::from_secs(35));
    console.finish();
    let log = log.text();
    let evidence = evidence.lock().unwrap();
    eprintln!(
        "balloon KVM enabled={enabled}, init_on_free={init_on_free}, elapsed={elapsed:?}, phases={:?}, resident={}/{}, reports={}\n{log}",
        evidence.phases, evidence.after, evidence.before, evidence.reports
    );
    assert_eq!(exit.unwrap(), VmExit::GuestReset, "{log}");
    assert!(log.contains("BALLOON_GUEST_OK"), "{log}");
    assert!(!log.contains("BALLOON_FAIL"), "{log}");
    assert_eq!(evidence.phases, [1, 2, 3, 4]);
    assert_eq!(evidence.scratch.len(), 16384);
    assert_eq!(evidence.live.len(), 4096);
    assert_eq!(evidence.before, evidence.scratch.len());
    assert_eq!(evidence.live_after, evidence.live.len());
    assert!(
        evidence.activations >= 2,
        "guest unbind/bind must reactivate"
    );
    assert!(evidence.resets >= 1, "guest unbind must reset");
    assert_eq!(evidence.negotiated & (1 << 5) != 0, enabled);
    if enabled {
        assert!(evidence.after < evidence.before / 2);
        assert!(
            evidence.reports_after_free > 0,
            "real used-ring completions after munmap"
        );
    } else {
        assert_eq!(evidence.after, evidence.before);
        assert_eq!(evidence.reports, 0);
    }
    eprintln!(
        "BALLOON_KVM_RESULT reporting={enabled} init_on_free={init_on_free} guest=6.12.110 host_page={host_page} scratch_pages={} resident_before={} resident_after={} live_pages={} live_resident={} reports={} reports_after_free={} activations={} resets={}",
        evidence.scratch.len(),
        evidence.before,
        evidence.after,
        evidence.live.len(),
        evidence.live_after,
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
fn balloon_without_reporting_keeps_freed_backing_resident() {
    run_reporting_guest(false, false);
}

#[test]
#[ignore = "requires Linux x86_64 KVM, reporting VMM_KERNEL and VMM_BALLOON_INIT"]
fn balloon_init_on_free_disables_reporting_without_weakening_security() {
    run_reporting_guest(false, true);
}
