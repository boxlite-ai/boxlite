// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Boot the production guest volume adapter as PID 1 over native virtio-fs.

use std::fs;

use super::{
    BOOT_TIMEOUT, CONSOLE_CMDLINE, SerialLog, TempFile, linux_config, newc_archive,
    run_with_watchdog,
};
use crate::{FsConfig, FsShareConfig, Vm, VmExit};

#[test]
#[ignore = "requires KVM, VMM_KERNEL and VMM_GUEST_MOUNT_INIT; run make test:integration:vmm:mounts"]
fn mounts_production_guest_volumes_through_aggregate_filesystem() {
    let init = std::env::var_os("VMM_GUEST_MOUNT_INIT")
        .expect("set VMM_GUEST_MOUNT_INIT to the static production guest mount test init");
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let original = root.join("original");
    let snapshot_original = root.join("snapshot-original");
    fs::write(&original, b"writable").unwrap();
    fs::write(&snapshot_original, b"snapshot").unwrap();
    let mut shares = Vec::new();
    for (name, contents, read_only) in [
        ("BoxLiteShared", b"shared".as_slice(), false),
        ("directory", b"directory", false),
        ("writable", b"writable", false),
        ("snapshot", b"snapshot", true),
    ] {
        let path = root.join(name);
        fs::create_dir(&path).unwrap();
        match name {
            "writable" => fs::hard_link(&original, path.join("file")).unwrap(),
            "snapshot" => {
                fs::copy(&snapshot_original, path.join("file")).unwrap();
            }
            _ => fs::write(path.join("file"), contents).unwrap(),
        }
        shares.push(FsShareConfig {
            name: name.into(),
            path,
            read_only,
        });
    }
    // Snapshot staging is independent of later edits to its source.
    fs::write(&snapshot_original, b"changed after snapshot").unwrap();
    let archive = newc_archive("init", &fs::read(init).unwrap());
    let initramfs = TempFile::new("guest-mounts.cpio", &archive);
    let mut config = linux_config(1, CONSOLE_CMDLINE, Some(initramfs.0.clone()));
    config.filesystem = Some(FsConfig {
        tag: "boxlite".into(),
        shares,
    });
    let log = SerialLog::default();
    let mut vm = Vm::new(config, Box::new(log.clone())).unwrap();
    let (exit, elapsed) = run_with_watchdog(&mut vm, BOOT_TIMEOUT);
    assert!(
        matches!(exit, Ok(VmExit::GuestReset)),
        "{exit:?} {elapsed:?}\n{}",
        log.text()
    );
    let output = log.text();
    assert!(output.contains("GUEST-MOUNTS-OK"), "{output}");
    assert!(!output.contains("GUEST-MOUNTS-FAIL"), "{output}");
    for (path, contents) in [
        (original, b"guest writable".as_slice()),
        (root.join("writable/file"), b"guest writable"),
        (root.join("directory/file"), b"guest directory"),
        (root.join("BoxLiteShared/file"), b"shared"),
        (root.join("snapshot/file"), b"snapshot"),
        (snapshot_original, b"changed after snapshot"),
    ] {
        assert_eq!(fs::read(&path).unwrap(), contents, "{}", path.display());
    }
    for name in ["writable", "snapshot"] {
        let entries: Vec<_> = fs::read_dir(root.join(name))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("file")]);
    }
    drop(vm);
    let retained: Vec<_> = fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| fs::read_link(entry.ok()?.path()).ok())
        .filter(|target| target.starts_with(root))
        .collect();
    assert!(
        retained.is_empty(),
        "export descriptors retained: {retained:?}"
    );
}
