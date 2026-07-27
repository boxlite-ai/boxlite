use assert_cmd::Command;
use predicates::prelude::*;

mod common;

/// Opens `/dev/kvm` inside the workload and creates a VM through it: proof the
/// opt-in reaches a working nested hypervisor, not just a device node.
///
/// `KVM_GET_API_VERSION` (0xAE00) always answers 12; `KVM_CREATE_VM` (0xAE01)
/// only succeeds when the host really exposes nesting.
const CREATE_NESTED_VM: &str = "\
import fcntl, os
kvm = os.open('/dev/kvm', os.O_RDWR | os.O_CLOEXEC)
api = fcntl.ioctl(kvm, 0xAE00, 0)
assert api == 12, api
vm = fcntl.ioctl(kvm, 0xAE01, 0)
assert vm >= 0, vm
print(f'nested-kvm-api={api}')
os.close(vm)
os.close(kvm)
";

#[test]
fn nested_virtualization_requires_explicit_rc_opt_in() {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    command
        .env_remove("BOXLITE_EXPERIMENTAL")
        .args([
            "--url",
            "http://127.0.0.1:1",
            "create",
            "--rootfs",
            "/definitely/missing/rootfs",
            "--nested-virtualization",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "BOXLITE_EXPERIMENTAL=nested-virtualization",
        ));
}

/// Needs nesting-capable hardware, so it is opt-in: the self-hosted integration
/// runner sets the variable, and developers can set it on suitable machines.
#[test]
fn nested_virtualization_can_create_kvm_vm() {
    if std::env::var_os("BOXLITE_TEST_NESTED_VIRTUALIZATION").is_none() {
        eprintln!("skipping nested KVM smoke test (set BOXLITE_TEST_NESTED_VIRTUALIZATION=1)");
        return;
    }

    let mut ctx = common::boxlite();
    ctx.cmd.timeout(std::time::Duration::from_secs(180));
    ctx.cmd.env("BOXLITE_EXPERIMENTAL", "nested-virtualization");
    ctx.cmd.args([
        "run",
        "--nested-virtualization",
        "--rm",
        "python:3.12-alpine",
        "python3",
        "-c",
        CREATE_NESTED_VM,
    ]);
    ctx.cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("nested-kvm-api=12"));
}
