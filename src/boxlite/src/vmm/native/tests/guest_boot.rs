//! The real guest executable owns PID 1; a test-only child observes its mounts
//! and serves as the Unix RPC client without needing a host vsock device.

use super::*;

async fn boot(scenario: &str) -> String {
    let test_box = TestBox::new();
    let guest = fs::read(std::env::var_os("VMM_GUEST").expect("set VMM_GUEST")).unwrap();
    let probe =
        fs::read(std::env::var_os("VMM_GUEST_PROBE").expect("set VMM_GUEST_PROBE")).unwrap();
    let mut entries: Vec<(&str, u32, &[u8])> =
        ["dev", "proc", "sys", "tmp", "var", "var/tmp", "run"]
            .into_iter()
            .map(|path| (path, 0o040_755, &[][..]))
            .collect();
    entries.extend([
        ("init", 0o100_755, probe.as_slice()),
        ("boxlite-guest", 0o100_755, guest.as_slice()),
    ]);
    let archive = m1_initramfs::newc_archive(&entries);
    let kernel = fs::read(std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL")).unwrap();
    let prepared = test_box.stage_kernel(&kernel, Some(&archive));
    let mut spec = test_box.spec(Some(prepared));
    spec.memory_mib = Some(512);
    spec.guest_entrypoint.args.push(scenario.to_string());

    let exit = test_box.run_shim(&spec).await;
    let console = test_box.console();
    assert_eq!(exit, ProcessExit::Code(0), "{console}");
    assert!(!console.contains("Kernel panic"), "{console}");
    assert!(!console.contains("BOOT_PROBE_FAILED"), "{console}");
    console
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn init_bootstraps_the_real_guest_and_serves_unix_rpc() {
    let console = boot("fresh").await;
    assert!(console.contains("BOXLITE_GUEST_BOOT_OK"), "{console}");
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn init_reuses_existing_mounts_and_applies_hostname() {
    let console = boot("premounted").await;
    assert!(console.contains("BOXLITE_GUEST_BOOT_OK"), "{console}");
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn init_restarts_on_argument_and_startup_errors() {
    for (scenario, diagnostic, status) in [
        ("bad-args", "unexpected argument", 2),
        ("help", "BoxLite Guest Agent", 0),
        ("bad-uri", "Invalid listen URI", 1),
    ] {
        let console = boot(scenario).await;
        assert!(console.contains(diagnostic), "{console}");
        assert!(
            console.contains(&format!("PID 1 restarting (status {status})")),
            "{console}"
        );
    }
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn init_rejects_incorrect_mount_types_without_overmounting() {
    for (scenario, diagnostic) in [
        ("wrong-proc", "/proc has an unexpected filesystem"),
        ("wrong-proc-bind", "/proc has an unexpected filesystem"),
        ("wrong-dev", "/dev is mounted as tmpfs, expected devtmpfs"),
        ("wrong-run", "/run is mounted as proc, expected tmpfs"),
        (
            "wrong-run-stacked",
            "/run is mounted as proc, expected tmpfs",
        ),
    ] {
        let console = boot(scenario).await;
        assert!(console.contains(diagnostic), "{console}");
        assert!(console.contains("PID 1 restarting (status 1)"), "{console}");
        assert!(!console.contains("zygote started"), "{console}");
    }
}
