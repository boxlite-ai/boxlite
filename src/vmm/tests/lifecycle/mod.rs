// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{fmt::Debug, sync::Arc, time::Duration};

use super::{Lifecycle, VmStatus};
use crate::{
    ControlReason, DiskConfig, DiskFormat, Error, FsConfig, NetConfig, VmConfig, VmControl,
    VsockConfig,
    control::ControlRegistry,
    events::{Event, EventLoop},
};

#[test]
fn control_is_clone_send_sync_and_debug() {
    fn assert_traits<T: Clone + Send + Sync + Debug>() {}
    assert_traits::<VmControl>();
}

#[test]
fn stop_latches_one_event_and_is_idempotent_after_exit() {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let lifecycle = Arc::new(Lifecycle::new(sender.clone()));
    let control = ControlRegistry::default().finish(Arc::clone(&lifecycle));

    assert_eq!(control.status(), VmStatus::Created);
    control.stop();
    control.clone().stop();
    assert_eq!(control.status(), VmStatus::Stopping);
    assert!(!lifecycle.state().run_claimed);
    assert!(sender.is_stopping());
    assert!(matches!(
        events.wait(Some(Duration::ZERO)).unwrap(),
        Some(Event::StopRequested)
    ));
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());

    #[cfg(target_arch = "x86_64")]
    {
        assert!(matches!(lifecycle.begin_run(), Ok(false)));
        assert!(matches!(lifecycle.begin_run(), Err(Error::AlreadyRan)));
    }

    lifecycle.mark_exited();
    control.stop();
    assert_eq!(control.status(), VmStatus::Exited);
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn device_less_validation_rejects_each_userspace_device() {
    let empty = VmConfig {
        vcpu_count: 1,
        memory_mib: 16,
        kernel: "vmlinux".into(),
        cmdline: String::new(),
        initramfs: None,
        disks: Vec::new(),
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
        hotplug_mib: 0,
    };
    empty.validate_device_less().unwrap();
    assert!(matches!(
        VmConfig {
            vcpu_count: 0,
            ..empty.clone()
        }
        .validate_device_less(),
        Err(Error::InvalidVcpuCount(0))
    ));

    for config in [
        VmConfig {
            disks: vec![DiskConfig {
                block_id: "data".into(),
                path: "disk.raw".into(),
                format: DiskFormat::Raw,
                read_only: true,
            }],
            ..empty.clone()
        },
        VmConfig {
            filesystem: Some(FsConfig {
                tag: "shared".into(),
                shares: Vec::new(),
            }),
            ..empty.clone()
        },
        VmConfig {
            vsock: Some(VsockConfig {
                cid: 3,
                listen: Vec::new(),
                connect: Vec::new(),
            }),
            ..empty.clone()
        },
        VmConfig {
            network: Some(NetConfig {
                path: "network.sock".into(),
                mac: [2, 0, 0, 0, 0, 1],
            }),
            ..empty.clone()
        },
        VmConfig {
            virtio_console: true,
            ..empty.clone()
        },
        VmConfig {
            hotplug_mib: 128,
            ..empty
        },
    ] {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        let error = crate::Vm::new_device_less(config).unwrap_err();
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        let error = config.validate_device_less().unwrap_err();

        assert!(matches!(
            error,
            Error::Control {
                operation: "new_device_less",
                reason: ControlReason::UnsupportedDevice,
            }
        ));
    }
}
