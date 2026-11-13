//! Native KVM first-box acceptance: ext4 PID 1 boot, ready notification and exec.
//! Run with `make test:integration:vmm:native` on Linux x86_64 with /dev/kvm.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::experimental::custom_kernel::{self, KernelFormat, KernelOptions};
use boxlite::experimental::{ExperimentalFeature, RuntimeBuilder, native_vmm};
use boxlite::runtime::options::BoxliteOptions;
use boxlite_test_utils::home::PerTestBoxHome;

/// Console lines the boot must reach, in order.
const PROGRESS: &[&str] = &[
    "virtio_blk virtio0: [vda]",
    "virtio_blk virtio1: [vdb]",
    "Mounted root (ext4 filesystem) readonly",
    "devtmpfs: mounted",
    "Run /boxlite/bin/boxlite-guest as init process",
    "[guest] T+0ms: agent starting",
    "BoxLite Guest Agent starting",
    "init bootstrap completed",
    "kernel hardening applied",
    "zygote started",
    "tmpfs mounted",
    "loopback ready",
];

fn native_runtime(home: &PerTestBoxHome) -> BoxliteRuntime {
    RuntimeBuilder::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .enable(ExperimentalFeature::CustomKernel)
    .enable(ExperimentalFeature::NativeVmm)
    .build()
    .expect("create the native runtime")
}

/// Asserts that each of `steps` is found in `log`, in that order.
fn assert_in_order(log: &str, steps: &[&str]) {
    let mut rest = log;
    for step in steps {
        let Some(at) = rest.find(step) else {
            panic!("missing {step:?} after the earlier steps; console:\n{log}");
        };
        rest = &rest[at + step.len()..];
    }
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a boxlite-shim built with native"]
async fn first_box_runs_boxlite_guest_as_pid_1_on_the_ext4_root() {
    let kernel = std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL or run make vmm:boot");
    let home = PerTestBoxHome::new();
    let runtime = native_runtime(&home);

    let mut options = common::alpine_opts();
    custom_kernel::configure(
        &mut options,
        KernelOptions::new(kernel).with_format(KernelFormat::Elf),
    );
    native_vmm::configure(&mut options);
    let bx = runtime.create(options, None).await.expect("create the box");

    bx.start().await.expect("native box must become ready");
    let setup = bx
        .exec(boxlite::BoxCommand::new("sh").args([
            "-c",
            "printf '#!/bin/sh\nexit 23\n' > /tmp/native-entrypoint; chmod +x /tmp/native-entrypoint",
        ]))
        .await
        .expect("create a script entrypoint");
    assert_eq!(setup.wait().await.unwrap().exit_code, 0);
    let execution = bx
        .exec(boxlite::BoxCommand::new("/tmp/native-entrypoint"))
        .await
        .expect("native exec of a shebang script");
    assert_eq!(execution.wait().await.unwrap().exit_code, 23);

    let console_log = home
        .path
        .join("boxes")
        .join(bx.id().as_str())
        .join("logs")
        .join("console.log");
    let console = std::fs::read_to_string(&console_log)
        .unwrap_or_else(|e| panic!("read {}: {e}", console_log.display()));
    println!("--- console.log ---\n{console}");

    assert_in_order(&console, PROGRESS);
    assert!(
        !console.contains("Unable to mount root fs"),
        "the kernel did not mount the guest root"
    );
    assert!(console.contains("server bound (vsock:2695)"));
    assert!(!console.contains("Failed to connect to notify vsock"));
    assert!(!console.contains("Kernel panic"), "console:\n{console}");

    bx.stop().await.expect("stop the native box");
    runtime
        .remove(bx.id().as_str(), true)
        .await
        .expect("remove the native box");
}
