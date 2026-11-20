// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! virtio-mem on KVM with the pinned kernel: the host grows a 512 MiB or
//! 6 GiB guest by 1024 MiB, the guest writes 640 MiB, then the host shrinks
//! the target back to 256 MiB. The 6 GiB guest exercises high boot RAM.

use std::sync::atomic::AtomicBool;

use super::*;

/// Drives the target from the guest's console markers until `stop` is set.
fn control(log: &SerialLog, handle: &crate::MemoryHandle, stop: &AtomicBool) {
    let (mut grew, mut shrank) = (false, false);
    while !stop.load(Ordering::SeqCst) {
        let text = log.text();
        if !grew && text.contains("HOTPLUG_BASE") {
            handle.request(1024).unwrap();
            grew = true;
        }
        if !shrank && text.contains("HOTPLUG_USED") {
            handle.request(256).unwrap();
            shrank = true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "requires Linux x86_64 KVM, a virtio-mem VMM_KERNEL and VMM_HOTPLUG_INIT"]
fn virtio_mem_grows_and_shrinks_a_real_guest() {
    grow_and_shrink(512, 4 << 30);
}

#[test]
#[ignore = "requires Linux x86_64 KVM, a virtio-mem VMM_KERNEL and VMM_HOTPLUG_INIT"]
fn virtio_mem_grows_and_shrinks_with_high_boot_ram() {
    grow_and_shrink(6144, 7 << 30);
}

fn grow_and_shrink(boot_mib: u32, window_base: u64) {
    let init = fs::read(
        std::env::var_os("VMM_HOTPLUG_INIT")
            .expect("use make test:integration:vmm:linux for the guest init"),
    )
    .unwrap();
    let initramfs = TempFile::new(
        &format!("hotplug-{boot_mib}.cpio"),
        &newc_archive("init", &init),
    );
    let log = SerialLog::default();
    let mut config = linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone()));
    config.memory_mib = boot_mib;
    config.hotplug_mib = 1024;
    let mut vm = crate::Vm::new(config, Box::new(log.clone())).unwrap();
    let handle = vm.memory_handle().expect("hotplug_mib adds the device");
    let stop = Arc::new(AtomicBool::new(false));
    let controller = {
        let (log, handle, stop) = (log.clone(), handle.clone(), Arc::clone(&stop));
        std::thread::spawn(move || control(&log, &handle, &stop))
    };
    let (exit, elapsed) = run_with_watchdog(&mut vm, Duration::from_secs(120));
    stop.store(true, Ordering::SeqCst);
    controller.join().unwrap();
    let after_shrink = handle.status();
    let log = log.text();
    eprintln!("virtio-mem KVM elapsed={elapsed:?} status={after_shrink:?}\n{log}");

    assert_eq!(exit.unwrap(), VmExit::GuestReset, "{log}");
    assert!(!log.contains("HOTPLUG_FAIL"), "{log}");
    let expected_base = format!("{window_base:#x}");
    assert!(
        log.lines().any(|line| {
            line.starts_with("virtio_mem ")
                && line
                    .split_once(": start address: ")
                    .is_some_and(|(_, address)| address.trim() == expected_base)
        }),
        "virtio-mem window should start at {expected_base}\n{log}"
    );
    for marker in [
        "HOTPLUG_GROWN",
        "HOTPLUG_USED",
        "HOTPLUG_SHRUNK",
        "HOTPLUG_GUEST_OK",
    ] {
        assert!(log.contains(marker), "{marker} missing: {log}");
    }
    assert_eq!(after_shrink.requested_mib, 256);
    assert_eq!(after_shrink.plugged_mib, 256, "the guest returned the rest");
    assert_eq!(
        after_shrink.mapped_mib, 256,
        "emptied slots must leave KVM and the host mapping"
    );
}
