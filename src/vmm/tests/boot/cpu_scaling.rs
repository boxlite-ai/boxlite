// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A real Linux guest with spare vCPUs: the host grants and revokes them
//! through `VmControl` while the guest onlines and offlines CPUs through
//! sysfs, and guest root cannot online a vCPU the host has not granted.

use std::{
    fs, thread,
    time::{Duration, Instant},
};

use super::{CONSOLE_CMDLINE, SerialLog, TempFile, linux_config, newc_archive, run_with_watchdog};
use crate::{VmConfig, VmExit};

/// Enough for two 10-second refused onlines plus the boot.
const TIMEOUT: Duration = Duration::from_secs(90);

/// What the host saw at each step of the guest's script.
#[derive(Debug, Default)]
struct HostSteps {
    threads_after_boot: usize,
    threads_after_bypass: usize,
    grant: Option<(crate::Result<u8>, Duration)>,
    threads_after_grant: usize,
    revoke: Option<(crate::Result<u8>, Duration)>,
    threads_after_revoke: usize,
}

/// Threads in this process that run, or ran, a vCPU: the VMM names them
/// `vcpu<id>`, and the tests run one at a time.
fn vcpu_threads() -> usize {
    fs::read_dir("/proc/self/task")
        .unwrap()
        .filter_map(|task| fs::read_to_string(task.ok()?.path().join("comm")).ok())
        .filter(|name| name.starts_with("vcpu"))
        .count()
}

/// Waits until the guest has printed `marker`; false once `deadline` passes
/// or the guest reported a failure.
fn wait_for(log: &SerialLog, marker: &str, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        let text = log.text();
        if text.contains(marker) {
            return true;
        }
        if text.contains("CPU_SCALING_FAIL") {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
    false
}

/// Answers the guest's markers: grant every vCPU when it waits, revoke two
/// once it has offlined them, and count vCPU threads after each step.
fn drive(log: &SerialLog, control: &crate::VmControl) -> HostSteps {
    let deadline = Instant::now() + TIMEOUT;
    let mut steps = HostSteps::default();
    if !wait_for(log, "CPU_BOOT", deadline) {
        return steps;
    }
    steps.threads_after_boot = vcpu_threads();
    if !wait_for(log, "CPU_BYPASS ", deadline) {
        return steps;
    }
    steps.threads_after_bypass = vcpu_threads();
    if !wait_for(log, "CPU_WAIT_GRANT", deadline) {
        return steps;
    }
    let started = Instant::now();
    steps.grant = Some((control.set_online_vcpus(4), started.elapsed()));
    steps.threads_after_grant = vcpu_threads();
    if !wait_for(log, "CPU_OFFLINED", deadline) {
        return steps;
    }
    let started = Instant::now();
    steps.revoke = Some((control.set_online_vcpus(2), started.elapsed()));
    steps.threads_after_revoke = vcpu_threads();
    steps
}

/// The value after `marker ` on its line.
fn after<'a>(log: &'a str, marker: &str) -> &'a str {
    let prefix = format!("{marker} ");
    log.lines()
        .find_map(|line| line.strip_prefix(prefix.as_str()))
        .unwrap_or_else(|| panic!("no {marker:?} in:\n{log}"))
        .trim()
}

/// The errno and milliseconds a refused online reported.
fn refusal(log: &str, marker: &str) -> (i64, u64) {
    let mut fields = after(log, marker).split(' ');
    let errno = fields.next().unwrap().parse().unwrap();
    let millis = fields.next().unwrap().parse().unwrap();
    (errno, millis)
}

#[test]
#[ignore = "requires Linux x86_64 KVM, VMM_KERNEL and VMM_CPU_SCALING_INIT"]
fn grants_and_revokes_vcpus_while_a_real_guest_onlines_and_offlines_them() {
    let init = fs::read(
        std::env::var_os("VMM_CPU_SCALING_INIT")
            .expect("use make test:integration:vmm:linux for the guest init"),
    )
    .unwrap();
    let initramfs = TempFile::new("cpu-scaling.cpio", &newc_archive("init", &init));
    let log = SerialLog::default();
    let config = VmConfig {
        max_vcpus: 4,
        ..linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone()))
    };
    let mut vm = crate::Vm::new(config, Box::new(log.clone())).unwrap();
    let host = {
        let (log, control) = (log.clone(), vm.control());
        thread::spawn(move || drive(&log, &control))
    };

    let (exit, elapsed) = run_with_watchdog(&mut vm, TIMEOUT);
    let steps = host.join().unwrap();
    drop(vm);
    let log = log.text();
    eprintln!("CPU scaling on KVM, elapsed={elapsed:?}, host={steps:?}\n{log}");

    assert_eq!(exit.unwrap(), VmExit::GuestReset, "{log}");
    assert!(log.contains("CPU_SCALING_OK"), "{log}");
    assert_eq!(after(&log, "CPU_BOOT"), "0", "maxcpus=1 brings up one CPU");
    assert_eq!(steps.threads_after_boot, 1, "parked vCPUs have no thread");

    let (errno, millis) = refusal(&log, "CPU_BYPASS");
    assert_eq!(
        errno, -5,
        "guest root cannot online an ungranted vCPU: {log}"
    );
    assert!(
        millis >= 9_000,
        "Linux waits about 10 s for the vCPU: {millis} ms"
    );
    assert_eq!(
        steps.threads_after_bypass, 1,
        "the refused online starts no thread"
    );

    let (granted, took) = steps.grant.expect("the guest waited for the grant");
    assert_eq!(granted.unwrap(), 4);
    assert!(took < Duration::from_secs(1), "grant took {took:?}");
    assert_eq!(steps.threads_after_grant, 4);
    // vCPU 3 latched INIT and SIPI from the refused online; the grant reset it.
    assert_eq!(after(&log, "CPU_GROWN"), "0-3");

    assert_eq!(after(&log, "CPU_OFFLINED"), "0-1");
    let (revoked, took) = steps.revoke.expect("the guest offlined two CPUs");
    assert_eq!(revoked.unwrap(), 2);
    assert!(took < Duration::from_secs(1), "revoke took {took:?}");
    assert_eq!(steps.threads_after_revoke, 2, "revoked vCPUs' threads exit");

    let (errno, _) = refusal(&log, "CPU_BYPASS_REVOKED");
    assert_eq!(errno, -5, "a revoked vCPU cannot be onlined again: {log}");
}
