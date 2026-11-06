// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Real Linux allocator reporting over KVM/MMIO. The host samples the RAM
//! mapping's residency while the guest moves through its phases, and takes the
//! phases from the guest's console markers, so nothing in the guest needs a
//! test-only kernel capability.

use super::*;
use crate::memory::GuestMemoryMmap;
use std::sync::atomic::AtomicBool;
use vm_memory::GuestMemoryBackend;

/// Where the guest is, as far as its console says.
const TOUCHED: u32 = 1;
const FREED: u32 = 2;

#[derive(Clone, Default, Debug)]
struct Evidence {
    phase: u32,
    /// Most pages resident while the guest held every page it touched.
    resident_touched: usize,
    /// Fewest pages resident while the guest's scratch pages were free.
    resident_freed: usize,
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

fn run_reporting_guest(init_on_free: bool) -> (Evidence, String) {
    let host_page = crate::memory::host_page_size().unwrap();
    assert_eq!(host_page, 4096, "x86_64 qualification uses 4 KiB PFNs");
    let init = fs::read(
        std::env::var_os("VMM_BALLOON_INIT")
            .expect("use make test:integration:vmm:linux for the guest init"),
    )
    .unwrap();
    let name = if init_on_free {
        "balloon-init-on-free.cpio"
    } else {
        "balloon.cpio"
    };
    let initramfs = TempFile::new(name, &newc_archive("init", &init));
    let log = SerialLog::default();
    let (writer, mut console) =
        ConsoleWorker::spawn(Box::new(log.clone()), DEFAULT_QUEUE_BYTES).unwrap();
    let evidence = Arc::new(Mutex::new(Evidence::default()));
    let mut cmdline = CONSOLE_CMDLINE.to_owned();
    if init_on_free {
        cmdline.push_str(" init_on_free=1");
    }
    let config = linux_config(1, &cmdline, Some(initramfs.0.clone()));
    // The frame goes through the production composition: `devices::add_all`
    // places the reporting device on the first slot, exactly as `Vm::new` does.
    let mut sampler_memory = None;
    let mut vm = crate::Vm::with_devices(
        config,
        boxlite_hypervisor::KvmVm::new,
        |ram, config| prepare(ram, config).map(|setup| setup.boot_regs),
        |chipset, ctx, config| {
            sampler_memory = Some(Arc::clone(ctx.memory));
            crate::devices::add_all(chipset, ctx, config, writer)
        },
    )
    .unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let memory = sampler_memory.expect("the device context holds the RAM");
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
    let evidence = evidence.lock().unwrap().clone();
    eprintln!(
        "balloon KVM init_on_free={init_on_free}, elapsed={elapsed:?}, resident={}/{}\n{log}",
        evidence.resident_freed, evidence.resident_touched
    );
    assert_eq!(exit.unwrap(), VmExit::GuestReset, "{log}");
    assert!(!log.contains("BALLOON_FAIL"), "{log}");
    assert!(
        log.contains("BALLOON_GUEST_OK"),
        "the guest must finish its own checks: {log}"
    );
    for marker in ["BALLOON_TOUCHED", "BALLOON_FREED", "BALLOON_REUSED"] {
        assert!(log.contains(marker), "{marker} missing: {log}");
    }
    // The guest touches 64 MiB of scratch and 16 MiB of live pages.
    assert!(
        evidence.resident_touched >= 80 << 20 >> 12,
        "the sampled residency must cover the pages the guest touched: {}",
        evidence.resident_touched
    );
    eprintln!(
        "BALLOON_KVM_RESULT init_on_free={init_on_free} guest=6.12.110 host_page={host_page} resident_touched={} resident_freed={}",
        evidence.resident_touched, evidence.resident_freed
    );
    (evidence, log)
}

#[test]
#[ignore = "requires Linux x86_64 KVM, reporting VMM_KERNEL and VMM_BALLOON_INIT"]
fn balloon_reporting_reclaims_and_reuses_guest_memory() {
    let (evidence, _log) = run_reporting_guest(false);
    // The device is composed by the production path, so the host sees only the
    // RAM mapping: reporting must drop most of the 64 MiB the guest freed.
    assert!(
        evidence.resident_freed < evidence.resident_touched / 2,
        "reporting must drop the freed scratch pages: {} of {}",
        evidence.resident_freed,
        evidence.resident_touched
    );
}

#[test]
#[ignore = "requires Linux x86_64 KVM, reporting VMM_KERNEL and VMM_BALLOON_INIT"]
fn balloon_init_on_free_disables_reporting_without_weakening_security() {
    // Host reclaim or swap can evict guest RAM independently of the device, so
    // this control asserts the guest's own checks only.
    let _ = run_reporting_guest(true);
}
