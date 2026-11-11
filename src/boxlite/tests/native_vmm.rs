//! First-box progress on the native engine.
//!
//! Boots an alpine box on `boxlite-vmm` through the runtime and asserts how far
//! it gets: the kernel mounts the guest root disk and runs `boxlite-guest` as
//! PID 1. The box cannot become ready yet: the native engine has no vsock,
//! virtio-fs or virtio-net device, so the ready notification fails and `start`
//! times out. Each device that lands moves the pinned stop
//! point until `start` succeeds.
//!
//! Run with `make test:integration:vmm:native`: it needs `/dev/kvm`,
//! `VMM_KERNEL` (from `make vmm:boot`) and a `boxlite-shim` built with the
//! `native` feature (`make runtime:debug`).

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

/// CID_ANY can listen without a vsock transport; connecting to the host cannot.
const STOP: &[&str] = &[
    "server bound (vsock:2695)",
    "Failed to connect to notify vsock",
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

    let error = bx
        .start()
        .await
        .expect_err("the box cannot become ready without vsock yet");
    println!("start failed as expected: {error}");

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
    assert_in_order(&console, STOP);
    assert!(!console.contains("Kernel panic"), "console:\n{console}");
    assert!(error.to_string().contains("timed out"), "{error}");

    let _ = bx.stop().await;
    let _ = runtime.remove(bx.id().as_str(), true).await;
}
