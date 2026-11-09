//! The real guest owns PID 1 on a read-only ext4 root. A test-only child
//! observes its mounts and serves as the Unix RPC client inside the VM.

use std::os::unix::fs::PermissionsExt;

use super::*;

fn guest_root(test_box: &TestBox) -> crate::disk::Disk {
    let root = test_box.home.path().join("guest-root");
    for path in ["dev", "proc", "sys", "tmp", "var/tmp", "run"] {
        fs::create_dir_all(root.join(path)).unwrap();
    }
    for (variable, name) in [("VMM_GUEST", "boxlite-guest"), ("VMM_GUEST_PROBE", "init")] {
        let source = std::env::var_os(variable).unwrap_or_else(|| panic!("set {variable}"));
        let destination = root.join(name);
        fs::copy(source, &destination).unwrap();
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let bases = test_box.home.path().join("bases");
    fs::create_dir_all(&bases).unwrap();
    crate::disk::create_ext4_from_dir(&root, &bases.join("guest.ext4"), 0).unwrap()
}

async fn boot(scenario: &str) -> String {
    let test_box = TestBox::new();
    let root_disk = guest_root(&test_box);
    let kernel = fs::read(std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL")).unwrap();
    let prepared = test_box.stage_kernel(&kernel, None);
    let mut spec = test_box.spec(Some(prepared));

    // vda only preserves the runtime's disk order; neither fixture needs writes.
    let container_disk = test_box.layout.disk_path();
    fs::File::create(&container_disk)
        .unwrap()
        .set_len(1024 * 1024)
        .unwrap();
    for (block_id, disk_path) in [
        ("vda", container_disk),
        ("vdb", root_disk.path().to_path_buf()),
    ] {
        spec.block_devices.add(BlockDevice {
            block_id: block_id.to_string(),
            disk_path,
            format: DiskFormat::Raw,
            read_only: true,
        });
    }
    spec.guest_rootfs.path = test_box.home.path().join("guest-root");
    spec.guest_rootfs.strategy = Strategy::Disk {
        disk_path: root_disk.path().to_path_buf(),
        device_path: Some("/dev/vdb".to_string()),
    };
    spec.memory_mib = Some(512);
    spec.guest_entrypoint.args.push(scenario.to_string());

    let exit = test_box.run_shim(&spec).await;
    let console = test_box.console();
    assert_eq!(exit, ProcessExit::Code(0), "{console}");
    assert!(
        console.contains("Mounted root (ext4 filesystem) readonly"),
        "{console}"
    );
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
