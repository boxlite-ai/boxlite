use super::tests::{
    ChildGuard, create_test_runtime, running_state, spawn_dummy_process, test_box_config_in_layout,
    write_pid_file_with_fingerprint,
};
use super::*;

#[test]
fn test_recovery_adopts_live_checkpoint_box_without_removing_vmstate() {
    use crate::litebox::archive::{CHECKPOINT_DIRNAME, GUEST_ROOTFS_FILENAME, VMSTATE_FILENAME};

    let (runtime, _dir) = create_test_runtime();
    let (pid, child) = spawn_dummy_process();
    let _child = ChildGuard(child);
    let config = test_box_config_in_layout(false, &runtime);
    let mut state = running_state(pid);
    state.pending_memory_restore = true;
    state.set_lock_id(runtime.lock_manager.allocate().unwrap());

    let layout = runtime
        .layout
        .box_layout(config.id.as_str(), false)
        .expect("box_layout is infallible");
    write_pid_file_with_fingerprint(&layout.pid_file_path(), pid);

    let checkpoint_dir = layout.root().join(CHECKPOINT_DIRNAME);
    std::fs::create_dir_all(&checkpoint_dir).unwrap();
    let vmstate_path = checkpoint_dir.join(VMSTATE_FILENAME);
    let guest_rootfs_path = checkpoint_dir.join(GUEST_ROOTFS_FILENAME);
    std::fs::write(&vmstate_path, b"vmstate").unwrap();
    std::fs::write(&guest_rootfs_path, b"guest-rootfs").unwrap();

    runtime.box_manager.add_box(&config, &state).unwrap();

    runtime.recover_boxes().expect("recover_boxes");

    let (_, recovered) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
    assert_eq!(recovered.status, BoxStatus::Running);
    assert_eq!(recovered.pid, Some(pid));
    assert!(
        !recovered.pending_memory_restore,
        "recover_boxes must persist pending_memory_restore=false even when status/pid stay unchanged"
    );
    assert!(
        vmstate_path.is_file(),
        "the live shim may not have opened vmstate.krun yet"
    );
    assert!(
        guest_rootfs_path.is_file(),
        "guest-rootfs.ext4 must remain available for chained export while Running"
    );
}

#[test]
fn test_recovery_preserves_unstarted_checkpoints_and_cleans_aborted_ones() {
    use crate::litebox::archive::{CHECKPOINT_DIRNAME, GUEST_ROOTFS_FILENAME, VMSTATE_FILENAME};

    let (runtime, _dir) = create_test_runtime();

    // 1. Configured and Failed boxes that never spawned a VM.
    let untouched = [BoxStatus::Configured, BoxStatus::Failed].map(|status| {
        let config = test_box_config_in_layout(false, &runtime);
        let mut state = BoxState::new();
        state.set_status(status);
        state.pending_memory_restore = true;
        let checkpoint = config.box_home.join(CHECKPOINT_DIRNAME);
        std::fs::create_dir_all(&checkpoint).unwrap();
        std::fs::write(checkpoint.join(VMSTATE_FILENAME), b"vmstate").unwrap();
        std::fs::write(checkpoint.join(GUEST_ROOTFS_FILENAME), b"rootfs").unwrap();
        runtime.box_manager.add_box(&config, &state).unwrap();
        (config.id, status, checkpoint)
    });

    // 2. Configured checkpoint box whose spawn crashed (dead PID file present).
    let spawned_cfg = test_box_config_in_layout(false, &runtime);
    let mut spawned_state = BoxState::new();
    let stale_pid = 999999;
    spawned_state.set_pid(Some(stale_pid));
    spawned_state.pending_memory_restore = true;
    let spawned_layout = runtime
        .layout
        .box_layout(spawned_cfg.id.as_str(), false)
        .unwrap();
    let spawned_pid_file = spawned_layout.pid_file_path();
    std::fs::create_dir_all(spawned_pid_file.parent().unwrap()).unwrap();
    std::fs::write(&spawned_pid_file, format!("{stale_pid}\n1\n")).unwrap();
    let spawned_ckpt = spawned_layout.root().join(CHECKPOINT_DIRNAME);
    std::fs::create_dir_all(&spawned_ckpt).unwrap();
    std::fs::write(spawned_ckpt.join(VMSTATE_FILENAME), b"vmstate").unwrap();
    std::fs::write(spawned_ckpt.join(GUEST_ROOTFS_FILENAME), b"rootfs").unwrap();
    runtime
        .box_manager
        .add_box(&spawned_cfg, &spawned_state)
        .unwrap();

    // 3. Running checkpoint box whose shim exited/crashed while runtime was down.
    let exited_cfg = test_box_config_in_layout(false, &runtime);
    let mut exited_state = running_state(999998);
    exited_state.pending_memory_restore = true;
    let exited_layout = runtime
        .layout
        .box_layout(exited_cfg.id.as_str(), false)
        .unwrap();
    let exited_ckpt = exited_layout.root().join(CHECKPOINT_DIRNAME);
    std::fs::create_dir_all(&exited_ckpt).unwrap();
    std::fs::write(exited_ckpt.join(VMSTATE_FILENAME), b"vmstate").unwrap();
    std::fs::write(exited_ckpt.join(GUEST_ROOTFS_FILENAME), b"rootfs").unwrap();
    runtime
        .box_manager
        .add_box(&exited_cfg, &exited_state)
        .unwrap();

    runtime.recover_boxes().expect("recover_boxes");

    for (id, status, checkpoint) in untouched {
        let (_, after) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
        assert_eq!(after.status, status);
        assert!(after.pending_memory_restore, "{status} never spawned");
        assert!(checkpoint.join(VMSTATE_FILENAME).is_file());
        assert!(checkpoint.join(GUEST_ROOTFS_FILENAME).is_file());
    }

    let (_, spawned_after) = runtime
        .box_manager
        .box_by_id(&spawned_cfg.id)
        .unwrap()
        .unwrap();
    assert_eq!(spawned_after.status, BoxStatus::Stopped);
    assert_eq!(spawned_after.pid, None);
    assert!(!spawned_pid_file.exists());
    assert!(!spawned_after.pending_memory_restore);
    assert!(!spawned_ckpt.exists());

    let (_, exited_after) = runtime
        .box_manager
        .box_by_id(&exited_cfg.id)
        .unwrap()
        .unwrap();
    assert_eq!(exited_after.status, BoxStatus::Stopped);
    assert!(!exited_after.pending_memory_restore);
    assert!(!exited_ckpt.exists());
}
